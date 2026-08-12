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
  filePaths: string[];
  recipeFiles?: Array<{ path: string; content: string }>;
  schemasJson?: string;
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
