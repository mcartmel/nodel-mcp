import { join } from "node:path";
import type { AppConfig } from "../config.js";
import { timingSafeStringEqual } from "../shared/secret.js";
import { StateStore, stateStore } from "./store.js";
import { publicError } from "../shared/publicErrors.js";

export type ApprovalDetails = { operation: string; target: string; proposalHash: string };
type StoredApproval = ApprovalDetails & {
  id: string;
  reason?: string;
  approvedBy?: string;
  createdAt: string;
  expiresAt: string;
};
type ApprovalEnvelope = { version: 2; approvals: StoredApproval[] };

export type ApprovalSeams = { now?: () => Date; uuid?: () => string; store?: StateStore };

const approvalsPath = (config: AppConfig) => join(config.stateDir, "approvals.json");

export function approvalRequest(config: AppConfig, details: ApprovalDetails) {
  const required = config.writesEnabled && config.writeApprovalRequired;
  return {
    required,
    ...details,
    confirmText: confirmText(details.proposalHash),
    expiresInSeconds: config.writeApprovalTtlSeconds,
    instructions: !config.writesEnabled
      ? "Writes are currently disabled. Enable write gates before requesting approval or applying this proposal."
      : required
        ? "After explicit operator approval, call nodel.approve_write with this operation, target, proposalHash, and confirmText. The manual fallback is a workflow guardrail, not an independent authorization boundary."
        : "Write approval is not required by current sidecar configuration.",
  };
}

export function approveWrite(
  config: AppConfig,
  details: ApprovalDetails,
  providedConfirmText: string,
  reason?: string,
  approvedBy?: string,
  seams: ApprovalSeams = {},
) {
  if (!config.writesEnabled)
    throw publicError("POLICY", "Write approval is unavailable because write tools are disabled.");
  assertNoBearer(details.operation, "operation");
  assertNoBearer(details.target, "target");
  assertNoBearer(reason, "reason");
  assertNoBearer(approvedBy, "approvedBy");
  if (!timingSafeStringEqual(providedConfirmText, confirmText(details.proposalHash))) {
    throw publicError("APPROVAL_REQUIRED", "Approval confirmation mismatch.");
  }
  assertApprovalDetails(details);
  const now = seams.now?.() ?? new Date();
  // This read-modify-write is synchronous. JavaScript cannot interleave it in
  // one event loop, and StateStore's startup lock excludes another process.
  const envelope = loadApprovals(config, seams);
  const approvals = envelope.approvals.filter((approval) => Date.parse(approval.expiresAt) > now.getTime());
  const id = seams.uuid?.() ?? crypto.randomUUID();
  if (approvals.some((approval) => timingSafeStringEqual(approval.id, id)))
    throw publicError("STATE", "Generated approval id already exists.");
  const approval: StoredApproval = {
    id,
    ...details,
    reason,
    approvedBy,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + config.writeApprovalTtlSeconds * 1000).toISOString(),
  };
  approvals.push(approval);
  saveApprovals(config, { version: 2, approvals }, seams);
  return {
    approvalId: id,
    operation: details.operation,
    target: details.target,
    proposalHash: details.proposalHash,
    expiresAt: approval.expiresAt,
  };
}

/** Consumes a matching approval durably immediately before a remote side effect. */
export function assertWriteApproved(
  config: AppConfig,
  details: ApprovalDetails,
  approvalId: string | undefined,
  seams: ApprovalSeams = {},
) {
  if (!config.writeApprovalRequired) return;
  if (!approvalId)
    throw publicError(
      "APPROVAL_REQUIRED",
      `Write approval is required. Call nodel.approve_write for proposalHash ${details.proposalHash} and pass approvalId.`,
    );
  const now = seams.now?.() ?? new Date();
  const envelope = loadApprovals(config, seams);
  const approvals = envelope.approvals.filter((approval) => Date.parse(approval.expiresAt) > now.getTime());
  const index = approvals.findIndex((approval) => timingSafeStringEqual(approval.id, approvalId));
  if (index < 0) {
    if (approvals.length !== envelope.approvals.length) saveApprovals(config, { version: 2, approvals }, seams);
    throw publicError("APPROVAL_REQUIRED", "Write approval was not found or has expired.");
  }
  const approval = approvals[index];
  if (
    !timingSafeStringEqual(approval.operation, details.operation) ||
    !timingSafeStringEqual(approval.target, details.target) ||
    !timingSafeStringEqual(approval.proposalHash, details.proposalHash)
  ) {
    throw publicError("CONFLICT", "Write approval does not match this operation, target, and full proposal hash.");
  }
  approvals.splice(index, 1);
  saveApprovals(config, { version: 2, approvals }, seams);
}

function loadApprovals(config: AppConfig, seams: ApprovalSeams): ApprovalEnvelope {
  const path = approvalsPath(config);
  const store = seams.store ?? stateStore(config.stateDir);
  store.initialize();
  if (!store.fs.existsSync(path)) return { version: 2, approvals: [] };
  store.fs.chmodSync(path, 0o600);
  let parsed: unknown;
  try {
    parsed = JSON.parse(store.fs.readFileSync(path, "utf8"));
  } catch (error) {
    quarantine(store, path, "corrupt", seams);
    throw publicError(
      "STATE",
      `Approval state is corrupt and has been quarantined. No approvals were accepted. Inspect ${path}.corrupt-* and remove/recover it before retrying.`,
      { cause: error },
    );
  }
  if (Array.isArray(parsed)) {
    // Pre-public approval records are intentionally not trusted in the v2 schema.
    quarantine(store, path, "legacy-invalidated", seams);
    saveApprovals(config, { version: 2, approvals: [] }, seams);
    return { version: 2, approvals: [] };
  }
  if (!isEnvelope(parsed)) {
    quarantine(store, path, "corrupt", seams);
    throw publicError(
      "STATE",
      `Approval state has an unsupported schema and has been quarantined. No approvals were accepted. Inspect ${path}.corrupt-* and recover manually.`,
    );
  }
  return parsed;
}

function saveApprovals(config: AppConfig, envelope: ApprovalEnvelope, seams: ApprovalSeams) {
  (seams.store ?? stateStore(config.stateDir)).atomicWrite(
    approvalsPath(config),
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
}

function quarantine(store: StateStore, path: string, reason: string, seams: ApprovalSeams) {
  const target = `${path}.${reason}-${(seams.now?.() ?? new Date()).getTime()}-${seams.uuid?.() ?? store.runtime.uuid()}`;
  try {
    store.durableRename(path, target);
  } catch (error) {
    if (store.fs.existsSync(target) && !store.fs.existsSync(path))
      throw publicError(
        "STATE",
        `Approval state was moved to ${target}, but durable quarantine did not complete. The original path ${path} no longer contains the state; recover the quarantined file manually before continuing.`,
        { cause: error },
      );
    throw publicError(
      "STATE",
      `Approval state is invalid but could not be quarantined. The original file was preserved at ${path}; refusing all approvals until it is recovered manually.`,
      { cause: error },
    );
  }
  try {
    store.fs.chmodSync(target, 0o600);
  } catch (error) {
    throw publicError(
      "STATE",
      `Approval state was quarantined at ${target}, but permission hardening failed. The original path ${path} was moved; recover the quarantined file manually before continuing.`,
      { cause: error },
    );
  }
}

function confirmText(proposalHash: string) {
  return `APPROVE ${proposalHash.slice(0, 12)}`;
}

function assertNoBearer(value: string | undefined, field: string) {
  if (value && /Bearer\s+[A-Za-z0-9._~+/=-]+/iu.test(value))
    throw publicError("VALIDATION", `Approval ${field} must not contain a bearer token.`);
}

function isEnvelope(value: unknown): value is ApprovalEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as { version?: unknown; approvals?: unknown };
  return envelope.version === 2 && Array.isArray(envelope.approvals) && envelope.approvals.every(isStoredApproval);
}

function isStoredApproval(value: unknown): value is StoredApproval {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<StoredApproval>;
  return (
    isNonEmpty(entry.id) &&
    isNonEmpty(entry.operation) &&
    isNonEmpty(entry.target) &&
    isSha256(entry.proposalHash) &&
    isValidTimestamp(entry.createdAt) &&
    isValidTimestamp(entry.expiresAt) &&
    Date.parse(entry.expiresAt) > Date.parse(entry.createdAt)
  );
}

function assertApprovalDetails(details: ApprovalDetails) {
  if (!isNonEmpty(details.operation) || !isNonEmpty(details.target) || !isSha256(details.proposalHash)) {
    throw publicError(
      "VALIDATION",
      "Approval operation, target, and proposalHash must be non-empty; proposalHash must be a SHA-256 hex digest.",
    );
  }
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value);
}
function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
