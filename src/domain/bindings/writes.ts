import type { AppConfig } from "../../config.js";
import { logger } from "../../logger.js";
import type { NodelClient } from "../../nodel/client.js";
import { approvalRequest, assertWriteApproved } from "../../safety/approvals.js";
import { backupBindingState } from "../../safety/audit.js";
import { assertWritesEnabled } from "../../safety/policy.js";
import { auditedMutation } from "../../state/audit.js";
import { withWriteLock } from "../../state/locks.js";
import { stableJsonHash } from "../../shared/canonicalJson.js";
import { publicError, sanitizeSensitiveMessage } from "../../shared/publicErrors.js";
import { planConfigWrite } from "../config/planner.js";
import { buildDirectBindingPlan } from "./directPlanner.js";
import { bindingApprovalPayload } from "./approval.js";

export async function setBindings(
  nodelClient: Pick<NodelClient, "resolveNode" | "getNodeBindings" | "nodeRequest">,
  config: AppConfig,
  input: {
    operation: string;
    node: string;
    bindings: Record<string, unknown>;
    mode: "merge" | "replace";
    removePaths?: string[][];
    expectedHash?: string;
    dryRun: boolean;
    reason?: string;
    approvalId?: string;
  },
) {
  const resolved = await nodelClient.resolveNode(input.node);
  return withWriteLock(writeKey(resolved, "bindings"), async () => {
    const current = await nodelClient.getNodeBindings(resolved);
    const planned = planConfigWrite(
      current.bindings,
      input.bindings,
      input.mode,
      input.expectedHash,
      "Binding",
      input.removePaths,
    );
    const approval = writeApproval(
      config,
      input.operation,
      current.node.name,
      bindingApprovalPayload({ ...planned, mode: input.mode, bindings: input.bindings }),
    );
    const plan = {
      operation: input.operation,
      node: current.node,
      mode: input.mode,
      currentHash: planned.currentHash,
      nextHash: planned.nextHash,
      bindings: input.bindings,
      removePaths: planned.removePaths,
      missingRemovePaths: planned.missingRemovePaths,
      restPath: "remote/save",
      method: "POST",
      approvalRequest: approval.request,
      reason: input.reason,
      dryRun: input.dryRun,
    };
    if (planned.currentHash === planned.nextHash) return { ...plan, status: "no_change", changed: false };
    if (input.dryRun) return { ...plan, status: "dry_run" };
    assertWritesEnabled(config);
    assertWriteApproved(config, approval.details, input.approvalId);
    const operationId = crypto.randomUUID();
    const backupPath = backupBindingState(config, current.node.name, current.bindings, operationId);
    logger.info("Setting Nodel bindings", {
      node: current.node.name,
      mode: input.mode,
      reason: input.reason,
    });
    const audited = await auditedMutation(
      config,
      {
        operation: input.operation,
        operationId,
        node: current.node.name,
        mode: input.mode,
        currentHash: planned.currentHash,
        nextHash: planned.nextHash,
        removePaths: planned.removePaths,
        missingRemovePaths: planned.missingRemovePaths,
        backupPath,
        reason: input.reason,
      },
      () =>
        nodelClient.nodeRequest(current.node, "remote/save", {
          method: "POST",
          body: planned.next,
          responseMode: "json",
        }),
    );
    const verification = await verifyBindings(nodelClient, current.node, planned.nextHash);
    return {
      ...plan,
      status: verification.ok ? "succeeded_verified" : "succeeded_verification_pending",
      response: audited.result.response,
      verification,
      operationId: audited.operationId,
    };
  });
}

export async function applyBindingPlan(
  nodelClient: Pick<
    NodelClient,
    "resolveNode" | "getNodeBindings" | "getNodeActions" | "getNodeSignals" | "nodeRequest"
  >,
  config: AppConfig,
  input: {
    node: string;
    targetNode: string;
    expectedHash: string;
    kinds: "actions" | "events" | "both";
    bindingNames?: string[];
    overwrite: boolean;
    minScore: number;
    dryRun: boolean;
    approvalId?: string;
    reason?: string;
  },
) {
  const resolved = await nodelClient.resolveNode(input.node);
  return withWriteLock(writeKey(resolved, "bindings"), async () => {
    const current = await nodelClient.getNodeBindings(resolved);
    const currentHash = stableJsonHash(current.bindings);
    if (currentHash !== input.expectedHash)
      throw publicError("CONFLICT", `Binding expectedHash mismatch. Current hash is ${currentHash}.`);
    const [targetActions, targetSignals] = await Promise.all([
      nodelClient.getNodeActions(input.targetNode),
      nodelClient.getNodeSignals(input.targetNode),
    ]);
    const plan = buildDirectBindingPlan({
      sourceNode: current.node,
      targetNode: targetActions.node,
      schema: current.schema,
      currentBindings: current.bindings,
      targetActions: targetActions.actions,
      targetSignals: targetSignals.signals,
      kinds: input.kinds,
      bindingNames: input.bindingNames,
      overwrite: input.overwrite,
      minScore: input.minScore,
    });
    if (plan.currentHash === plan.nextHash && plan.unresolved.length === 0) {
      const applyPlan = { ...plan, operation: "apply_node_binding_plan", reason: input.reason, dryRun: input.dryRun };
      return { ...applyPlan, status: "no_change", changed: false };
    }
    if (plan.proposals.length === 0)
      throw publicError("VALIDATION", "No binding proposals met the requested criteria.");
    if (plan.unresolved.length > 0)
      throw publicError(
        "VALIDATION",
        `Some bindings could not be resolved: ${plan.unresolved.map((entry) => entry.bindingName).join(", ")}`,
      );
    const approval = writeApproval(
      config,
      "apply_node_binding_plan",
      current.node.name,
      bindingApprovalPayload({
        mode: "merge",
        currentHash: plan.currentHash,
        nextHash: plan.nextHash,
        bindings: plan.bindingPatch,
      }),
    );
    const applyPlan = {
      ...plan,
      operation: "apply_node_binding_plan",
      approvalRequest: approval.request,
      reason: input.reason,
      dryRun: input.dryRun,
    };
    if (input.dryRun) return { ...applyPlan, status: "dry_run" };
    assertWritesEnabled(config);
    assertWriteApproved(config, approval.details, input.approvalId);
    const operationId = crypto.randomUUID();
    const backupPath = backupBindingState(config, current.node.name, current.bindings, operationId);
    logger.info("Applying Nodel binding plan", {
      node: current.node.name,
      targetNode: targetActions.node.name,
      count: plan.proposals.length,
      reason: input.reason,
    });
    const audited = await auditedMutation(
      config,
      {
        operation: "apply_node_binding_plan",
        operationId,
        node: current.node.name,
        targetNode: targetActions.node.name,
        currentHash,
        nextHash: plan.nextHash,
        backupPath,
        count: plan.proposals.length,
        reason: input.reason,
      },
      () =>
        nodelClient.nodeRequest(current.node, "remote/save", {
          method: "POST",
          body: plan.nextBindings,
          responseMode: "json",
        }),
    );
    const verification = await verifyBindings(nodelClient, current.node, plan.nextHash);
    return {
      ...applyPlan,
      status: verification.ok ? "succeeded_verified" : "succeeded_verification_pending",
      response: audited.result.response,
      verification,
      operationId: audited.operationId,
    };
  });
}

async function verifyBindings(
  nodelClient: Pick<NodelClient, "getNodeBindings">,
  node: { name: string },
  expectedHash: string,
) {
  try {
    const readBack = await nodelClient.getNodeBindings(node as never);
    const actualHash = stableJsonHash(readBack.bindings);
    return {
      attempted: true,
      ok: actualHash === expectedHash,
      expectedHash,
      actualHash,
      strategy: "GET REST/remote hash comparison",
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      expectedHash,
      strategy: "GET REST/remote hash comparison",
      message: sanitizeSensitiveMessage(error),
    };
  }
}

function writeKey(node: { nodeBaseUrl: string; name: string }, resource: string) {
  return `${node.nodeBaseUrl}:${node.name}:${resource}`;
}
function writeApproval(config: AppConfig, operation: string, target: string, payload: unknown) {
  const details = {
    operation,
    target,
    proposalHash: stableJsonHash({ operation, target, payload }),
  };
  return { details, request: approvalRequest(config, details) };
}
