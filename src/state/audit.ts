import { join } from "node:path";
import type { AppConfig } from "../config.js";
import { stableStringify } from "../shared/canonicalJson.js";
import { PublicError, publicError, sanitizeSensitiveMessage, sanitizeSensitiveValue } from "../shared/publicErrors.js";
import { NodelTransportError } from "../nodel/http/errors.js";
import { getRequestContext } from "../shared/requestContext.js";
import { StateStore, stateStore } from "./store.js";

export type AuditOutcome = "attempted" | "succeeded" | "failed" | "ambiguous";
export type AuditEvent = Record<string, unknown> & { operation: string; outcome?: AuditOutcome; operationId?: string };
export type AuditSeams = {
  now?: () => Date;
  uuid?: () => string;
  store?: StateStore;
  /** Test seam for exact pre/post-side-effect audit failures. */
  write?: (event: AuditEvent) => string;
};

export function auditWrite(config: AppConfig, event: AuditEvent, seams: AuditSeams = {}) {
  const operationId = event.operationId ?? seams.uuid?.() ?? crypto.randomUUID();
  const requestId = getRequestContext()?.requestId;
  const record = {
    version: 3,
    time: (seams.now?.() ?? new Date()).toISOString(),
    operationId,
    outcome: event.outcome ?? "attempted",
    ...(requestId ? { requestId } : {}),
    ...(redactAuditValues(event) as Record<string, unknown>),
  };
  const store = seams.store ?? stateStore(config.stateDir);
  const path = join(store.ensureDirectory(config.stateDir), "audit.jsonl");
  const line = `${JSON.stringify(record)}\n`;
  rotateAudit(config, store, path, Buffer.byteLength(line, "utf8"));
  store.fs.appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
  store.fs.chmodSync(path, 0o600);
  const fd = store.fs.openSync(path, "r");
  try {
    store.fs.fsyncSync(fd);
  } finally {
    store.fs.closeSync(fd);
  }
  return operationId;
}

/**
 * Audit appends and rotation are synchronous. A Node process cannot interleave
 * them between awaits, and StateStore's startup lock excludes a second process.
 */
export async function auditedMutation<T>(
  config: AppConfig,
  event: AuditEvent,
  remote: () => Promise<T>,
  seams: AuditSeams = {},
) {
  const write = seams.write ?? ((entry: AuditEvent) => auditWrite(config, entry, seams));
  const operationId = write({ ...event, outcome: "attempted" });
  try {
    const result = await remote();
    try {
      write({ ...event, operationId, outcome: "succeeded" });
    } catch (error) {
      throw new PostSideEffectAuditError(operationId, error);
    }
    return { operationId, result };
  } catch (remoteError) {
    if (remoteError instanceof PostSideEffectAuditError) throw remoteError;
    try {
      const outcome = isAmbiguousMutationError(remoteError) ? "ambiguous" : "failed";
      write({ ...event, operationId, outcome, error: classifyError(remoteError) });
    } catch (auditError) {
      throw new RemoteFailureAuditError(operationId, remoteError, auditError);
    }
    throw withOperationId(remoteError, operationId);
  }
}

export class PostSideEffectAuditError extends Error {
  constructor(
    readonly operationId: string,
    readonly auditError: unknown,
  ) {
    super(
      `Remote mutation may have succeeded, but durable success audit failed for operation ${operationId}. Inspect Nodel state before retrying. ${sanitizeSensitiveMessage(auditError)}`,
    );
    this.name = "PostSideEffectAuditError";
  }
}

export class RemoteFailureAuditError extends Error {
  constructor(
    readonly operationId: string,
    readonly remoteError: unknown,
    readonly auditError: unknown,
  ) {
    super(
      `Remote mutation outcome is unresolved because durable audit failed for operation ${operationId}. Inspect Nodel state before retrying. Remote error: ${sanitizeSensitiveMessage(remoteError)}; audit error: ${sanitizeSensitiveMessage(auditError)}`,
    );
    this.name = "RemoteFailureAuditError";
  }
}

export function backupBindingState(
  config: AppConfig,
  nodeName: string,
  bindings: unknown,
  operationId: string = crypto.randomUUID(),
  seams: Pick<AuditSeams, "now" | "uuid" | "store"> = {},
) {
  return backupState(config, "bindings", nodeName, bindings, operationId, seams);
}

export function backupParameterState(
  config: AppConfig,
  nodeName: string,
  parameters: unknown,
  operationId: string = crypto.randomUUID(),
  seams: Pick<AuditSeams, "now" | "uuid" | "store"> = {},
) {
  return backupState(config, "parameters", nodeName, parameters, operationId, seams);
}

export function auditFilePaths(stateDir: string, store = stateStore(stateDir)) {
  if (!store.fs.existsSync(stateDir)) return [];
  const rotated = store.fs
    .readdirSync(stateDir)
    .flatMap((name) => {
      const match = /^audit\.jsonl\.(\d+)$/u.exec(name);
      return match ? [{ path: join(stateDir, name), sequence: Number(match[1]) }] : [];
    })
    .sort((left, right) => right.sequence - left.sequence)
    .map((entry) => entry.path);
  const active = join(stateDir, "audit.jsonl");
  return store.fs.existsSync(active) ? [...rotated, active] : rotated;
}

function backupState(
  config: AppConfig,
  kind: "bindings" | "parameters",
  nodeName: string,
  value: unknown,
  operationId: string,
  seams: Pick<AuditSeams, "now" | "uuid" | "store">,
) {
  const store = seams.store ?? stateStore(config.stateDir);
  const dir = store.ensureDirectory(join(config.stateDir, "backups", kind));
  const filename = `${(seams.now?.() ?? new Date()).toISOString().replace(/[:.]/gu, "-")}--op_${Buffer.from(operationId).toString("base64url")}--${seams.uuid?.() ?? crypto.randomUUID()}--node_b64_${Buffer.from(nodeName).toString("base64url")}.json`;
  const path = join(dir, filename);
  if (containsSidecarToken(value, config.mcpToken))
    throw publicError(
      "STATE",
      "Current Nodel state contains the configured sidecar MCP token. A faithful backup cannot be persisted; refusing the mutation.",
    );
  // Backups are restoration records and therefore retain remote state verbatim.
  store.atomicWrite(path, `${stableStringify(value)}\n`);
  pruneBackups(config, store, dir, nodeName);
  return path;
}

function rotateAudit(config: AppConfig, store: StateStore, path: string, incomingBytes: number) {
  const maxBytes = config.auditMaxBytes ?? 10 * 1024 * 1024;
  const retentionFiles = config.auditRetentionFiles ?? 5;
  if (!store.fs.existsSync(path) || store.fs.statSync(path).size + incomingBytes <= maxBytes) return;
  if (retentionFiles <= 1) {
    store.atomicWrite(path, "");
    return;
  }
  const oldest = `${path}.${retentionFiles - 1}`;
  if (store.fs.existsSync(oldest)) store.fs.unlinkSync(oldest);
  for (let index = retentionFiles - 2; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    if (store.fs.existsSync(source)) store.durableRename(source, `${path}.${index + 1}`);
  }
  store.durableRename(path, `${path}.1`);
  store.atomicWrite(path, "");
}

function pruneBackups(config: AppConfig, store: StateStore, dir: string, nodeName: string) {
  const now = Date.now();
  const retentionDays = config.backupRetentionDays ?? 30;
  const retentionCap = config.backupRetentionPerNodeKind ?? 50;
  const terminalOperationIds = terminalAuditOperationIds(config.stateDir, store);
  const safeNode = safeName(nodeName);
  const encodedNode = Buffer.from(nodeName).toString("base64url");
  const matching = store.fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(`--node_b64_${encodedNode}.json`) || name.endsWith(`--${safeNode}.json`))
    .map((name) => ({ name, stat: store.fs.statSync(join(dir, name)), operationId: backupOperationId(name) }))
    .sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);
  const removable = matching.filter((entry) => entry.operationId && terminalOperationIds.has(entry.operationId));
  const expired = removable.filter((entry) => now - entry.stat.mtimeMs > retentionDays * 86400000);
  for (const entry of expired) {
    store.fs.unlinkSync(join(dir, entry.name));
  }
  const retained = matching.filter((entry) => !expired.includes(entry));
  const excess = Math.max(0, retained.length - retentionCap);
  for (const entry of retained.filter((entry) => removable.includes(entry)).slice(0, excess))
    store.fs.unlinkSync(join(dir, entry.name));
}

function terminalAuditOperationIds(stateDir: string, store: StateStore) {
  const ids = new Set<string>();
  for (const path of auditFilePaths(stateDir, store)) {
    for (const line of store.fs.readFileSync(path, "utf8").split(/\r?\n/u)) {
      try {
        const event = JSON.parse(line) as { operationId?: unknown; outcome?: unknown };
        if (typeof event.operationId === "string" && (event.outcome === "succeeded" || event.outcome === "failed"))
          ids.add(event.operationId);
      } catch {
        /* malformed historical lines are unreadable, not terminal */
      }
    }
  }
  return ids;
}

function backupOperationId(filename: string) {
  const parts = filename.split("--");
  if (parts.length < 4) return undefined;
  if (!parts[1].startsWith("op_")) return parts[1]; // Legacy UUID-style filenames.
  try {
    return Buffer.from(parts[1].slice(3), "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function redactAuditValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditValues);
  if (!value || typeof value !== "object") return typeof value === "string" ? sanitizeSensitiveMessage(value) : value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      /(?:authorization|bearer.?token|mcp.?token)/iu.test(key)
        ? "[redacted]"
        : redactAuditValues(sanitizeSensitiveValue(child)),
    ]),
  );
}

function containsSidecarToken(value: unknown, token: string | undefined): boolean {
  if (!token) return false;
  if (typeof value === "string") return value === token;
  if (Array.isArray(value)) return value.some((entry) => containsSidecarToken(entry, token));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => key === token || containsSidecarToken(child, token),
  );
}

function classifyError(error: unknown) {
  return error instanceof Error ? error.name : "unknown";
}

function isAmbiguousMutationError(error: unknown) {
  return (
    (error instanceof NodelTransportError && ["TIMEOUT", "NETWORK", "INVALID_JSON", "REDIRECT"].includes(error.code)) ||
    (error instanceof PublicError && error.ambiguous === true)
  );
}

/** Preserve the concrete remote error for callers while adding audit correlation. */
function withOperationId(error: unknown, operationId: string): Error {
  if (error instanceof Error) {
    Object.defineProperty(error, "operationId", { value: operationId, enumerable: true, configurable: true });
    return error;
  }
  const wrapped = new Error(sanitizeSensitiveMessage(error));
  Object.defineProperty(wrapped, "operationId", { value: operationId, enumerable: true });
  return wrapped;
}
function safeName(value: string) {
  return (
    value
      .replace(/[^a-z0-9._-]+/giu, "_")
      .replace(/^_+|_+$/gu, "")
      .slice(0, 120) || "node"
  );
}
