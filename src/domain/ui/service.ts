import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type { NodelClient } from "../../nodel/client.js";
import type { ResolvedNode } from "../../nodel/types.js";
import { assertSafeRecipePath } from "../../nodel/pathPolicy.js";
import { PublicError, publicError } from "../../shared/publicErrors.js";
import { validateV1Ui } from "./validator.js";
import { recognizeUi } from "./recognition.js";
import { UI_ADVISORY_LIMITS } from "./limits.js";
import { getUiCapabilityContext, unavailableUiCapabilityContext } from "./capabilities.js";
import { readUiLiveContext, decodeUiActivity } from "./enrichment.js";
import { validateV2Ui } from "./v2/validator.js";
import { normalizePointDefinitions } from "./points-schema.js";
import { issueLimit } from "./diagnostics.js";
import type { UiAdvisoryEnvelope, UiAdvisoryIssue, UiFormatSelection } from "./advisory-types.js";

const UI_PATH = "content/index.xml";
export type UiAnalysisOptions = {
  /** Internal default-path evidence only; never accepted from public tool inputs. */
  forceAutoUnselectedReason?: string;
  selection?: UiFormatSelection;
  originalContent?: string;
  automatic?: boolean;
  refresh?: boolean;
  includeLiveValues?: boolean;
  dynamicOptionWarningThreshold?: number;
  maxIssues?: number;
};
const isPolicy = (error: unknown): error is PublicError => error instanceof PublicError && error.code === "POLICY";

/** Existing positional v1 API retained; options are additive in the eighth slot. */
export async function verifyUiFile(
  nodelClient: NodelClient,
  node: string,
  inputPath: string,
  proposedContent: string | undefined,
  includeLiveValues: boolean,
  dynamicOptionWarningThreshold: number,
  maxIssues: number,
  options: UiAnalysisOptions = {},
) {
  if (!/\.(?:html?|xml)$/iu.test(inputPath))
    throw publicError("VALIDATION", "UI validation path must end with .xml or .html.");
  const result = await analyzeUiCandidate(nodelClient, node, inputPath, proposedContent, {
    ...options,
    includeLiveValues,
    dynamicOptionWarningThreshold,
    maxIssues,
  });
  return result;
}

/**
 * Shared read-only advisory analysis for later file lifecycle integration. It never
 * imports recipe write services and never changes candidate bytes.
 */
export async function analyzeUiCandidate(
  client: NodelClient,
  node: string | ResolvedNode,
  inputPath: string,
  candidate?: string | Uint8Array,
  options: UiAnalysisOptions = {},
) {
  const path = assertSafeRecipePath(inputPath);
  const nodeInput = typeof node === "string" ? node : node.input;
  const deadlineMs =
    Date.now() + (options.automatic ? UI_ADVISORY_LIMITS.automaticDeadlineMs : UI_ADVISORY_LIMITS.explicitDeadlineMs);
  const isHtmlOrXml = /\.(?:html?|xml)$/iu.test(path);
  const selection = options.selection ?? "auto";
  const suppliedHash = candidate === undefined ? undefined : createHash("sha256").update(candidate).digest("hex");
  if (!isHtmlOrXml && selection !== "v1" && selection !== "v2" && selection !== "skip")
    return {
      node: nodeInput,
      uiFeedback: skippedEnvelope(
        path,
        "not_ui",
        "File extension is not eligible for automatic UI analysis.",
        suppliedHash,
      ),
    };
  if (selection === "skip")
    return {
      node: nodeInput,
      uiFeedback: skippedEnvelope(path, "unknown", "UI feedback was explicitly skipped.", suppliedHash),
    };

  let resolved: ResolvedNode | undefined = typeof node === "string" ? undefined : node;
  let content: string;
  let bytes: Uint8Array | undefined = typeof candidate === "string" ? Buffer.from(candidate, "utf8") : candidate;
  if (candidate === undefined) {
    try {
      resolved ??= await client.resolveNode(nodeInput, { deadlineMs });
      bytes = await client.getNodeFileBytes(resolved, path, {
        deadlineMs,
        maxResponseBytes: UI_ADVISORY_LIMITS.maxInputBytes,
      });
    } catch (error) {
      if (isPolicy(error)) throw error;
      return {
        node: resolved ?? nodeInput,
        uiFeedback: skippedEnvelope(
          path,
          "unknown",
          "Saved candidate could not be read within the bounded UTF-8 input policy.",
        ),
      };
    }
  }
  const hash = createHash("sha256")
    .update(bytes ?? Buffer.alloc(0))
    .digest("hex");
  if (!bytes || bytes.byteLength > UI_ADVISORY_LIMITS.maxInputBytes)
    return {
      node: resolved ?? nodeInput,
      uiFeedback: skippedEnvelope(path, "unknown", "Candidate exceeds the 2 MiB UTF-8 analysis limit.", hash),
    };
  try {
    // Even string inputs are analysed from the exact encoded bytes being
    // hashed/saved. In particular, a lone UTF-16 surrogate encodes as U+FFFD.
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return {
      node: resolved ?? nodeInput,
      uiFeedback: skippedEnvelope(path, "unknown", "Candidate is not valid UTF-8; bytes were not modified.", hash),
    };
  }
  const recognition = recognizeUi({ path, content, originalContent: options.originalContent, selection });
  // Positive prefix evidence cannot rule out another format in an unanalysed
  // suffix. Only an explicit format may opt into bounded partial validation.
  // Syntax errors alone are not resource truncation: legacy malformed XML must
  // still reach its validator and retain its definite parse errors.
  if (selection === "auto" && (recognition.truncated || options.forceAutoUnselectedReason)) {
    recognition.selectedFormat = undefined;
    recognition.complete = false;
    recognition.truncated = true;
    recognition.errorCountIsLowerBound = true;
    recognition.explanation =
      options.forceAutoUnselectedReason ??
      "Recognition is incomplete (resource-truncated); prefix markers cannot establish an unambiguous format. Choose v1 or v2 explicitly for bounded partial validation.";
  }
  const selected = recognition.selectedFormat;
  if (!selected) {
    const uiFeedback = skippedEnvelope(
      path,
      recognition.kind,
      recognition.explanation ?? "No unambiguous UI format was recognized; use an explicit format to validate.",
      hash,
    );
    uiFeedback.detection = { kind: recognition.kind, basis: recognition.basis, explanation: recognition.explanation };
    uiFeedback.checks.push({
      name: "format-recognition",
      state: recognition.complete ? "skipped" : "truncated",
      reason: recognition.explanation,
    });
    return { node: resolved ?? nodeInput, recognition, uiFeedback };
  }

  const issues: UiAdvisoryIssue[] = recognition.errors.map((error) => ({
    severity: "warning",
    code: error.code,
    message: error.message,
    line: error.line,
    column: error.column,
    location: { line: error.line, column: error.column, startOffset: error.startOffset, endOffset: error.endOffset },
    explanation: `Recognition source: ${error.source ?? "candidate"}.`,
  }));
  const checks: UiAdvisoryEnvelope["checks"] = [
    {
      name: "format-recognition",
      state: recognition.complete ? "completed" : "truncated",
      reason: recognition.explanation,
    },
  ];
  if (recognition.omittedErrors > 0)
    checks.push({
      name: "recognition-diagnostics",
      state: "truncated",
      reason: `${recognition.omittedErrors} parser diagnostics were counted but omitted from the returned issue list.`,
    });
  const limitations = [
    "Static advisory analysis only; markup is not executed and no browser or live equipment action was used.",
  ];
  let capabilities: Record<string, unknown> | undefined;
  let provenance: UiAdvisoryEnvelope["provenance"];
  let validationResult: ReturnType<typeof validateV1Ui> | ReturnType<typeof validateV2Ui> | undefined;
  let liveIncomplete = false;

  if (selected === "v1") {
    const live = await getV1Context(client, nodeInput, resolved, options.includeLiveValues ?? false, deadlineMs);
    resolved = live.node ?? resolved;
    liveIncomplete = live.incomplete;
    checks.push(...live.checks);
    const result = validateV1Ui({
      path,
      content,
      source: candidate === undefined ? "saved" : "provided",
      actions: live.actions,
      signals: live.signals,
      actionsAvailable: live.actionsAvailable,
      signalsAvailable: live.signalsAvailable,
      filePaths: live.filePaths,
      filePathsAvailable: live.filePathsAvailable,
      recipeFiles: live.recipeFiles,
      schemasJson: live.schemasJson,
      schemasAvailable: live.schemasAvailable,
      liveEntries: live.liveEntries,
      dynamicOptionWarningThreshold: options.dynamicOptionWarningThreshold,
      maxIssues: options.maxIssues,
    });
    validationResult = result;
    issues.push(...result.issues);
    if (live.omittedRecipeFiles) {
      liveIncomplete = true;
      checks.push({
        name: "recipe-context",
        state: "truncated",
        reason: `${live.omittedRecipeFiles} recipe files omitted by bounded context limits.`,
      });
    }
    if (options.includeLiveValues) limitations.push("v1 live-value checks were explicitly requested.");
  } else {
    let contract: typeof import("./v2/contract.js").PINNED_V2_CONTRACT;
    let resolutionFailed = false;
    try {
      resolved ??= await client.resolveNode(nodeInput, { deadlineMs });
      const context = await getUiCapabilityContext(client, resolved, path, {
        automatic: options.automatic,
        refresh: options.refresh,
        content,
        deadlineMs,
      });
      capabilities = context.capabilities as unknown as Record<string, unknown>;
      contract = context.contract;
      provenance = context.provenance;
      checks.push({
        name: "deployed-contract",
        state: context.provenance.contractSource === "deployed" ? "completed" : "skipped",
        reason: context.provenance.detectionFailure,
      });
      if (context.provenance.contractSource !== "deployed") liveIncomplete = true;
      checks.push({
        name: "runtime-support",
        state: context.capabilities.state === "available" ? "completed" : "skipped",
        reason:
          context.capabilities.state === "available"
            ? undefined
            : `Deployment support is ${context.capabilities.state}; a usable contract alone does not confirm entry assets.`,
      });
      if (context.capabilities.state !== "available") liveIncomplete = true;
    } catch (error) {
      if (isPolicy(error)) throw error;
      liveIncomplete = true;
      resolutionFailed = !resolved;
      const context = unavailableUiCapabilityContext(
        path,
        error instanceof Error && /timeout/iu.test(error.name) ? "aggregate_timeout" : "resolution_failed",
        { automatic: options.automatic, refresh: options.refresh, content },
      );
      capabilities = context.capabilities as unknown as Record<string, unknown>;
      contract = context.contract;
      provenance = context.provenance;
      checks.push({
        name: "deployed-contract",
        state: "failed",
        reason: "Capability evidence unavailable; the pinned contract is an unverified authoring reference only.",
      });
      checks.push({
        name: "runtime-support",
        state: "skipped",
        reason: "Deployment support is unknown because capability discovery failed.",
      });
    }
    const live = {
      actions: undefined as unknown,
      signals: undefined as unknown,
      actionsAvailable: false,
      signalsAvailable: false,
      filePaths: undefined as string[] | undefined,
      checks: [] as UiAdvisoryEnvelope["checks"],
    };
    try {
      if (resolutionFailed) throw new Error("resolution_unavailable");
      if (!resolved) resolved = await client.resolveNode(nodeInput, { deadlineMs });
      const context = await readUiLiveContext(client, resolved, deadlineMs, false);
      if (context.files.available) live.filePaths = context.files.value;
      if (context.actions.available) {
        live.actionsAvailable = true;
        live.actions = context.actions.value;
      }
      if (context.signals.available) {
        live.signalsAvailable = true;
        live.signals = context.signals.value;
      }
      for (const [name, probe] of [
        ["actions", context.actions],
        ["events", context.signals],
        ["files", context.files],
      ] as const) {
        live.checks.push({
          name,
          state: probe.available ? "completed" : "failed",
          reason: probe.available ? undefined : probe.reason,
        });
        if (!probe.available) liveIncomplete = true;
      }
    } catch (error) {
      if (isPolicy(error)) throw error;
      liveIncomplete = true;
      live.checks.push({
        name: "live-context",
        state: "failed",
        reason: "One or more independent live context probes were unavailable.",
      });
    }
    checks.push(...live.checks);
    const actionDefinitions = live.actionsAvailable ? normalizePointDefinitions(live.actions) : undefined;
    const actionSet = actionDefinitions ? new Set(actionDefinitions.map((point) => point.name)) : undefined;
    const signalDefinitions = live.signalsAvailable ? normalizePointDefinitions(live.signals) : undefined;
    const signalSet = signalDefinitions ? new Set(signalDefinitions.map((point) => point.name)) : undefined;
    validationResult = validateV2Ui({
      path,
      content,
      contract,
      capabilities: capabilities as any,
      actions: actionSet,
      actionDefinitions,
      signalDefinitions,
      signals: signalSet,
      actionsAvailable: live.actionsAvailable,
      signalsAvailable: live.signalsAvailable,
      filePaths: live.filePaths,
      maxIssues: options.maxIssues,
    });
    issues.push(...validationResult.issues);
    checks.push({
      name: "point-schemas",
      state:
        !live.actionsAvailable || !live.signalsAvailable || validationResult.summary.schemaChecksSkipped
          ? "skipped"
          : "completed",
      reason:
        !live.actionsAvailable || !live.signalsAvailable || validationResult.summary.schemaChecksSkipped
          ? "Dynamic, unavailable, ambiguous, or unsupported payload/schema checks remain unknown; only the safe static argument subset was checked."
          : undefined,
    });
    if (validationResult.summary.numericChecksSkipped)
      checks.push({
        name: "numeric-semantics",
        state: "skipped",
        reason: "Component-specific numeric conversion could not be inferred from the contract.",
      });
    if (validationResult.summary.templateChecksSkipped)
      checks.push({
        name: "template-context",
        state: "skipped",
        reason: "One or more clone parent/child checks require an unknown rendered context.",
      });
    if (validationResult.summary.runtimeChecksSkipped)
      checks.push({
        name: "component-runtime-rules",
        state: "skipped",
        reason:
          "Some runtime checks could not be established from the selected contract profile, declared features, or element namespace; no bundled component features were substituted.",
      });
    limitations.push(...validationResult.limitations);
    if (options.includeLiveValues) {
      liveIncomplete = true;
      checks.push({ name: "live-values", state: "skipped", reason: "v2 live-value checks are not implemented." });
    }
  }

  // Validator totals include diagnostics omitted by its bounded collector. Never
  // reconstruct totals from the returned sample (maxIssues may even be zero).
  const errorCount = validationResult?.summary.errorCount ?? 0;
  const omittedHtmlErrors = validationResult && "parse" in validationResult ? validationResult.parse.omittedErrors : 0;
  const warningCount =
    (validationResult?.summary.warningCount ?? 0) + recognition.errors.length + recognition.omittedErrors;
  const infoCount = validationResult?.summary.infoCount ?? 0;
  const maxIssues = issueLimit(options.maxIssues, selected === "v1" ? 1000 : UI_ADVISORY_LIMITS.maxIssues);
  const boundedIssues = issues.slice(0, maxIssues);
  const truncated = issues.length > boundedIssues.length || !!validationResult?.summary.truncatedIssues;
  if (truncated)
    checks.push({
      name: "issue-output",
      state: "truncated",
      reason: `Returned ${boundedIssues.length} of ${errorCount + warningCount + infoCount} observed issues. Counts include omitted diagnostics.`,
    });
  const validationIncomplete =
    validationResult && "incomplete" in validationResult.summary && validationResult.summary.incomplete;
  const parseTruncated =
    validationResult &&
    "parse" in validationResult &&
    (!validationResult.parse.complete || validationResult.summary.countsAreLowerBounds);
  const complete =
    recognition.complete &&
    !liveIncomplete &&
    !validationIncomplete &&
    !truncated &&
    !recognition.omittedErrors &&
    !omittedHtmlErrors;
  const status = errorCount ? "errors" : !complete ? "incomplete" : warningCount ? "warnings" : "passed";
  const uiFeedback: UiAdvisoryEnvelope = {
    advisory: true,
    selectedFormat: selected,
    detection: { kind: recognition.kind, basis: recognition.basis, explanation: recognition.explanation },
    sha256: hash,
    validation: { status, complete, errors: errorCount, warnings: warningCount, info: infoCount },
    checks: [
      ...checks,
      {
        name: "static-validation",
        state: parseTruncated ? "truncated" : "completed",
        reason:
          validationIncomplete && !parseTruncated
            ? "One or more context-dependent static checks or bounded diagnostics remain incomplete."
            : undefined,
      },
    ],
    issues: boundedIssues,
    limitations: [...new Set(limitations)],
    coverage: {
      inputBytes: bytes.byteLength,
      visitedNodes: validationResult?.summary.elementCount,
      truncated: truncated || !!parseTruncated || recognition.truncated,
      countsAreLowerBounds: validationResult?.summary.countsAreLowerBounds ?? false,
    },
    provenance,
    capabilities,
    recommendation:
      selected === "v2"
        ? (capabilities?.recommendation as Record<string, unknown> | undefined)
        : { format: "preserve_v1", reason: "Preserve existing v1 XML; no automatic migration." },
    browserTested: false,
  };
  return {
    node: resolved ?? nodeInput,
    ...validationResult,
    sha256: hash,
    recognition,
    uiFeedback,
  };
}

async function getV1Context(
  client: NodelClient,
  node: string,
  known: Awaited<ReturnType<NodelClient["resolveNode"]>> | undefined,
  includeLiveValues: boolean,
  deadlineMs: number,
) {
  let resolved = known;
  const checks: UiAdvisoryEnvelope["checks"] = [];
  let actions: unknown,
    signals: unknown,
    filePaths: string[] = [],
    recipeFiles: Array<{ path: string; content: string }> = [],
    schemasJson: string | undefined,
    liveEntries: unknown[] | undefined;
  let actionsAvailable = false,
    signalsAvailable = false,
    filePathsAvailable = false,
    schemasAvailable = false,
    incomplete = false,
    omittedRecipeFiles = 0;
  try {
    resolved ??= await client.resolveNode(node, { deadlineMs });
    const context = await readUiLiveContext(client, resolved, deadlineMs);
    if (context.actions.available) {
      actionsAvailable = true;
      actions = context.actions.value;
    }
    if (context.signals.available) {
      signalsAvailable = true;
      signals = context.signals.value;
    }
    if (context.files.available) {
      filePathsAvailable = true;
      filePaths = context.files.value;
    }
    if (context.recipeFiles.available) recipeFiles = context.recipeFiles.value;
    schemasJson = context.schemas.value;
    if (context.schemas.available) {
      schemasAvailable = true;
    }
    omittedRecipeFiles = context.omittedRecipeFiles;
    for (const [name, probe] of [
      ["actions", context.actions],
      ["events", context.signals],
      ["files", context.files],
      ["recipe-context", context.recipeFiles],
      ["schemas", context.schemas],
    ] as const) {
      checks.push({
        name,
        state: probe.available ? "completed" : "failed",
        reason: probe.available ? undefined : probe.reason,
      });
      incomplete ||= !probe.available;
    }
  } catch (error) {
    if (isPolicy(error)) throw error;
    incomplete = true;
    checks.push({
      name: "live-context",
      state: "failed",
      reason: "Live enrichment was unavailable; static validation is retained.",
    });
  }
  if (includeLiveValues && resolved) {
    try {
      const response = await client.nodeRequest<unknown>(resolved, "activity?from=-1", {
        deadlineMs,
        maxResponseBytes: 1024 * 1024,
      });
      liveEntries = decodeUiActivity(response.response);
      checks.push({ name: "live-values", state: "completed" });
    } catch (error) {
      if (isPolicy(error)) throw error;
      incomplete = true;
      checks.push({ name: "live-values", state: "failed", reason: "Activity was unavailable." });
    }
  }
  return {
    node: resolved,
    checks,
    actions,
    signals,
    actionsAvailable,
    signalsAvailable,
    filePaths,
    filePathsAvailable,
    recipeFiles,
    schemasJson,
    schemasAvailable,
    liveEntries,
    incomplete,
    omittedRecipeFiles,
  };
}

function skippedEnvelope(
  path: string,
  kind: UiAdvisoryEnvelope["detection"]["kind"],
  reason: string,
  hash?: string,
): UiAdvisoryEnvelope {
  return {
    advisory: true,
    detection: { kind, basis: [], explanation: reason },
    // No fabricated empty-file digest when a saved candidate could not be read.
    sha256: hash ?? "",
    validation: { status: "not_run", complete: false, errors: 0, warnings: 0, info: 0 },
    checks: [{ name: "format-recognition", state: "skipped", reason }],
    issues: [],
    limitations: ["Static analysis was not run."],
    coverage: { path, candidateHashKnown: hash !== undefined },
    browserTested: false,
  };
}

export { UI_PATH };
