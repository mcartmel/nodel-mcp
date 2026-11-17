import type { AppConfig } from "../config.js";
import {
  decodeActivity,
  decodeBindings,
  decodeBindingsSchema,
  decodeConsole,
  decodeDefinitions,
  decodeFiles,
  decodeHostStatus,
} from "./contracts/decoders.js";
import { NodelHttpTransport } from "./http/transport.js";
import { BoundedReadLimiter, createReadScope, waitForRead } from "./http/bounded.js";
import { readResolvedStaticAsset, staticAssetUrl } from "./http/staticAssets.js";
import { assertSafeRecipePath } from "./pathPolicy.js";
import {
  isAllowedRuntimeOrigin,
  normalizeRuntimeBaseUrl,
  runtimeNodeBaseUrl,
  runtimeRestUrl,
} from "./resolution/matching.js";
import { NodelResolver } from "./resolution/resolver.js";
import { publicError } from "../shared/publicErrors.js";
import { assertNodeAllowed } from "../safety/policy.js";
import { reduceNodelName } from "../shared/nodelName.js";
import type {
  NodelActivityResponse,
  NodelBindingsResponse,
  NodelBindingsSchemaResponse,
  NodelConsoleResponse,
  BytesNodeRequestOptions,
  EmptyNodeRequestOptions,
  JsonNodeRequestOptions,
  NodelDefinitionsResponse,
  NodelFilesResponse,
  NodelHostStatus,
  NodeRequestOptions,
  ResolvedNode,
  TextNodeRequestOptions,
  NodeReadOptions,
  StaticAsset,
  StaticAssetReadOptions,
  ResolvedStaticAssetRequest,
  StaticAssetReadResult,
} from "./types.js";

export { fetchAndConsumeWithTimeout, fetchWithTimeout } from "./http/transport.js";
export {
  NodelHttpError,
  NodelInvalidJsonError,
  NodelNetworkError,
  NodelNotFoundError,
  NodelRedirectError,
  NodelTimeoutError,
  NodelTransportError,
  NodelResponseTooLargeError,
} from "./http/errors.js";
export { NODEL_STATIC_ASSET_PATHS, NODEL_STATIC_READ_LIMITS } from "./http/staticAssets.js";
export { getVerySimpleName, normalizeRuntimeBaseUrl, runtimeRestUrl } from "./resolution/matching.js";

type NodeReference = string | ResolvedNode;

/** Small application-facing facade over trusted resolution and HTTP transport. */
export class NodelClient {
  private readonly transport: NodelHttpTransport;
  private readonly resolver: NodelResolver;
  private readonly trustedNodes = new WeakSet<ResolvedNode>();
  private readonly staticReads = new BoundedReadLimiter();

  constructor(private readonly config: AppConfig) {
    this.transport = new NodelHttpTransport(config.nodelRequestTimeoutMs);
    this.resolver = new NodelResolver(config, this.transport);
  }

  async getHostStatus(): Promise<NodelHostStatus> {
    return decodeHostStatus(await this.transport.request(runtimeRestUrl(this.config.nodelBaseUrl, "")));
  }

  async getToolkit(): Promise<unknown> {
    return this.transport.request(runtimeRestUrl(this.config.nodelBaseUrl, "Toolkit"));
  }

  listLocalNodes(onlyAllowed: boolean) {
    return this.resolver.listLocalNodes(onlyAllowed);
  }
  listNetworkNodeUrls(filter: string) {
    return this.resolver.listNetworkNodeUrls(filter);
  }
  listNetworkNodeUrlsForNode(name: string) {
    return this.resolver.listNetworkNodeUrlsForNode(name);
  }
  resolveNode(node: string, options?: NodeReadOptions) {
    return this.withReadOptions(options, async (readOptions) => this.resolve(node, readOptions));
  }
  async resolveRemoteNode(node: string) {
    return this.rememberNode(await this.resolver.resolveRemoteNode(node));
  }
  async resolveNodeForDeletion(node: string) {
    return this.rememberNode(await this.resolver.resolveNodeForDeletion(node));
  }

  /** Resolve through trusted discovery, never interpret a caller URL as a fetch target. */
  resolveStaticAssetRequest(
    node: NodeReference,
    artifact: StaticAsset,
    options: StaticAssetReadOptions = {},
  ): Promise<ResolvedStaticAssetRequest> {
    return this.withReadOptions(
      { ...options, timeoutMs: Math.min(options.timeoutMs ?? 10_000, 10_000) },
      async (readOptions) => {
        const resolved = await this.resolve(node, readOptions);
        return Object.freeze({
          node: resolved,
          artifact,
          url: staticAssetUrl(resolved, artifact).toString(),
          deadlineMs: readOptions?.deadlineMs,
        });
      },
    );
  }

  /** Fixed node-root artifacts only. No authored URL or manifest link is ever fetched. */
  readStaticAsset(
    node: NodeReference,
    artifact: StaticAsset,
    options: StaticAssetReadOptions = {},
  ): Promise<StaticAssetReadResult> {
    return this.withReadOptions(
      { ...options, timeoutMs: Math.min(options.timeoutMs ?? 10_000, 10_000) },
      async (readOptions) => {
        return this.staticReads.run(readOptions?.signal, async () => {
          const resolved = await this.resolve(node, readOptions);
          return readResolvedStaticAsset(resolved, artifact, this.config.nodelRequestTimeoutMs, readOptions);
        });
      },
    );
  }

  async getNodeActions(
    node: NodeReference,
    options?: NodeReadOptions,
  ): Promise<{ node: ResolvedNode; actions: NodelDefinitionsResponse }> {
    const result = await this.nodeRequest(node, "actions", options);
    return { node: result.node, actions: decodeDefinitions(result.response) };
  }

  async getNodeSignals(
    node: NodeReference,
    options?: NodeReadOptions,
  ): Promise<{ node: ResolvedNode; signals: NodelDefinitionsResponse }> {
    const result = await this.nodeRequest(node, "events", options);
    return { node: result.node, signals: decodeDefinitions(result.response) };
  }

  async getNodeBindings(
    node: NodeReference,
  ): Promise<{ node: ResolvedNode; schema: NodelBindingsSchemaResponse; bindings: NodelBindingsResponse }> {
    const resolved = await this.resolve(node);
    const [schema, bindings] = await Promise.all([
      this.nodeRequestValue(resolved, "remote/schema"),
      this.nodeRequestValue(resolved, "remote"),
    ]);
    return { node: resolved, schema: decodeBindingsSchema(schema), bindings: decodeBindings(bindings) };
  }

  async getNodeFiles(
    node: NodeReference,
    options?: NodeReadOptions,
  ): Promise<{ node: ResolvedNode; files: NodelFilesResponse }> {
    const result = await this.nodeRequest(node, "files", options);
    return { node: result.node, files: decodeFiles(result.response) };
  }

  async getNodeFileContents(node: NodeReference, path: string, options?: NodeReadOptions): Promise<string> {
    const safePath = assertSafeRecipePath(path);
    return (
      await this.nodeRequest(node, `files/contents?path=${encodeURIComponent(safePath)}`, {
        ...options,
        responseMode: "text",
      })
    ).response;
  }

  async getNodeFileBytes(node: NodeReference, path: string, options?: NodeReadOptions): Promise<Uint8Array> {
    const safePath = assertSafeRecipePath(path);
    return (
      await this.nodeRequest(node, `files/contents?path=${encodeURIComponent(safePath)}`, {
        ...options,
        responseMode: "bytes",
      })
    ).response;
  }

  async getNodeActivity(
    node: NodeReference,
    from: number,
  ): Promise<{ node: ResolvedNode; activity: NodelActivityResponse }> {
    const resolved = await this.resolve(node);
    return { node: resolved, activity: decodeActivity(await this.nodeRequestValue(resolved, `activity?from=${from}`)) };
  }

  async getNodeConsole(
    node: NodeReference,
    from: number,
    max: number,
  ): Promise<{ node: ResolvedNode; console: NodelConsoleResponse }> {
    const resolved = await this.resolve(node);
    return {
      node: resolved,
      console: decodeConsole(await this.nodeRequestValue(resolved, `console?from=${from}&max=${max}`)),
    };
  }

  nodeRequest<T = unknown>(
    node: NodeReference,
    restPath: string,
    options?: JsonNodeRequestOptions,
  ): Promise<{ node: ResolvedNode; response: T | undefined }>;
  nodeRequest(
    node: NodeReference,
    restPath: string,
    options: TextNodeRequestOptions,
  ): Promise<{ node: ResolvedNode; response: string }>;
  nodeRequest(
    node: NodeReference,
    restPath: string,
    options: BytesNodeRequestOptions,
  ): Promise<{ node: ResolvedNode; response: Uint8Array }>;
  nodeRequest(
    node: NodeReference,
    restPath: string,
    options: EmptyNodeRequestOptions,
  ): Promise<{ node: ResolvedNode; response: void }>;
  async nodeRequest(
    node: NodeReference,
    restPath: string,
    options: NodeRequestOptions = {},
  ): Promise<{ node: ResolvedNode; response: unknown }> {
    return this.withReadOptions(options, async (readOptions) => {
      const resolved = await this.resolve(node, readOptions);
      return {
        node: resolved,
        response: await this.nodeRequestValue(resolved, restPath, { ...options, ...readOptions }),
      };
    });
  }

  runtimeRequest<T = unknown>(
    restPath: string,
    options?: JsonNodeRequestOptions,
    runtimeBaseUrl?: string,
  ): Promise<T | undefined>;
  runtimeRequest(restPath: string, options: TextNodeRequestOptions, runtimeBaseUrl?: string): Promise<string>;
  runtimeRequest(restPath: string, options: BytesNodeRequestOptions, runtimeBaseUrl?: string): Promise<Uint8Array>;
  runtimeRequest(restPath: string, options: EmptyNodeRequestOptions, runtimeBaseUrl?: string): Promise<void>;
  async runtimeRequest(restPath: string, options: NodeRequestOptions = {}, runtimeBaseUrl?: string): Promise<unknown> {
    const runtime = runtimeBaseUrl ?? this.config.nodelBaseUrl;
    this.assertRuntimeUrlAllowed(runtime);
    return this.requestValue(runtimeRestUrl(runtime, restPath), options);
  }

  assertRuntimeUrlAllowed(runtimeUrl: string) {
    if (!isAllowedRuntimeOrigin(runtimeUrl, this.config.nodelBaseUrl, this.config.allowedRuntimeOrigins)) {
      throw publicError("POLICY", "Runtime URL origin is not in NODEL_ALLOWED_RUNTIME_ORIGINS.");
    }
  }

  /**
   * Explicit-runtime authority, not discovery: creation readiness must stay on
   * the runtime that accepted the authorized POST even when a local name matches.
   * Only a fixed nodes/<reduced-name>/ namespace is minted, after the same runtime
   * origin and node-prefix policies used by creation. Caller objects still never
   * enter trustedNodes; copies must go back through ordinary trusted discovery.
   */
  createRuntimeNodeReference(runtimeUrl: string, name: string): ResolvedNode {
    const runtime = normalizeRuntimeBaseUrl(runtimeUrl);
    this.assertRuntimeUrlAllowed(runtime);
    assertNodeAllowed(name, this.config.allowedNodePrefixes);
    // Java SimpleName uses Nodel.reduce, not discovery's approximate UI slug.
    // Do not route the original display name: NanoHTTPD decodes percent escapes
    // BEFORE NodelHostHTTPD splits '/', so even an encoded original slash could
    // select a different node/path. Reduce first, then encode exactly one segment.
    const segment = reduceNodelName(name);
    if (!segment) throw publicError("VALIDATION", "Runtime node name must have a non-empty Nodel reduced name.");
    const nodeBaseUrl = runtimeNodeBaseUrl(runtime, segment);
    return this.rememberNode({
      input: nodeBaseUrl,
      scope: runtime === normalizeRuntimeBaseUrl(this.config.nodelBaseUrl) ? "local" : "remote",
      name,
      restPathSegment: segment,
      address: nodeBaseUrl,
      url: nodeBaseUrl,
      nodeBaseUrl,
      allowed: true,
    });
  }

  private async resolve(node: NodeReference, options?: NodeReadOptions) {
    if (typeof node !== "string" && this.trustedNodes.has(node)) return node;
    const input = typeof node === "string" ? node : node.input;
    if (typeof input !== "string") throw publicError("VALIDATION", "Node reference must have a resolution input.");
    if (!options?.signal) return this.rememberNode(await this.resolver.resolveNode(input));
    options.signal.throwIfAborted();
    // Isolate bounded discovery from the legacy resolver without changing its
    // transport/retry/cache defaults. The real discovery requests share the scope's signal.
    const resolver = new NodelResolver(
      this.config,
      new NodelHttpTransport(this.config.nodelRequestTimeoutMs, {
        ...options,
        maxResponseBytes: 2 * 1024 * 1024,
      }),
    );
    return this.rememberNode(await waitForRead(resolver.resolveNode(input), options.signal));
  }
  private rememberNode(node: ResolvedNode) {
    Object.freeze(node);
    this.trustedNodes.add(node);
    return node;
  }
  private async withReadOptions<T>(
    options: NodeReadOptions | undefined,
    consume: (options?: NodeReadOptions) => Promise<T>,
  ): Promise<T> {
    if (
      !options ||
      ![options.signal, options.timeoutMs, options.deadlineMs, options.maxResponseBytes].some(
        (value) => value !== undefined,
      )
    )
      return consume();
    const scope = createReadScope(new URL(this.config.nodelBaseUrl), this.config.nodelRequestTimeoutMs, options);
    try {
      return await consume(scope.options);
    } finally {
      scope.close();
    }
  }
  private nodeRequestValue<T = unknown>(
    node: ResolvedNode,
    restPath: string,
    options?: JsonNodeRequestOptions,
  ): Promise<T | undefined>;
  private nodeRequestValue(node: ResolvedNode, restPath: string, options: TextNodeRequestOptions): Promise<string>;
  private nodeRequestValue(node: ResolvedNode, restPath: string, options: BytesNodeRequestOptions): Promise<Uint8Array>;
  private nodeRequestValue(node: ResolvedNode, restPath: string, options: EmptyNodeRequestOptions): Promise<void>;
  private nodeRequestValue(node: ResolvedNode, restPath: string, options: NodeRequestOptions): Promise<unknown>;
  private nodeRequestValue(node: ResolvedNode, restPath: string, options: NodeRequestOptions = {}) {
    return this.requestValue(new URL(`REST/${restPath}`, ensureTrailingSlash(node.nodeBaseUrl)).toString(), options);
  }

  private requestValue<T = unknown>(url: string, options?: JsonNodeRequestOptions): Promise<T | undefined>;
  private requestValue(url: string, options: TextNodeRequestOptions): Promise<string>;
  private requestValue(url: string, options: BytesNodeRequestOptions): Promise<Uint8Array>;
  private requestValue(url: string, options: EmptyNodeRequestOptions): Promise<void>;
  private requestValue(url: string, options: NodeRequestOptions): Promise<unknown>;
  private requestValue(url: string, options: NodeRequestOptions = {}) {
    const headers = { ...(options.headers ?? {}) };
    let body: RequestInit["body"] | undefined;
    if (options.body !== undefined) {
      if (typeof options.body === "string" || options.body instanceof Uint8Array) body = options.body;
      else {
        headers["content-type"] ??= "application/json";
        body = JSON.stringify(options.body);
      }
    }
    const init = { method: options.method ?? "GET", headers, body };
    const readOptions = {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      deadlineMs: options.deadlineMs,
      maxResponseBytes: options.maxResponseBytes,
    };
    if (options.responseMode === "text") return this.transport.request(url, init, "text", readOptions);
    if (options.responseMode === "bytes") return this.transport.request(url, init, "bytes", readOptions);
    if (options.responseMode === "empty") return this.transport.request(url, init, "empty", readOptions);
    return this.transport.request(url, init, "json", readOptions);
  }
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}
