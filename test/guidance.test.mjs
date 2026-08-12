import assert from "node:assert/strict";
import test from "node:test";
import {
  availableWriteTools,
  verifyWritePlan,
  workflowGuidance,
  writeApprovalInstructions,
  writeStatus,
} from "../dist/mcp/tools/guidance.js";
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

test("workflowGuidance adapts when writes are disabled", () => {
  const guidance = workflowGuidance(config(), "recipe_script", false);

  assert.equal(guidance.mode.mode, "read_only");
  assert.ok(guidance.recommendedWorkflow.some((step) => /Writes are disabled/u.test(step)));
  assert.equal(guidance.approval.available, false);
});

test("workflowGuidance includes approval steps when approval is required", () => {
  const guidance = workflowGuidance(config({ writesEnabled: true, writeApprovalRequired: true }), "parameters", false);

  assert.equal(guidance.mode.mode, "writes_with_approval");
  assert.ok(guidance.recommendedWorkflow.some((step) => /request_write_approval/u.test(step)));
  assert.equal(guidance.approval.required, true);
});

test("workflowGuidance omits approval step when approval is disabled", () => {
  const guidance = workflowGuidance(config({ writesEnabled: true, writeApprovalRequired: false }), "parameters", false);

  assert.equal(guidance.mode.mode, "writes_without_approval");
  assert.ok(guidance.recommendedWorkflow.some((step) => /Approval ids are not required/u.test(step)));
  assert.equal(
    writeApprovalInstructions(config({ writesEnabled: true, writeApprovalRequired: false })).required,
    false,
  );
});

test("availableWriteTools reflects lifecycle and delete gates", () => {
  const tools = availableWriteTools(config({ writesEnabled: true, nodeLifecycleEnabled: true, deletesEnabled: true }));

  assert.ok(tools.available.includes("nodel.restart_node"));
  assert.ok(tools.available.includes("nodel.delete_node"));
});

test("writeStatus recommends proposal and approval when required", () => {
  const status = writeStatus(config({ writesEnabled: true, writeApprovalRequired: true }));

  assert.match(status.recommendedNextStep, /request_write_approval/u);
  assert.ok(status.availableWriteTools.includes("nodel.save_recipe_script"));
  assert.ok(status.availableWriteTools.includes("nodel.save_node_file_text"));
  assert.ok(status.availableWriteTools.includes("nodel.request_write_approval"));
});

test("verifyWritePlan rejects non-approval-ready recipe script", () => {
  const result = verifyWritePlan(
    config({ writesEnabled: true }),
    "recipe_script",
    { operation: "save_recipe_script", approvalReady: false },
    "nodel.save_recipe_script",
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /approvalReady=true/u.test(error)));
});

test("verifyWritePlan accepts recipe script and script edit plans", () => {
  const scriptResult = verifyWritePlan(
    config({ writesEnabled: true, writeApprovalRequired: false }),
    "recipe_script",
    { operation: "save_recipe_script", approvalReady: true, recipeVerification: { ok: true } },
    "nodel.save_recipe_script",
  );
  const editResult = verifyWritePlan(
    config({ writesEnabled: true, writeApprovalRequired: false }),
    "recipe_script_edit",
    { operation: "apply_recipe_script_edit", recipeVerification: { ok: true } },
    "nodel.apply_recipe_script_edit",
  );

  assert.equal(scriptResult.ok, true);
  assert.equal(editResult.ok, true);
});

test("verifyWritePlan warns for UI assets outside content", () => {
  const result = verifyWritePlan(
    config({ writesEnabled: true, writeApprovalRequired: false }),
    "node_file",
    { operation: "save_node_file", path: "assets/app.css" },
    "nodel.save_node_file_text",
  );

  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => /outside content\//u.test(warning)));
});

test("verifyWritePlan accepts node file text and base64 tools", () => {
  const textResult = verifyWritePlan(
    config({ writesEnabled: true, writeApprovalRequired: false }),
    "node_file",
    { operation: "save_node_file", path: "content/app.js" },
    "nodel.save_node_file_text",
  );
  const base64Result = verifyWritePlan(
    config({ writesEnabled: true, writeApprovalRequired: false }),
    "node_file",
    { operation: "save_node_file", path: "content/logo.png" },
    "nodel.save_node_file_base64",
  );

  assert.equal(textResult.ok, true);
  assert.equal(base64Result.ok, true);
});

test("verifyWritePlan rejects script.py for node file plans", () => {
  const result = verifyWritePlan(
    config({ writesEnabled: true, writeApprovalRequired: false }),
    "node_file",
    { operation: "save_node_file", path: "script.py" },
    "nodel.save_node_file_text",
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /script\.py/u.test(error)));
});

test("workflowGuidance distinguishes recipe script reloads and node files", () => {
  const scriptGuidance = workflowGuidance(config({ writesEnabled: true }), "recipe_script", false);
  const fileGuidance = workflowGuidance(config({ writesEnabled: true }), "node_file", false);

  assert.ok(scriptGuidance.recommendedWorkflow.some((step) => /postWrite\.ready/u.test(step)));
  assert.ok(fileGuidance.recommendedWorkflow.some((step) => /No node reload/u.test(step)));
  assert.ok(fileGuidance.warnings.some((warning) => /reject script\.py/u.test(warning)));
});

test("workflowGuidance points v1 XML dashboard work to UI guidelines", () => {
  const guidance = workflowGuidance(config({ writesEnabled: true }), "node_file", false);

  assert.ok(guidance.recommendedWorkflow.some((step) => /nodel\.get_ui_guidelines/u.test(step)));
  assert.ok(guidance.recommendedWorkflow.some((step) => /current actions\/signals/u.test(step)));
});

test("verifyWritePlan warns on replace mode and validates removePaths", () => {
  const result = verifyWritePlan(
    config({ writesEnabled: true, writeApprovalRequired: false }),
    "parameters",
    { mode: "replace", removePaths: [["old"]] },
    "nodel.patch_node_parameters",
  );

  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => /mode=replace/u.test(warning)));
});

test("verifyWritePlan errors on invalid removePaths", () => {
  const result = verifyWritePlan(
    config({ writesEnabled: true }),
    "bindings",
    { removePaths: ["old"] },
    "nodel.patch_node_bindings",
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /removePaths/u.test(error)));
});
