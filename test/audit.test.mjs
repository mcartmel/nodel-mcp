import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditWrite, backupBindingState, backupParameterState } from "../dist/safety/audit.js";
import { createTestConfig } from "../dist/config.js";

function config(stateDir) {
  return createTestConfig({ stateDir });
}

test("auditWrite appends JSONL events", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-audit-"));
  try {
    auditWrite(config(stateDir), { operation: "set_node_bindings", node: "Example" });
    const log = readFileSync(join(stateDir, "audit.jsonl"), "utf8").trim();
    const event = JSON.parse(log);
    assert.equal(event.operation, "set_node_bindings");
    assert.equal(event.node, "Example");
    assert.ok(event.time);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("backupBindingState writes stable binding backup", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-backup-"));
  try {
    const path = backupBindingState(config(stateDir), "Example Node", {
      events: {},
      actions: { Play: { node: "Player", action: "Play" } },
    });
    assert.ok(existsSync(path));
    assert.match(readFileSync(path, "utf8"), /"Play"/u);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("backupParameterState writes stable parameter backup", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-param-backup-"));
  try {
    const path = backupParameterState(config(stateDir), "Example Node", { host: "127.0.0.1", nested: { port: 8085 } });
    assert.ok(existsSync(path));
    assert.match(readFileSync(path, "utf8"), /"host":"127\.0\.0\.1"/u);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
