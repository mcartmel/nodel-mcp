export type UiIssueSeverity = "error" | "warning" | "info";
export type UiValidationIssue = {
  severity: UiIssueSeverity;
  code: string;
  message: string;
  element?: string;
  attribute?: string;
  line?: number;
  column?: number;
  parserSpecific?: boolean;
  explanation?: string;
  suggestion?: string;
  provenance?: { rule?: string; source?: string; version?: string };
  location?: { line?: number; column?: number; startOffset?: number; endOffset?: number };
};
export type UiPointReference = {
  kind: "action" | "event";
  name: string;
  attribute: string;
  element: string;
  line: number;
  column: number;
  derived: boolean;
};
export type UiAssetReference = {
  element: string;
  attribute: string;
  value: string;
  normalizedPath?: string;
  external: boolean;
  builtIn: boolean;
  exists?: boolean;
  line: number;
  column: number;
};
export type UiValidationInput = {
  path: string;
  content: string;
  source: "saved" | "provided";
  actions: unknown;
  signals: unknown;
  /** Failed or omitted probes are unknown, not an empty point catalogue. */
  actionsAvailable?: boolean;
  signalsAvailable?: boolean;
  filePaths: string[];
  filePathsAvailable?: boolean;
  recipeFiles?: Array<{ path: string; content: string }>;
  schemasJson?: string;
  /** False means schema-dependent Frontend checks must not assume an empty schema file. */
  schemasAvailable?: boolean;
  liveEntries?: unknown[];
  dynamicOptionWarningThreshold?: number;
  maxIssues?: number;
};
export type PointDefinition = { name: string; schema?: unknown };
export type FrontendSchemaOverride = {
  name: string;
  roles: Set<"action" | "event">;
  differences: Set<string>;
  origins: Set<string>;
  element: string;
  line: number;
  column: number;
};
