import assert from "node:assert/strict";
import test from "node:test";
import { UiCapabilityCache } from "../src/domain/ui/capabilities-cache.js";

type Value = { positive: boolean; bytes: number; count: number };
void test("capability cache enforces success/error TTLs, refresh, LRU64 and 16MiB budget", async () => {
  let now = 0;
  const cache = new UiCapabilityCache<Value>(() => now);
  const signal = new AbortController().signal;
  let calls = 0;
  async function read(key: string, positive = true, bytes = 0, refresh = false) {
    return cache.read(
      key,
      { signal, refresh },
      () => ({ positive, bytes, count: 0 }),
      async (progress) => {
        progress.count = ++calls;
        return progress;
      },
      (value) => value,
    );
  }
  assert.equal((await read("success")).hit, false);
  now = 59_999;
  assert.equal((await read("success")).hit, true);
  now = 60_000;
  assert.equal((await read("success")).hit, false);
  assert.equal((await read("success", true, 0, true)).hit, false);
  assert.equal((await read("negative", false)).ttlMs, 10_000);
  now += 9_999;
  assert.equal((await read("negative", false)).hit, true);
  now++;
  assert.equal((await read("negative", false)).hit, false);
  for (let i = 0; i < 64; i++) await read(`entry-${i}`);
  assert.equal((await read("entry-0")).hit, true);
  await read("entry-64");
  assert.equal((await read("entry-1")).hit, false, "oldest non-accessed entry should be evicted");
  for (let i = 0; i < 8; i++) await read(`big-${i}`, true, 2 * 1024 * 1024);
  await read("big-8", true, 2 * 1024 * 1024);
  assert.equal((await read("big-0", true, 2 * 1024 * 1024)).hit, false);
  const tooBig = 16 * 1024 * 1024 + 1;
  await read("oversized", true, tooBig);
  assert.equal((await read("oversized", true, tooBig)).hit, false);
});

void test("cancelled refresh leaves prior cache intact and never stores partial work", async () => {
  const cache = new UiCapabilityCache<Value>();
  const controller = new AbortController();
  const initial = { positive: true, bytes: 10, count: 1 };
  await cache.read(
    "key",
    { signal: controller.signal },
    () => ({ ...initial }),
    async (progress) => progress,
    (value) => value,
  );
  let release: (() => void) | undefined;
  let aborted = false;
  const refresh = cache.read(
    "key",
    { refresh: true, signal: controller.signal },
    () => ({ positive: false, bytes: 0, count: 2 }),
    async (progress, signal) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return progress;
    },
    (value) => value,
  );
  controller.abort();
  assert.equal((await refresh).interrupted, true);
  assert.equal(aborted, true);
  release!();
  const old = await cache.read(
    "key",
    { signal: new AbortController().signal },
    () => initial,
    async (progress) => progress,
    (value) => value,
  );
  assert.equal(old.hit, true);
  assert.equal(old.value.count, 1);
});

void test("cache bounds concurrent flights/queue and cancellation releases actual loader work", async () => {
  const cache = new UiCapabilityCache<Value>();
  const controllers = Array.from({ length: 70 }, () => new AbortController());
  let active = 0;
  let maximum = 0;
  const pending = controllers.map((controller, i) =>
    cache.read(
      `target-${i}`,
      { signal: controller.signal },
      () => ({ positive: false, bytes: 0, count: i }),
      async (progress, signal) => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        active--;
        return progress;
      },
      (value) => value,
    ),
  );
  assert.equal(active, 3);
  const capacity = await Promise.all(pending.slice(67));
  assert(capacity.every((result) => result.interruptionReason === "probe_capacity"));
  for (const controller of controllers) controller.abort();
  await Promise.all(pending);
  assert.equal(active, 0);
  assert.equal(maximum, 3);
  const retry = await cache.read(
    "target-0",
    { signal: new AbortController().signal },
    () => ({ positive: true, bytes: 0, count: 100 }),
    async (value) => value,
    (value) => value,
  );
  assert.equal(retry.hit, false);
  assert.equal(retry.value.count, 100);
});

void test("deduplicated subscribers are also bounded without cancelling admitted callers", async () => {
  const cache = new UiCapabilityCache<Value>();
  let release: (() => void) | undefined;
  let loads = 0;
  const signal = new AbortController().signal;
  const pending = Array.from({ length: 65 }, () =>
    cache.read(
      "shared",
      { signal },
      () => ({ positive: true, bytes: 0, count: 1 }),
      async (progress) => {
        loads++;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return progress;
      },
      (value) => value,
    ),
  );
  assert.equal((await pending[64]!).interruptionReason, "probe_capacity");
  release!();
  const admitted = await Promise.all(pending.slice(0, 64));
  assert(admitted.every((value) => !value.interrupted));
  assert.equal(loads, 1);
});
