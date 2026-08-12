import {
  NodelHttpError,
  NodelInvalidJsonError,
  NodelNetworkError,
  NodelNotFoundError,
  NodelRedirectError,
  NodelTimeoutError,
  NodelTransportError,
} from "./errors.js";
import { PublicError } from "../../shared/publicErrors.js";

export type HttpResponseMode = "json" | "text" | "bytes" | "empty";

export class NodelHttpTransport {
  constructor(private readonly timeoutMs: number) {}

  request<T = unknown>(urlInput: string | URL, init?: RequestInit, responseMode?: "json"): Promise<T | undefined>;
  request(urlInput: string | URL, init: RequestInit | undefined, responseMode: "text"): Promise<string>;
  request(urlInput: string | URL, init: RequestInit | undefined, responseMode: "bytes"): Promise<Uint8Array>;
  request(urlInput: string | URL, init: RequestInit | undefined, responseMode: "empty"): Promise<void>;
  async request(
    urlInput: string | URL,
    init: RequestInit = {},
    responseMode: HttpResponseMode = "json",
  ): Promise<unknown> {
    const url = new URL(urlInput);
    return fetchAndConsumeWithTimeout(url, init, this.timeoutMs, "Nodel request", async (response, responseUrl) => {
      const text = responseMode === "bytes" ? "" : await response.text();
      if (!response.ok) {
        const diagnostic = responseMode === "bytes" ? new TextDecoder().decode(await response.arrayBuffer()) : text;
        if (response.status === 404) throw new NodelNotFoundError(responseUrl, diagnostic);
        throw new NodelHttpError(responseUrl, response.status, response.statusText, diagnostic);
      }
      if (responseMode === "empty") return undefined;
      if (responseMode === "bytes") return new Uint8Array(await response.arrayBuffer());
      if (responseMode === "text") return text;
      if (text.length === 0) return undefined;
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new NodelInvalidJsonError(responseUrl, text, error);
      }
    });
  }
}

export async function fetchWithTimeout(
  urlInput: URL | string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const session = createTimedFetch(urlInput, init, timeoutMs, label);
  try {
    const { response } = await fetchFollowingSafeRedirects(session);
    // Return a fresh, fully buffered response so callers cannot accidentally
    // consume a body after the timeout controller has been released.
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    throw classifyTimedFetchError(session, error);
  } finally {
    session.close();
  }
}

/** Keeps the timeout active through both headers and caller-supplied body consumption. */
export async function fetchAndConsumeWithTimeout<T>(
  urlInput: URL | string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
  consume: (response: Response, url: URL) => Promise<T>,
): Promise<T> {
  const session = createTimedFetch(urlInput, init, timeoutMs, label);
  try {
    const { response, url } = await fetchFollowingSafeRedirects(session);
    return await consume(response, url);
  } catch (error) {
    throw classifyTimedFetchError(session, error);
  } finally {
    session.close();
  }
}

function createTimedFetch(urlInput: URL | string, init: RequestInit, timeoutMs: number, _label: string) {
  const url = new URL(urlInput);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const externalAbort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) externalAbort();
  else init.signal?.addEventListener("abort", externalAbort, { once: true });
  return {
    url,
    init,
    timeoutMs,
    controller,
    get timedOut() {
      return timedOut;
    },
    close() {
      clearTimeout(timeout);
      init.signal?.removeEventListener("abort", externalAbort);
    },
  };
}

type TimedFetch = ReturnType<typeof createTimedFetch>;

async function fetchFollowingSafeRedirects(session: TimedFetch) {
  const method = (session.init.method ?? "GET").toUpperCase();
  let url = session.url;
  const seen = new Set<string>();
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(url, { ...session.init, redirect: "manual", signal: session.controller.signal });
    if (!isRedirect(response.status)) return { response, url };
    const location = response.headers.get("location");
    if (method !== "GET" && method !== "HEAD") throw new NodelRedirectError(url, "Mutation redirects are rejected.");
    if (!location) throw new NodelRedirectError(url, "Redirect response did not include Location.");
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new NodelRedirectError(url, "Redirect target is invalid.");
    }
    if (
      !["http:", "https:"].includes(next.protocol) ||
      next.origin !== url.origin ||
      next.username ||
      next.password ||
      hasCredentials(session.init.headers)
    )
      throw new NodelRedirectError(url, "Redirect target is not a credential-free same-origin HTTP(S) URL.");
    if (redirects >= 4 || seen.has(next.toString()))
      throw new NodelRedirectError(url, "Redirect limit or loop exceeded.");
    seen.add(url.toString());
    await response.body?.cancel();
    url = next;
  }
}

function classifyTimedFetchError(session: TimedFetch, error: unknown) {
  if (error instanceof NodelTransportError || error instanceof PublicError) return error;
  if (session.timedOut) return new NodelTimeoutError(session.url, session.timeoutMs);
  return new NodelNetworkError(session.url, error);
}

function isRedirect(status: number) {
  return status >= 300 && status < 400;
}

function hasCredentials(headers: RequestInit["headers"] | undefined) {
  if (!headers) return false;
  const normalized = new Headers(headers);
  return normalized.has("authorization") || normalized.has("cookie") || normalized.has("proxy-authorization");
}
