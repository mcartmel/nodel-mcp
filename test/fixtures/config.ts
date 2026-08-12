import type { AppConfig } from "../../src/config.js";

export function completeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodelBaseUrl: "http://127.0.0.1:8085",
    mcpPort: 8765,
    mcpBindAddress: "127.0.0.1",
    mcpToken: undefined,
    allowedOrigins: [],
    trustInboundRequestId: false,
    allowedRuntimeOrigins: [],
    requestBodyLimitBytes: 1024 * 1024,
    shutdownTimeoutMs: 10000,
    allowedNodePrefixes: [],
    stateDir: "/tmp/nodel-ai-test",
    writesEnabled: false,
    nodeLifecycleEnabled: false,
    deletesEnabled: false,
    writeApprovalRequired: true,
    unsafeWriteMode: false,
    configWarnings: [],
    writeApprovalTtlSeconds: 600,
    postWriteSettleMs: 3000,
    postWriteReadyTimeoutSeconds: 20,
    nodelRequestTimeoutMs: 10000,
    publicRecipeRequestTimeoutMs: 15000,
    auditMaxBytes: 10 * 1024 * 1024,
    auditRetentionFiles: 5,
    backupRetentionDays: 30,
    backupRetentionPerNodeKind: 50,
    ...overrides,
  };
}
