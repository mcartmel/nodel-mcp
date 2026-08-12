import assert from "node:assert/strict";
import test from "node:test";
import { verifyNodeReady } from "../dist/mcp/tools/nodeReady.js";

const node = {
  input: "Demo",
  scope: "local",
  name: "Demo",
  url: "http://node",
  nodeBaseUrl: "http://node",
  allowed: true,
};

/** @param {unknown} value @returns {import("../dist/nodel/client.js").NodelClient} */
function asClient(value) {
  return /** @type {import("../dist/nodel/client.js").NodelClient} */ (/** @type {unknown} */ (value));
}

test("verifyNodeReady reports ready when selected probes pass", async () => {
  const client = {
    resolveNode: async () => node,
    getNodeActions: async () => ({ node, actions: { Play: {} } }),
    getNodeSignals: async () => ({ node, signals: { Status: {} } }),
    getNodeBindings: async () => ({ node, schema: {}, bindings: {} }),
    getNodeConsole: async () => ({ node, console: [] }),
  };

  const result = await verifyNodeReady(asClient(client), "Demo", undefined, 10);
  assert.equal(result.ready, true);
});

test("verifyNodeReady reports not ready on failed probes and console errors", async () => {
  const client = {
    resolveNode: async () => node,
    getNodeActions: async () => {
      throw new Error("not loaded");
    },
    getNodeConsole: async () => ({ node, console: ["Traceback: failed"] }),
  };

  const result = await verifyNodeReady(asClient(client), "Demo", ["actions", "console"], 10);
  assert.equal(result.ready, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.recentConsoleErrors.length, 1);
});

test("verifyNodeReady ignores console errors older than node started timestamp", async () => {
  const client = {
    resolveNode: async () => node,
    getNodeActions: async () => ({ node, actions: { Play: {} } }),
    getNodeConsole: async () => ({
      node,
      console: [
        { console: "info", comment: "('main' completed cleanly)", timestamp: "2026-06-18T11:10:38.758+10:00" },
        { console: "error", comment: "AttributeError: failed", timestamp: "2026-06-16T22:44:05.006+10:00" },
      ],
    }),
    nodeRequest: async () => ({ node, response: { started: "2026-06-18T11:10:38.758+10:00" } }),
  };

  const result = await verifyNodeReady(asClient(client), "Demo", ["actions", "console"], 10);
  assert.equal(result.ready, true);
  assert.equal(result.recentConsoleErrors.length, 0);
  assert.equal(result.staleConsoleErrors.length, 1);
  assert.equal(
    /** @type {{ consoleCutoffSource: string }} */ (result.probes.console).consoleCutoffSource,
    "node_started",
  );
});

test("verifyNodeReady treats console errors after node started as current", async () => {
  const client = {
    resolveNode: async () => node,
    getNodeActions: async () => ({ node, actions: { Play: {} } }),
    getNodeConsole: async () => ({
      node,
      console: [{ console: "error", comment: "Traceback: failed", timestamp: "2026-06-18T11:10:40.000+10:00" }],
    }),
    nodeRequest: async () => ({ node, response: { started: "2026-06-18T11:10:38.758+10:00" } }),
  };

  const result = await verifyNodeReady(asClient(client), "Demo", ["actions", "console"], 10);
  assert.equal(result.ready, false);
  assert.equal(result.recentConsoleErrors.length, 1);
  assert.equal(result.staleConsoleErrors.length, 0);
});

test("verifyNodeReady falls back to latest console startup marker", async () => {
  const client = {
    resolveNode: async () => node,
    getNodeActions: async () => ({ node, actions: { Play: {} } }),
    getNodeConsole: async () => ({
      node,
      console: [
        { console: "out", comment: "('main' completed cleanly)", timestamp: "2026-06-18T11:10:38.758+10:00" },
        { console: "error", comment: "AttributeError: failed", timestamp: "2026-06-16T22:44:05.006+10:00" },
      ],
    }),
    nodeRequest: async () => {
      throw new Error("metadata unavailable");
    },
  };

  const result = await verifyNodeReady(asClient(client), "Demo", ["actions", "console"], 10);
  assert.equal(result.ready, true);
  assert.equal(result.recentConsoleErrors.length, 0);
  assert.equal(result.staleConsoleErrors.length, 1);
  assert.equal(
    /** @type {{ consoleCutoffSource: string }} */ (result.probes.console).consoleCutoffSource,
    "console_start_marker",
  );
});

test("verifyNodeReady keeps timestamp-less console errors blocking", async () => {
  const client = {
    resolveNode: async () => node,
    getNodeActions: async () => ({ node, actions: { Play: {} } }),
    getNodeConsole: async () => ({ node, console: ["Traceback: failed"] }),
    nodeRequest: async () => ({ node, response: { started: "2026-06-18T11:10:38.758+10:00" } }),
  };

  const result = await verifyNodeReady(asClient(client), "Demo", ["actions", "console"], 10);
  assert.equal(result.ready, false);
  assert.equal(result.recentConsoleErrors.length, 1);
  assert.equal(result.staleConsoleErrors.length, 0);
});
