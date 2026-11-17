export type NodelHostStatus = {
  started?: string | number | boolean;
  nodes?: Record<string, NodelNodeEntry>;
  raw?: Record<string, unknown>;
};

export type NodelNodeEntry = {
  name: string;
  desc?: string;
  started?: string | number | boolean;
  nodelVersion?: string;
  webSocketPort?: number;
  raw?: Record<string, unknown>;
};

export type NormalizedNode = {
  key: string;
  name: string;
  desc?: string;
  started?: unknown;
  nodelVersion?: string;
  webSocketPort?: number;
  url: string;
  restPathSegment: string;
  allowed: boolean;
};

export type DiscoveredNode = {
  name: string;
  address: string;
  restPathSegment?: string;
};

export type DiscoveryDiagnostics = {
  rejectedEntries: number;
  reasons: string[];
};

export type NetworkNodeUrlsResponse = DiscoveredNode[];

export type ResolvedNode = {
  input: string;
  scope: "local" | "remote";
  key?: string;
  name: string;
  restPathSegment?: string;
  address?: string;
  url: string;
  nodeBaseUrl: string;
  allowed: boolean;
  resolutionSource?: "local" | "discovery" | "cache";
};

export type NodelDefinition = Record<string, unknown>;
export type NodelDefinitionsResponse = NodelDefinition[] | Record<string, NodelDefinition>;
export type NodelFilesResponse = Array<string | Record<string, unknown>> | Record<string, unknown>;
export type NodelBindingsSchemaResponse = Record<string, unknown>;
export type NodelBindingsResponse = Record<string, unknown>;
export type NodelActivityResponse = unknown[] | Record<string, unknown>;
export type NodelConsoleResponse = string | unknown[] | Record<string, unknown>;

export type NodelHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Opt-in bounds for read-only enrichment. deadlineMs is an absolute Date.now() deadline. */
export type NodeReadOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  deadlineMs?: number;
  maxResponseBytes?: number;
};

export type StaticAsset = "contract" | "script" | "stylesheet";
export type StaticAssetReadOptions = Omit<NodeReadOptions, "maxResponseBytes">;
export type ResolvedStaticAssetRequest = {
  node: ResolvedNode;
  artifact: StaticAsset;
  url: string;
  /** Effective aggregate deadline, including the client's configured lower request timeout. */
  deadlineMs?: number;
};
export type StaticAssetReadResult = ResolvedStaticAssetRequest & {
  outcome:
    | "observed"
    | "http_error"
    | "unexpected_content"
    | "too_large"
    | "timeout"
    | "aborted"
    | "redirect_rejected"
    | "network_error";
  status?: number;
  mimeType?: string;
  finalUrl: string;
  retrievedAt: string;
  durationMs: number;
  bytesRead: number;
  bodyComplete: boolean;
  /** Only MIME-qualified successful content; never an HTTP error/login response body. */
  content?: string;
  /** SHA-256 of the exact fully-read contract bytes, before UTF-8 decoding. */
  contentSha256?: string;
  /** JS/CSS evidence only. This is a bounded sample, never executed or imported. */
  sample?: string;
};

type NodeRequestBase = NodeReadOptions & {
  method?: NodelHttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
};

export type JsonNodeRequestOptions = NodeRequestBase & { responseMode?: "json" };
export type TextNodeRequestOptions = NodeRequestBase & { responseMode: "text" };
export type BytesNodeRequestOptions = NodeRequestBase & { responseMode: "bytes" };
export type EmptyNodeRequestOptions = NodeRequestBase & { responseMode: "empty" };
export type NodeRequestOptions =
  | JsonNodeRequestOptions
  | TextNodeRequestOptions
  | BytesNodeRequestOptions
  | EmptyNodeRequestOptions;
