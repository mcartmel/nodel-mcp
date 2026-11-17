import type { ResolvedNode, StaticAsset, StaticAssetReadOptions, StaticAssetReadResult } from "../types.js";
import { createHash } from "node:crypto";
import { readBoundedBody, readTimeoutMs } from "./bounded.js";
import { NodelRedirectError, NodelTimeoutError, NodelTransportError } from "./errors.js";
import { fetchAndConsumeWithTimeout } from "./transport.js";
import { hasStaticEntryEvidence } from "./staticContentEvidence.js";

export const NODEL_STATIC_ASSET_PATHS = Object.freeze({
  contract: "v2/nodel-components.json",
  script: "v2/nodel-webui.js",
  stylesheet: "v2/nodel-webui.css",
} as const);
export const NODEL_STATIC_READ_LIMITS = Object.freeze({ contractBytes: 2 * 1024 * 1024, sampleBytes: 4096 });

/** Internal URL builder. The application facade must authorize/mint the node first. */
export function staticAssetUrl(node: ResolvedNode, artifact: StaticAsset): URL {
  if (!Object.hasOwn(NODEL_STATIC_ASSET_PATHS, artifact)) throw new TypeError("Unknown static artifact.");
  const root = new URL(node.nodeBaseUrl);
  if (
    !["http:", "https:"].includes(root.protocol) ||
    root.username ||
    root.password ||
    root.search ||
    root.hash ||
    /[?#\\\s]/u.test(node.nodeBaseUrl) ||
    !/\/nodes\/[^/]+\/?$/u.test(root.pathname) ||
    !safePath(root.pathname)
  )
    throw new NodelRedirectError(root, "Static reads require a credential-free resolved node namespace.");
  if (!root.pathname.endsWith("/")) root.pathname += "/";
  return new URL(NODEL_STATIC_ASSET_PATHS[artifact], root);
}

/** Internal bounded reader; only NodelClient accepts application-supplied node references. */
export async function readResolvedStaticAsset(
  node: ResolvedNode,
  artifact: StaticAsset,
  configuredTimeoutMs: number,
  options: StaticAssetReadOptions = {},
): Promise<StaticAssetReadResult> {
  const url = staticAssetUrl(node, artifact);
  const started = Date.now();
  const result: StaticAssetReadResult = {
    node,
    artifact,
    url: url.toString(),
    finalUrl: url.toString(),
    retrievedAt: new Date(started).toISOString(),
    durationMs: 0,
    outcome: "network_error",
    bytesRead: 0,
    bodyComplete: false,
  };
  try {
    const timeoutMs = readTimeoutMs(configuredTimeoutMs, options);
    if (timeoutMs <= 0) {
      result.outcome = "timeout";
      return result;
    }
    await fetchAndConsumeWithTimeout(
      url,
      { method: "GET", signal: options.signal, credentials: "omit", headers: { accept: expectedAccept(artifact) } },
      timeoutMs,
      "Nodel static asset",
      async (response, responseUrl, signal) => {
        result.finalUrl = responseUrl.toString();
        result.status = response.status;
        result.mimeType = mimeType(response.headers.get("content-type"));
        if (!response.ok) {
          result.outcome = "http_error";
          return;
        }
        if (!expectedMime(artifact, result.mimeType)) {
          result.outcome = "unexpected_content";
          return;
        }
        const body = await readBoundedBody(
          response,
          responseUrl,
          artifact === "contract" ? NODEL_STATIC_READ_LIMITS.contractBytes : NODEL_STATIC_READ_LIMITS.sampleBytes,
          artifact !== "contract",
          signal,
        );
        result.bytesRead = body.bytes.byteLength;
        result.bodyComplete = body.complete;
        let text: string;
        try {
          // Preserve BOM for exact-byte consumers; a prefix may end inside a UTF-8 sequence.
          text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body.bytes, {
            stream: !body.complete,
          });
        } catch {
          result.outcome = "unexpected_content";
          return;
        }
        // Even a correctly labelled response may be a proxy/login page. Never expose that body.
        if (!text.trim() || /^\s*</u.test(text) || text.includes("\u0000")) {
          result.outcome = "unexpected_content";
          return;
        }
        if (artifact !== "contract" && !hasStaticEntryEvidence(artifact, text, body.complete)) {
          result.outcome = "unexpected_content";
          return;
        }
        result.outcome = "observed";
        if (artifact === "contract") {
          result.content = text;
          result.contentSha256 = createHash("sha256").update(body.bytes).digest("hex");
        } else result.sample = text;
      },
      {
        cancelBody: true,
        validateRedirect(location, from, next) {
          // Check lexical form before URL normalization erases dot-segments/encoded traversal.
          if (
            /[?#\\\s]/u.test(location) ||
            !safePath(locationPath(location)) ||
            next.origin !== url.origin ||
            next.username ||
            next.password ||
            next.search ||
            next.hash ||
            next.pathname !== url.pathname
          )
            throw new NodelRedirectError(from, "Redirect is outside the approved static artifact path.");
        },
      },
    );
  } catch (error) {
    // Deliberately return no server text, arbitrary exception message, or redirect destination.
    if (options.signal?.aborted && options.signal.reason instanceof NodelTimeoutError) result.outcome = "timeout";
    else if (options.signal?.aborted) result.outcome = "aborted";
    else if (error instanceof NodelTransportError) {
      if (error.code === "TIMEOUT") result.outcome = "timeout";
      else if (error.code === "RESPONSE_TOO_LARGE") result.outcome = "too_large";
      else if (error.code === "REDIRECT") result.outcome = "redirect_rejected";
      else result.outcome = "network_error";
    } else result.outcome = "network_error";
  } finally {
    result.durationMs = Date.now() - started;
  }
  return result;
}

function safePath(path: string): boolean {
  if (path.includes("\\") || path.includes("//")) return false;
  return path.split("/").every((part) => {
    try {
      const decoded = decodeURIComponent(part);
      return (
        decoded !== "." &&
        decoded !== ".." &&
        !/[/%\\?#]/u.test(decoded) &&
        !Array.from(decoded).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      );
    } catch {
      return false;
    }
  });
}

function locationPath(location: string): string {
  // Extract, don't normalize: new URL("../...") would hide prohibited traversal.
  return location.replace(/^(?:https?:)?\/\/[^/]+/iu, "");
}
function mimeType(value: string | null): string | undefined {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mime && mime.length <= 128 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime) ? mime : undefined;
}
function expectedMime(artifact: StaticAsset, mime: string | undefined): boolean {
  if (!mime) return false;
  // NanoHTTPD's host mapping is json=application/javascript. This exception is
  // only reachable at the fixed contract URL; full JSON/schema proof stays in domain.
  if (artifact === "contract")
    return (
      mime === "application/json" ||
      mime === "application/javascript" ||
      /^application\/[a-z0-9.+-]+\+json$/u.test(mime)
    );
  if (artifact === "stylesheet") return mime === "text/css";
  return ["text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"].includes(mime);
}
function expectedAccept(artifact: StaticAsset): string {
  return artifact === "contract"
    ? "application/json, application/javascript"
    : artifact === "stylesheet"
      ? "text/css"
      : "text/javascript, application/javascript";
}
