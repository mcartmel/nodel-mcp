import { BoundedReadLimiter } from "../../nodel/http/bounded.js";
import { UI_ADVISORY_LIMITS as limits } from "./limits.js";

type Entry<T> = { value: T; completedAt: number; expiresAt: number; ttlMs: number; bytes: number };
type Flight<T> = {
  progress: T;
  promise: Promise<T>;
  controller: AbortController;
  subscribers: number;
  timedOut: boolean;
};
export type CapabilityCacheRead<T> = {
  value: T;
  hit: boolean;
  deduplicated: boolean;
  ageMs: number;
  ttlMs: number;
  interrupted: boolean;
  interruptionReason?: "aggregate_timeout" | "probe_capacity" | "probe_failed";
};

/** Private per-client cache. Values must be treated as internal, never returned to callers directly. */
export class UiCapabilityCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly flights = new Map<string, Flight<T>>();
  private bytes = 0;
  private readonly limiter = new BoundedReadLimiter(limits.capabilityConcurrentProbes, limits.capabilityQueuedProbes);

  constructor(private readonly now: () => number = Date.now) {}

  async read(
    key: string,
    options: { refresh?: boolean; signal: AbortSignal },
    create: () => T,
    load: (progress: T, signal: AbortSignal, deadlineMs: number) => Promise<T>,
    describe: (value: T) => { positive: boolean; bytes: number },
  ): Promise<CapabilityCacheRead<T>> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt <= this.now()) this.remove(key);
    else if (cached && !options.refresh && !options.signal.aborted) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return {
        value: cached.value,
        hit: true,
        deduplicated: false,
        ageMs: Math.max(0, this.now() - cached.completedAt),
        ttlMs: cached.ttlMs,
        interrupted: false,
      };
    }
    let flight = this.flights.get(key);
    const deduplicated = !!flight;
    if (!flight) {
      const progress = create();
      if (
        options.signal.aborted ||
        this.flights.size >= limits.capabilityConcurrentProbes + limits.capabilityQueuedProbes
      )
        return {
          value: progress,
          hit: false,
          deduplicated: false,
          ageMs: 0,
          ttlMs: 0,
          interrupted: true,
          interruptionReason: options.signal.aborted ? undefined : "probe_capacity",
        };
      const controller = new AbortController();
      const deadlineMs = this.now() + limits.explicitDeadlineMs;
      flight = { progress, controller, subscribers: 0, promise: Promise.resolve(progress), timedOut: false };
      const current = flight;
      const timer = setTimeout(() => {
        current.timedOut = true;
        controller.abort();
      }, limits.explicitDeadlineMs);
      current.promise = this.limiter
        .run(controller.signal, () => load(progress, controller.signal, deadlineMs))
        .then((value) => {
          if (!controller.signal.aborted && current.subscribers > 0) {
            const { positive, bytes } = describe(value);
            this.store(key, value, positive, bytes);
          }
          return value;
        })
        .catch(() => {
          controller.abort();
          return progress;
        })
        .finally(() => {
          clearTimeout(timer);
          if (this.flights.get(key) === current) this.flights.delete(key);
        });
      this.flights.set(key, current);
    }
    const current = flight;
    if (options.signal.aborted || current.subscribers >= limits.capabilityQueuedProbes) {
      return {
        value: current.progress,
        hit: false,
        deduplicated,
        ageMs: 0,
        ttlMs: 0,
        interrupted: true,
        interruptionReason: options.signal.aborted ? undefined : "probe_capacity",
      };
    }
    current.subscribers++;
    let interrupted = false;
    try {
      const value = await new Promise<T>((resolve) => {
        const abort = () => {
          interrupted = true;
          resolve(current.progress);
        };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
        void current.promise.then((value) => {
          options.signal.removeEventListener("abort", abort);
          resolve(value);
        });
      });
      const { positive } = describe(value);
      interrupted ||= current.controller.signal.aborted;
      return {
        value,
        hit: false,
        deduplicated,
        ageMs: 0,
        ttlMs: interrupted ? 0 : positive ? limits.capabilitySuccessTtlMs : limits.capabilityFailureTtlMs,
        interrupted,
        interruptionReason: current.timedOut
          ? "aggregate_timeout"
          : current.controller.signal.aborted
            ? "probe_failed"
            : undefined,
      };
    } finally {
      current.subscribers--;
      if (!current.subscribers && this.flights.get(key) === current) {
        // One cancelled caller must not abort another caller's read. The last
        // departing caller DOES cancel the real pending transport and is never cached.
        current.controller.abort();
        this.flights.delete(key);
      }
    }
  }

  private store(key: string, value: T, positive: boolean, bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limits.capabilityCacheContractBytes) return;
    this.remove(key);
    // Purge expired entries before applying the memory/LRU limit.
    for (const [entryKey, entry] of this.entries) if (entry.expiresAt <= this.now()) this.remove(entryKey);
    while (
      this.entries.size >= limits.capabilityCacheEntries ||
      this.bytes + bytes > limits.capabilityCacheContractBytes
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    const ttlMs = positive ? limits.capabilitySuccessTtlMs : limits.capabilityFailureTtlMs;
    const completedAt = this.now();
    this.entries.set(key, { value, completedAt, expiresAt: completedAt + ttlMs, ttlMs, bytes });
    this.bytes += bytes;
  }
  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}
