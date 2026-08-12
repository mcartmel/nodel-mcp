import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import type { NodelClient } from "../../nodel/client.js";
import { assertSafeRecipePath } from "../../nodel/pathPolicy.js";
import {
  assertSupportingFilePath,
  nodeFileSaveRequest as domainNodeFileSaveRequest,
  normalizeBase64Content,
  normalizeRecipeScript,
  normalizeTextContent,
  verifyComposedRecipeForNode,
  proposeRecipeScript,
  proposeRecipeScriptEdit,
  proposeNodeFile,
  proposeNodeFileEdit,
  saveRecipeScript,
  applyRecipeScriptEdit,
  saveNodeFile,
  applyNodeFileEdit,
  restartNode,
  createNode,
  deleteNode,
  SCRIPT_PATH,
} from "../../domain/recipes/service.js";
import {
  destructiveWriteToolAnnotations,
  proposalToolAnnotations,
  remoteReadOnlyToolAnnotations,
  writeToolAnnotations,
} from "../toolAnnotations.js";
import { toolResult } from "./common.js";
import { publicError, sanitizeSensitiveMessage } from "../../shared/publicErrors.js";

export {
  assertSupportingFilePath,
  applyTextEdits,
  normalizeBase64Content,
  normalizeRecipeScript,
  normalizeTextContent,
  readOptionalNodeFileBytes,
  recipeScriptSaveRequest,
} from "../../domain/recipes/service.js";

export function nodeFileSaveRequest(path: string, bytes: Uint8Array) {
  return domainNodeFileSaveRequest(assertSupportingFilePath(path), bytes);
}

const nodeInput = { node: z.string().min(1) };
const textEditSchema = z
  .object({
    oldText: z.string().min(1),
    newText: z.string(),
    replaceAll: z.boolean().optional().default(false),
  })
  .strict();
const textEdits = z.array(textEditSchema).min(1);

export function registerRecipeWriteTools(server: McpServer, nodelClient: NodelClient, config: AppConfig) {
  server.registerTool(
    "nodel.describe_node",
    {
      title: "Describe Node",
      description: "Resolve a node and return key read-only metadata for planning.",
      inputSchema: nodeInput,
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ node }) =>
      toolResult(async () => {
        const resolved = await nodelClient.resolveNode(node);
        const [actions, signals, bindings] = await Promise.all([
          nodelClient.getNodeActions(resolved).catch((error) => ({ error: sanitizeSensitiveMessage(error) })),
          nodelClient.getNodeSignals(resolved).catch((error) => ({ error: sanitizeSensitiveMessage(error) })),
          nodelClient.getNodeBindings(resolved).catch((error) => ({ error: sanitizeSensitiveMessage(error) })),
        ]);
        return { node: resolved, actions, signals, bindings };
      }),
  );
  server.registerTool(
    "nodel.verify_recipe_script",
    {
      title: "Verify Recipe Script",
      description:
        "Run heuristic static analysis of a Python recipe file or composed recipe load order for likely Python 2.5/Jython 2.5 and import/call-policy issues. It has false positives and false negatives, is not a complete parser, and requires runtime verification in Nodel.",
      inputSchema: {
        ...nodeInput,
        path: z.string().min(1).optional(),
        script: z.string().optional(),
        verifyComposedRecipe: z.boolean().optional().default(false),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ node, path, script, verifyComposedRecipe }) =>
      toolResult(async () => {
        const resolved = await nodelClient.resolveNode(node);
        const safePath = assertSafeRecipePath(path ?? SCRIPT_PATH);
        if (!safePath.endsWith(".py")) throw publicError("VALIDATION", "Recipe verification path must end with .py.");
        const source = script ?? (await nodelClient.getNodeFileContents(resolved, safePath));
        const normalized = normalizeRecipeScript(source, safePath);
        const response: Record<string, unknown> = {
          node: resolved,
          path: safePath,
          source: script === undefined ? "current" : "provided",
          byteLength: normalized.byteLength,
          sourceHash: normalized.hash,
          staticAnalysisOnly: true,
          message:
            "Heuristic static analysis only; no Jython execution or Nodel runtime import/load was performed. False positives and false negatives are possible; runtime verification is required.",
          recipeVerification: normalized.recipeVerification,
        };
        if (verifyComposedRecipe)
          response.composedRecipeVerification = await verifyComposedRecipeForNode(
            nodelClient,
            resolved,
            script === undefined ? undefined : { path: safePath, content: script },
          );
        return response;
      }),
  );
  registerProposalTools(server, nodelClient, config);
  if (config.writesEnabled) registerSaveTools(server, nodelClient, config);
  if (config.writesEnabled && config.nodeLifecycleEnabled) registerLifecycleTools(server, nodelClient, config);
  if (config.writesEnabled && config.nodeLifecycleEnabled && config.deletesEnabled)
    registerDeleteTool(server, nodelClient, config);
}

function registerProposalTools(server: McpServer, client: NodelClient, config: AppConfig) {
  server.registerTool(
    "nodel.propose_recipe_script",
    {
      title: "Propose Recipe Script Save",
      description:
        "Read the current main Python recipe script and propose a full replacement. Script saves use REST/script/save, reload the node, and require recipe validation plus post-save readiness checks.",
      inputSchema: {
        ...nodeInput,
        script: z.string().describe("Complete replacement Python recipe script."),
        expectedHash: z.string().optional(),
        detail: z.string().optional(),
      },
      annotations: proposalToolAnnotations,
    },
    async ({ node, script, expectedHash, detail }) =>
      toolResult(async () => proposeRecipeScript(client, config, node, script, expectedHash, detail)),
  );
  server.registerTool(
    "nodel.propose_recipe_script_edit",
    {
      title: "Propose Recipe Script Edit",
      description:
        "Read the main Python recipe script and apply exact text replacements in memory without modifying the node.",
      inputSchema: {
        ...nodeInput,
        edits: textEdits,
        expectedHash: z.string().optional(),
        detail: z.string().optional(),
        includeContent: z.boolean().optional().default(true),
      },
      annotations: proposalToolAnnotations,
    },
    async ({ node, edits, expectedHash, detail, includeContent }) =>
      toolResult(async () =>
        proposeRecipeScriptEdit(client, config, node, edits, expectedHash, detail, includeContent ?? true),
      ),
  );
  server.registerTool(
    "nodel.propose_node_file_text",
    {
      title: "Propose Supporting Text File Save",
      description:
        "Read a supporting node file and propose a text save via REST/files/save. This rejects script.py, does not reload the node, and does not run recipe validation.",
      inputSchema: {
        ...nodeInput,
        path: z.string().min(1),
        content: z.string().describe("Complete replacement text content."),
        expectedHash: z.string().optional(),
        detail: z.string().optional(),
      },
      annotations: proposalToolAnnotations,
    },
    async ({ node, path, content, expectedHash, detail }) =>
      toolResult(async () =>
        proposeNodeFile(client, config, node, path, normalizeTextContent(content), expectedHash, detail),
      ),
  );
  server.registerTool(
    "nodel.propose_node_file_base64",
    {
      title: "Propose Supporting Base64 File Save",
      description:
        "Read a supporting node file and propose a base64/binary save via REST/files/save. This rejects script.py, does not reload the node, and does not run recipe validation.",
      inputSchema: {
        ...nodeInput,
        path: z.string().min(1),
        contentBase64: z.string().describe("Complete replacement content encoded as standard base64."),
        expectedHash: z.string().optional(),
        detail: z.string().optional(),
      },
      annotations: proposalToolAnnotations,
    },
    async ({ node, path, contentBase64, expectedHash, detail }) =>
      toolResult(async () =>
        proposeNodeFile(client, config, node, path, normalizeBase64Content(contentBase64), expectedHash, detail),
      ),
  );
  server.registerTool(
    "nodel.propose_node_file_edit",
    {
      title: "Propose Supporting Text File Edit",
      description:
        "Read a supporting text file and apply exact text replacements in memory without modifying the node. This rejects script.py and does not run recipe validation.",
      inputSchema: {
        ...nodeInput,
        path: z.string().min(1),
        edits: textEdits,
        expectedHash: z.string().optional(),
        detail: z.string().optional(),
        includeContent: z.boolean().optional().default(true),
      },
      annotations: proposalToolAnnotations,
    },
    async ({ node, path, edits, expectedHash, detail, includeContent }) =>
      toolResult(async () =>
        proposeNodeFileEdit(client, config, node, path, edits, expectedHash, detail, includeContent ?? true),
      ),
  );
}

function registerSaveTools(server: McpServer, client: NodelClient, config: AppConfig) {
  server.registerTool(
    "nodel.save_recipe_script",
    {
      title: "Save Recipe Script",
      description:
        "Save the main Python recipe script via REST/script/save. This reloads the node, blocks invalid recipes, and waits for post-save readiness by default.",
      inputSchema: {
        ...nodeInput,
        script: z.string().describe("Complete replacement Python recipe script."),
        expectedHash: z.string(),
        dryRun: z.boolean().optional().default(false),
        waitForReady: z.boolean().optional().default(true),
        readyTimeoutSeconds: z.number().int().min(1).max(120).optional(),
        approvalId: z.string().optional(),
        reason: z.string().optional(),
      },
      annotations: writeToolAnnotations,
    },
    async ({ node, script, expectedHash, dryRun, waitForReady, readyTimeoutSeconds, approvalId, reason }) =>
      toolResult(async () =>
        saveRecipeScript(
          client,
          config,
          node,
          script,
          expectedHash,
          dryRun ?? false,
          waitForReady ?? true,
          readyTimeoutSeconds,
          reason,
          { operation: "save_recipe_script" },
          approvalId,
        ),
      ),
  );
  server.registerTool(
    "nodel.apply_recipe_script_edit",
    {
      title: "Apply Recipe Script Edit",
      description:
        "Apply approved exact text replacements to the main Python recipe script via REST/script/save. This reloads the node and waits for readiness by default.",
      inputSchema: {
        ...nodeInput,
        edits: textEdits,
        expectedHash: z.string(),
        dryRun: z.boolean().optional().default(false),
        waitForReady: z.boolean().optional().default(true),
        readyTimeoutSeconds: z.number().int().min(1).max(120).optional(),
        approvalId: z.string().optional(),
        reason: z.string().optional(),
      },
      annotations: writeToolAnnotations,
    },
    async ({ node, edits, expectedHash, dryRun, waitForReady, readyTimeoutSeconds, approvalId, reason }) =>
      toolResult(async () =>
        applyRecipeScriptEdit(
          client,
          config,
          node,
          edits,
          expectedHash,
          dryRun ?? false,
          waitForReady ?? true,
          readyTimeoutSeconds,
          reason,
          approvalId,
        ),
      ),
  );
  server.registerTool(
    "nodel.save_node_file_text",
    {
      title: "Save Supporting Text File",
      description:
        "Save a supporting text file via REST/files/save. Rejects script.py, does not reload the node, and does not run recipe validation.",
      inputSchema: {
        ...nodeInput,
        path: z.string().min(1),
        content: z.string().describe("Complete replacement text content."),
        expectedHash: z.string().optional(),
        dryRun: z.boolean().optional().default(false),
        approvalId: z.string().optional(),
        reason: z.string().optional(),
      },
      annotations: writeToolAnnotations,
    },
    async ({ node, path, content, expectedHash, dryRun, approvalId, reason }) =>
      toolResult(async () =>
        saveNodeFile(
          client,
          config,
          node,
          path,
          normalizeTextContent(content),
          expectedHash,
          dryRun ?? false,
          reason,
          { operation: "save_node_file" },
          approvalId,
        ),
      ),
  );
  server.registerTool(
    "nodel.save_node_file_base64",
    {
      title: "Save Supporting Base64 File",
      description:
        "Save a supporting binary/base64 file via REST/files/save. Rejects script.py, does not reload the node, and does not run recipe validation.",
      inputSchema: {
        ...nodeInput,
        path: z.string().min(1),
        contentBase64: z.string().describe("Complete replacement content encoded as standard base64."),
        expectedHash: z.string().optional(),
        dryRun: z.boolean().optional().default(false),
        approvalId: z.string().optional(),
        reason: z.string().optional(),
      },
      annotations: writeToolAnnotations,
    },
    async ({ node, path, contentBase64, expectedHash, dryRun, approvalId, reason }) =>
      toolResult(async () =>
        saveNodeFile(
          client,
          config,
          node,
          path,
          normalizeBase64Content(contentBase64),
          expectedHash,
          dryRun ?? false,
          reason,
          { operation: "save_node_file" },
          approvalId,
        ),
      ),
  );
  server.registerTool(
    "nodel.apply_node_file_edit",
    {
      title: "Apply Supporting Text File Edit",
      description:
        "Apply exact text replacements to a supporting text file via REST/files/save. Rejects script.py, does not reload the node, and does not run recipe validation.",
      inputSchema: {
        ...nodeInput,
        path: z.string().min(1),
        edits: textEdits,
        expectedHash: z.string().optional(),
        dryRun: z.boolean().optional().default(false),
        approvalId: z.string().optional(),
        reason: z.string().optional(),
      },
      annotations: writeToolAnnotations,
    },
    async ({ node, path, edits, expectedHash, dryRun, approvalId, reason }) =>
      toolResult(async () =>
        applyNodeFileEdit(client, config, node, path, edits, expectedHash, dryRun ?? false, reason, approvalId),
      ),
  );
}

function registerLifecycleTools(server: McpServer, client: NodelClient, config: AppConfig) {
  server.registerTool(
    "nodel.restart_node",
    {
      title: "Restart Node",
      description:
        "Restart a node. Requires NODEL_ENABLE_WRITES=true and NODEL_ENABLE_NODE_LIFECYCLE=true unless dryRun is true.",
      inputSchema: {
        ...nodeInput,
        dryRun: z.boolean().optional().default(false),
        approvalId: z.string().optional(),
        reason: z.string().optional(),
      },
      annotations: writeToolAnnotations,
    },
    async ({ node, dryRun, approvalId, reason }) =>
      toolResult(async () => restartNode(client, config, node, dryRun ?? false, approvalId, reason)),
  );
  server.registerTool(
    "nodel.create_node",
    {
      title: "Create Node",
      description:
        "Create a node on the local runtime, or on an explicit remote Nodel runtimeUrl. Requires lifecycle writes unless dryRun is true.",
      inputSchema: {
        name: z.string().min(1),
        runtimeUrl: z.string().url().optional(),
        dryRun: z.boolean().optional().default(false),
        approvalId: z.string().optional(),
        reason: z.string().optional(),
      },
      annotations: writeToolAnnotations,
    },
    async ({ name, runtimeUrl, dryRun, approvalId, reason }) =>
      toolResult(async () => createNode(client, config, name, runtimeUrl, dryRun ?? false, approvalId, reason)),
  );
}

function registerDeleteTool(server: McpServer, client: NodelClient, config: AppConfig) {
  server.registerTool(
    "nodel.delete_node",
    {
      title: "Delete Node",
      description:
        "Delete a node. Requires writes, lifecycle, delete gate, and exact name confirmation unless dryRun is true.",
      inputSchema: {
        ...nodeInput,
        confirmNodeName: z.string().optional(),
        dryRun: z.boolean().optional().default(false),
        approvalId: z.string().optional(),
        reason: z.string().optional(),
      },
      annotations: destructiveWriteToolAnnotations,
    },
    async ({ node, confirmNodeName, dryRun, approvalId, reason }) =>
      toolResult(async () => deleteNode(client, config, node, confirmNodeName, dryRun ?? false, approvalId, reason)),
  );
}
