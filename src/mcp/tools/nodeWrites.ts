import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import { actionRequest, callAction, deepMerge, planConfigWrite, setParameters } from "../../domain/config/index.js";
import {
  applyBindingPlan,
  buildContextBindingPlan,
  buildDirectBindingPlan,
  discoverContextCandidates,
  setBindings,
  bindingApprovalPayload,
} from "../../domain/bindings/index.js";
import type { NodelClient } from "../../nodel/client.js";
import { approvalRequest } from "../../safety/approvals.js";
import { stableJsonHash } from "../../shared/canonicalJson.js";
import { proposalToolAnnotations, remoteReadOnlyToolAnnotations, writeToolAnnotations } from "../toolAnnotations.js";
import { bestNameMatch, isRecord, readString, toolResult } from "./common.js";
import { publicError } from "../../shared/publicErrors.js";

export { actionRequest, deepMerge, planConfigWrite };

const nodeInput = { node: z.string().min(1) };
const bindingKindSchema = z.enum(["actions", "events", "both"]);
const configWriteModeSchema = z.enum(["merge", "replace"]);
const removePathSchema = z.array(z.string().min(1)).min(1);

export function registerNodeWriteTools(server: McpServer, nodelClient: NodelClient, config: AppConfig) {
  registerReadTools(server, nodelClient);
  registerProposalTools(server, nodelClient, config);
  if (!config.writesEnabled) return;
  registerWriteTools(server, nodelClient, config);
}

function registerReadTools(server: McpServer, nodelClient: NodelClient) {
  server.registerTool(
    "nodel.read_signal",
    {
      title: "Read Node Signal",
      description:
        "Read a signal/event value by name. Endpoint behavior is runtime-dependent; falls back to REST/events/<name>.",
      inputSchema: {
        ...nodeInput,
        signal: z.string().min(1),
        args: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ node, signal, args }) =>
      toolResult(async () => {
        const signals = await nodelClient.getNodeSignals(node);
        const signalName = resolveDefinitionName(signals.signals, signal, "signal/event");
        const query =
          args && Object.keys(args).length > 0
            ? `?${new URLSearchParams(Object.entries(args).map(([key, value]) => [key, String(value)])).toString()}`
            : "";
        const result = await nodelClient.nodeRequest(signals.node, `events/${encodeURIComponent(signalName)}${query}`, {
          responseMode: "json",
        });
        return {
          operation: "read_signal",
          node: signals.node,
          signal: signalName,
          args,
          response: result.response,
        };
      }),
  );
  server.registerTool(
    "nodel.get_node_parameters",
    {
      title: "Get Node Parameters",
      description: "Read node parameters using the conventional REST/params endpoint.",
      inputSchema: {
        ...nodeInput,
        names: z.array(z.string().min(1)).optional(),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ node, names }) =>
      toolResult(async () => {
        const resolved = await nodelClient.resolveNode(node);
        const result = await nodelClient.nodeRequest<unknown>(resolved, "params", { responseMode: "json" });
        return {
          operation: "get_node_parameters",
          node: resolved,
          names,
          parameters: filterObject(result.response, names),
        };
      }),
  );
}

function registerProposalTools(server: McpServer, nodelClient: NodelClient, config: AppConfig) {
  server.registerTool(
    "nodel.propose_node_bindings",
    {
      title: "Propose Node Bindings",
      description:
        "Plan remote action/event bindings from one node to a target node using binding schema and target actions/signals. No changes are applied. Use nodel.verify_write_plan before approval/apply.",
      inputSchema: {
        node: z.string().min(1),
        targetNode: z.string().min(1),
        kinds: bindingKindSchema.optional().default("both"),
        bindingNames: z.array(z.string().min(1)).optional(),
        overwrite: z.boolean().optional().default(false),
        minScore: z.number().int().min(0).max(100).optional().default(45),
      },
      annotations: proposalToolAnnotations,
    },
    async ({ node, targetNode, kinds, bindingNames, overwrite, minScore }) =>
      toolResult(async () => {
        const current = await nodelClient.getNodeBindings(node);
        const [targetActions, targetSignals] = await Promise.all([
          nodelClient.getNodeActions(targetNode),
          nodelClient.getNodeSignals(targetNode),
        ]);
        const plan = buildDirectBindingPlan({
          sourceNode: current.node,
          targetNode: targetActions.node,
          schema: current.schema,
          currentBindings: current.bindings,
          targetActions: targetActions.actions,
          targetSignals: targetSignals.signals,
          kinds: kinds ?? "both",
          bindingNames,
          overwrite: overwrite ?? false,
          minScore: minScore ?? 45,
        });
        return withApprovalRequest(
          config,
          plan,
          "apply_node_binding_plan",
          current.node.name,
          bindingApprovalPayload({
            mode: "merge",
            currentHash: plan.currentHash,
            nextHash: plan.nextHash,
            bindings: plan.bindingPatch,
          }),
        );
      }),
  );
  server.registerTool(
    "nodel.propose_context_bindings",
    {
      title: "Propose Context Bindings",
      description:
        "Plan remote bindings for a frontend, dashboard, group, or control node by discovering likely target equipment from a room/context phrase and matching source binding names to target actions/signals. Use nodel.verify_write_plan before approval/apply.",
      inputSchema: {
        sourceNode: z.string().min(1),
        context: z.string().optional(),
        targetHint: z.string().optional(),
        candidateNodes: z.array(z.string().min(1)).optional(),
        excludeNodes: z.array(z.string().min(1)).optional(),
        kinds: bindingKindSchema.optional().default("both"),
        bindingNames: z.array(z.string().min(1)).optional(),
        overwrite: z.boolean().optional().default(false),
        minScore: z.number().int().min(0).max(100).optional().default(55),
        ambiguityMargin: z.number().int().min(0).max(50).optional().default(8),
        maxCandidates: z.number().int().min(1).max(50).optional().default(12),
      },
      annotations: proposalToolAnnotations,
    },
    async ({
      sourceNode,
      context,
      targetHint,
      candidateNodes,
      excludeNodes,
      kinds,
      bindingNames,
      overwrite,
      minScore,
      ambiguityMargin,
      maxCandidates,
    }) =>
      toolResult(async () => {
        const current = await nodelClient.getNodeBindings(sourceNode);
        const resolvedContext = context ?? inferContextFromName(current.node.name);
        const candidates = await discoverContextCandidates(nodelClient, {
          sourceNodeName: current.node.name,
          context: resolvedContext,
          targetHint,
          candidateNodes,
          excludeNodes,
          maxCandidates: maxCandidates ?? 12,
        });
        const plan = buildContextBindingPlan({
          sourceNode: current.node,
          context: resolvedContext,
          targetHint,
          schema: current.schema,
          currentBindings: current.bindings,
          candidates,
          kinds: kinds ?? "both",
          bindingNames,
          overwrite: overwrite ?? false,
          minScore: minScore ?? 55,
          ambiguityMargin: ambiguityMargin ?? 8,
        });
        return withApprovalRequest(
          config,
          plan,
          "set_node_bindings",
          current.node.name,
          bindingApprovalPayload({
            mode: "merge",
            currentHash: plan.currentHash,
            nextHash: plan.nextHash,
            bindings: plan.bindingPatch,
          }),
        );
      }),
  );
}

function registerWriteTools(server: McpServer, nodelClient: NodelClient, config: AppConfig) {
  server.registerTool(
    "nodel.call_action",
    {
      title: "Call Node Action",
      description: "Call a node action with optional args. Side effects require NODEL_ENABLE_WRITES=true.",
      inputSchema: {
        ...nodeInput,
        action: z.string().min(1),
        args: z.unknown().optional(),
        method: z.enum(["POST", "GET", "PUT"]).optional().default("POST"),
        dryRun: z.boolean().optional().default(false),
        approvalId: z.string().optional(),
        reason: z.string().optional(),
      },
      annotations: writeToolAnnotations,
    },
    async (input) =>
      toolResult(async () =>
        callAction(nodelClient, config, {
          ...input,
          method: input.method ?? "POST",
          dryRun: input.dryRun ?? false,
        }),
      ),
  );
  server.registerTool(
    "nodel.set_node_parameter",
    {
      title: "Set Node Parameter",
      description:
        "Safely set one node parameter by reading REST/params, merging this value into the current parameter object, then POSTing the full result to Nodel's replace-only REST/params/save endpoint. Waits for post-write node readiness by default because Nodel may restart the node. Side effects require NODEL_ENABLE_WRITES=true.",
      inputSchema: {
        ...nodeInput,
        name: z.string().min(1),
        value: z.unknown(),
        expectedHash: z.string().optional(),
        dryRun: z.boolean().optional().default(false),
        waitForReady: z.boolean().optional().default(true),
        readyTimeoutSeconds: z.number().int().min(1).max(120).optional(),
        approvalId: z.string().optional(),
        reason: z.string().optional(),
      },
      annotations: writeToolAnnotations,
    },
    async ({ node, name, value, expectedHash, dryRun, waitForReady, readyTimeoutSeconds, approvalId, reason }) =>
      toolResult(async () =>
        setParameters(nodelClient, config, {
          operation: "set_node_parameter",
          node,
          values: { [name]: value },
          mode: "merge",
          expectedHash,
          dryRun: dryRun ?? false,
          waitForReady: waitForReady ?? true,
          readyTimeoutSeconds,
          approvalId,
          reason,
        }),
      ),
  );
  server.registerTool(
    "nodel.patch_node_parameters",
    parameterTool(
      "nodel.patch_node_parameters",
      "Patch Node Parameters",
      "Preferred partial parameter update helper. Reads REST/params, deep-merges values into the current parameter object, optionally removes explicit removePaths, then POSTs the full result to Nodel's replace-only REST/params/save endpoint. Null values are assigned, not deleted. Use nodel.verify_write_plan before approval/apply.",
    ),
    async (input) =>
      toolResult(async () =>
        setParameters(nodelClient, config, {
          ...input,
          operation: "patch_node_parameters",
          mode: "merge",
          dryRun: input.dryRun ?? false,
          waitForReady: input.waitForReady ?? true,
        }),
      ),
  );
  server.registerTool(
    "nodel.set_node_parameters",
    parameterTool(
      "nodel.set_node_parameters",
      "Set Node Parameters",
      "Set multiple node parameters. Defaults to mode=merge, which reads REST/params and deep-merges values into the current parameter object, optionally removes explicit removePaths, then POSTs the full result to Nodel's replace-only REST/params/save endpoint. Use removePaths to delete explicit keys. Use mode=replace only for a full binding overwrite. Waits for post-write node readiness by default because Nodel may restart the node. Side effects require NODEL_ENABLE_WRITES=true.",
    ),
    async (input) =>
      toolResult(async () =>
        setParameters(nodelClient, config, {
          ...input,
          operation: "set_node_parameters",
          mode: input.mode ?? "merge",
          dryRun: input.dryRun ?? false,
          waitForReady: input.waitForReady ?? true,
        }),
      ),
  );
  server.registerTool(
    "nodel.patch_node_bindings",
    bindingTool(
      "nodel.patch_node_bindings",
      "Patch Node Bindings",
      "Preferred partial binding update helper. Reads REST/remote, deep-merges bindings into the current binding object, optionally removes explicit removePaths, then POSTs the full result to Nodel's replace-only REST/remote/save endpoint. Null values are assigned, not deleted. Use nodel.verify_write_plan before approval/apply.",
    ),
    async (input) =>
      toolResult(async () =>
        setBindings(nodelClient, config, {
          ...input,
          operation: "patch_node_bindings",
          mode: "merge",
          dryRun: input.dryRun ?? false,
        }),
      ),
  );
  server.registerTool(
    "nodel.set_node_bindings",
    bindingTool(
      "nodel.set_node_bindings",
      "Set Node Bindings",
      "Set remote bindings. Defaults to mode=merge, which reads REST/remote and deep-merges bindings into the current binding object, optionally removes explicit removePaths. Use mode=replace only for a full binding overwrite.",
    ),
    async (input) =>
      toolResult(async () =>
        setBindings(nodelClient, config, {
          ...input,
          operation: "set_node_bindings",
          mode: input.mode ?? "merge",
          dryRun: input.dryRun ?? false,
        }),
      ),
  );
  server.registerTool(
    "nodel.apply_node_binding_plan",
    {
      title: "Apply Node Binding Plan",
      description:
        "Plan and apply remote bindings from one node to a target node. Requires NODEL_ENABLE_WRITES=true unless dryRun is true. Use nodel.verify_write_plan before approval/apply.",
      inputSchema: {
        node: z.string().min(1),
        targetNode: z.string().min(1),
        expectedHash: z.string(),
        kinds: bindingKindSchema.optional().default("both"),
        bindingNames: z.array(z.string().min(1)).optional(),
        overwrite: z.boolean().optional().default(false),
        minScore: z.number().int().min(0).max(100).optional().default(45),
        dryRun: z.boolean().optional().default(false),
        approvalId: z.string().optional(),
        reason: z.string().optional(),
      },
      annotations: writeToolAnnotations,
    },
    async (input) =>
      toolResult(async () =>
        applyBindingPlan(nodelClient, config, {
          ...input,
          kinds: input.kinds ?? "both",
          overwrite: input.overwrite ?? false,
          minScore: input.minScore ?? 45,
          dryRun: input.dryRun ?? false,
        }),
      ),
  );
}

function parameterTool(name: string, title: string, description: string) {
  return {
    title,
    description,
    inputSchema: {
      ...nodeInput,
      values: z.record(z.string(), z.unknown()),
      mode: configWriteModeSchema.optional(),
      removePaths: z.array(removePathSchema).optional(),
      expectedHash: z.string().optional(),
      dryRun: z.boolean().optional().default(false),
      waitForReady: z.boolean().optional().default(true),
      readyTimeoutSeconds: z.number().int().min(1).max(120).optional(),
      approvalId: z.string().optional(),
      reason: z.string().optional(),
    },
    annotations: writeToolAnnotations,
    _name: name,
  };
}
function bindingTool(name: string, title: string, description: string) {
  return {
    title,
    description,
    inputSchema: {
      ...nodeInput,
      bindings: z.record(z.string(), z.unknown()),
      mode: configWriteModeSchema.optional(),
      removePaths: z.array(removePathSchema).optional(),
      expectedHash: z.string().optional(),
      dryRun: z.boolean().optional().default(false),
      approvalId: z.string().optional(),
      reason: z.string().optional(),
    },
    annotations: writeToolAnnotations,
    _name: name,
  };
}
function resolveDefinitionName(definitions: unknown, input: string, label: string) {
  const matched = bestNameMatch(normalizeDefinitions(definitions), (entry) => entry.name, input);
  if (!matched) throw publicError("VALIDATION", `No ${label} matched: ${input}`);
  return matched.name;
}
function normalizeDefinitions(value: unknown): Array<{ name: string }> {
  return Array.isArray(value)
    ? value.map((definition, index) => ({
        name: readString(isRecord(definition) ? definition.name : undefined) ?? String(index),
      }))
    : isRecord(value)
      ? Object.keys(value).map((name) => ({ name }))
      : [];
}
function filterObject(value: unknown, names: string[] | undefined) {
  return !names || names.length === 0 || !isRecord(value)
    ? value
    : Object.fromEntries(Object.entries(value).filter(([key]) => names.includes(key)));
}
function withApprovalRequest<T extends Record<string, unknown>>(
  config: AppConfig,
  plan: T,
  operation: string,
  target: string,
  payload: unknown,
) {
  const details = {
    operation,
    target,
    proposalHash: stableJsonHash({ operation, target, payload }),
  };
  return { ...plan, approvalRequest: approvalRequest(config, details) };
}
function inferContextFromName(name: string) {
  const withoutRole = name.replace(
    /\b(frontend|dashboard|control|controller|group|media player|player|display|tv|monitor|projector)\b/giu,
    " ",
  );
  return (
    withoutRole
      .replace(/\s*[-_:]\s*$/u, "")
      .replace(/\s+/gu, " ")
      .trim() || name
  );
}
