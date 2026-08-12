import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import { localReadOnlyToolAnnotations } from "../toolAnnotations.js";
import { toolResult } from "./common.js";
import { publicError } from "../../shared/publicErrors.js";
import { sha256 } from "../../shared/canonicalJson.js";
import { auditFilePaths } from "../../state/audit.js";

const backupKindSchema = z.enum(["parameters", "bindings"]);

export function registerAuditReadTools(server: McpServer, config: AppConfig) {
  server.registerTool(
    "nodel.list_write_audit",
    {
      title: "List Write Audit",
      description:
        "Read recent sidecar write audit JSONL entries, including retained rotations, from NODEL_STATE_DIR without modifying state. Legacy records are reported as attempted, never successful.",
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().default(100),
        operation: z.string().optional(),
        node: z.string().optional(),
      },
      annotations: localReadOnlyToolAnnotations,
    },
    async ({ limit, operation, node }) => toolResult(async () => listWriteAudit(config, limit ?? 100, operation, node)),
  );

  server.registerTool(
    "nodel.list_config_backups",
    {
      title: "List Config Backups",
      description: "List parameter and binding backup files saved before sidecar config writes.",
      inputSchema: {
        kind: z.enum(["parameters", "bindings", "both"]).optional().default("both"),
        node: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional().default(100),
      },
      annotations: localReadOnlyToolAnnotations,
    },
    async ({ kind, node, limit }) =>
      toolResult(async () => listConfigBackups(config, kind ?? "both", node, limit ?? 100)),
  );

  server.registerTool(
    "nodel.read_config_backup",
    {
      title: "Read Config Backup",
      description:
        "Read one parameter or binding backup file from NODEL_STATE_DIR/backups. Path traversal outside the backup directory is rejected.",
      inputSchema: {
        kind: backupKindSchema,
        path: z.string().min(1),
      },
      annotations: localReadOnlyToolAnnotations,
    },
    async ({ kind, path }) => toolResult(async () => readConfigBackup(config, kind, path)),
  );
}

export function listWriteAudit(config: AppConfig, limit: number, operation?: string, node?: string) {
  const path = join(config.stateDir, "audit.jsonl");
  const paths = auditFilePaths(config.stateDir);
  if (paths.length === 0) {
    return { path, count: 0, entries: [] };
  }
  const entries = paths
    .flatMap((auditPath) =>
      readFileSync(auditPath, "utf8")
        .split(/\r?\n/u)
        .filter(Boolean)
        .flatMap((line) => parseJsonLine(line)),
    )
    .filter((entry) => !operation || entry.operation === operation)
    .filter((entry) => !node || entry.node === node)
    .slice(-limit);
  return { path, paths, count: entries.length, entries, order: "oldest_to_newest" };
}

export function listConfigBackups(
  config: AppConfig,
  kind: "parameters" | "bindings" | "both",
  node: string | undefined,
  limit: number,
) {
  const kinds = kind === "both" ? (["parameters", "bindings"] as const) : ([kind] as const);
  const entries = kinds.flatMap((entryKind) => listBackupKind(config, entryKind, node));
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { count: entries.slice(-limit).length, backups: entries.slice(-limit), order: "oldest_to_newest" };
}

export function readConfigBackup(config: AppConfig, kind: "parameters" | "bindings", path: string) {
  const dir = backupDir(config, kind);
  const fullPath = safeBackupPath(dir, path);
  const text = readFileSync(fullPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { kind, path: fullPath, filename: basename(fullPath), sha256: sha256(text), parsed, text };
}

function listBackupKind(config: AppConfig, kind: "parameters" | "bindings", node: string | undefined) {
  const dir = backupDir(config, kind);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((filename) => filename.endsWith(".json"))
    .map((filename) => {
      const path = join(dir, filename);
      const stats = statSync(path);
      return { kind, filename, path, size: stats.size, modifiedAt: stats.mtime.toISOString() };
    })
    .filter(
      (entry) =>
        !node || entry.filename.toLocaleLowerCase().includes(node.toLocaleLowerCase().replace(/[^a-z0-9._-]+/giu, "_")),
    );
}

function backupDir(config: AppConfig, kind: "parameters" | "bindings") {
  return join(config.stateDir, "backups", kind);
}

function safeBackupPath(dir: string, inputPath: string) {
  const root = resolve(dir);
  if (inputPath.includes("/") || inputPath.includes("\\") || basename(inputPath) !== inputPath) {
    throw publicError("VALIDATION", "Backup path must be a filename inside the selected backup directory.");
  }
  const candidate = resolve(root, inputPath);
  if (!candidate.startsWith(`${root}/`) && candidate !== root) {
    throw publicError("VALIDATION", "Backup path must stay inside the selected backup directory.");
  }
  if (!existsSync(candidate)) {
    throw publicError("VALIDATION", `Backup file was not found: ${basename(inputPath)}`);
  }
  return candidate;
}

function parseJsonLine(line: string) {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    // Legacy records were pre-write attempts only and must never be presented as success.
    return [
      {
        ...parsed,
        version: typeof parsed.version === "number" ? parsed.version : 1,
        outcome: typeof parsed.outcome === "string" ? parsed.outcome : "attempted",
        operationId: typeof parsed.operationId === "string" ? parsed.operationId : undefined,
      } as Record<string, unknown>,
    ];
  } catch {
    return [];
  }
}
