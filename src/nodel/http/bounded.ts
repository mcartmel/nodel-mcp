import { NodelResponseTooLargeError, NodelTimeoutError } from "./errors.js";
import type { NodeReadOptions } from "../types.js";

/** Validate bounds before opening a socket; callers cannot raise a configured timeout. */
export function readTimeoutMs(configuredMs: number, options: NodeReadOptions = {}, now = Date.now()): number {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
    throw new TypeError("timeoutMs must be a positive finite number.");
  if (options.deadlineMs !== undefined && !Number.isFinite(options.deadlineMs))
    throw new TypeError("deadlineMs must be a finite absolute timestamp.");
  if (
    options.maxResponseBytes !== undefined &&
    (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1)
  )
    throw new TypeError("maxResponseBytes must be a positive safe integer.");
  return Math.min(configuredMs, options.timeoutMs ?? configuredMs, (options.deadlineMs ?? Infinity) - now);
}

/** Keeps a single deadline across resolution, redirects and consumption. Always close the scope. */
export function createReadScope(
  url: URL,
  configuredMs: number,
  options: NodeReadOptions = {},
): {
  options: NodeReadOptions;
  readonly timedOut: boolean;
  close(): void;
} {
  const timeoutMs = readTimeoutMs(configuredMs, options);
  if (timeoutMs <= 0) throw new NodelTimeoutError(url, 0);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new NodelTimeoutError(url, timeoutMs));
  }, timeoutMs);
  return {
    options: {
      ...options,
      signal: controller.signal,
      deadlineMs: Math.min(options.deadlineMs ?? Infinity, Date.now() + timeoutMs),
    },
    get timedOut() {
      return timedOut;
    },
    close() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    },
  };
}

/** Instance-local admission control. Queued work consumes its caller's existing deadline. */
export class BoundedReadLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(
    private readonly concurrency = 3,
    private readonly maxWaiting = 64,
  ) {}

  async run<T>(signal: AbortSignal | undefined, read: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxWaiting) throw new Error("Static read admission limit exceeded.");
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          const index = this.waiting.indexOf(admit);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(abortError(signal));
        };
        const admit = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        signal?.addEventListener("abort", abort, { once: true });
        this.waiting.push(admit);
      });
    } else this.active++;
    try {
      signal?.throwIfAborted();
      return await read();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/**
 * Stop waiting for a resolver retry sleep on abort. The supplied operation must ALSO
 * use this signal for its transport, so this never substitutes a race for HTTP cancellation.
 */
export function waitForRead<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Stream decoded response bytes, including chunked/compressed responses with no trustworthy length. */
export async function readBoundedBody(
  response: Response,
  url: URL,
  limit: number,
  prefix: boolean,
  signal?: AbortSignal | null,
): Promise<{ bytes: Uint8Array; complete: boolean }> {
  signal?.throwIfAborted();
  const length = response.headers.get("content-length");
  if (!prefix && length && /^\d+$/u.test(length) && Number(length) > limit)
    throw new NodelResponseTooLargeError(url, limit);
  if (!response.body) return { bytes: new Uint8Array(), complete: true };
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const cancel = () => {
    // Cancellation must not keep a deadline open waiting for an uncooperative peer.
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  // A fixed allocation avoids retaining millions of tiny chunk objects for a
  // byte-at-a-time peer. Never retain a large fetch chunk backing buffer either.
  const buffer = new Uint8Array(limit);
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        complete = true;
        break;
      }
      if (!prefix && value.byteLength > limit - total) throw new NodelResponseTooLargeError(url, limit);
      const part = value.subarray(0, limit - total);
      buffer.set(part, total);
      total += part.byteLength;
      if (prefix && total >= limit) break;
    }
    return { bytes: buffer.slice(0, total), complete };
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("Read aborted", "AbortError");
}
