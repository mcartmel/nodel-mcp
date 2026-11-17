import type { NodelClient } from "../../nodel/client.js";
import type { StaticAsset, StaticAssetReadResult } from "../../nodel/types.js";
import type { V2Contract } from "./v2/contract.js";

export type UiCapabilityClient = Pick<NodelClient, "resolveStaticAssetRequest" | "readStaticAsset">;
export type UiCapabilityOptions = {
  refresh?: boolean;
  automatic?: boolean;
  signal?: AbortSignal;
  /** Absolute Date.now() deadline, shared with other advisory enrichment. */
  deadlineMs?: number;
  /** Proposed page contents, inspected locally only. The saved page need not exist. */
  content?: string;
};
export type UiCapabilityState = "available" | "not_detected" | "incomplete" | "incompatible_contract" | "unknown";
export type UiAssetEvidence = {
  artifact: StaticAsset;
  outcome: StaticAssetReadResult["outcome"] | "not_run";
  url?: string;
  finalUrl?: string;
  status?: number;
  mimeType?: string;
  bytesRead: number;
  bodyComplete: boolean;
  retrievedAt?: string;
  durationMs?: number;
  contentHash?: string;
  reason?: string;
};
export type UiContractEvidence = {
  state: "supported" | "unsupported_schema" | "invalid" | "unavailable";
  schemaVersion?: string | number;
  packageVersion?: string;
  contentHash?: string;
  diagnostics: string[];
  limitations: string[];
};
export type UiContractProvenance = {
  contractSource: "deployed" | "bundled";
  schemaVersion: number;
  packageVersion: string;
  contentHash: string;
  sourceUrl?: string;
  repository?: string;
  repositoryRevision?: string;
  license?: string;
  retrievedAt?: string;
  cacheAgeMs: number;
  deploymentApplicable: boolean;
  compatibility: "supported-contract" | "unverified";
  detectionFailure?: string;
};
export type UiRuntimeReference = {
  artifact: "script" | "stylesheet";
  /** Sanitized diagnostic, not a fetch target. */
  reference: string;
  resolvedUrl?: string;
  state: "matches_node_root" | "different_path" | "unchecked";
  reason?: string;
};
export type UiPageRuntimeContext = {
  storagePath: string;
  browserUrl?: string;
  baseUrl?: string;
  state: "not_inspected" | "matches_node_root" | "mismatched" | "unchecked" | "incomplete";
  apiResolution: "node_root" | "different_path" | "external" | "unchecked";
  references: UiRuntimeReference[];
  limitations: string[];
};
export type UiCapabilities = {
  advisory: true;
  target?: { name: string; nodeBaseUrl: string };
  state: UiCapabilityState;
  assets: Record<StaticAsset, UiAssetEvidence>;
  deployedContract: UiContractEvidence;
  contract: UiContractProvenance;
  page: UiPageRuntimeContext;
  recommendation: { format: "v2" | "preserve_v1" | "undetermined"; scope: "node_root"; reason: string };
  cache: { hit: boolean; deduplicated: boolean; ageMs: number; ttlMs: number; refresh: boolean };
  resolution?: { state: "failed"; reason: string };
  limitations: string[];
  browserTested: false;
};
export type UiCapabilityContext = {
  capabilities: UiCapabilities;
  /** Internal authority for validators/reference tools. Deeply frozen; never merge with fallback. */
  contract: V2Contract;
  provenance: UiContractProvenance;
};
