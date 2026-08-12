import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getObjectShape, normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { NodelClient } from "../../nodel/client.js";
import { registerApprovalTools, type ElicitInput } from "../tools/approvals.js";
import { registerAuditReadTools } from "../tools/auditReads.js";
import { registerGuidanceTools } from "../tools/guidance.js";
import { registerHealthTool } from "../tools/health.js";
import { registerListNodesTool } from "../tools/listNodes.js";
import { registerNodeReadyTool } from "../tools/nodeReady.js";
import { registerNodeReadTools } from "../tools/nodeReads.js";
import { registerNodeWriteTools } from "../tools/nodeWrites.js";
import { registerPingTool } from "../tools/ping.js";
import { registerRecipeReadTools } from "../tools/recipeReads.js";
import { registerRecipeWriteTools } from "../tools/recipeWrites.js";
import { registerUiTools } from "../tools/ui.js";
import {
  TOOL_POLICIES,
  toolIsAvailable,
  type ToolCapability,
  type ToolGate,
  type ToolPolicy,
  type ToolStability,
  type WorkflowMetadata,
} from "./metadata.js";

export type { ToolCapability, ToolGate, ToolPolicy, ToolStability, WorkflowMetadata } from "./metadata.js";
export type ToolSpec = ToolPolicy & {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  jsonInputSchema: Record<string, unknown>;
  definition: unknown;
  annotations?: unknown;
  handler: ToolHandler;
  registration: string;
};

type ToolDefinition = {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
  [key: string]: unknown;
};
type ToolHandler = (...args: unknown[]) => unknown;
type RecordingServer = {
  registerTool(name: string, definition: ToolDefinition, handler: ToolHandler): void;
};
type Registrar = (server: RecordingServer, ...args: unknown[]) => void;
type Captured = {
  name: string;
  definition: ToolDefinition;
  handler: ToolHandler;
  registration: string;
};

const REGISTRARS: Array<{
  name: string;
  register: Registrar;
  args: "server" | "config" | "client" | "clientConfig" | "configElicitInput";
}> = [
  {
    name: "ping",
    register: registerPingTool as unknown as Registrar,
    args: "server",
  },
  {
    name: "guidance",
    register: registerGuidanceTools as unknown as Registrar,
    args: "config",
  },
  {
    name: "ui",
    register: registerUiTools as unknown as Registrar,
    args: "client",
  },
  {
    name: "health",
    register: registerHealthTool as unknown as Registrar,
    args: "clientConfig",
  },
  {
    name: "listNodes",
    register: registerListNodesTool as unknown as Registrar,
    args: "client",
  },
  {
    name: "auditReads",
    register: registerAuditReadTools as unknown as Registrar,
    args: "config",
  },
  {
    name: "nodeReads",
    register: registerNodeReadTools as unknown as Registrar,
    args: "client",
  },
  {
    name: "nodeReady",
    register: registerNodeReadyTool as unknown as Registrar,
    args: "client",
  },
  {
    name: "recipeReads",
    register: registerRecipeReadTools as unknown as Registrar,
    args: "clientConfig",
  },
  {
    name: "approvals",
    register: registerApprovalTools as unknown as Registrar,
    args: "configElicitInput",
  },
  {
    name: "nodeWrites",
    register: registerNodeWriteTools as unknown as Registrar,
    args: "clientConfig",
  },
  {
    name: "recipeWrites",
    register: registerRecipeWriteTools as unknown as Registrar,
    args: "clientConfig",
  },
];

export function collectToolSpecs(
  config: AppConfig,
  nodelClient = {} as NodelClient,
  elicitInput?: ElicitInput,
): ToolSpec[] {
  const captured: Captured[] = [];
  const recorder: RecordingServer = {
    registerTool(name, definition, handler) {
      if (!name || !definition || typeof handler !== "function")
        throw new Error(`Incomplete captured tool definition: ${name || "unnamed"}`);
      captured.push({ name, definition, handler, registration: "unknown" });
    },
  };
  for (const registrar of REGISTRARS) {
    if (registrar.args === "server") registrar.register(recorder);
    else if (registrar.args === "config") registrar.register(recorder, config);
    else if (registrar.args === "client") registrar.register(recorder, nodelClient);
    else if (registrar.args === "configElicitInput") registrar.register(recorder, config, elicitInput);
    else registrar.register(recorder, nodelClient, config);
    for (const entry of captured.filter((candidate) => candidate.registration === "unknown"))
      entry.registration = registrar.name;
  }
  const specs = captured.map((entry) => {
    const metadata = TOOL_POLICIES[entry.name];
    if (!metadata) throw new Error(`Registered tool is missing policy: ${entry.name}`);
    const inputSchema = strictObjectInputSchema(entry.definition.inputSchema);
    const definition = { ...entry.definition, inputSchema };
    return {
      ...metadata,
      name: entry.name,
      title: entry.definition.title ?? entry.name,
      description: entry.definition.description ?? "",
      inputSchema,
      jsonInputSchema: jsonInputSchema(inputSchema),
      definition,
      annotations: definition.annotations,
      handler: entry.handler,
      registration: entry.registration,
    };
  });
  const policyNames = Object.entries(TOOL_POLICIES)
    .filter(([, metadata]) => toolIsAvailable(metadata, config))
    .map(([name]) => name)
    .sort();
  const actualNames = specs.map((spec) => spec.name).sort();
  if (policyNames.join("\n") !== actualNames.join("\n")) {
    const policies = new Set(policyNames);
    const actual = new Set(actualNames);
    throw new Error(
      `Tool policy and runtime registration names differ. Missing policy: ${actualNames.filter((name) => !policies.has(name)).join(", ")}; unregistered policy: ${policyNames.filter((name) => !actual.has(name)).join(", ")}`,
    );
  }
  if (new Set(actualNames).size !== actualNames.length) throw new Error("Duplicate runtime tool registration.");
  return specs;
}

function jsonInputSchema(inputSchema: unknown): Record<string, unknown> {
  const objectSchema = normalizeObjectSchema(inputSchema as never);
  return objectSchema
    ? toJsonSchemaCompat(objectSchema, { strictUnions: true, pipeStrategy: "input" })
    : { type: "object", properties: {}, additionalProperties: false };
}

/** Canonical registrations reject unknown arguments instead of silently stripping them. */
function strictObjectInputSchema(inputSchema: unknown) {
  const objectSchema = normalizeObjectSchema(inputSchema as never);
  const shape = objectSchema && getObjectShape(objectSchema);
  if (!shape) return z.object({}).strict();
  return z.object(shape).strict();
}

export {
  assertToolReferences,
  toolIsAvailable,
  toolPolicies,
  unavailableReason,
  workflowMetadata,
} from "./metadata.js";
