import { isIP } from "node:net";
import { resolve } from "node:path";

export type ConfigWarning = {
  code: "UNSAFE_WRITE_MODE";
  message: string;
};

export type AppConfig = {
  nodelBaseUrl: string;
  mcpPort: number;
  mcpBindAddress: string;
  mcpToken?: string;
  allowedOrigins: string[];
  trustInboundRequestId: boolean;
  allowedRuntimeOrigins: string[];
  requestBodyLimitBytes: number;
  shutdownTimeoutMs: number;
  allowedNodePrefixes: string[];
  stateDir: string;
  writesEnabled: boolean;
  nodeLifecycleEnabled: boolean;
  deletesEnabled: boolean;
  writeApprovalRequired: boolean;
  unsafeWriteMode: boolean;
  configWarnings: ConfigWarning[];
  writeApprovalTtlSeconds: number;
  postWriteSettleMs: number;
  postWriteReadyTimeoutSeconds: number;
  nodelRequestTimeoutMs: number;
  publicRecipeRequestTimeoutMs: number;
  auditMaxBytes: number;
  auditRetentionFiles: number;
  backupRetentionDays: number;
  backupRetentionPerNodeKind: number;
};

type Environment = Record<string, string | undefined>;

const DEFAULTS = {
  nodelBaseUrl: "http://127.0.0.1:8085",
  mcpPort: 8765,
  mcpBindAddress: "127.0.0.1",
  requestBodyLimitBytes: 1024 * 1024,
  shutdownTimeoutMs: 10000,
  stateDir: ".state",
  writeApprovalTtlSeconds: 600,
  postWriteSettleMs: 3000,
  postWriteReadyTimeoutSeconds: 20,
  nodelRequestTimeoutMs: 10000,
  publicRecipeRequestTimeoutMs: 15000,
  auditMaxBytes: 10 * 1024 * 1024,
  auditRetentionFiles: 5,
  backupRetentionDays: 30,
  backupRetentionPerNodeKind: 50,
} as const;

function value(env: Environment, name: string, fallback?: string) {
  const candidate = env[name];
  return candidate === undefined || candidate.trim() === "" ? fallback : candidate.trim();
}

function booleanValue(env: Environment, name: string, fallback: boolean) {
  const candidate = value(env, name);
  if (candidate === undefined) return fallback;
  if (["true", "1", "yes"].includes(candidate.toLowerCase())) return true;
  if (["false", "0", "no"].includes(candidate.toLowerCase())) return false;
  throw new Error(`${name} must be one of true, false, 1, 0, yes, or no.`);
}

function integerValue(env: Environment, name: string, fallback: number, min: number, max: number) {
  const candidate = value(env, name);
  const parsed = candidate === undefined ? fallback : Number(candidate);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function normalizeHttpUrl(raw: string, name: string, requireOrigin = false) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid URL using http or https.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${name} must use http or https.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not contain embedded credentials.`);
  }
  if (requireOrigin && (url.pathname !== "/" || url.search || url.hash)) {
    throw new Error(`${name} must contain an origin only, without a path, query, or fragment.`);
  }
  return requireOrigin ? url.origin : url.toString().replace(/\/+$/, "");
}

function originList(env: Environment, name: string) {
  const raw = value(env, name, "") ?? "";
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => normalizeHttpUrl(item, name, true));
}

function isLoopbackAddress(address: string) {
  const normalized = address.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const version = isIP(normalized);
  if (version === 4) return normalized.startsWith("127.");
  return false;
}

function validateToken(token: string | undefined, bindAddress: string) {
  if (isLoopbackAddress(bindAddress)) return;
  if (!token) {
    throw new Error(
      "NODEL_MCP_TOKEN is required when MCP_BIND_ADDRESS is not loopback; use a random token of at least 32 characters.",
    );
  }
  if (token.length < 32 || new Set(token).size < 16) {
    throw new Error(
      "NODEL_MCP_TOKEN must be at least 32 characters with at least 16 distinct characters when MCP_BIND_ADDRESS is not loopback.",
    );
  }
}

function validateGates(writesEnabled: boolean, lifecycleEnabled: boolean, deletesEnabled: boolean) {
  const errors: string[] = [];
  if (lifecycleEnabled && !writesEnabled) {
    errors.push("NODEL_ENABLE_NODE_LIFECYCLE=true requires NODEL_ENABLE_WRITES=true.");
  }
  if (deletesEnabled && !lifecycleEnabled) {
    errors.push("NODEL_ENABLE_DELETES=true requires NODEL_ENABLE_NODE_LIFECYCLE=true.");
  }
  if (deletesEnabled && !writesEnabled) {
    errors.push("NODEL_ENABLE_DELETES=true requires NODEL_ENABLE_WRITES=true.");
  }
  if (errors.length > 0) throw new Error(`Invalid safety gate configuration:\n- ${errors.join("\n- ")}`);
}

export function loadConfig(env: Environment = process.env, cwd = process.cwd()): AppConfig {
  const nodelBaseUrl = normalizeHttpUrl(value(env, "NODEL_BASE_URL", DEFAULTS.nodelBaseUrl)!, "NODEL_BASE_URL");
  const mcpBindAddress = value(env, "MCP_BIND_ADDRESS", DEFAULTS.mcpBindAddress)!;
  const writesEnabled = booleanValue(env, "NODEL_ENABLE_WRITES", false);
  const nodeLifecycleEnabled = booleanValue(env, "NODEL_ENABLE_NODE_LIFECYCLE", false);
  const deletesEnabled = booleanValue(env, "NODEL_ENABLE_DELETES", false);
  validateGates(writesEnabled, nodeLifecycleEnabled, deletesEnabled);

  const mcpToken = value(env, "NODEL_MCP_TOKEN");
  validateToken(mcpToken, mcpBindAddress);
  const writeApprovalRequired = booleanValue(env, "NODEL_REQUIRE_WRITE_APPROVAL", true);
  const unsafeWriteMode = writesEnabled && !writeApprovalRequired;

  return {
    nodelBaseUrl,
    mcpPort: integerValue(env, "MCP_PORT", DEFAULTS.mcpPort, 1, 65535),
    mcpBindAddress,
    mcpToken,
    allowedOrigins: originList(env, "MCP_ALLOWED_ORIGINS"),
    trustInboundRequestId: booleanValue(env, "MCP_TRUST_REQUEST_ID_HEADER", false),
    allowedRuntimeOrigins: originList(env, "NODEL_ALLOWED_RUNTIME_ORIGINS"),
    requestBodyLimitBytes: integerValue(
      env,
      "MCP_REQUEST_BODY_LIMIT_BYTES",
      DEFAULTS.requestBodyLimitBytes,
      1024,
      50 * 1024 * 1024,
    ),
    shutdownTimeoutMs: integerValue(env, "MCP_SHUTDOWN_TIMEOUT_MS", DEFAULTS.shutdownTimeoutMs, 1000, 60000),
    allowedNodePrefixes: (value(env, "NODEL_ALLOWED_NODE_PREFIXES", "") ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
    stateDir: resolve(cwd, value(env, "NODEL_STATE_DIR", DEFAULTS.stateDir)!),
    writesEnabled,
    nodeLifecycleEnabled,
    deletesEnabled,
    writeApprovalRequired,
    unsafeWriteMode,
    configWarnings: unsafeWriteMode
      ? [
          {
            code: "UNSAFE_WRITE_MODE",
            message: "Writes are enabled without approval; write tools are not independently authorized.",
          },
        ]
      : [],
    writeApprovalTtlSeconds: integerValue(
      env,
      "NODEL_WRITE_APPROVAL_TTL_SECONDS",
      DEFAULTS.writeApprovalTtlSeconds,
      30,
      3600,
    ),
    postWriteSettleMs: integerValue(env, "NODEL_POST_WRITE_SETTLE_MS", DEFAULTS.postWriteSettleMs, 0, 30000),
    postWriteReadyTimeoutSeconds: integerValue(
      env,
      "NODEL_POST_WRITE_READY_TIMEOUT_SECONDS",
      DEFAULTS.postWriteReadyTimeoutSeconds,
      1,
      120,
    ),
    nodelRequestTimeoutMs: integerValue(env, "NODEL_REQUEST_TIMEOUT_MS", DEFAULTS.nodelRequestTimeoutMs, 1000, 120000),
    publicRecipeRequestTimeoutMs: integerValue(
      env,
      "PUBLIC_RECIPE_REQUEST_TIMEOUT_MS",
      DEFAULTS.publicRecipeRequestTimeoutMs,
      1000,
      120000,
    ),
    auditMaxBytes: integerValue(env, "NODEL_AUDIT_MAX_BYTES", DEFAULTS.auditMaxBytes, 1024, 1024 * 1024 * 1024),
    auditRetentionFiles: integerValue(env, "NODEL_AUDIT_RETENTION_FILES", DEFAULTS.auditRetentionFiles, 1, 100),
    backupRetentionDays: integerValue(env, "NODEL_BACKUP_RETENTION_DAYS", DEFAULTS.backupRetentionDays, 1, 3650),
    backupRetentionPerNodeKind: integerValue(
      env,
      "NODEL_BACKUP_RETENTION_PER_NODE_KIND",
      DEFAULTS.backupRetentionPerNodeKind,
      1,
      10000,
    ),
  };
}

export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const config = loadConfig({}, "test-state");
  return { ...config, ...overrides, configWarnings: overrides.configWarnings ?? config.configWarnings };
}

export function redactedConfig(source: AppConfig) {
  return {
    nodelBaseUrl: source.nodelBaseUrl,
    mcpPort: source.mcpPort,
    mcpBindAddress: source.mcpBindAddress,
    mcpTokenConfigured: Boolean(source.mcpToken),
    allowedOrigins: source.allowedOrigins,
    trustInboundRequestId: source.trustInboundRequestId,
    allowedRuntimeOrigins: source.allowedRuntimeOrigins,
    requestBodyLimitBytes: source.requestBodyLimitBytes,
    shutdownTimeoutMs: source.shutdownTimeoutMs,
    allowedNodePrefixes: source.allowedNodePrefixes,
    stateDir: source.stateDir,
    writesEnabled: source.writesEnabled,
    nodeLifecycleEnabled: source.nodeLifecycleEnabled,
    deletesEnabled: source.deletesEnabled,
    writeApprovalRequired: source.writeApprovalRequired,
    unsafeWriteMode: source.unsafeWriteMode,
    configWarnings: source.configWarnings,
    writeApprovalTtlSeconds: source.writeApprovalTtlSeconds,
    postWriteSettleMs: source.postWriteSettleMs,
    postWriteReadyTimeoutSeconds: source.postWriteReadyTimeoutSeconds,
    nodelRequestTimeoutMs: source.nodelRequestTimeoutMs,
    publicRecipeRequestTimeoutMs: source.publicRecipeRequestTimeoutMs,
    auditMaxBytes: source.auditMaxBytes,
    auditRetentionFiles: source.auditRetentionFiles,
    backupRetentionDays: source.backupRetentionDays,
    backupRetentionPerNodeKind: source.backupRetentionPerNodeKind,
  };
}
