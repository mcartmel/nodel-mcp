import type { UiValidationIssue } from "./types.js";

export type UiAdvisoryFormat = "v1" | "v2";
export type UiFormatSelection = "auto" | "skip" | UiAdvisoryFormat;
export type UiDetectionKind = "v1" | "v2" | "mixed" | "unknown" | "not_ui";
export type UiDetectionBasis =
  | "canonical_path"
  | "pages_root"
  | "v1_stylesheet"
  | "nodel_element"
  | "v2_runtime_reference"
  | "original_content"
  | "explicit";
export type UiValidationStatus = "passed" | "warnings" | "errors" | "incomplete" | "not_run";
export type UiCheckState = "completed" | "skipped" | "failed" | "truncated";

export type UiAdvisoryLocation = { line?: number; column?: number; startOffset?: number; endOffset?: number };
export type UiAdvisoryIssue = UiValidationIssue & {
  explanation?: string;
  suggestion?: string;
  provenance?: { rule?: string; source?: string; version?: string };
  location?: UiAdvisoryLocation;
};
export type UiAdvisoryCheck = { name: string; state: UiCheckState; reason?: string; visited?: number; limit?: number };

/** Flexible until the later capability/contract stages define their detailed schemas. */
export type UiAdvisoryProvenance = {
  contractSource?: "deployed" | "bundled" | "none" | (string & {});
  schemaVersion?: string | number;
  packageVersion?: string;
  contentHash?: string;
  sourceUrl?: string;
  repositoryRevision?: string;
  retrievedAt?: string;
  cacheAgeMs?: number;
  deploymentApplicable?: boolean | "unknown";
  [key: string]: unknown;
};
export type UiAdvisoryEnvelope = {
  advisory: true;
  selectedFormat?: UiAdvisoryFormat;
  detection: { kind: UiDetectionKind; basis: UiDetectionBasis[]; explanation?: string };
  sha256: string;
  validation: { status: UiValidationStatus; complete: boolean; errors: number; warnings: number; info: number };
  checks: UiAdvisoryCheck[];
  issues: UiAdvisoryIssue[];
  limitations: string[];
  coverage: { visitedNodes?: number; inputBytes?: number; truncated?: boolean; [key: string]: unknown };
  provenance?: UiAdvisoryProvenance;
  capabilities?: Record<string, unknown>;
  recommendation?: Record<string, unknown>;
  browserTested: false;
};
