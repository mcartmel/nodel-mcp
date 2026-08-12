export type ToolCapability = "read" | "proposal" | "write" | "lifecycle" | "delete";
export type ToolStability = "preview" | "experimental";
export type ToolGate = "always" | "writes" | "lifecycle" | "deletes";
export type ToolPolicy = {
  capability: ToolCapability;
  stability: ToolStability;
  gate: ToolGate;
};
export type WorkflowMetadata = {
  requiredTools: string[];
  verificationTools: string[];
};

const policy = (
  capability: ToolCapability,
  gate: ToolGate = "always",
  stability: ToolStability = "preview",
): ToolPolicy => ({ capability, gate, stability });
export const TOOL_POLICIES: Record<string, ToolPolicy> = {
  "nodel.ping": policy("read"),
  "nodel.get_workflow_guidance": policy("read"),
  "nodel.get_write_status": policy("read"),
  "nodel.verify_write_plan": policy("read"),
  "nodel.health": policy("read"),
  "nodel.list_nodes": policy("read"),
  "nodel.list_local_nodes": policy("read"),
  "nodel.get_node_actions": policy("read"),
  "nodel.get_node_signals": policy("read"),
  "nodel.get_node_bindings": policy("read"),
  "nodel.get_node_files": policy("read"),
  "nodel.get_node_activity": policy("read"),
  "nodel.get_node_console": policy("read"),
  "nodel.get_logs": policy("read"),
  "nodel.read_recipe": policy("read"),
  "nodel.get_recipe_guidelines": policy("read"),
  "nodel.list_public_recipes": policy("read"),
  "nodel.read_public_recipe": policy("read"),
  "nodel.read_toolkit": policy("read"),
  "nodel.describe_node": policy("read"),
  "nodel.verify_recipe_script": policy("read"),
  "nodel.get_ui_guidelines": policy("read"),
  "nodel.get_ui_component_reference": policy("read"),
  "nodel.verify_ui_file": policy("read"),
  "nodel.read_signal": policy("read"),
  "nodel.get_node_parameters": policy("read"),
  "nodel.list_write_audit": policy("read"),
  "nodel.list_config_backups": policy("read"),
  "nodel.read_config_backup": policy("read"),
  "nodel.verify_node_ready": policy("read"),
  "nodel.propose_node_bindings": policy("proposal", "always", "experimental"),
  "nodel.propose_context_bindings": policy("proposal", "always", "experimental"),
  "nodel.approve_write": policy("write", "writes", "experimental"),
  "nodel.request_write_approval": policy("write", "writes", "experimental"),
  "nodel.call_action": policy("write", "writes", "experimental"),
  "nodel.set_node_parameter": policy("write", "writes", "experimental"),
  "nodel.patch_node_parameters": policy("write", "writes", "experimental"),
  "nodel.set_node_parameters": policy("write", "writes", "experimental"),
  "nodel.patch_node_bindings": policy("write", "writes", "experimental"),
  "nodel.set_node_bindings": policy("write", "writes", "experimental"),
  "nodel.apply_node_binding_plan": policy("write", "writes", "experimental"),
  "nodel.propose_recipe_script": policy("proposal", "always", "experimental"),
  "nodel.propose_recipe_script_edit": policy("proposal", "always", "experimental"),
  "nodel.propose_node_file_text": policy("proposal", "always", "experimental"),
  "nodel.propose_node_file_base64": policy("proposal", "always", "experimental"),
  "nodel.propose_node_file_edit": policy("proposal", "always", "experimental"),
  "nodel.save_recipe_script": policy("write", "writes", "experimental"),
  "nodel.apply_recipe_script_edit": policy("write", "writes", "experimental"),
  "nodel.save_node_file_text": policy("write", "writes", "experimental"),
  "nodel.save_node_file_base64": policy("write", "writes", "experimental"),
  "nodel.apply_node_file_edit": policy("write", "writes", "experimental"),
  "nodel.restart_node": policy("lifecycle", "lifecycle", "experimental"),
  "nodel.create_node": policy("lifecycle", "lifecycle", "experimental"),
  "nodel.delete_node": policy("delete", "deletes", "experimental"),
};
export const WORKFLOWS: Record<string, WorkflowMetadata> = {
  recipe_script: {
    requiredTools: [
      "nodel.read_recipe",
      "nodel.propose_recipe_script",
      "nodel.verify_write_plan",
      "nodel.save_recipe_script",
    ],
    verificationTools: ["nodel.read_recipe", "nodel.get_node_console", "nodel.verify_node_ready"],
  },
  recipe_script_edit: {
    requiredTools: [
      "nodel.read_recipe",
      "nodel.propose_recipe_script_edit",
      "nodel.verify_write_plan",
      "nodel.apply_recipe_script_edit",
    ],
    verificationTools: ["nodel.read_recipe", "nodel.get_node_console", "nodel.verify_node_ready"],
  },
  node_file: {
    requiredTools: [
      "nodel.get_node_files",
      "nodel.propose_node_file_text or nodel.propose_node_file_base64",
      "nodel.verify_write_plan",
      "nodel.save_node_file_text or nodel.save_node_file_base64",
    ],
    verificationTools: ["nodel.get_node_files"],
  },
  node_file_edit: {
    requiredTools: [
      "nodel.get_node_files",
      "nodel.propose_node_file_edit",
      "nodel.verify_write_plan",
      "nodel.apply_node_file_edit",
    ],
    verificationTools: ["nodel.get_node_files"],
  },
  parameters: {
    requiredTools: ["nodel.get_node_parameters", "nodel.patch_node_parameters", "nodel.verify_write_plan"],
    verificationTools: ["nodel.get_node_parameters", "nodel.verify_node_ready"],
  },
  bindings: {
    requiredTools: ["nodel.get_node_bindings", "nodel.patch_node_bindings", "nodel.verify_write_plan"],
    verificationTools: ["nodel.get_node_bindings", "nodel.verify_node_ready"],
  },
  diagnose: {
    requiredTools: [
      "nodel.describe_node",
      "nodel.get_node_console",
      "nodel.get_node_activity",
      "nodel.verify_node_ready",
    ],
    verificationTools: ["nodel.verify_node_ready"],
  },
  general: {
    requiredTools: ["nodel.get_write_status", "nodel.get_workflow_guidance", "nodel.health"],
    verificationTools: ["nodel.verify_node_ready", "nodel.get_node_console", "nodel.get_node_activity"],
  },
};

Object.assign(WORKFLOWS, {
  action: {
    requiredTools: ["nodel.get_node_actions", "nodel.call_action", "nodel.verify_write_plan"],
    verificationTools: ["nodel.get_node_activity", "nodel.get_node_console"],
  },
  restart: {
    requiredTools: ["nodel.verify_write_plan", "nodel.restart_node"],
    verificationTools: ["nodel.verify_node_ready", "nodel.get_node_console"],
  },
  create_node: {
    requiredTools: ["nodel.verify_write_plan", "nodel.create_node"],
    verificationTools: ["nodel.list_local_nodes", "nodel.get_node_console"],
  },
  delete_node: {
    requiredTools: ["nodel.describe_node", "nodel.verify_write_plan", "nodel.delete_node"],
    verificationTools: ["nodel.list_nodes"],
  },
} satisfies Record<string, WorkflowMetadata>);

export function toolIsAvailable(
  spec: ToolPolicy,
  config: {
    writesEnabled: boolean;
    nodeLifecycleEnabled: boolean;
    deletesEnabled: boolean;
  },
) {
  return (
    spec.gate === "always" ||
    (spec.gate === "writes" && config.writesEnabled) ||
    (spec.gate === "lifecycle" && config.writesEnabled && config.nodeLifecycleEnabled) ||
    (spec.gate === "deletes" && config.writesEnabled && config.nodeLifecycleEnabled && config.deletesEnabled)
  );
}

export function unavailableReason(
  spec: ToolPolicy,
  config: {
    writesEnabled: boolean;
    nodeLifecycleEnabled: boolean;
    deletesEnabled: boolean;
  },
) {
  if (spec.gate === "writes" && !config.writesEnabled) return "NODEL_ENABLE_WRITES=false";
  if (spec.gate === "lifecycle")
    return config.writesEnabled ? "NODEL_ENABLE_NODE_LIFECYCLE=false" : "NODEL_ENABLE_WRITES=false";
  if (spec.gate === "deletes")
    return !config.writesEnabled
      ? "NODEL_ENABLE_WRITES=false"
      : !config.nodeLifecycleEnabled
        ? "NODEL_ENABLE_NODE_LIFECYCLE=false"
        : "NODEL_ENABLE_DELETES=false";
  return undefined;
}

export function assertToolReferences(references: readonly string[]) {
  const names = new Set(Object.keys(TOOL_POLICIES));
  const invalid = references
    .flatMap((reference) => reference.split(/\s+or\s+/u))
    .filter((reference) => !names.has(reference));
  if (invalid.length > 0) throw new Error(`Unknown tool reference(s): ${invalid.join(", ")}`);
}

export function toolPolicies() {
  return { ...TOOL_POLICIES };
}
export function workflowMetadata(task: string) {
  const metadata = WORKFLOWS[task] ?? WORKFLOWS.general;
  assertToolReferences([...metadata.requiredTools, ...metadata.verificationTools]);
  return {
    requiredTools: [...metadata.requiredTools],
    verificationTools: [...metadata.verificationTools],
  };
}
