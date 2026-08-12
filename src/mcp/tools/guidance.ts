import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import { redactedConfig } from "../../config.js";
import { contentAssetPathWarning } from "../../nodel/pathPolicy.js";
import { localReadOnlyToolAnnotations } from "../toolAnnotations.js";
import { isRecord, readString, toolResult } from "./common.js";
import {
  TOOL_POLICIES,
  WORKFLOWS,
  assertToolReferences,
  toolIsAvailable,
  unavailableReason,
} from "../registry/metadata.js";

const guidanceTaskSchema = z.enum([
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
]);
const writePlanTaskSchema = z.enum([
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
  "binding_plan",
]);

export type GuidanceTask = z.infer<typeof guidanceTaskSchema>;
export type WritePlanTask = z.infer<typeof writePlanTaskSchema>;

export function registerGuidanceTools(server: McpServer, config: AppConfig) {
  server.registerTool(
    "nodel.get_workflow_guidance",
    {
      title: "Get Workflow Guidance",
      description:
        "Return task-specific MCP workflow guidance that adapts to write, approval, lifecycle, and delete gates.",
      inputSchema: {
        task: guidanceTaskSchema.optional().default("general"),
        includeExamples: z.boolean().optional().default(true),
      },
      annotations: localReadOnlyToolAnnotations,
    },
    async ({ task, includeExamples }) =>
      toolResult(async () => workflowGuidance(config, task ?? "general", includeExamples ?? true)),
  );

  server.registerTool(
    "nodel.get_write_status",
    {
      title: "Get Write Status",
      description:
        "Summarize write-related gates, available write tools, and recommended next steps for the current sidecar configuration.",
      inputSchema: {},
      annotations: localReadOnlyToolAnnotations,
    },
    async () => toolResult(async () => writeStatus(config)),
  );

  server.registerTool(
    "nodel.verify_write_plan",
    {
      title: "Verify Write Plan",
      description:
        "Read-only consistency check for a proposed or dry-run write plan before operator approval or apply. This is guidance only; write tools still enforce safety gates.",
      inputSchema: {
        task: writePlanTaskSchema,
        plan: z.record(z.string(), z.unknown()),
        intendedApplyTool: z.string().optional(),
      },
      annotations: localReadOnlyToolAnnotations,
    },
    async ({ task, plan, intendedApplyTool }) =>
      toolResult(async () => verifyWritePlan(config, task, plan, intendedApplyTool)),
  );
}

export function writeMode(config: AppConfig) {
  const mode = !config.writesEnabled
    ? "read_only"
    : config.writeApprovalRequired
      ? "writes_with_approval"
      : "writes_without_approval";
  return {
    mode,
    writesEnabled: config.writesEnabled,
    writeApprovalRequired: config.writeApprovalRequired,
    nodeLifecycleEnabled: config.nodeLifecycleEnabled,
    deletesEnabled: config.deletesEnabled,
  };
}

export function availableWriteTools(config: AppConfig) {
  const unavailable: Array<{ tool: string; reason: string }> = [];
  const available: string[] = [];
  for (const [name, spec] of Object.entries(TOOL_POLICIES).filter(([, candidate]) => candidate.capability !== "read")) {
    if (toolIsAvailable(spec, config)) available.push(name);
    else
      unavailable.push({
        tool: name,
        reason: unavailableReason(spec, config) ?? "disabled",
      });
  }

  return { available, unavailable };
}

export function workflowGuidance(config: AppConfig, task: GuidanceTask, includeExamples = true) {
  const mode = writeMode(config);
  const approval = writeApprovalInstructions(config);
  const base = baseWorkflow(task);
  assertToolReferences([...base.requiredTools, ...base.verificationTools]);
  const workflow = [...base.readSteps];

  if (!config.writesEnabled) {
    workflow.push(
      "Writes are disabled; stop after read/propose/dry-run context and ask an operator to enable write gates before applying changes.",
    );
  } else if (config.writeApprovalRequired) {
    workflow.push("Review the proposal or dry-run payload, including hashes, warnings, and approvalRequest.");
    workflow.push(
      "Ask the operator to approve the exact approvalRequest.confirmText using nodel.request_write_approval where the client supports elicitation, or nodel.approve_write as manual fallback. The fallback is a workflow guardrail, not an authentication boundary.",
    );
    workflow.push("Pass the returned approvalId to the matching apply tool.");
  } else {
    workflow.push(
      "Review the proposal or dry-run payload, including hashes and warnings. Approval ids are not required by current configuration.",
    );
    workflow.push(
      "Apply with the matching write tool and omit approvalId unless the tool explicitly supplies one for audit context.",
    );
  }

  workflow.push(...base.applySteps);
  workflow.push(...base.verifySteps);

  return {
    task,
    mode,
    requiredTools: base.requiredTools,
    verificationTools: base.verificationTools,
    recommendedWorkflow: workflow,
    warnings: taskWarnings(config, task),
    approval,
    examples: includeExamples ? taskExamples(config, task) : undefined,
  };
}

export function writeStatus(config: AppConfig) {
  const tools = availableWriteTools(config);
  return {
    mode: writeMode(config),
    config: redactedConfig(config),
    availableWriteTools: tools.available,
    unavailableWriteTools: tools.unavailable,
    recommendedNextStep: !config.writesEnabled
      ? "Use read/proposal tools only, or enable NODEL_ENABLE_WRITES for approved maintenance."
      : config.writeApprovalRequired
        ? "Use proposal or dryRun tools, get explicit operator approval with nodel.request_write_approval or fallback nodel.approve_write, then apply and verify."
        : "Use proposal or dryRun tools, apply without approvalId, then verify read-back hashes and runtime state.",
  };
}

export function writeApprovalInstructions(config: AppConfig, operation?: string) {
  if (!config.writesEnabled) {
    return {
      required: false,
      available: false,
      message:
        "Writes are disabled. Proposal and read-only diagnostics may be used, but apply/action tools are not registered.",
    };
  }
  if (!config.writeApprovalRequired) {
    return {
      required: false,
      available: true,
      operation,
      message:
        "Write approval ids are not required by current sidecar configuration. Still use proposals/dry-runs, expected hashes, and verification reads.",
    };
  }
  return {
    required: true,
    available: true,
    operation,
    message:
      "After explicit operator approval of the exact confirmText, prefer nodel.request_write_approval where the client supports elicitation, or use fallback nodel.approve_write. The fallback depends on client/operator discipline and is not an authentication boundary. Pass the returned approvalId to the matching write tool.",
  };
}

export function verifyWritePlan(
  config: AppConfig,
  task: WritePlanTask,
  plan: Record<string, unknown>,
  intendedApplyTool?: string,
) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const approval = writeApprovalInstructions(config, readString(plan.operation));
  const operation = readString(plan.operation);

  if (!config.writesEnabled) {
    errors.push("Writes are disabled; this plan cannot be applied until NODEL_ENABLE_WRITES=true.");
  }
  if (
    config.writeApprovalRequired &&
    config.writesEnabled &&
    !isRecord(plan.approvalRequest) &&
    !readString(plan.approvalId)
  ) {
    warnings.push(
      "Approval is required for writes; ensure the matching proposal includes approvalRequest and obtain approvalId before apply.",
    );
  }

  if (task === "recipe_script") {
    if (plan.approvalReady !== true) {
      errors.push("Recipe script proposals must have approvalReady=true before approval or apply.");
    }
    requireOperation(errors, operation, "save_recipe_script", task);
    requireTool(errors, intendedApplyTool, "nodel.save_recipe_script");
    checkRecipeVerification(errors, plan);
  }
  if (task === "recipe_script_edit") {
    requireOperation(errors, operation, "apply_recipe_script_edit", task);
    requireTool(errors, intendedApplyTool, "nodel.apply_recipe_script_edit");
    checkRecipeVerification(errors, plan);
  }
  if (task === "node_file") {
    requireOperation(errors, operation, "save_node_file", task);
    requireTool(errors, intendedApplyTool, "nodel.save_node_file_text", ["nodel.save_node_file_base64"]);
    rejectScriptPath(errors, plan);
    addContentAssetWarning(warnings, plan);
  }
  if (task === "node_file_edit") {
    requireOperation(errors, operation, "apply_node_file_edit", task);
    requireTool(errors, intendedApplyTool, "nodel.apply_node_file_edit");
    rejectScriptPath(errors, plan);
    addContentAssetWarning(warnings, plan);
  }
  if (task === "parameters" || task === "bindings") {
    if (plan.mode === "replace") {
      warnings.push(
        "mode=replace overwrites the full saved object. Prefer merge plus removePaths for targeted changes.",
      );
    }
    if (!readString(plan.currentHash)) {
      warnings.push(
        "Plan does not include currentHash; expected hashes are recommended before applying full-save endpoint writes.",
      );
    }
    if (!readString(plan.nextHash)) {
      warnings.push("Plan does not include nextHash; dry-run/proposal output should include it for operator review.");
    }
    validateRemovePaths(errors, plan.removePaths);
  }
  if (task === "binding_plan") {
    if (Array.isArray(plan.unresolved) && plan.unresolved.length > 0) {
      errors.push("Binding plan has unresolved entries; review or adjust criteria before applying.");
    }
    if (Array.isArray(plan.ambiguous) && plan.ambiguous.length > 0) {
      errors.push("Binding plan has ambiguous entries; choose explicit targets before applying.");
    }
    requireOperation(errors, operation, "apply_node_binding_plan", task);
  }
  if (task === "restart" && !config.nodeLifecycleEnabled) {
    errors.push("Node lifecycle tools are disabled; restart cannot be applied until NODEL_ENABLE_NODE_LIFECYCLE=true.");
  }
  if (task === "create_node" && !config.nodeLifecycleEnabled) {
    errors.push(
      "Node lifecycle tools are disabled; create_node cannot be applied until NODEL_ENABLE_NODE_LIFECYCLE=true.",
    );
  }
  if (task === "delete_node") {
    if (!config.nodeLifecycleEnabled || !config.deletesEnabled) {
      errors.push("Delete tools require writes, lifecycle, and delete gates to be enabled.");
    }
    if (!readString(plan.confirmNodeName) && !readString(plan.requiredConfirmation)) {
      errors.push("Delete plans must include or surface exact node-name confirmation.");
    }
  }

  return {
    ok: errors.length === 0,
    task,
    intendedApplyTool,
    errors,
    warnings,
    approval,
    nextStep:
      errors.length > 0
        ? "Fix validation errors before requesting approval or applying."
        : config.writeApprovalRequired && config.writesEnabled
          ? "Get operator approval with nodel.request_write_approval or fallback nodel.approve_write before applying."
          : "Apply with the matching tool, then verify read-back state.",
  };
}

function baseWorkflow(task: GuidanceTask) {
  const metadata = WORKFLOWS[task] ?? WORKFLOWS.general;
  if (task === "recipe_script") {
    return {
      ...metadata,
      readSteps: [
        "Read current script.py and runtime state.",
        "Use nodel.propose_recipe_script and review recipeVerification before requesting approval.",
      ],
      applySteps: [
        "Apply with nodel.save_recipe_script using expectedHash=currentHash and the matching approval flow.",
      ],
      verifySteps: [
        "Wait for postWrite.ready=true, then verify script hash, console/activity, and node readiness after the reload.",
      ],
    };
  }
  if (task === "recipe_script_edit") {
    return {
      ...metadata,
      readSteps: [
        "Read current script.py and runtime state.",
        "Use nodel.propose_recipe_script_edit with exact text edits and review recipeVerification before requesting approval.",
      ],
      applySteps: [
        "Apply with nodel.apply_recipe_script_edit using expectedHash=currentHash and the matching approval flow.",
      ],
      verifySteps: [
        "Wait for postWrite.ready=true, then verify script hash, console/activity, and node readiness after the reload.",
      ],
    };
  }
  if (task === "node_file") {
    return {
      ...metadata,
      readSteps: [
        "Use supporting-file tools for HTML/JS/CSS/images/assets; never use them for script.py.",
        "Place custom UI/static assets under content/ because Nodel treats that folder specially; browser URLs should omit the content/ prefix.",
        "For v1 XML dashboard files, call nodel.get_ui_guidelines, use nodel.get_ui_component_reference for exact DOM/CSS behavior, read the current XML, and inspect current actions/signals before proposing changes.",
        "Validate proposed v1 XML with nodel.verify_ui_file(content=...) before approval/apply.",
        "Use text tools for text assets and base64 tools for binary assets.",
      ],
      applySteps: [
        "Apply with nodel.save_node_file_text or nodel.save_node_file_base64 using expectedHash/currentHash and the matching approval flow.",
      ],
      verifySteps: [
        "Read the file back and verify the hash/content. For v1 XML, run nodel.verify_ui_file on the saved file. No node reload or readiness wait is expected.",
      ],
    };
  }
  if (task === "node_file_edit") {
    return {
      ...metadata,
      readSteps: [
        "Use nodel.propose_node_file_edit for exact text replacements in supporting files; never use it for script.py.",
      ],
      applySteps: [
        "Apply with nodel.apply_node_file_edit using expectedHash/currentHash and the matching approval flow.",
      ],
      verifySteps: ["Read the file back and verify the hash/content. No node reload or readiness wait is expected."],
    };
  }
  if (task === "parameters") {
    return configWriteWorkflow("parameters", "nodel.get_node_parameters", "nodel.patch_node_parameters");
  }
  if (task === "bindings") {
    return configWriteWorkflow("bindings", "nodel.get_node_bindings", "nodel.patch_node_bindings");
  }
  if (task === "action") {
    return {
      ...metadata,
      readSteps: ["Inspect the action definition and its expected argument before calling it."],
      applySteps: ["Use nodel.call_action with dryRun where appropriate, then the matching approval flow."],
      verifySteps: ["Inspect node activity and console output for the resulting action execution."],
    };
  }
  if (task === "restart") {
    return {
      ...metadata,
      readSteps: ["Confirm the node is the intended restart target and inspect current console/activity."],
      applySteps: ["Use nodel.restart_node with the matching approval flow."],
      verifySteps: ["Wait for nodel.verify_node_ready, then inspect current console output."],
    };
  }
  if (task === "create_node") {
    return {
      ...metadata,
      readSteps: ["Confirm the runtime target and proposed node name before creation."],
      applySteps: ["Use nodel.create_node with the matching approval flow."],
      verifySteps: ["Confirm the new node appears locally and inspect its initial console output."],
    };
  }
  if (task === "delete_node") {
    return {
      ...metadata,
      readSteps: ["Describe the target node and confirm its exact name before deletion."],
      applySteps: ["Use nodel.delete_node with exact confirmNodeName and the matching approval flow."],
      verifySteps: ["Confirm the node no longer appears in discovered nodes."],
    };
  }
  if (task === "diagnose") {
    return {
      ...metadata,
      readSteps: ["Describe the node and inspect console/activity before changing anything."],
      applySteps: ["Prefer diagnosis and proposals before any write."],
      verifySteps: ["Use nodel.verify_node_ready to summarize probe results and current-runtime console errors."],
    };
  }
  return {
    ...metadata,
    readSteps: ["Check nodel.get_write_status and choose a task-specific workflow."],
    applySteps: ["Use proposal or dryRun tools before writes whenever available."],
    verifySteps: ["Verify through MCP read-back tools after any change."],
  };
}

function configWriteWorkflow(label: string, readTool: string, patchTool: string) {
  const metadata = WORKFLOWS[label] ?? WORKFLOWS.general;
  return {
    ...metadata,
    readSteps: [`Read current ${label} first.`, "Use merge mode for targeted changes and removePaths for deletions."],
    applySteps: [`Use ${patchTool} with expectedHash/currentHash and the matching approval flow.`],
    verifySteps: [`Read ${label} back and confirm the expected keys/values changed.`],
  };
}

function taskWarnings(config: AppConfig, task: GuidanceTask) {
  const warnings = ["Do not fall back to direct Nodel writes when the sidecar is available."];
  if (!config.writesEnabled) {
    warnings.push("Write/action/apply tools are not registered while writes are disabled.");
  }
  if (task === "recipe_script" || task === "recipe_script_edit") {
    warnings.push(
      "Recipe script saves use REST/script/save, reload the node, and must pass recipe validation and post-save readiness checks.",
    );
  }
  if (task === "node_file" || task === "node_file_edit") {
    warnings.push(
      "Supporting-file tools use REST/files/save, reject script.py, do not reload the node, and should be verified by read-back hash/content only.",
    );
    warnings.push(
      "Custom UI/static assets should be placed under content/ because Nodel treats that folder specially; writes outside content/ are allowed but will include an advisory warning. Browser-facing URLs should omit the content/ prefix.",
    );
    warnings.push(
      "V1 XML validation is static and point/schema-aware; it does not execute XSLT in a browser or prove visual rendering.",
    );
  }
  if (task === "restart" && !config.nodeLifecycleEnabled) {
    warnings.push("Restart requires NODEL_ENABLE_NODE_LIFECYCLE=true in addition to writes.");
  }
  if (task === "delete_node") {
    warnings.push(
      "Deletion requires writes, lifecycle, delete gate, approval flow where configured, and exact name confirmation.",
    );
  }
  return warnings;
}

function taskExamples(config: AppConfig, task: GuidanceTask) {
  if (task === "parameters" || task === "bindings") {
    return [
      {
        removePaths: [["obsoleteKey"], ["connection", "oldHost"]],
        note: "removePaths deletes keys; null assigns null.",
      },
    ];
  }
  if (task === "recipe_script") {
    return [
      {
        approvalReady: true,
        next: config.writeApprovalRequired ? "approve_write -> save_recipe_script" : "save_recipe_script",
      },
    ];
  }
  if (task === "node_file") {
    return [
      {
        approvalReady: true,
        next: config.writeApprovalRequired
          ? "approve_write -> save_node_file_text/base64"
          : "save_node_file_text/base64",
      },
    ];
  }
  return undefined;
}

function requireOperation(errors: string[], actual: string | undefined, expected: string, task: string) {
  if (actual && actual !== expected) {
    errors.push(`${task} should use operation ${expected}, but plan operation is ${actual}.`);
  }
}

function requireTool(errors: string[], actual: string | undefined, expected: string, alternatives: string[] = []) {
  if (actual && actual !== expected && !alternatives.includes(actual)) {
    errors.push(`Use ${[expected, ...alternatives].join(" or ")} for this plan, not ${actual}.`);
  }
}

function checkRecipeVerification(errors: string[], plan: Record<string, unknown>) {
  const verification = isRecord(plan.recipeVerification) ? plan.recipeVerification : undefined;
  if (verification && verification.ok !== true) {
    errors.push("recipeVerification.ok must be true before applying a recipe script write.");
  }
}

function rejectScriptPath(errors: string[], plan: Record<string, unknown>) {
  if (readString(plan.path) === "script.py") {
    errors.push("Supporting-file tools cannot save script.py; use recipe script tools instead.");
  }
}

function addContentAssetWarning(warnings: string[], plan: Record<string, unknown>) {
  const path = readString(plan.path);
  const warning = path ? contentAssetPathWarning(path) : undefined;
  if (!warning || warnings.includes(warning)) {
    return;
  }

  warnings.push(warning);
}

function validateRemovePaths(errors: string[], value: unknown) {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push("removePaths must be an array of non-empty string arrays.");
    return;
  }
  for (const path of value) {
    if (
      !Array.isArray(path) ||
      path.length === 0 ||
      path.some((segment) => typeof segment !== "string" || segment.length === 0)
    ) {
      errors.push("removePaths must be an array of non-empty string arrays.");
      return;
    }
  }
}
