import assert from "node:assert/strict";
import test from "node:test";
import { planConfigWrite } from "../dist/mcp/tools/nodeWrites.js";

test("planConfigWrite merge preserves unspecified top-level and nested keys", () => {
  const current = {
    host: "127.0.0.1",
    connection: { port: 8085, secure: false },
    labels: ["a"],
  };
  const planned = planConfigWrite(current, { connection: { secure: true } }, "merge");

  assert.deepEqual(planned.next, {
    host: "127.0.0.1",
    connection: { port: 8085, secure: true },
    labels: ["a"],
  });
});

test("planConfigWrite merge replaces arrays and primitives", () => {
  const planned = planConfigWrite(
    { retry: { count: 3 }, labels: ["a", "b"], enabled: true },
    { retry: 5, labels: ["c"], enabled: false },
    "merge",
  );

  assert.deepEqual(planned.next, { retry: 5, labels: ["c"], enabled: false });
});

test("planConfigWrite replace returns only the provided object", () => {
  const planned = planConfigWrite({ keep: true, remove: true }, { keep: false }, "replace");

  assert.deepEqual(planned.next, { keep: false });
});

test("planConfigWrite hashes unchanged no-op merge and rejects stale expectedHash", () => {
  const current = { a: 1, nested: { b: 2 } };
  const planned = planConfigWrite(current, { nested: { b: 2 } }, "merge");

  assert.equal(planned.currentHash, planned.nextHash);
  assert.throws(() => planConfigWrite(current, { a: 2 }, "merge", "stale"), /expectedHash mismatch/u);
});

test("planConfigWrite removePaths deletes top-level and nested keys", () => {
  const planned = planConfigWrite(
    { host: "127.0.0.1", connection: { port: 8085, secure: false }, obsolete: true },
    { connection: { secure: true } },
    "merge",
    undefined,
    "Parameter",
    [["connection", "port"], ["obsolete"]],
  );

  assert.deepEqual(planned.next, { host: "127.0.0.1", connection: { secure: true } });
  assert.deepEqual(planned.removePaths, [["connection", "port"], ["obsolete"]]);
  assert.deepEqual(planned.missingRemovePaths, []);
});

test("planConfigWrite treats null as an assigned value, not deletion", () => {
  const planned = planConfigWrite({ a: 1, b: 2 }, { a: null }, "merge");

  assert.deepEqual(planned.next, { a: null, b: 2 });
});

test("planConfigWrite reports missing removePaths without changing unrelated state", () => {
  const planned = planConfigWrite(
    { actions: { Play: { node: "Player", action: "Play" } }, events: {} },
    {},
    "merge",
    undefined,
    "Binding",
    [
      ["actions", "Stop"],
      ["events", "Status", "state"],
    ],
  );

  assert.deepEqual(planned.next, { actions: { Play: { node: "Player", action: "Play" } }, events: {} });
  assert.deepEqual(planned.missingRemovePaths, [
    ["actions", "Stop"],
    ["events", "Status", "state"],
  ]);
});
