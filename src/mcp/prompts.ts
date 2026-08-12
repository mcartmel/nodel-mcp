import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { workflowGuidance, type GuidanceTask } from "./tools/guidance.js";

export function registerWorkflowPrompts(server: McpServer, config: AppConfig) {
  server.registerPrompt(
    "nodel_safe_write_workflow",
    {
      title: "Nodel Safe Write Workflow",
      description: "Dynamic safe-write workflow for the current sidecar write and approval gates.",
      argsSchema: {
        task: z.string().optional(),
        node: z.string().optional(),
      },
    },
    ({ task, node }) => promptResult("Nodel safe write workflow", promptText(config, normalizeTask(task), node)),
  );

  server.registerPrompt(
    "nodel_recipe_edit_workflow",
    {
      title: "Nodel Recipe Edit Workflow",
      description: "Recipe edit/patch workflow including verification, approval, and post-write readiness guidance.",
      argsSchema: {
        node: z.string().optional(),
        path: z.string().optional(),
      },
    },
    ({ node, path }) => {
      const selectedPath = path ?? "script.py or selected supporting file";
      const task: GuidanceTask = path === undefined || path === "script.py" ? "recipe_script" : "node_file";
      return promptResult("Nodel recipe edit workflow", `${promptText(config, task, node)}\n\nPath: ${selectedPath}`);
    },
  );

  server.registerPrompt(
    "nodel_binding_workflow",
    {
      title: "Nodel Binding Workflow",
      description: "Remote binding planning workflow including ambiguity review and approval/apply guidance.",
      argsSchema: {
        sourceNode: z.string().optional(),
        targetNode: z.string().optional(),
        context: z.string().optional(),
      },
    },
    ({ sourceNode, targetNode, context }) =>
      promptResult(
        "Nodel binding workflow",
        `${promptText(config, "bindings", sourceNode)}\n\nSource node: ${sourceNode ?? "unspecified"}\nTarget node: ${targetNode ?? "discover or specify"}\nContext: ${context ?? "unspecified"}`,
      ),
  );

  server.registerPrompt(
    "nodel_config_patch_workflow",
    {
      title: "Nodel Config Patch Workflow",
      description:
        "Parameter/binding patch workflow explaining merge, removePaths, null semantics, and full-save endpoint risks.",
      argsSchema: {
        node: z.string().optional(),
        kind: z.enum(["parameters", "bindings"]).optional(),
      },
    },
    ({ node, kind }) =>
      promptResult(
        "Nodel config patch workflow",
        `${promptText(config, kind === "bindings" ? "bindings" : "parameters", node)}\n\nUse merge for targeted updates. Use removePaths to delete keys. null assigns null; it does not delete. Avoid mode=replace unless intentionally overwriting the complete object.`,
      ),
  );
}

export function promptText(config: AppConfig, task: GuidanceTask, node?: string) {
  const guidance = workflowGuidance(config, task, true);
  return [
    `Task: ${task}`,
    node ? `Node: ${node}` : undefined,
    `Mode: ${guidance.mode.mode}`,
    "Workflow:",
    ...guidance.recommendedWorkflow.map((step, index) => `${index + 1}. ${step}`),
    "Warnings:",
    ...guidance.warnings.map((warning) => `- ${warning}`),
    "Approval guidance:",
    guidance.approval.message,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function promptResult(description: string, text: string) {
  return {
    description,
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text,
        },
      },
    ],
  };
}

export function normalizeTask(task: string | undefined): GuidanceTask {
  const allowed = new Set([
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
  return allowed.has(task ?? "") ? (task as GuidanceTask) : "general";
}
