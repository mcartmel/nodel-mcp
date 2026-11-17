import { TextDecoder } from "node:util";
import type { NodelClient } from "../../nodel/client.js";
import type { ResolvedNode } from "../../nodel/types.js";
import { sha256 } from "../../shared/canonicalJson.js";
import type { UiAdvisoryEnvelope, UiFormatSelection } from "../ui/advisory-types.js";
import { UI_ADVISORY_LIMITS } from "../ui/limits.js";
import { recognizeUi } from "../ui/recognition.js";
import { analyzeUiCandidate } from "../ui/service.js";

/** Selection is deliberately separate from every mutation/approval plan. */
export type UiFeedbackSelection = UiFormatSelection;

export function mayAnalyzeFileUi(path: string, selection: UiFeedbackSelection) {
  return selection === "v1" || selection === "v2" || /\.(?:html?|xml)$/iu.test(path);
}

function decodeEvidence(bytes: Uint8Array | undefined) {
  if (!bytes || bytes.byteLength > UI_ADVISORY_LIMITS.maxInputBytes || bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * The only best-effort boundary in the supporting-file lifecycle. Call AFTER
 * the core operation and its lock have returned. Core policy, approvals, save
 * and read-back never run in this catch. All reads use the analyzer's aggregate
 * 3s deadline (and transport cancellation), not a detached timeout race.
 */
export async function fileUiFeedback(
  client: NodelClient,
  trustedResolvedNode: ResolvedNode,
  path: string,
  candidate: Uint8Array,
  original: Uint8Array | undefined,
  selection: UiFeedbackSelection = "auto",
): Promise<{ uiFeedback?: UiAdvisoryEnvelope }> {
  if (!mayAnalyzeFileUi(path, selection)) return {};
  try {
    const originalContent = decodeEvidence(original);
    let feedback: UiAdvisoryEnvelope;
    if (original !== undefined && originalContent === undefined) {
      // Unavailable original evidence is uncertainty, never proof that a plain
      // replacement is unrelated. Do not start live probes on this path, even
      // for explicit formats; retain exact source/candidate hashes below.
      feedback = unavailableFeedback(
        candidate,
        selection === "skip"
          ? "UI feedback was explicitly skipped; original format classification is unavailable."
          : "UI analysis was not run because original format classification is unavailable.",
      );
    } else if (
      selection !== "skip" &&
      candidate.byteLength <= UI_ADVISORY_LIMITS.maxInputBytes &&
      candidate.includes(0)
    ) {
      // Valid UTF-8 can still be binary (including UTF-16-looking markup).
      // Never feed NUL-bearing file bytes to the markup validators or repair them.
      feedback = unavailableFeedback(
        candidate,
        "Candidate contains binary NUL bytes; UTF-8 UI analysis was not run and bytes were not modified.",
      );
    } else if (selection === "skip") {
      const content = decodeEvidence(candidate);
      const recognition = recognizeUi({ path, content, originalContent });
      if (recognition.kind === "unknown" && !recognition.truncated && content !== undefined) return {};
      feedback = unavailableFeedback(candidate, "UI feedback was explicitly skipped.");
      feedback.detection = {
        kind: recognition.kind,
        basis: recognition.basis,
        explanation: "UI feedback was explicitly skipped.",
      };
    } else {
      const result = await analyzeUiCandidate(client, trustedResolvedNode, path, candidate, {
        selection,
        automatic: true,
        originalContent,
        maxIssues: UI_ADVISORY_LIMITS.maxIssues,
      });
      // Unmarked HTML/XML is unrelated, even when an ordinary XML support file
      // has a syntax error. Resource truncation is different: it cannot rule
      // out UI markers in an unanalysed suffix and retains not_run advice.
      if (selection === "auto" && result.recognition?.kind === "unknown" && !result.recognition.truncated) return {};
      feedback = result.uiFeedback;
    }
    feedback.coverage = {
      ...feedback.coverage,
      originalPresent: original !== undefined,
      originalSha256: original === undefined ? undefined : sha256(original),
      originalClassificationAvailable: original === undefined || originalContent !== undefined,
    };
    if (original !== undefined && originalContent === undefined) {
      feedback.checks.push({
        name: "original-classification",
        state: "skipped",
        reason:
          "Original bytes exceed the UTF-8 analysis policy or cannot be decoded; original format evidence is unavailable.",
      });
      feedback.validation.complete = false;
      if (feedback.validation.status === "passed" || feedback.validation.status === "warnings")
        feedback.validation.status = "incomplete";
    }
    return { uiFeedback: feedback };
  } catch {
    // Never include exception text, remote response bodies, credentials or
    // caller-controlled diagnostics. Even advisory POLICY failures cannot undo
    // an already-authorized write; core POLICY failures never reach this catch.
    const feedback = unavailableFeedback(
      candidate,
      "UI advisory analysis was unavailable; write authorization and byte verification are unchanged.",
    );
    feedback.coverage = {
      originalPresent: original !== undefined,
      originalSha256: original === undefined ? undefined : sha256(original),
    };
    return { uiFeedback: feedback };
  }
}

function unavailableFeedback(candidate: Uint8Array, reason: string): UiAdvisoryEnvelope {
  return {
    advisory: true,
    detection: { kind: "unknown", basis: [], explanation: reason },
    sha256: sha256(candidate),
    validation: { status: "not_run", complete: false, errors: 0, warnings: 0, info: 0 },
    checks: [{ name: "ui-advisory", state: "skipped", reason }],
    issues: [],
    limitations: ["Static advisory analysis only; byte read-back is not UI or browser verification."],
    coverage: { inputBytes: candidate.byteLength, candidateHashKnown: true },
    browserTested: false,
  };
}
