import type {
  DiscoveredNode,
  NodelActivityResponse,
  NodelBindingsResponse,
  NodelBindingsSchemaResponse,
  NodelConsoleResponse,
  NodelDefinition,
  NodelDefinitionsResponse,
  NodelFilesResponse,
  NodelHostStatus,
  NodelNodeEntry,
  DiscoveryDiagnostics,
} from "../types.js";
import { publicError } from "../../shared/publicErrors.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw publicError("VALIDATION", `Malformed Nodel ${label} response.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalScalar(value: unknown) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

export function decodeHostStatus(value: unknown): NodelHostStatus {
  const raw = record(value, "host status");
  let nodes: Record<string, NodelNodeEntry> | undefined;
  if (raw.nodes !== undefined) {
    const source = record(raw.nodes, "host nodes");
    nodes = {};
    for (const [key, entry] of Object.entries(source)) {
      const rawEntry = record(entry, "host node");
      nodes[key] = {
        name: optionalString(rawEntry.name) ?? key,
        desc: optionalString(rawEntry.desc),
        started: optionalScalar(rawEntry.started),
        nodelVersion: optionalString(rawEntry.nodelVersion),
        webSocketPort:
          typeof rawEntry.webSocketPort === "number" && Number.isFinite(rawEntry.webSocketPort)
            ? rawEntry.webSocketPort
            : undefined,
        raw: rawEntry,
      };
    }
  }
  return { started: optionalScalar(raw.started), nodes, raw };
}

export function decodeDiscoveredNodes(value: unknown): DiscoveredNode[] {
  return decodeDiscoveredNodesDetailed(value).nodes;
}

export function decodeDiscoveredNodesDetailed(value: unknown): {
  nodes: DiscoveredNode[];
  diagnostics: DiscoveryDiagnostics;
} {
  const values = Array.isArray(value) ? value : Object.values(record(value, "network discovery"));
  const result: DiscoveredNode[] = [];
  const reasons: string[] = [];
  const reject = (reason: string) => reasons.push(reason);
  for (const entry of values) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      reject("entry_not_object");
      continue;
    }
    const raw = entry as Record<string, unknown>;
    const name = optionalString(raw.node) ?? optionalString(raw.name) ?? optionalString(raw.key);
    const address = optionalString(raw.address) ?? optionalString(raw.url);
    if (!name || !address) {
      reject("missing_name_or_address");
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(address);
    } catch {
      reject("invalid_address");
      continue;
    }
    if (!isHttpUrl(parsed)) {
      reject("unsafe_protocol");
      continue;
    }
    if (parsed.username || parsed.password) {
      reject("embedded_credentials");
      continue;
    }
    result.push({ name, address: parsed.toString(), restPathSegment: restPathSegmentFromAddress(parsed) });
  }
  return { nodes: result, diagnostics: { rejectedEntries: reasons.length, reasons } };
}

export function decodeDefinitions(value: unknown): NodelDefinitionsResponse {
  if (Array.isArray(value)) return value.map((item) => record(item, "definition"));
  return recordDefinitions(value);
}

export function decodeFiles(value: unknown): NodelFilesResponse {
  if (Array.isArray(value)) {
    if (
      !value.every(
        (item) => typeof item === "string" || (typeof item === "object" && item !== null && !Array.isArray(item)),
      )
    ) {
      throw publicError("VALIDATION", "Malformed Nodel files response.");
    }
    return value;
  }
  return record(value, "files");
}

export function decodeBindingsSchema(value: unknown): NodelBindingsSchemaResponse {
  return record(value, "binding schema");
}

export function decodeBindings(value: unknown): NodelBindingsResponse {
  return record(value, "bindings");
}

export function decodeActivity(value: unknown): NodelActivityResponse {
  if (Array.isArray(value)) return value;
  return record(value, "activity");
}

export function decodeConsole(value: unknown): NodelConsoleResponse {
  if (typeof value === "string" || Array.isArray(value)) return value;
  return record(value, "console");
}

function recordDefinitions(value: unknown): Record<string, NodelDefinition> {
  const source = record(value, "definitions");
  const result: Record<string, NodelDefinition> = {};
  for (const [key, entry] of Object.entries(source)) result[key] = record(entry, "definition");
  return result;
}

function restPathSegmentFromAddress(url: URL) {
  const match = /\/nodes\/([^/]+)/u.exec(url.pathname);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return undefined;
    }
  }
  return optionalString(url.searchParams.get("node"));
}

function isHttpUrl(url: URL) {
  return url.protocol === "http:" || url.protocol === "https:";
}
