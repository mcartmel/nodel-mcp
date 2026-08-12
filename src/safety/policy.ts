import type { AppConfig } from "../config.js";
import { publicError } from "../shared/publicErrors.js";

export function isNodeAllowed(nodeName: string, allowedPrefixes: string[]) {
  if (allowedPrefixes.length === 0) {
    return true;
  }

  return allowedPrefixes.some((prefix) => nodeName.startsWith(prefix));
}

export function assertNodeAllowed(nodeName: string, allowedPrefixes: string[]) {
  if (!isNodeAllowed(nodeName, allowedPrefixes)) {
    throw publicError("POLICY", `Node is not allowed by NODEL_ALLOWED_NODE_PREFIXES: ${nodeName}`);
  }
}

export function assertWritesEnabled(config: AppConfig) {
  if (!config.writesEnabled) {
    throw publicError(
      "POLICY",
      "Write/action tools are disabled. Set NODEL_ENABLE_WRITES=true only after adding approval flows.",
    );
  }
}

export function assertNodeLifecycleEnabled(config: AppConfig) {
  assertWritesEnabled(config);
  if (!config.nodeLifecycleEnabled) {
    throw publicError(
      "POLICY",
      "Node lifecycle tools are disabled. Set NODEL_ENABLE_NODE_LIFECYCLE=true for create/restart operations.",
    );
  }
}

export function assertDeletesEnabled(config: AppConfig) {
  assertNodeLifecycleEnabled(config);
  if (!config.deletesEnabled) {
    throw publicError(
      "POLICY",
      "Delete tools are disabled. Set NODEL_ENABLE_DELETES=true only for explicitly approved deletion workflows.",
    );
  }
}
