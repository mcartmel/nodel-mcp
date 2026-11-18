import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  availableWriteTools,
  verifyWritePlan,
  workflowGuidance,
  writeApprovalInstructions,
  writeStatus,
} from "../dist/mcp/tools/guidance.js";
import { createTestConfig } from "../dist/config.js";
import { RECIPE_GUIDELINES } from "../dist/nodel/guidelines.js";
import { approvalRequest } from "../dist/state/approvals.js";

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
  const guidance = workflowGuidance(config(), "recipe_script");

  assert.equal(guidance.mode.mode, "read_only");
  assert.ok(guidance.recommendedWorkflow.some((step) => /Writes are disabled/u.test(step)));
  assert.equal(guidance.approval.available, false);
  assert.equal(guidance.examples, undefined);
  assert.doesNotMatch(guidance.recommendedWorkflow.join(" "), /request_write_approval|approve_write|Apply with/u);
  assert.doesNotMatch(guidance.recommendedWorkflow.join(" "), /matching approval flow/u);
  assert.doesNotMatch(guidance.recommendedWorkflow.join(" "), /postWrite\.ready|after the reload/u);
});

test("read-only diagnosis retains readiness probes without post-write or approval steps", () => {
  const guidance = workflowGuidance(config(), "diagnose");
  const combined = guidance.recommendedWorkflow.join(" ");

  assert.ok(guidance.verificationTools.includes("nodel.verify_node_ready"));
  assert.match(combined, /nodel\.verify_node_ready to summarize probe results and current-runtime console errors/u);
  assert.doesNotMatch(combined, /request_write_approval|approve_write|Apply with|postWrite|after the reload/u);
  assert.equal(guidance.examples, undefined);
});

test("workflowGuidance includes approval steps when approval is required", () => {
  const guidance = workflowGuidance(config({ writesEnabled: true, writeApprovalRequired: true }), "parameters", false);

  assert.equal(guidance.mode.mode, "writes_with_approval");
  assert.ok(guidance.recommendedWorkflow.some((step) => /request_write_approval/u.test(step)));
  assert.equal(guidance.approval.required, true);
  const combined = guidance.recommendedWorkflow.join(" ");
  assert.match(combined, /itself the user confirmation step/u);
  assert.match(combined, /do not ask for duplicate chat approval/u);
  assert.match(combined, /outcome=approved/u);
  assert.match(combined, /fallbackAvailable=true/u);
  assert.match(combined, /never retry or fall back/u);
  assert.match(guidance.approval.message, /unverified context/u);
  assert.match(guidance.approval.message, /resultOk=true and outcome=approved/u);
  assert.match(guidance.approval.message, /manual tool returns ok=true/u);
  assert.match(guidance.approval.message, /fallbackAvailable=true/u);
});

test("primary approval guidance requires operator exact-phrase approval before manual fallback", () => {
  const cfg = config({ writesEnabled: true });
  const workflow = workflowGuidance(cfg, "parameters");
  const proposal = approvalRequest(cfg, { operation: "set_parameters", target: "Demo", proposalHash: "a".repeat(64) });
  const nativeGuidance = [
    workflow.recommendedWorkflow.join(" "),
    workflow.approval.message,
    proposal.instructions,
    RECIPE_GUIDELINES,
  ];
  for (const text of nativeGuidance) {
    assert.match(text, /do not ask for duplicate chat approval/u);
  }
  for (const text of [...nativeGuidance, writeStatus(cfg).recommendedNextStep]) {
    assert.match(
      text,
      /fallbackAvailable=true[^.]*obtain explicit operator approval of the exact confirmText before calling nodel\.approve_write/u,
    );
  }
});

test("approval docs distinguish operator fallback approval and proposal versus helper no-approval fields", () => {
  for (const path of ["../README.md", "../docs/security-model.md"]) {
    const text = readFileSync(new URL(path, import.meta.url), "utf8")
      .replace(/`/gu, "")
      .replace(/\s+/gu, " ");
    assert.match(
      text,
      /fallbackAvailable=true[^.]*obtain explicit operator approval of the exact confirmText before calling nodel\.approve_write/u,
    );
    assert.match(text, /proposals report approvalRequest\.required=false; skip approval tools/u);
    assert.match(
      text,
      /nodel\.request_write_approval is unnecessarily called, the helper returns outcome=not_required without prompting or issuing an approval ID/u,
    );
  }
});

test("workflowGuidance omits approval step when approval is disabled", () => {
  const guidance = workflowGuidance(config({ writesEnabled: true, writeApprovalRequired: false }), "parameters", false);

  assert.equal(guidance.mode.mode, "writes_without_approval");
  assert.ok(guidance.recommendedWorkflow.some((step) => /Approval ids are not required/u.test(step)));
  assert.equal(
    writeApprovalInstructions(config({ writesEnabled: true, writeApprovalRequired: false })).required,
    false,
  );
  assert.doesNotMatch(guidance.recommendedWorkflow.join(" "), /request_write_approval|approve_write/u);
  assert.match(
    writeApprovalInstructions(config({ writesEnabled: true, writeApprovalRequired: false })).message,
    /proposals report approvalRequest\.required=false\. Skip approval tools[^.]*\. If nodel\.request_write_approval is unnecessarily called, it returns outcome=not_required/u,
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
  assert.match(status.recommendedNextStep, /Never fall back after denial or failure/u);
  assert.match(status.recommendedNextStep, /resultOk=true and outcome=approved/u);
  assert.match(status.recommendedNextStep, /request_write_approval/u);
  assert.match(status.recommendedNextStep, /ok=true and approvalId/u);
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

test("verifyWritePlan warning and next step prefer native approval but preserve operator-approved manual fallback", () => {
  const result = verifyWritePlan(
    config({ writesEnabled: true }),
    "parameters",
    { operation: "set_parameters", currentHash: "current", nextHash: "next" },
    "nodel.patch_node_parameters",
  );

  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
  for (const text of [result.warnings[0], result.nextStep]) {
    assert.match(text, /Prefer nodel\.request_write_approval/u);
    assert.match(text, /resultOk=true and outcome=approved/u);
    assert.match(
      text,
      /Only if fallbackAvailable=true, obtain explicit operator approval of the exact confirmText before calling nodel\.approve_write/u,
    );
    assert.match(text, /tool returns ok=true and approvalId/u);
    assert.match(text, /Never fall back after denial or failure/u);
  }
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
