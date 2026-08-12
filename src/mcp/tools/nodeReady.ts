import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NodelClient } from "../../nodel/client.js";
import { remoteReadOnlyToolAnnotations } from "../toolAnnotations.js";
import { extractEntries, isRecord, toolResult } from "./common.js";
import { sanitizeSensitiveMessage } from "../../shared/publicErrors.js";

const probeSchema = z.enum(["actions", "signals", "bindings", "activity", "console"]);
const CONSOLE_CUTOFF_TOLERANCE_MS = 1000;
type ReadinessClient = Pick<NodelClient, "resolveNode"> &
  Partial<
    Pick<
      NodelClient,
      "getNodeActions" | "getNodeSignals" | "getNodeBindings" | "getNodeActivity" | "getNodeConsole" | "nodeRequest"
    >
  >;

export function registerNodeReadyTool(server: McpServer, nodelClient: NodelClient) {
  server.registerTool(
    "nodel.verify_node_ready",
    {
      title: "Verify Node Ready",
      description:
        "Read-only readiness summary for a node using selected REST probes and current-runtime console error heuristics. Useful after writes or ambiguous reloads.",
      inputSchema: {
        node: z.string().min(1),
        probes: z.array(probeSchema).optional(),
        consoleMax: z.number().int().min(1).max(1000).optional().default(50),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ node, probes, consoleMax }) =>
      toolResult(async () => verifyNodeReady(nodelClient, node, probes, consoleMax ?? 50)),
  );
}

export async function verifyNodeReady(
  nodelClient: ReadinessClient,
  node: string,
  probes: Array<z.infer<typeof probeSchema>> | undefined,
  consoleMax: number,
) {
  const selected = probes && probes.length > 0 ? probes : (["actions", "signals", "bindings", "console"] as const);
  const resolved = await nodelClient.resolveNode(node);
  const results: Record<string, unknown> = {};
  const failures: string[] = [];
  let recentConsoleErrors: unknown[] = [];
  let staleConsoleErrors: unknown[] = [];

  for (const probe of selected) {
    try {
      if (probe === "actions") {
        const result = await nodelClient.getNodeActions!(resolved);
        results.actions = { ok: true, count: countDefinitions(result.actions) };
      } else if (probe === "signals") {
        const result = await nodelClient.getNodeSignals!(resolved);
        results.signals = { ok: true, count: countDefinitions(result.signals) };
      } else if (probe === "bindings") {
        const result = await nodelClient.getNodeBindings!(resolved);
        results.bindings = {
          ok: true,
          hasSchema: result.schema !== undefined,
          hasBindings: result.bindings !== undefined,
        };
      } else if (probe === "activity") {
        const result = await nodelClient.getNodeActivity!(resolved, -1);
        results.activity = { ok: true, count: extractEntries(result.activity).length };
      } else if (probe === "console") {
        const result = await nodelClient.getNodeConsole!(resolved, -1, consoleMax);
        const entries = extractEntries(result.console);
        const startedMs = await readNodeStartedMs(nodelClient, resolved);
        const classification = classifyConsoleErrors(entries, startedMs);
        recentConsoleErrors = classification.currentErrors.slice(-10).map((entry) => entry.entry);
        staleConsoleErrors = classification.staleErrors.slice(-10).map((entry) => entry.entry);
        results.console = {
          ok: true,
          count: entries.length,
          consoleCutoff:
            classification.cutoffMs === undefined ? undefined : new Date(classification.cutoffMs).toISOString(),
          consoleCutoffSource: classification.cutoffSource,
          recentConsoleErrors,
          staleConsoleErrors,
          staleConsoleErrorCount: classification.staleErrors.length,
        };
      }
    } catch (error) {
      failures.push(`${probe}: ${(error as Error).message}`);
      results[probe] = { ok: false, error: sanitizeSensitiveMessage(error) };
    }
  }

  const ready = failures.length === 0 && recentConsoleErrors.length === 0;
  return {
    node: resolved,
    ready,
    probes: results,
    failures,
    recentConsoleErrors,
    staleConsoleErrors,
    recommendedNextStep: ready
      ? staleConsoleErrors.length > 0
        ? "Node responded to selected probes. Stale console errors from before the current runtime were ignored for readiness. Continue with task-specific verification."
        : "Node responded to selected probes and no current-runtime console errors matched the heuristic. Continue with task-specific verification."
      : "Inspect failed probes and console/activity logs before further writes.",
  };
}

function countDefinitions(value: unknown) {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (isRecord(value)) {
    return Object.keys(value).length;
  }
  return undefined;
}

function isConsoleErrorEntry(entry: unknown) {
  const text = consoleEntryText(entry);
  return /error|exception|traceback|failed|syntax/iu.test(text);
}

async function readNodeStartedMs(
  nodelClient: ReadinessClient,
  node: Awaited<ReturnType<ReadinessClient["resolveNode"]>>,
) {
  try {
    const result = await nodelClient.nodeRequest!<unknown>(node, "", { responseMode: "json" });
    const started = isRecord(result.response) ? result.response.started : undefined;
    return parseTimestampMs(started);
  } catch {
    return undefined;
  }
}

function classifyConsoleErrors(entries: unknown[], startedMs: number | undefined) {
  const normalized = entries.map(normalizeConsoleEntry);
  const markerMs = latestStartupMarkerMs(normalized);
  const cutoffMs = startedMs ?? markerMs;
  const cutoffSource =
    startedMs !== undefined ? "node_started" : markerMs !== undefined ? "console_start_marker" : "none";
  const cutoffWithTolerance = cutoffMs === undefined ? undefined : cutoffMs - CONSOLE_CUTOFF_TOLERANCE_MS;
  const currentErrors: ReturnType<typeof normalizeConsoleEntry>[] = [];
  const staleErrors: ReturnType<typeof normalizeConsoleEntry>[] = [];

  for (const entry of normalized) {
    if (!isConsoleErrorEntry(entry.entry)) {
      continue;
    }

    if (
      cutoffWithTolerance !== undefined &&
      entry.timestampMs !== undefined &&
      entry.timestampMs < cutoffWithTolerance
    ) {
      staleErrors.push(entry);
    } else {
      currentErrors.push(entry);
    }
  }

  return { cutoffMs, cutoffSource, currentErrors, staleErrors };
}

function latestStartupMarkerMs(entries: Array<ReturnType<typeof normalizeConsoleEntry>>) {
  const markerTimes = entries
    .filter((entry) => entry.timestampMs !== undefined && isStartupMarker(entry.text))
    .map((entry) => entry.timestampMs as number);
  return markerTimes.length === 0 ? undefined : Math.max(...markerTimes);
}

function normalizeConsoleEntry(entry: unknown) {
  return {
    entry,
    text: consoleEntryText(entry),
    timestampMs: consoleEntryTimestampMs(entry),
    seq: isRecord(entry) && typeof entry.seq === "number" ? entry.seq : undefined,
  };
}

function consoleEntryText(entry: unknown) {
  if (typeof entry === "string") {
    return entry;
  }
  if (!isRecord(entry)) {
    return JSON.stringify(entry);
  }
  const parts = [entry.comment, entry.message, entry.text, entry.error, entry.console].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : JSON.stringify(entry);
}

function consoleEntryTimestampMs(entry: unknown) {
  if (typeof entry === "string") {
    return parseLeadingTimestampMs(entry);
  }
  if (!isRecord(entry)) {
    return undefined;
  }
  return parseTimestampMs(entry.timestamp) ?? parseTimestampMs(entry.time) ?? parseTimestampMs(entry.date);
}

function parseLeadingTimestampMs(value: string) {
  const match = /^\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/u.exec(value);
  return match?.[1] ? parseTimestampMs(match[1]) : undefined;
}

function parseTimestampMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function isStartupMarker(text: string) {
  return /Python and script\.py loaded|calling 'main'|\('main' completed cleanly\)|started/iu.test(text);
}
