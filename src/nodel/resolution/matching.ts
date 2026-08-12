import type { DiscoveredNode, NormalizedNode } from "../types.js";

export type NodeUrlInput = { original: string; url: URL; pathSegment?: string; queryNode?: string };

export function getVerySimpleName(name: string) {
  const prefix = /^(.+?)(?:\(| \(|$)/iu.exec(name)?.[1] ?? name;
  return prefix.replace(/[^\p{L}\p{N}]/giu, "");
}

export function parseNodeUrlInput(input: string): NodeUrlInput | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (!isHttpUrl(url) || url.username || url.password) return undefined;
  const match = /(?:^|\/)nodes\/([^/]+)/u.exec(url.pathname);
  const pathSegment = match?.[1] ? safeDecodeURIComponent(match[1]) : undefined;
  const queryNode = nonEmptyString(url.searchParams.get("node"));
  return pathSegment || queryNode ? { original: input, url, pathSegment, queryNode } : undefined;
}

export function bestLocalMatch(nodes: NormalizedNode[], input: string): NormalizedNode | undefined {
  const matches = nodes.map((node) => ({ node, score: localScore(node, input) })).filter((entry) => entry.score > 0);
  return uniqueBest(matches, input, "local")?.node;
}

export function bestRemoteMatch(
  candidates: DiscoveredNode[],
  input: string,
  urlInput?: NodeUrlInput,
): DiscoveredNode | undefined {
  const simple = getVerySimpleName(input);
  const matches = candidates
    .map((candidate) => ({ candidate, score: remoteScore(candidate, input, simple, urlInput) }))
    .filter((entry) => entry.score > 0);
  return uniqueBest(matches, input, "discovered")?.candidate;
}

export function remoteNodeBaseUrl(candidate: DiscoveredNode) {
  const address = new URL(candidate.address);
  address.search = "";
  address.hash = "";
  if (!address.pathname.includes("/nodes/")) {
    address.pathname = `/nodes/${encodeURIComponent(candidate.restPathSegment ?? getVerySimpleName(candidate.name))}/`;
  } else if (!address.pathname.endsWith("/")) {
    address.pathname += "/";
  }
  return address.toString();
}

export function sameRuntimeOrigin(left: URL, right: URL) {
  return (
    left.protocol === right.protocol &&
    normalizeText(left.hostname) === normalizeText(right.hostname) &&
    left.port === right.port
  );
}

export function isConfiguredLocalRuntime(left: URL, configuredRuntime: URL) {
  return (
    sameRuntimeOrigin(left, configuredRuntime) ||
    (left.protocol === configuredRuntime.protocol &&
      left.port === configuredRuntime.port &&
      isLoopback(left.hostname) &&
      isLoopback(configuredRuntime.hostname))
  );
}

export function normalizeRuntimeBaseUrl(input: string) {
  const url = new URL(input);
  if (!isHttpUrl(url)) throw publicError("VALIDATION", "Runtime URL must use http or https.");
  if (url.username || url.password)
    throw publicError("VALIDATION", "Runtime URL must not include embedded credentials.");
  url.search = "";
  url.hash = "";
  if (/\/REST\/?$/u.test(url.pathname)) url.pathname = url.pathname.replace(/\/REST\/?$/u, "/");
  return url.toString().replace(/\/+$/u, "");
}

export function runtimeRestUrl(runtimeBaseUrl: string, restPath: string) {
  return new URL(restPath ? `REST/${restPath}` : "REST", `${normalizeRuntimeBaseUrl(runtimeBaseUrl)}/`).toString();
}

export function runtimeNodeBaseUrl(runtimeBaseUrl: string, restPathSegment: string) {
  return new URL(
    `nodes/${encodeURIComponent(restPathSegment)}/`,
    `${normalizeRuntimeBaseUrl(runtimeBaseUrl)}/`,
  ).toString();
}

export function isAllowedRuntimeOrigin(runtimeUrl: string, configuredBaseUrl: string, allowedOrigins: string[]) {
  const origin = new URL(normalizeRuntimeBaseUrl(runtimeUrl)).origin;
  return origin === new URL(normalizeRuntimeBaseUrl(configuredBaseUrl)).origin || allowedOrigins.includes(origin);
}

export function safeResolutionInput(input: string) {
  try {
    const url = new URL(input);
    return `${url.origin}${url.pathname}`;
  } catch {
    return input.slice(0, 200);
  }
}

function localScore(node: NormalizedNode, input: string) {
  const simple = getVerySimpleName(input);
  if ([node.name, node.key, node.restPathSegment].includes(input) || node.restPathSegment === simple) return 100;
  if ([node.name, node.key, node.restPathSegment].some((value) => sameText(value, input))) return 90;
  if (sameText(getVerySimpleName(node.name), simple)) return 80;
  if ([node.name, node.key, node.restPathSegment].some((value) => containsText(value, input))) return 50;
  return 0;
}

function remoteScore(candidate: DiscoveredNode, input: string, simple: string, urlInput?: NodeUrlInput) {
  if (urlInput) {
    const candidateUrl = new URL(candidate.address);
    if (
      sameRuntimeOrigin(candidateUrl, urlInput.url) &&
      (sameText(candidate.restPathSegment, urlInput.pathSegment) || sameText(candidate.name, urlInput.queryNode))
    )
      return 100;
    return 0;
  }
  if (candidate.name === input || candidate.address === input) return 100;
  if (candidate.restPathSegment === input) return 90;
  if (sameText(candidate.name, input) || sameText(candidate.address, input)) return 80;
  if (sameText(getVerySimpleName(candidate.name), simple)) return 70;
  if (containsText(candidate.name, input)) return 50;
  return 0;
}

function uniqueBest<T extends { score: number }>(matches: T[], input: string, scope: string): T | undefined {
  const bestScore = Math.max(0, ...matches.map((match) => match.score));
  if (bestScore === 0) return undefined;
  const best = matches.filter((match) => match.score === bestScore);
  if (best.length !== 1)
    throw publicError("VALIDATION", `Node name is ambiguous in ${scope} discovery: ${safeResolutionInput(input)}`);
  return best[0];
}

function isHttpUrl(url: URL) {
  return url.protocol === "http:" || url.protocol === "https:";
}
function isLoopback(hostname: string) {
  const normalized = hostname.toLocaleLowerCase();
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}
function nonEmptyString(value: string | null) {
  return value && value.length > 0 ? value : undefined;
}
function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function normalizeText(value: string | undefined) {
  return (value ?? "").trim().toLocaleLowerCase();
}
function sameText(left: string | undefined, right: string | undefined) {
  return normalizeText(left) === normalizeText(right);
}
function containsText(value: string | undefined, input: string) {
  return input.length > 0 && normalizeText(value).includes(normalizeText(input));
}
import { publicError } from "../../shared/publicErrors.js";
