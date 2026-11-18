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
  assert.doesNotMatch(text, /request_write_approval|approve_write|Apply with|postWrite\.ready/u);
});

test("read-only diagnose prompt preserves diagnostic readiness verification", () => {
  const text = promptText(config(), "diagnose", "Demo");

  assert.match(text, /Mode: read_only/u);
  assert.match(text, /nodel\.verify_node_ready to summarize probe results and current-runtime console errors/u);
  assert.doesNotMatch(text, /request_write_approval|approve_write|Apply with|postWrite|after the reload/u);
});

test("promptText inherits native-first approval and terminal denial guidance", () => {
  const text = promptText(config({ writesEnabled: true, writeApprovalRequired: true }), "recipe_script", "Demo");

  assert.match(text, /nodel\.request_write_approval/u);
  assert.match(text, /nodel\.approve_write/u);
  assert.match(text, /do not ask for duplicate chat approval/u);
  assert.match(text, /outcome=approved/u);
  assert.match(text, /never retry or fall back/u);
  assert.match(text, /fallbackAvailable=true/u);
  assert.match(text, /obtain explicit operator approval of the exact confirmText before calling nodel\.approve_write/u);
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
