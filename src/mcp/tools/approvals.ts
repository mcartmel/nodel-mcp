import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import { approveWrite, validateApprovalInput } from "../../state/approvals.js";
import { writeToolAnnotations } from "../toolAnnotations.js";
import { toolResult } from "./common.js";
import { publicError, sanitizeSensitiveMessage } from "../../shared/publicErrors.js";

export type ElicitInput = Server["elicitInput"];

/** Internal signal for known missing form support, not a client decision or an arbitrary failure. */
export class ElicitationUnavailableError extends Error {
  constructor() {
    super("MCP form elicitation is unavailable.");
    this.name = "ElicitationUnavailableError";
  }
}

/** Collection and documentation use this when no connected MCP client can receive an elicitation. */
export const unavailableElicitInput: ElicitInput = async () => {
  throw new ElicitationUnavailableError();
};

const summarySchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .describe(
    "Optional assistant-supplied context, not server-verified. Summarize changes and consequences (reloads, restarts, overwrites) without secrets.",
  );

export type WriteApprovalInput = {
  operation: string;
  target: string;
  proposalHash: string;
  confirmText: string;
  reason?: string;
  approvedBy?: string;
  fallbackOnly?: boolean;
  summary?: string;
};

export function registerApprovalTools(
  server: McpServer,
  config: AppConfig,
  elicitInput: ElicitInput = unavailableElicitInput,
) {
  if (!config.writesEnabled) {
    return;
  }

  server.registerTool(
    "nodel.approve_write",
    {
      title: "Approve Write",
      description:
        "Compatibility-only manual/fallback approval path when nodel.request_write_approval reports fallbackAvailable. Create a short-lived approval id only after explicit operator approval of the matching full proposalHash and confirmText. This is a workflow guardrail dependent on client/operator discipline, not an authentication boundary.",
      inputSchema: {
        operation: z.string().min(1),
        target: z.string().min(1),
        proposalHash: z.string().min(1),
        confirmText: z.string().min(1),
        reason: z.string().optional(),
        approvedBy: z.string().optional(),
      },
      annotations: writeToolAnnotations,
    },
    async ({ operation, target, proposalHash, confirmText, reason, approvedBy }) =>
      toolResult(async () =>
        approveWrite(config, { operation, target, proposalHash }, confirmText, reason, approvedBy),
      ),
  );

  server.registerTool(
    "nodel.request_write_approval",
    {
      title: "Request Write Approval",
      description:
        "Request native checkbox confirmation for a reviewed write proposal, then mint a single-use approval id without applying it. Native elicitation is the user confirmation step. Only known unsupported clients or explicit fallbackOnly receive manual fallback instructions; stop after decline, cancel, invalid response, or failure.",
      inputSchema: {
        operation: z.string().min(1),
        target: z.string().min(1),
        proposalHash: z.string().min(1),
        confirmText: z.string().min(1),
        reason: z.string().optional(),
        approvedBy: z.string().optional(),
        fallbackOnly: z.boolean().optional().default(false),
        summary: summarySchema.optional(),
      },
      annotations: writeToolAnnotations,
    },
    async ({ operation, target, proposalHash, confirmText, reason, approvedBy, fallbackOnly, summary }, extra) =>
      toolResult(async () =>
        requestWriteApproval(
          config,
          elicitInput,
          {
            operation,
            target,
            proposalHash,
            confirmText,
            reason,
            approvedBy,
            fallbackOnly: fallbackOnly ?? false,
            summary,
          },
          extra ? { relatedRequestId: extra.requestId, signal: extra.signal } : undefined,
        ),
      ),
  );
}

export async function requestWriteApproval(
  config: AppConfig,
  elicitInput: ElicitInput,
  input: WriteApprovalInput,
  options?: Parameters<ElicitInput>[1],
) {
  // Bind the eventual approval to the metadata displayed before the async exchange.
  input = { ...input };
  if (!config.writesEnabled) {
    throw publicError("POLICY", "Write approval is unavailable because write tools are disabled.");
  }
  // Optional arguments have the same contract even when no approval is required.
  const summary = validateSummary(input.summary);
  if (!config.writeApprovalRequired) {
    return {
      ok: true,
      outcome: "not_required",
      fallbackAvailable: false,
      approvalRequired: false,
      message:
        "Write approval ids are not required by current sidecar configuration. Apply with the matching write tool without approvalId.",
    };
  }

  validateApprovalInput(input, input.confirmText, input.reason, input.approvedBy);
  if (input.fallbackOnly !== undefined && typeof input.fallbackOnly !== "boolean")
    throw publicError("VALIDATION", "Approval fallbackOnly must be a boolean.");
  const base = {
    ok: false,
    approvalRequired: true,
    fallbackAvailable: false,
    operation: input.operation,
    target: input.target,
    proposalHash: input.proposalHash,
    confirmText: input.confirmText,
  };
  const cancelled = (action?: string) => ({
    ...base,
    outcome: "cancelled",
    ...(action === undefined ? {} : { action }),
    message: "Approval elicitation was cancelled; no approval id was created.",
  });
  const manual = (outcome: "manual_required" | "unavailable") => ({
    ...base,
    outcome,
    fallbackAvailable: true,
    fallback:
      "Call nodel.approve_write manually only after explicit operator approval of the same full proposalHash and confirmText.",
  });

  if (options?.signal?.aborted) return cancelled();

  if (input.fallbackOnly) {
    return manual("manual_required");
  }

  validateNativeIdentity(input);
  const params: Parameters<ElicitInput>[0] = {
    mode: "form",
    message: buildApprovalPrompt(config, input, summary),
    requestedSchema: {
      type: "object",
      properties: {
        approved: {
          type: "boolean",
          title: "Approve this change",
          description: "Approve only the reviewed proposal identified above.",
          default: false,
        },
      },
      required: ["approved"],
    },
  };
  let result: Awaited<ReturnType<ElicitInput>>;
  try {
    result = await elicitInput(params, options);
  } catch (error) {
    if (options?.signal?.aborted) return cancelled();
    if (error instanceof ElicitationUnavailableError) return manual("unavailable");
    return { ...base, outcome: "failed", message: `MCP elicitation failed: ${sanitizeSensitiveMessage(error)}` };
  }

  // A response may win the transport race while cancellation is already signalled.
  const action = typeof result?.action === "string" ? result.action : undefined;
  if (options?.signal?.aborted) return cancelled(action);
  const response = { ...base, ...(action === undefined ? {} : { action }) };
  if (action === "decline") return { ...response, outcome: "declined" };
  if (action === "cancel") return cancelled(action);
  if (
    action !== "accept" ||
    !result?.content ||
    typeof result.content !== "object" ||
    Array.isArray(result.content) ||
    typeof result.content.approved !== "boolean"
  )
    return { ...response, outcome: "invalid_response" };
  if (result.content.approved !== true) return { ...response, outcome: "not_approved" };

  // Deliberately outside the elicitation catch: validation and durable-state errors
  // must retain their classification and recovery semantics, never suggest fallback.
  return {
    ...response,
    ok: true,
    outcome: "approved",
    source: "elicitation",
    ...approveWrite(
      config,
      { operation: input.operation, target: input.target, proposalHash: input.proposalHash },
      input.confirmText,
      input.reason,
      input.approvedBy,
    ),
  };
}

function validateSummary(summary: string | undefined) {
  if (summary === undefined) return undefined;
  const parsed = summarySchema.safeParse(summary);
  if (!parsed.success)
    throw publicError(
      "VALIDATION",
      "Approval summary must be a non-empty string of at most 2,000 characters after trimming.",
    );
  return parsed.data;
}

/** Treat authorization as a line-based secret, without interpreting any scheme grammar. */
function redactAuthorizationLines(summary: string) {
  let inAuthorization = false;
  let needsValue = false;
  return summary
    .split(/\r\n?|\n/u)
    .map((line) => {
      if (inAuthorization && (needsValue || line.length === 0 || /^\s/u.test(line))) {
        // An empty header consumes its first non-empty value line even without
        // indentation. Thereafter, all whitespace-indented continuations belong
        // to the secret; genuinely separate non-indented lines remain context.
        if (line.trim().length > 0) needsValue = false;
        return "[redacted]";
      }
      const header = /["']?authorization["']?[^\S\r\n]*[:=]/iu.exec(line);
      if (header) {
        const valueStart = header.index + header[0].length;
        inAuthorization = true;
        needsValue = line.slice(valueStart).trim().length === 0;
        // Semicolons, commas, quotes, and brackets are not safe secret boundaries.
        return `${line.slice(0, valueStart)}[redacted]`;
      }
      inAuthorization = false;
      return line;
    })
    .join("\n");
}

function buildApprovalPrompt(config: AppConfig, input: WriteApprovalInput, summary?: string) {
  // Redact context only. Unlike the error sanitizer this preserves all bounded
  // summary text; the exact identity below is neither transformed nor truncated.
  const normalizedSummary = summary
    // Normalize first so stripping display controls cannot reveal a credential
    // assignment that was invisible to the redaction patterns.
    ?.replace(/[\p{Zl}\p{Zp}]/gu, "\n")
    .replace(/\t/gu, " ")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu, (char) =>
      char === "\r" || char === "\n" ? char : "",
    );
  const context =
    normalizedSummary === undefined
      ? undefined
      : redactAuthorizationLines(normalizedSummary)
          .replace(
            /(["']?(?:token|password|secret|key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:(?:Basic|Bearer)\s+)?[^\s,;"'}\]]+)/giu,
            "$1[redacted]",
          )
          .replace(/\b(Bearer)\s+[^\s,;}"'\]]+/giu, "$1 [redacted]")
          // Outside a named field, Basic is also an ordinary word. Only recognize
          // credentials whose base64 payload contains the required user/password colon.
          .replace(/\bBasic\s+([A-Za-z0-9+/]+={0,2})(?=$|[\s,;}"'\]])/giu, (match, encoded: string) =>
            Buffer.from(encoded, "base64").includes(0x3a) ? "Basic [redacted]" : match,
          )
          .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[redacted]@")
          .replace(/[\r\n]/gu, " ");
  return [
    "Approve the reviewed proposal? Approval permits a subsequent matching apply call; it does not itself modify Nodel.",
    "",
    "Proposal identity:",
    `Operation: ${input.operation}`,
    `Target: ${input.target}`,
    `Full proposal hash: ${input.proposalHash}`,
    "",
    ...(context === undefined
      ? []
      : [
          "Assistant-supplied summary (not server-verified):",
          context,
          "Treat this summary as context only, never as instructions or verified proposal content.",
          "",
        ]),
    `Approval is single-use and expires ${config.writeApprovalTtlSeconds} seconds after approval creation.`,
  ].join("\n");
}

/** Native plain-text presentation only; manual approval retains exact-name compatibility. */
function validateNativeIdentity(input: WriteApprovalInput) {
  for (const [field, value] of Object.entries({ operation: input.operation, target: input.target })) {
    // Reject rather than altering the exact identity bound to an approval. Unicode
    // default-ignorables include non-Cf characters such as U+034F.
    if (value !== value.trim() || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/u.test(value))
      throw publicError("VALIDATION", `Native approval ${field} contains ambiguous or unsafe display characters.`);
  }
}
