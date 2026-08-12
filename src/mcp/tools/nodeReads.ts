import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertSafeRecipePath } from "../../nodel/pathPolicy.js";
import type { NodelClient } from "../../nodel/client.js";
import { remoteReadOnlyToolAnnotations } from "../toolAnnotations.js";
import { extractEntries, extractFileEntries, isRecord, toolResult, truncateUtf8 } from "./common.js";
import { sha256 } from "../../shared/canonicalJson.js";
import { filterBindings, filterDefinitions, hasPointFilters, summarizeDefinitions } from "./pointFiltering.js";

const nodeInput = { node: z.string().min(1) };
const pointFilterInput = {
  names: z.array(z.string().min(1)).max(200).optional(),
  filter: z.string().min(1).max(256).optional(),
  caseSensitive: z.boolean().optional().default(false),
  summaryOnly: z.boolean().optional().default(false),
};
const textExtensions = new Set([
  "",
  ".py",
  ".js",
  ".ts",
  ".json",
  ".jsonc",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
  ".html",
  ".css",
  ".xml",
  ".csv",
  ".ini",
  ".cfg",
  ".conf",
]);

export function registerNodeReadTools(server: McpServer, nodelClient: NodelClient) {
  server.registerTool(
    "nodel.get_node_actions",
    {
      title: "Get Node Actions",
      description:
        "Inspect callable actions via GET REST/actions, with optional exact-name or safe-regex filtering and summary-only output.",
      inputSchema: {
        ...nodeInput,
        ...pointFilterInput,
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ node, names, filter, caseSensitive, summaryOnly }) =>
      toolResult(async () => {
        const result = await nodelClient.getNodeActions(node);
        if (summaryOnly !== true && !hasPointFilters({ names, filter })) {
          return { ...result, summary: summarizeDefinitions(result.actions) };
        }

        const filtered = filterDefinitions(result.actions, { names, filter, caseSensitive: caseSensitive ?? false });
        if (summaryOnly === true) {
          return {
            node: result.node,
            totalCount: filtered.totalCount,
            matchedCount: filtered.matchedCount,
            summaries: filtered.summaries,
          };
        }
        return {
          node: result.node,
          actions: filtered.value,
          totalCount: filtered.totalCount,
          matchedCount: filtered.matchedCount,
          summary: filtered.summaries,
          summaries: filtered.summaries,
        };
      }),
  );

  server.registerTool(
    "nodel.get_node_signals",
    {
      title: "Get Node Signals",
      description:
        "Inspect node signals/events via GET REST/events, with optional exact-name or safe-regex filtering and summary-only output.",
      inputSchema: {
        ...nodeInput,
        ...pointFilterInput,
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ node, names, filter, caseSensitive, summaryOnly }) =>
      toolResult(async () => {
        const result = await nodelClient.getNodeSignals(node);
        if (summaryOnly !== true && !hasPointFilters({ names, filter })) {
          return { ...result, summary: summarizeDefinitions(result.signals) };
        }

        const filtered = filterDefinitions(result.signals, { names, filter, caseSensitive: caseSensitive ?? false });
        if (summaryOnly === true) {
          return {
            node: result.node,
            totalCount: filtered.totalCount,
            matchedCount: filtered.matchedCount,
            summaries: filtered.summaries,
          };
        }
        return {
          node: result.node,
          signals: filtered.value,
          totalCount: filtered.totalCount,
          matchedCount: filtered.matchedCount,
          summary: filtered.summaries,
          summaries: filtered.summaries,
        };
      }),
  );

  server.registerTool(
    "nodel.get_node_bindings",
    {
      title: "Get Node Bindings",
      description:
        "Inspect configured remote bindings/schema, with optional exact-name or safe-regex filtering, summary-only output, and status.",
      inputSchema: {
        ...nodeInput,
        includeStatus: z.boolean().optional().default(false),
        ...pointFilterInput,
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ node, includeStatus, names, filter, caseSensitive, summaryOnly }) =>
      toolResult(async () => {
        const bindings = await nodelClient.getNodeBindings(node);
        if (includeStatus !== true && summaryOnly !== true && !hasPointFilters({ names, filter })) {
          return bindings;
        }

        const bindingStatus =
          includeStatus === true
            ? extractEntries((await nodelClient.getNodeActivity(bindings.node, -1)).activity).filter(
                isBindingStatusEntry,
              )
            : undefined;

        if (summaryOnly !== true && !hasPointFilters({ names, filter })) {
          return {
            ...bindings,
            bindingStatus,
          };
        }

        const filtered = filterBindings(bindings.schema, bindings.bindings, bindingStatus, {
          names,
          filter,
          caseSensitive: caseSensitive ?? false,
        });
        if (summaryOnly === true) {
          return {
            node: bindings.node,
            totalCount: filtered.totalCount,
            matchedCount: filtered.matchedCount,
            summaries: filtered.summaries,
          };
        }

        return {
          node: bindings.node,
          schema: filtered.schema,
          bindings: filtered.bindings,
          bindingStatus: includeStatus === true ? filtered.bindingStatus : undefined,
          totalCount: filtered.totalCount,
          matchedCount: filtered.matchedCount,
          summaries: filtered.summaries,
        };
      }),
  );

  server.registerTool(
    "nodel.get_node_files",
    {
      title: "Get Node Files",
      description: "Read node recipe file lists and capped text file contents via REST/files endpoints.",
      inputSchema: {
        ...nodeInput,
        paths: z.array(z.string().min(1)).optional(),
        includeContents: z.boolean().optional().default(false),
        maxBytesPerFile: z.number().int().min(1).max(262144).optional().default(65536),
        maxFiles: z.number().int().min(1).max(200).optional().default(20),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ node, paths, includeContents, maxBytesPerFile, maxFiles }) =>
      toolResult(async () => {
        const listed = await nodelClient.getNodeFiles(node);
        const entries = extractFileEntries(listed.files);
        const explicitPaths = paths?.map(assertSafeRecipePath);
        const selectedPaths = selectContentPaths(entries, explicitPaths, includeContents, maxFiles ?? 20);
        const contents: Record<string, unknown> = {};

        for (const path of selectedPaths) {
          const entry = entries.find((candidate) => candidate.path === path);
          if (!isLikelyTextFile(path)) {
            if (explicitPaths?.includes(path)) {
              const bytes = await nodelClient.getNodeFileBytes(listed.node, path);
              contents[path] = { binary: true, sha256: sha256(bytes), byteLength: bytes.byteLength };
              continue;
            }
            contents[path] = { skipped: true, reason: "binary_or_unknown_extension" };
            continue;
          }
          if (typeof entry?.size === "number" && entry.size > (maxBytesPerFile ?? 65536)) {
            contents[path] = { skipped: true, reason: "oversized", size: entry.size, maxBytes: maxBytesPerFile };
            continue;
          }

          const text = await nodelClient.getNodeFileContents(listed.node, path);
          const truncated = Buffer.byteLength(text, "utf8") > (maxBytesPerFile ?? 65536);
          contents[path] = {
            text: truncateUtf8(text, maxBytesPerFile ?? 65536),
            sha256: sha256(text),
            truncated,
            maxBytes: maxBytesPerFile,
          };
        }

        return { ...listed, normalizedFiles: entries, contents };
      }),
  );

  server.registerTool(
    "nodel.get_node_activity",
    {
      title: "Get Node Activity",
      description: "Read action, signal, and binding activity via GET REST/activity.",
      inputSchema: {
        ...nodeInput,
        from: z.number().int().optional().default(-1),
        maxEntries: z.number().int().min(1).max(10000).optional(),
        includeBindingStatus: z.boolean().optional().default(false),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ node, from, maxEntries, includeBindingStatus }) =>
      toolResult(async () => {
        const result = await nodelClient.getNodeActivity(node, from ?? -1);
        const entries = limitEntries(extractEntries(result.activity), maxEntries);
        return {
          ...result,
          entries,
          bindingStatus: includeBindingStatus ? entries.filter(isBindingStatusEntry) : undefined,
        };
      }),
  );

  server.registerTool(
    "nodel.get_node_console",
    {
      title: "Get Node Console",
      description: "Read recipe console logs via GET REST/console without executing console code.",
      inputSchema: {
        ...nodeInput,
        from: z.number().int().optional().default(-1),
        max: z.number().int().min(1).max(10000).optional().default(200),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ node, from, max }) =>
      toolResult(async () => {
        const result = await nodelClient.getNodeConsole(node, from ?? -1, max ?? 200);
        return { ...result, entries: extractEntries(result.console) };
      }),
  );

  server.registerTool(
    "nodel.get_logs",
    {
      title: "Get Logs Compatibility Wrapper",
      description:
        "Compatibility wrapper for read-only activity and console logs. Prefer nodel.get_node_activity or nodel.get_node_console.",
      inputSchema: {
        ...nodeInput,
        source: z.enum(["activity", "console", "both"]).optional().default("both"),
        from: z.number().int().optional().default(-1),
        max: z.number().int().min(1).max(10000).optional().default(200),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ node, source, from, max }) =>
      toolResult(async () => {
        const selected = source ?? "both";
        const result: Record<string, unknown> = {
          node,
          source: selected,
          message: "Compatibility wrapper. Prefer nodel.get_node_activity or nodel.get_node_console.",
        };

        if (selected === "activity" || selected === "both") {
          result.activity = await nodelClient.getNodeActivity(node, from ?? -1);
        }
        if (selected === "console" || selected === "both") {
          result.console = await nodelClient.getNodeConsole(node, from ?? -1, max ?? 200);
        }

        return result;
      }),
  );
}

function selectContentPaths(
  entries: Array<{ path: string }>,
  explicitPaths: string[] | undefined,
  includeContents: boolean | undefined,
  maxFiles: number,
) {
  if (includeContents !== true && (!explicitPaths || explicitPaths.length === 0)) {
    return [];
  }
  if (explicitPaths && explicitPaths.length > 0) {
    return explicitPaths.slice(0, maxFiles);
  }

  const paths = entries.map((entry) => entry.path);
  const preferred = paths.filter((path) => path === "script.py" || isLikelyTextFile(path));
  return preferred.slice(0, maxFiles);
}

function limitEntries(entries: unknown[], maxEntries: number | undefined) {
  return typeof maxEntries === "number" ? entries.slice(-maxEntries) : entries;
}

function isBindingStatusEntry(entry: unknown) {
  return (
    isRecord(entry) && entry.source === "remote" && (entry.type === "eventBinding" || entry.type === "actionBinding")
  );
}

function isLikelyTextFile(path: string) {
  const name = path.toLowerCase();
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot) : "";
  return textExtensions.has(extension);
}
