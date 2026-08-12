import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestConfig } from "../dist/config.js";
import { listConfigBackups, listWriteAudit, readConfigBackup } from "../dist/mcp/tools/auditReads.js";

function config(stateDir) {
  return createTestConfig({ stateDir });
}

test("listWriteAudit returns empty result when audit file is missing", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-audit-read-"));
  try {
    const result = listWriteAudit(config(stateDir), 10);
    assert.equal(result.count, 0);
    assert.deepEqual(result.entries, []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("listWriteAudit filters JSONL entries", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-audit-read-"));
  try {
    writeFileSync(
      join(stateDir, "audit.jsonl"),
      [
        JSON.stringify({ operation: "set_node_bindings", node: "A" }),
        JSON.stringify({ operation: "save_recipe_script", node: "B" }),
      ].join("\n") + "\n",
      "utf8",
    );
    const result = listWriteAudit(config(stateDir), 10, "save_recipe_script");
    assert.equal(result.count, 1);
    assert.equal(result.entries[0].node, "B");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("listConfigBackups and readConfigBackup read only backup files", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-backup-read-"));
  try {
    const dir = join(stateDir, "backups", "parameters");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01-Example.json"), '{"host":"127.0.0.1"}\n', "utf8");

    const listed = listConfigBackups(config(stateDir), "parameters", "Example", 10);
    assert.equal(listed.count, 1);

    const backup = readConfigBackup(config(stateDir), "parameters", "2026-01-01-Example.json");
    assert.deepEqual(backup.parsed, { host: "127.0.0.1" });
    assert.throws(() => readConfigBackup(config(stateDir), "parameters", "../secret.json"), /filename inside/u);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
