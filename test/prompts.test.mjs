import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTask, promptText } from "../dist/mcp/prompts.js";
import { createTestConfig } from "../dist/config.js";

function config(overrides = {}) {
  return createTestConfig({
    writesEnabled: false,
    nodeLifecycleEnabled: false,
    deletesEnabled: false,
    writeApprovalRequired: true,
    writeApprovalTtlSeconds: 600,
    postWriteSettleMs: 3000,
    postWriteReadyTimeoutSeconds: 20,
    nodelRequestTimeoutMs: 10000,
    publicRecipeRequestTimeoutMs: 15000,
    ...overrides,
  });
}

test("promptText reflects disabled writes", () => {
  const text = promptText(config(), "recipe_script_edit", "Demo");

  assert.match(text, /Mode: read_only/u);
  assert.match(text, /Writes are disabled/u);
});

test("promptText mentions elicitation approval and fallback when required", () => {
  const text = promptText(config({ writesEnabled: true, writeApprovalRequired: true }), "recipe_script", "Demo");

  assert.match(text, /nodel\.request_write_approval/u);
  assert.match(text, /nodel\.approve_write/u);
});

test("promptText omits approval requirement when approval disabled", () => {
  const text = promptText(config({ writesEnabled: true, writeApprovalRequired: false }), "parameters", "Demo");

  assert.match(text, /Approval ids are not required/u);
});

test("normalizeTask accepts every current guidance task and rejects obsolete aliases", () => {
  for (const task of [
    "recipe_script",
    "recipe_script_edit",
    "node_file",
    "node_file_edit",
    "parameters",
    "bindings",
    "action",
    "restart",
    "create_node",
    "delete_node",
    "diagnose",
    "general",
  ]) {
    assert.equal(normalizeTask(task), task);
  }
  assert.equal(normalizeTask("recipe_edit"), "general");
  assert.equal(normalizeTask("recipe_patch"), "general");
});
