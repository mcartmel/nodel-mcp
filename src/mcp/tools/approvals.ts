import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import { approveWrite } from "../../safety/approvals.js";
import { timingSafeStringEqual } from "../../shared/secret.js";
import { writeToolAnnotations } from "../toolAnnotations.js";
import { toolResult } from "./common.js";
import { publicError, sanitizeSensitiveMessage } from "../../shared/publicErrors.js";

export type ElicitInput = Server["elicitInput"];

/** Collection and documentation use this when no connected MCP client can receive an elicitation. */
export const unavailableElicitInput: ElicitInput = async () => ({ action: "decline" });

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
        "Manual/fallback approval path. Create a short-lived approval id only after explicit operator approval of the matching full proposalHash and confirmText. This is a workflow guardrail dependent on client/operator discipline, not an authentication boundary.",
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
        "Ask the MCP client to elicit operator confirmation for a proposed write where supported, then mint the same approval id as nodel.approve_write. Falls back to manual approval instructions when elicitation is unavailable.",
      inputSchema: {
        operation: z.string().min(1),
        target: z.string().min(1),
        proposalHash: z.string().min(1),
        confirmText: z.string().min(1),
        reason: z.string().optional(),
        approvedBy: z.string().optional(),
        fallbackOnly: z.boolean().optional().default(false),
      },
      annotations: writeToolAnnotations,
    },
    async ({ operation, target, proposalHash, confirmText, reason, approvedBy, fallbackOnly }, extra) =>
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
          },
          extra ? { relatedRequestId: extra.requestId, signal: extra.signal } : undefined,
        ),
      ),
  );
}

export async function requestWriteApproval(
  config: AppConfig,
  elicitInput: ElicitInput,
  input: {
    operation: string;
    target: string;
    proposalHash: string;
    confirmText: string;
    reason?: string;
    approvedBy?: string;
    fallbackOnly?: boolean;
  },
  options?: Parameters<ElicitInput>[1],
) {
  if (!config.writesEnabled) {
    throw publicError("POLICY", "Write approval is unavailable because write tools are disabled.");
  }
  if (!config.writeApprovalRequired) {
    return {
      ok: true,
      approvalRequired: false,
      message:
        "Write approval ids are not required by current sidecar configuration. Apply with the matching write tool without approvalId.",
    };
  }

  const fallback = {
    ok: false,
    approvalRequired: true,
    fallback: "Call nodel.approve_write manually after explicit operator approval of the same confirmText.",
    operation: input.operation,
    target: input.target,
    proposalHash: input.proposalHash,
    confirmText: input.confirmText,
  };

  if (input.fallbackOnly) {
    return fallback;
  }

  try {
    const result = await elicitInput(
      {
        mode: "form",
        message: `Approve ${input.operation} for ${input.target}? Enter the exact confirmation text to continue: ${input.confirmText}`,
        requestedSchema: {
          type: "object",
          properties: {
            confirmText: {
              type: "string",
              title: "Confirmation Text",
              description: `Type exactly: ${input.confirmText}`,
            },
          },
          required: ["confirmText"],
        },
      },
      options,
    );

    if (options?.signal?.aborted) {
      return {
        ...fallback,
        action: "cancel",
        message: "Approval elicitation was cancelled; no approval id was created.",
      };
    }

    if (result.action !== "accept") {
      return {
        ...fallback,
        action: result.action,
        message: "Operator did not accept the approval elicitation; no approval id was created.",
      };
    }
    if (
      typeof result.content?.confirmText !== "string" ||
      !timingSafeStringEqual(result.content.confirmText, input.confirmText)
    ) {
      return {
        ...fallback,
        action: result.action,
        message: "Elicited confirmation text did not match exactly; no approval id was created.",
      };
    }

    return {
      ok: true,
      approvalRequired: true,
      source: "elicitation",
      ...approveWrite(
        config,
        { operation: input.operation, target: input.target, proposalHash: input.proposalHash },
        input.confirmText,
        input.reason,
        input.approvedBy,
      ),
    };
  } catch (error) {
    return { ...fallback, message: `MCP elicitation was unavailable or failed: ${sanitizeSensitiveMessage(error)}` };
  }
}
