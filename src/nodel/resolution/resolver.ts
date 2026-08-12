import type { AppConfig } from "../../config.js";
import { assertNodeAllowed, isNodeAllowed } from "../../safety/policy.js";
import { decodeDiscoveredNodes, decodeDiscoveredNodesDetailed, decodeHostStatus } from "../contracts/decoders.js";
import { NodelHttpTransport } from "../http/transport.js";
import type { DiscoveredNode, NormalizedNode, ResolvedNode } from "../types.js";
import {
  bestLocalMatch,
  bestRemoteMatch,
  getVerySimpleName,
  isAllowedRuntimeOrigin,
  isConfiguredLocalRuntime,
  parseNodeUrlInput,
  remoteNodeBaseUrl,
  runtimeNodeBaseUrl,
  runtimeRestUrl,
  sameRuntimeOrigin,
  safeResolutionInput,
} from "./matching.js";
import { PublicError, publicError } from "../../shared/publicErrors.js";

const RETRY_DELAYS_MS = [0, 250, 750] as const;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 256;

type CacheEntry = { candidate: DiscoveredNode; expiresAt: number };

/** Signals the resolver completed discovery without a matching node. */
export class NodeResolutionNotFoundError extends PublicError {
  constructor(input: string) {
    super("VALIDATION", `Node was not found locally or in discovered nodes: ${safeResolutionInput(input)}`);
    this.name = "NodeResolutionNotFoundError";
  }
}

export class NodeResolutionInconclusiveError extends PublicError {
  constructor(input: string) {
    super("VALIDATION", `Node absence could not be conclusively verified: ${safeResolutionInput(input)}`);
    this.name = "NodeResolutionInconclusiveError";
  }
}

/**
 * Discovery addresses are trusted by the configured local Nodel runtime. Deployments
 * should therefore treat that runtime and its discovery network as one trust boundary.
 */
export class NodelResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly config: AppConfig,
    private readonly transport: NodelHttpTransport,
  ) {}

  async listLocalNodes(onlyAllowed: boolean): Promise<NormalizedNode[]> {
    const status = decodeHostStatus(await this.transport.request(runtimeRestUrl(this.config.nodelBaseUrl, "")));
    return Object.entries(status.nodes ?? {})
      .map(([key, entry]) => {
        const name = entry.name || key;
        return {
          key,
          name,
          desc: entry.desc,
          started: entry.started,
          nodelVersion: entry.nodelVersion,
          webSocketPort: entry.webSocketPort,
          url: `/nodes/${encodeURIComponent(getVerySimpleName(name))}`,
          restPathSegment: getVerySimpleName(name),
          allowed: isNodeAllowed(name, this.config.allowedNodePrefixes),
        };
      })
      .filter((node) => !onlyAllowed || node.allowed);
  }

  async listNetworkNodeUrls(filter: string): Promise<DiscoveredNode[]> {
    return decodeDiscoveredNodes(
      await this.transport.request(runtimeRestUrl(this.config.nodelBaseUrl, "nodeURLs"), jsonPost({ filter })),
    );
  }

  async listNetworkNodeUrlsForNode(name: string): Promise<DiscoveredNode[]> {
    return decodeDiscoveredNodes(
      await this.transport.request(runtimeRestUrl(this.config.nodelBaseUrl, "nodeURLsForNode"), jsonPost({ name })),
    );
  }

  async resolveNode(node: string): Promise<ResolvedNode> {
    return this.resolve(node, true);
  }
  async resolveRemoteNode(node: string): Promise<ResolvedNode> {
    return this.resolve(node, false);
  }
  async resolveNodeForDeletion(node: string): Promise<ResolvedNode> {
    return this.resolve(node, true, true);
  }

  private async resolve(inputValue: string, includeLocal: boolean, conclusiveAbsence = false): Promise<ResolvedNode> {
    const input = inputValue.trim();
    if (!input) throw publicError("VALIDATION", "Node is required.");
    const urlInput = parseNodeUrlInput(input);
    for (const delayMs of RETRY_DELAYS_MS) {
      if (delayMs) await delay(delayMs);
      if (includeLocal) {
        const local = await this.resolveLocal(input, urlInput);
        if (local) return local;
      }
      const discovered = await this.discover(input, urlInput);
      const candidate = bestRemoteMatch(discovered.nodes, input, urlInput);
      if (candidate && this.isTrustedUrlMatch(candidate, urlInput))
        return this.toResolved(input, candidate, "discovery");
      if (conclusiveAbsence && discovered.diagnostics.rejectedEntries > 0)
        throw new NodeResolutionInconclusiveError(input);
    }
    const cached = await this.resolveCache(input, urlInput);
    if (cached) return cached;
    throw new NodeResolutionNotFoundError(input);
  }

  private async resolveLocal(input: string, urlInput: ReturnType<typeof parseNodeUrlInput>) {
    const localUrl = new URL(this.config.nodelBaseUrl);
    const localInput =
      urlInput && isConfiguredLocalRuntime(urlInput.url, localUrl)
        ? (urlInput.pathSegment ?? urlInput.queryNode ?? input)
        : input;
    const match = bestLocalMatch(await this.listLocalNodes(false), localInput);
    if (!match) return undefined;
    assertNodeAllowed(match.name, this.config.allowedNodePrefixes);
    const nodeBaseUrl = runtimeNodeBaseUrl(this.config.nodelBaseUrl, match.restPathSegment);
    return {
      input,
      scope: "local" as const,
      key: match.key,
      name: match.name,
      restPathSegment: match.restPathSegment,
      url: nodeBaseUrl,
      nodeBaseUrl,
      allowed: true,
      resolutionSource: "local" as const,
    };
  }

  private async discover(input: string, urlInput: ReturnType<typeof parseNodeUrlInput>) {
    if (urlInput) {
      // Never fetch caller-supplied URLs. Use their node identifiers only against local discovery.
      const names = [
        ...new Set([urlInput.pathSegment, urlInput.queryNode].filter((name): name is string => Boolean(name))),
      ];
      const exact = await Promise.all(names.map((name) => this.discoverForNode(name)));
      const merged = merge(exact.map((entry) => entry.nodes));
      if (merged.length > 0) return { nodes: merged, diagnostics: combineDiagnostics(exact) };
      const all = await this.discoverAll();
      return { nodes: all.nodes, diagnostics: combineDiagnostics([...exact, all]) };
    }
    const targeted = await this.discoverFiltered(input);
    if (targeted.nodes.length > 0) return targeted;
    const all = await this.discoverAll();
    return { nodes: all.nodes, diagnostics: combineDiagnostics([targeted, all]) };
  }

  private async discoverFiltered(filter: string) {
    return decodeDiscoveredNodesDetailed(
      await this.transport.request(runtimeRestUrl(this.config.nodelBaseUrl, "nodeURLs"), jsonPost({ filter })),
    );
  }
  private async discoverForNode(name: string) {
    return decodeDiscoveredNodesDetailed(
      await this.transport.request(runtimeRestUrl(this.config.nodelBaseUrl, "nodeURLsForNode"), jsonPost({ name })),
    );
  }
  private async discoverAll() {
    return this.discoverFiltered("");
  }

  private isTrustedUrlMatch(candidate: DiscoveredNode, urlInput: ReturnType<typeof parseNodeUrlInput>) {
    if (!urlInput) return true;
    const candidateUrl = new URL(candidate.address);
    return (
      sameRuntimeOrigin(candidateUrl, urlInput.url) ||
      isAllowedRuntimeOrigin(urlInput.url.toString(), this.config.nodelBaseUrl, this.config.allowedRuntimeOrigins ?? [])
    );
  }

  private toResolved(input: string, candidate: DiscoveredNode, source: "discovery" | "cache"): ResolvedNode {
    assertNodeAllowed(candidate.name, this.config.allowedNodePrefixes);
    const resolved = {
      input,
      scope: "remote" as const,
      name: candidate.name,
      restPathSegment: candidate.restPathSegment,
      address: candidate.address,
      url: remoteNodeBaseUrl(candidate),
      nodeBaseUrl: remoteNodeBaseUrl(candidate),
      allowed: true,
      resolutionSource: source,
    };
    if (source === "discovery") this.remember(input, candidate);
    return resolved;
  }

  private remember(input: string, candidate: DiscoveredNode) {
    const key = cacheKey(input);
    this.cache.delete(key);
    this.cache.set(key, { candidate, expiresAt: Date.now() + CACHE_TTL_MS });
    while (this.cache.size > CACHE_MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
  }

  private async resolveCache(input: string, urlInput: ReturnType<typeof parseNodeUrlInput>) {
    const entry = this.cache.get(cacheKey(input));
    if (!entry || entry.expiresAt <= Date.now() || !this.isTrustedUrlMatch(entry.candidate, urlInput)) return undefined;
    try {
      const metadata = await this.transport.request(
        new URL("REST", ensureTrailingSlash(remoteNodeBaseUrl(entry.candidate))),
      );
      if (
        typeof metadata !== "object" ||
        metadata === null ||
        (metadata as Record<string, unknown>).name !== entry.candidate.name
      )
        return undefined;
      return this.toResolved(input, entry.candidate, "cache");
    } catch {
      return undefined;
    }
  }
}

function jsonPost(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
function merge(groups: DiscoveredNode[][]) {
  return [...new Map(groups.flat().map((node) => [`${node.name}\u0000${node.address}`, node])).values()];
}
function combineDiagnostics(entries: Array<{ diagnostics: { rejectedEntries: number; reasons: string[] } }>) {
  return {
    rejectedEntries: entries.reduce((total, entry) => total + entry.diagnostics.rejectedEntries, 0),
    reasons: [...new Set(entries.flatMap((entry) => entry.diagnostics.reasons))],
  };
}
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function cacheKey(input: string) {
  return input.trim().toLocaleLowerCase();
}
function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}
