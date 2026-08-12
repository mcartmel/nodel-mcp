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
import { assertSafeRecipePath } from "./pathPolicy.js";
import { isAllowedRuntimeOrigin, runtimeRestUrl } from "./resolution/matching.js";
import { NodelResolver } from "./resolution/resolver.js";
import { publicError } from "../shared/publicErrors.js";
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
} from "./http/errors.js";
export { getVerySimpleName, normalizeRuntimeBaseUrl, runtimeRestUrl } from "./resolution/matching.js";

type NodeReference = string | ResolvedNode;

/** Small application-facing facade over trusted resolution and HTTP transport. */
export class NodelClient {
  private readonly transport: NodelHttpTransport;
  private readonly resolver: NodelResolver;

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
  resolveNode(node: string) {
    return this.resolver.resolveNode(node);
  }
  resolveRemoteNode(node: string) {
    return this.resolver.resolveRemoteNode(node);
  }
  resolveNodeForDeletion(node: string) {
    return this.resolver.resolveNodeForDeletion(node);
  }

  async getNodeActions(node: NodeReference): Promise<{ node: ResolvedNode; actions: NodelDefinitionsResponse }> {
    const resolved = await this.resolve(node);
    return { node: resolved, actions: decodeDefinitions(await this.nodeRequestValue(resolved, "actions")) };
  }

  async getNodeSignals(node: NodeReference): Promise<{ node: ResolvedNode; signals: NodelDefinitionsResponse }> {
    const resolved = await this.resolve(node);
    return { node: resolved, signals: decodeDefinitions(await this.nodeRequestValue(resolved, "events")) };
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

  async getNodeFiles(node: NodeReference): Promise<{ node: ResolvedNode; files: NodelFilesResponse }> {
    const resolved = await this.resolve(node);
    return { node: resolved, files: decodeFiles(await this.nodeRequestValue(resolved, "files")) };
  }

  async getNodeFileContents(node: NodeReference, path: string): Promise<string> {
    const resolved = await this.resolve(node);
    const safePath = assertSafeRecipePath(path);
    return this.nodeRequestValue(resolved, `files/contents?path=${encodeURIComponent(safePath)}`, {
      responseMode: "text",
    });
  }

  async getNodeFileBytes(node: NodeReference, path: string): Promise<Uint8Array> {
    const resolved = await this.resolve(node);
    const safePath = assertSafeRecipePath(path);
    return this.nodeRequestValue(resolved, `files/contents?path=${encodeURIComponent(safePath)}`, {
      responseMode: "bytes",
    });
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
    const resolved = await this.resolve(node);
    return { node: resolved, response: await this.nodeRequestValue(resolved, restPath, options) };
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

  private resolve(node: NodeReference) {
    return typeof node === "string" ? this.resolveNode(node) : Promise.resolve(node);
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
    if (options.responseMode === "text") return this.transport.request(url, init, "text");
    if (options.responseMode === "bytes") return this.transport.request(url, init, "bytes");
    if (options.responseMode === "empty") return this.transport.request(url, init, "empty");
    return this.transport.request(url, init, "json");
  }
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}
