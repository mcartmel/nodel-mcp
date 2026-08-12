import type { AppConfig } from "../../config.js";
import { logger } from "../../logger.js";
import type { NodelClient } from "../../nodel/client.js";
import { approvalRequest, assertWriteApproved } from "../../safety/approvals.js";
import { backupParameterState } from "../../safety/audit.js";
import { assertWritesEnabled } from "../../safety/policy.js";
import { auditedMutation } from "../../state/audit.js";
import { withWriteLock } from "../../state/locks.js";
import { stableJsonHash } from "../../shared/canonicalJson.js";
import { publicError, sanitizeSensitiveMessage } from "../../shared/publicErrors.js";
import { waitForNodeReadyAfterWrite } from "../recipes/readiness.js";
import { planConfigWrite } from "./planner.js";

export function actionRequest(actionName: string, method: "POST" | "GET" | "PUT", args: unknown) {
  const basePath = `actions/${encodeURIComponent(actionName)}/call`;
  if (method !== "GET")
    return {
      method,
      restPath: basePath,
      body: args === undefined ? {} : { arg: args },
    };
  if (args === undefined) return { method, restPath: basePath, body: undefined };
  if (!["string", "number", "boolean"].includes(typeof args) && args !== null)
    throw publicError("VALIDATION", "GET action args must be a primitive arg value.");
  const params = new URLSearchParams();
  params.set("arg", String(args));
  const query = params.toString();
  return {
    method,
    restPath: query ? `${basePath}?${query}` : basePath,
    body: undefined,
  };
}

export async function callAction(
  nodelClient: Pick<NodelClient, "resolveNode" | "getNodeActions" | "nodeRequest" | "getNodeActivity">,
  config: AppConfig,
  input: {
    node: string;
    action: string;
    args?: unknown;
    method: "POST" | "GET" | "PUT";
    dryRun: boolean;
    approvalId?: string;
    reason?: string;
  },
) {
  const resolved = await nodelClient.resolveNode(input.node);
  return withWriteLock(writeKey(resolved, `action:${input.action}`), async () => {
    const actions = await nodelClient.getNodeActions(resolved);
    const actionName = resolveDefinitionName(actions.actions, input.action, "action");
    const request = actionRequest(actionName, input.method, input.args);
    const approval = writeApproval(config, "call_action", `${actions.node.name}:${actionName}`, {
      method: request.method,
      args: input.args,
    });
    const plan = {
      operation: "call_action",
      node: actions.node,
      action: actionName,
      restPath: request.restPath,
      method: request.method,
      args: input.args,
      approvalRequest: approval.request,
      reason: input.reason,
      dryRun: input.dryRun,
    };
    if (input.dryRun) return { ...plan, status: "dry_run" };
    assertWritesEnabled(config);
    assertWriteApproved(config, approval.details, input.approvalId);
    const activityFrom = Date.now();
    logger.info("Calling Nodel action", {
      node: actions.node.name,
      action: actionName,
      reason: input.reason,
    });
    const audited = await auditedMutation(
      config,
      {
        operation: "call_action",
        node: actions.node.name,
        action: actionName,
        method: input.method,
        reason: input.reason,
      },
      () =>
        nodelClient.nodeRequest(actions.node, request.restPath, {
          method: request.method,
          body: request.body,
          responseMode: "json",
        }),
    );
    const verification = await verifyActionActivity(nodelClient, actions.node, actionName, activityFrom);
    return {
      ...plan,
      status: verification.ok ? "succeeded_verified" : "succeeded_verification_pending",
      verification,
      response: audited.result.response,
      operationId: audited.operationId,
    };
  });
}

async function verifyActionActivity(
  nodelClient: Pick<NodelClient, "getNodeActivity">,
  node: { name: string },
  action: string,
  from: number,
) {
  try {
    const activity = await nodelClient.getNodeActivity(node as never, from);
    const matched = activityContainsAction(activity.activity, action);
    return {
      attempted: true,
      ok: matched,
      from,
      strategy: "GET REST/activity from the pre-action timestamp",
      activity: activity.activity,
      ...(matched ? {} : { message: "No post-action activity matched the requested action." }),
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      from,
      strategy: "GET REST/activity from the pre-action timestamp",
      message: sanitizeSensitiveMessage(error),
    };
  }
}

function activityContainsAction(activity: unknown, action: string) {
  const entries = Array.isArray(activity)
    ? activity
    : activity && typeof activity === "object"
      ? [
          activity,
          ...["entries", "activity", "items", "logs"].flatMap((key) => {
            const value = (activity as Record<string, unknown>)[key];
            return Array.isArray(value) ? value : [];
          }),
        ]
      : [];
  return entries.some((entry) => {
    if (!entry || typeof entry !== "object") return typeof entry === "string" && entry === action;
    const record = entry as Record<string, unknown>;
    if (record.type === "action") return record.alias === action;
    return ["action", "actionName", "name"].some((key) => record[key] === action);
  });
}

export async function setParameters(
  nodelClient: Pick<NodelClient, "resolveNode" | "nodeRequest">,
  config: AppConfig,
  input: {
    operation: string;
    node: string;
    values: Record<string, unknown>;
    mode: "merge" | "replace";
    removePaths?: string[][];
    expectedHash?: string;
    dryRun: boolean;
    waitForReady: boolean;
    readyTimeoutSeconds?: number;
    reason?: string;
    approvalId?: string;
  },
) {
  const resolved = await nodelClient.resolveNode(input.node);
  return withWriteLock(writeKey(resolved, "parameters"), async () => {
    const current = await nodelClient.nodeRequest<unknown>(resolved, "params", {
      responseMode: "json",
    });
    const planned = planConfigWrite(
      current.response,
      input.values,
      input.mode,
      input.expectedHash,
      "Parameter",
      input.removePaths,
    );
    const approval = writeApproval(config, input.operation, resolved.name, {
      mode: input.mode,
      currentHash: planned.currentHash,
      nextHash: planned.nextHash,
      values: input.values,
      removePaths: planned.removePaths,
    });
    const plan = {
      operation: input.operation,
      node: resolved,
      mode: input.mode,
      currentHash: planned.currentHash,
      nextHash: planned.nextHash,
      values: input.values,
      removePaths: planned.removePaths,
      missingRemovePaths: planned.missingRemovePaths,
      restPath: "params/save",
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
    const backupPath = backupParameterState(config, resolved.name, current.response, operationId);
    logger.info("Setting Nodel parameters", {
      node: resolved.name,
      mode: input.mode,
      names: Object.keys(input.values),
      reason: input.reason,
    });
    const audited = await auditedMutation(
      config,
      {
        operation: input.operation,
        operationId,
        node: resolved.name,
        mode: input.mode,
        currentHash: planned.currentHash,
        nextHash: planned.nextHash,
        names: Object.keys(input.values),
        removePaths: planned.removePaths,
        missingRemovePaths: planned.missingRemovePaths,
        backupPath,
        reason: input.reason,
      },
      () =>
        nodelClient.nodeRequest(resolved, "params/save", {
          method: "POST",
          body: planned.next,
          responseMode: "json",
        }),
    );
    const postWrite = await waitForNodeReadyAfterWrite(nodelClient, config, resolved, {
      waitForReady: input.waitForReady,
      readyTimeoutSeconds: input.readyTimeoutSeconds,
      operation: input.operation,
    });
    const verification = await verifyParameters(nodelClient, resolved, planned.nextHash);
    return {
      ...plan,
      status: verification.ok && postWrite.ready === true ? "succeeded_verified" : "succeeded_verification_pending",
      response: audited.result.response,
      verification,
      postWrite,
      operationId: audited.operationId,
    };
  });
}

async function verifyParameters(
  nodelClient: Pick<NodelClient, "nodeRequest">,
  node: { name: string },
  expectedHash: string,
) {
  try {
    const readBack = await nodelClient.nodeRequest<unknown>(node as never, "params", { responseMode: "json" });
    const actualHash = stableJsonHash(readBack.response);
    return {
      attempted: true,
      ok: actualHash === expectedHash,
      expectedHash,
      actualHash,
      strategy: "GET REST/params hash comparison",
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      expectedHash,
      strategy: "GET REST/params hash comparison",
      message: sanitizeSensitiveMessage(error),
    };
  }
}

function resolveDefinitionName(definitions: unknown, input: string, label: string) {
  const entries = Array.isArray(definitions)
    ? definitions.map((definition, index) => ({
        name: isRecord(definition) && typeof definition.name === "string" ? definition.name : String(index),
      }))
    : isRecord(definitions)
      ? Object.keys(definitions).map((name) => ({ name }))
      : [];
  const exact = entries.filter((entry) => entry.name === input);
  const normalizedExact = entries.filter(
    (entry) => entry.name.toLocaleLowerCase() === input.trim().toLocaleLowerCase(),
  );
  const candidates =
    exact.length > 0
      ? exact
      : normalizedExact.length > 0
        ? normalizedExact
        : entries.filter((entry) => entry.name.toLocaleLowerCase().includes(input.trim().toLocaleLowerCase()));
  if (candidates.length === 0) throw publicError("VALIDATION", `No ${label} matched: ${input}`);
  if (candidates.length > 1)
    throw publicError(
      "VALIDATION",
      `Name is ambiguous: ${input}. Candidates: ${candidates.map((entry) => entry.name).join(", ")}`,
    );
  return candidates[0].name;
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
