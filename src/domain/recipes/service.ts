import type { AppConfig } from "../../config.js";
import { logger } from "../../logger.js";
import { normalizeRuntimeBaseUrl, type NodelClient } from "../../nodel/client.js";
import { assertSafeRecipePath, contentAssetPathWarning } from "../../nodel/pathPolicy.js";
import { verifyComposedRecipe } from "../../nodel/recipeComposition.js";
import { summarizeRecipeVerification, verifyRecipeCompliance } from "../../nodel/recipeVerifier.js";
import type { ResolvedNode } from "../../nodel/types.js";
import { approvalRequest, assertWriteApproved } from "../../safety/approvals.js";
import {
  assertDeletesEnabled,
  assertNodeAllowed,
  assertNodeLifecycleEnabled,
  assertWritesEnabled,
} from "../../safety/policy.js";
import { auditedMutation } from "../../state/audit.js";
import { withWriteLock } from "../../state/locks.js";
import { sha256 } from "../../shared/canonicalJson.js";
import { PublicError, publicError, sanitizeSensitiveMessage } from "../../shared/publicErrors.js";
import { NodelNotFoundError } from "../../nodel/http/errors.js";
import { NodeResolutionInconclusiveError, NodeResolutionNotFoundError } from "../../nodel/resolution/resolver.js";
import {
  applyTextEdits,
  NODE_CONFIG_PATH,
  nodeFileSaveRequest,
  normalizeBase64Content,
  normalizeTextContent,
  recipeScriptSaveRequest,
  SCRIPT_PATH,
  type NormalizedContent,
} from "./operations.js";
import { recipeWriteProposalHash, writeApprovalDetails } from "./plans.js";
import { waitForNodeReadyAfterWrite } from "./readiness.js";

export type TextEdit = { oldText: string; newText: string; replaceAll?: boolean };
export type NormalizedRecipeScript = NormalizedContent & {
  script: string;
  recipeVerification: ReturnType<typeof verifyRecipeCompliance>;
};

export {
  NODE_CONFIG_PATH,
  SCRIPT_PATH,
  applyTextEdits,
  nodeFileSaveRequest,
  normalizeBase64Content,
  normalizeTextContent,
  recipeScriptSaveRequest,
};

export function normalizeRecipeScript(script: string, path = SCRIPT_PATH): NormalizedRecipeScript {
  return { ...normalizeTextContent(script), script, recipeVerification: verifyRecipeCompliance(path, script) };
}

export function assertSupportingFilePath(path: string) {
  const safePath = assertSafeRecipePath(path);
  if (safePath === SCRIPT_PATH)
    throw publicError(
      "VALIDATION",
      "Use recipe script tools for script.py; supporting file tools cannot save the main recipe script.",
    );
  return safePath;
}

export async function verifyComposedRecipeForNode(
  nodelClient: NodelClient,
  node: ResolvedNode,
  candidate?: { path: string; content: string },
) {
  const listed = await nodelClient.nodeRequest<unknown>(node, "files", { responseMode: "json" });
  const contentPaths = filePaths(listed.response).filter((path) => path === NODE_CONFIG_PATH || path.endsWith(".py"));
  const files = await Promise.all(
    contentPaths.map(async (path) =>
      candidate?.path === path
        ? { path, content: candidate.content }
        : { path, content: await nodelClient.getNodeFileContents(node, path) },
    ),
  );
  if (candidate && !contentPaths.includes(candidate.path)) files.push(candidate);
  return verifyComposedRecipe(files, { candidate });
}

export async function proposeRecipeScript(
  nodelClient: Pick<NodelClient, "resolveNode" | "getNodeFileContents">,
  config: AppConfig,
  node: string,
  script: string,
  expectedHash?: string,
  detail?: string,
) {
  const resolved = await nodelClient.resolveNode(node);
  const current = await nodelClient.getNodeFileContents(resolved, SCRIPT_PATH);
  const currentHash = sha256(current);
  if (expectedHash && currentHash !== expectedHash)
    throw publicError("CONFLICT", `Recipe script expectedHash mismatch. Current hash is ${currentHash}.`);
  const normalized = normalizeRecipeScript(script);
  const operation = "save_recipe_script";
  const target = `${resolved.name}:${SCRIPT_PATH}`;
  const proposalHash = recipeWriteProposalHash(operation, target, currentHash, normalized.hash, SCRIPT_PATH, {
    operation,
  });
  return {
    operation,
    node: resolved,
    path: SCRIPT_PATH,
    detail,
    currentHash,
    nextHash: normalized.hash,
    changed: currentHash !== normalized.hash,
    byteLength: normalized.byteLength,
    recipeVerification: normalized.recipeVerification,
    approvalReady: true,
    approvalRequest: approvalRequest(config, { operation, target, proposalHash }),
    proposedContent: script,
    message: config.writesEnabled
      ? "No changes applied. Pass script and currentHash to nodel.save_recipe_script after approval."
      : "No changes applied. Enable writes and get approval before saving this recipe script.",
  };
}

export async function proposeRecipeScriptEdit(
  nodelClient: NodelClient,
  config: AppConfig,
  node: string,
  edits: TextEdit[],
  expectedHash: string | undefined,
  detail: string | undefined,
  includeContent: boolean,
) {
  const resolved = await nodelClient.resolveNode(node);
  const current = await nodelClient.getNodeFileContents(resolved, SCRIPT_PATH);
  const currentHash = sha256(current);
  if (expectedHash && currentHash !== expectedHash)
    throw publicError("CONFLICT", `Recipe script expectedHash mismatch. Current hash is ${currentHash}.`);
  const editResult = applyTextEdits(current, edits);
  const normalized = normalizeRecipeScript(editResult.content);
  const operation = "apply_recipe_script_edit";
  const target = `${resolved.name}:${SCRIPT_PATH}`;
  const proposalHash = recipeWriteProposalHash(operation, target, currentHash, normalized.hash, SCRIPT_PATH, {
    operation,
    edits: editResult.applied,
  });
  return {
    operation,
    node: resolved,
    path: SCRIPT_PATH,
    detail,
    currentHash,
    nextHash: normalized.hash,
    changed: currentHash !== normalized.hash,
    edits: editResult.applied,
    recipeVerification: normalized.recipeVerification,
    approvalReady: true,
    approvalRequest: approvalRequest(config, { operation, target, proposalHash }),
    proposedContent: includeContent ? editResult.content : undefined,
    message: config.writesEnabled
      ? "No changes applied. Pass the same edits and currentHash to nodel.apply_recipe_script_edit after approval."
      : "No changes applied. Enable writes and get approval before applying this script edit.",
  };
}

export async function proposeNodeFile(
  nodelClient: NodelClient,
  config: AppConfig,
  node: string,
  path: string,
  normalized: NormalizedContent,
  expectedHash?: string,
  detail?: string,
) {
  const safePath = assertSupportingFilePath(path);
  const resolved = await nodelClient.resolveNode(node);
  const current = await readOptionalNodeFileBytes(nodelClient, resolved, safePath);
  const currentHash = current === undefined ? undefined : sha256(current);
  if (expectedHash && currentHash !== expectedHash)
    throw publicError(
      "CONFLICT",
      `Supporting file expectedHash mismatch. Current hash is ${currentHash ?? "<missing>"}.`,
    );
  const operation = "save_node_file";
  const target = `${resolved.name}:${safePath}`;
  const proposalHash = recipeWriteProposalHash(operation, target, currentHash, normalized.hash, safePath, {
    operation,
  });
  return {
    operation,
    node: resolved,
    path: safePath,
    detail,
    currentHash,
    nextHash: normalized.hash,
    changed: currentHash !== normalized.hash,
    contentMode: normalized.mode,
    byteLength: normalized.byteLength,
    pathWarnings: recipePathWarnings(safePath),
    approvalReady: true,
    approvalRequest: approvalRequest(config, { operation, target, proposalHash }),
    proposedContent: normalized.text,
    message: config.writesEnabled
      ? `No changes applied. Pass ${normalized.mode === "base64" ? "contentBase64" : "content"} and currentHash to the matching nodel.save_node_file_* tool after approval.`
      : "No changes applied. Enable writes and get approval before saving this supporting file.",
  };
}

export async function proposeNodeFileEdit(
  nodelClient: NodelClient,
  config: AppConfig,
  node: string,
  path: string,
  edits: TextEdit[],
  expectedHash: string | undefined,
  detail: string | undefined,
  includeContent: boolean,
) {
  const safePath = assertSupportingFilePath(path);
  const resolved = await nodelClient.resolveNode(node);
  const current = await nodelClient.getNodeFileContents(resolved, safePath);
  const currentHash = sha256(current);
  if (expectedHash && currentHash !== expectedHash)
    throw publicError("CONFLICT", `Supporting file expectedHash mismatch. Current hash is ${currentHash}.`);
  const editResult = applyTextEdits(current, edits);
  const normalized = normalizeTextContent(editResult.content);
  const operation = "apply_node_file_edit";
  const target = `${resolved.name}:${safePath}`;
  const proposalHash = recipeWriteProposalHash(operation, target, currentHash, normalized.hash, safePath, {
    operation,
    edits: editResult.applied,
  });
  return {
    operation,
    node: resolved,
    path: safePath,
    detail,
    currentHash,
    nextHash: normalized.hash,
    changed: currentHash !== normalized.hash,
    edits: editResult.applied,
    contentMode: normalized.mode,
    byteLength: normalized.byteLength,
    pathWarnings: recipePathWarnings(safePath),
    approvalReady: true,
    approvalRequest: approvalRequest(config, { operation, target, proposalHash }),
    proposedContent: includeContent ? editResult.content : undefined,
    message: config.writesEnabled
      ? "No changes applied. Pass the same edits and currentHash to nodel.apply_node_file_edit after approval."
      : "No changes applied. Enable writes and get approval before applying this supporting-file edit.",
  };
}

export async function saveRecipeScript(
  nodelClient: NodelClient,
  config: AppConfig,
  node: string | ResolvedNode,
  script: string,
  expectedHash: string | undefined,
  dryRun: boolean,
  waitForReady: boolean,
  readyTimeoutSeconds: number | undefined,
  reason?: string,
  extraPlan: Record<string, unknown> = {},
  approvalId?: string,
  alreadyLocked = false,
) {
  const resolved = typeof node === "string" ? await nodelClient.resolveNode(node) : node;
  const save = async () => {
    const current = await nodelClient.getNodeFileContents(resolved, SCRIPT_PATH);
    const currentHash = sha256(current);
    if (expectedHash && currentHash !== expectedHash)
      throw publicError("CONFLICT", `Recipe script expectedHash mismatch. Current hash is ${currentHash}.`);
    const normalized = normalizeRecipeScript(script);
    const request = recipeScriptSaveRequest(script);
    const plan = {
      operation: "save_recipe_script",
      ...extraPlan,
      node: resolved,
      path: SCRIPT_PATH,
      byteLength: normalized.byteLength,
      restPath: request.restPath,
      method: request.method,
      currentHash,
      nextHash: normalized.hash,
      recipeVerification: normalized.recipeVerification,
      dryRun,
      reason,
    };
    const operation = typeof plan.operation === "string" ? plan.operation : "save_recipe_script";
    const approval = writeApproval(config, operation, `${resolved.name}:${SCRIPT_PATH}`, {
      currentHash,
      nextHash: normalized.hash,
      path: SCRIPT_PATH,
      extraPlan,
    });
    const planWithApproval = { ...plan, approvalRequest: approval.request };
    if (currentHash === normalized.hash) return { ...planWithApproval, status: "no_change", changed: false };
    if (dryRun) return { ...planWithApproval, status: "dry_run" };
    assertWritesEnabled(config);
    if (!normalized.recipeVerification.ok)
      throw publicError(
        "VALIDATION",
        `Recipe compliance check failed for ${SCRIPT_PATH}: ${summarizeRecipeVerification(normalized.recipeVerification)}`,
      );
    assertWriteApproved(config, approval.details, approvalId);
    logger.info("Saving Nodel recipe script", { node: resolved.name, reason });
    const audited = await auditedMutation(
      config,
      { operation, node: resolved.name, path: SCRIPT_PATH, currentHash, nextHash: normalized.hash, reason },
      () =>
        nodelClient.nodeRequest(resolved, request.restPath, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          responseMode: "json",
        }),
    );
    const postWrite = await waitForNodeReadyAfterWrite(nodelClient, config, resolved, {
      waitForReady,
      readyTimeoutSeconds,
      operation,
    });
    const verification = await verifyRecipeScriptReadBack(nodelClient, resolved, normalized.hash);
    const ready = postWrite.ready === true;
    return {
      ...planWithApproval,
      status: verification.ok && ready ? "succeeded_verified" : "succeeded_verification_pending",
      response: audited.result.response,
      postWrite,
      verification,
      operationId: audited.operationId,
    };
  };
  return alreadyLocked ? save() : withWriteLock(writeKey(resolved, SCRIPT_PATH), save);
}

export async function applyRecipeScriptEdit(
  nodelClient: NodelClient,
  config: AppConfig,
  node: string,
  edits: TextEdit[],
  expectedHash: string,
  dryRun: boolean,
  waitForReady: boolean,
  readyTimeoutSeconds: number | undefined,
  reason?: string,
  approvalId?: string,
) {
  const resolved = await nodelClient.resolveNode(node);
  return withWriteLock(writeKey(resolved, SCRIPT_PATH), async () => {
    const current = await nodelClient.getNodeFileContents(resolved, SCRIPT_PATH);
    const currentHash = sha256(current);
    if (currentHash !== expectedHash)
      throw publicError("CONFLICT", `Recipe script expectedHash mismatch. Current hash is ${currentHash}.`);
    const editResult = applyTextEdits(current, edits);
    return saveRecipeScript(
      nodelClient,
      config,
      resolved,
      editResult.content,
      expectedHash,
      dryRun,
      waitForReady,
      readyTimeoutSeconds,
      reason,
      { operation: "apply_recipe_script_edit", edits: editResult.applied },
      approvalId,
      true,
    );
  });
}

export async function saveNodeFile(
  nodelClient: NodelClient,
  config: AppConfig,
  node: string | ResolvedNode,
  path: string,
  normalized: NormalizedContent,
  expectedHash: string | undefined,
  dryRun: boolean,
  reason?: string,
  extraPlan: Record<string, unknown> = {},
  approvalId?: string,
  alreadyLocked = false,
) {
  path = assertSupportingFilePath(path);
  const resolved = typeof node === "string" ? await nodelClient.resolveNode(node) : node;
  const save = async () => {
    const current = await readOptionalNodeFileBytes(nodelClient, resolved, path);
    const currentHash = current === undefined ? undefined : sha256(current);
    if (expectedHash && currentHash !== expectedHash)
      throw publicError(
        "CONFLICT",
        `Supporting file expectedHash mismatch. Current hash is ${currentHash ?? "<missing>"}.`,
      );
    const request = nodeFileSaveRequest(path, normalized.bytes);
    const plan = {
      operation: "save_node_file",
      ...extraPlan,
      node: resolved,
      path,
      contentMode: normalized.mode,
      byteLength: normalized.byteLength,
      restPath: request.restPath,
      method: request.method,
      currentHash,
      nextHash: normalized.hash,
      pathWarnings: recipePathWarnings(path),
      dryRun,
      reason,
    };
    const operation = typeof plan.operation === "string" ? plan.operation : "save_node_file";
    const approval = writeApproval(config, operation, `${resolved.name}:${path}`, {
      currentHash,
      nextHash: normalized.hash,
      path,
      extraPlan,
    });
    const planWithApproval = { ...plan, approvalRequest: approval.request };
    if (currentHash === normalized.hash) return { ...planWithApproval, status: "no_change", changed: false };
    if (dryRun) return { ...planWithApproval, status: "dry_run" };
    assertWritesEnabled(config);
    assertWriteApproved(config, approval.details, approvalId);
    logger.info("Saving Nodel supporting file", { node: resolved.name, path, reason });
    const audited = await auditedMutation(
      config,
      { operation, node: resolved.name, path, currentHash, nextHash: normalized.hash, reason },
      () =>
        nodelClient.nodeRequest(resolved, request.restPath, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          responseMode: "json",
        }),
    );
    const verification = await verifySupportingFileReadBack(nodelClient, resolved, path, normalized.hash);
    return {
      ...planWithApproval,
      status: verification.ok ? "succeeded_verified" : "succeeded_verification_pending",
      response: audited.result.response,
      verification,
      operationId: audited.operationId,
    };
  };
  return alreadyLocked ? save() : withWriteLock(writeKey(resolved, `file:${path}`), save);
}

export async function applyNodeFileEdit(
  nodelClient: NodelClient,
  config: AppConfig,
  node: string,
  path: string,
  edits: TextEdit[],
  expectedHash: string | undefined,
  dryRun: boolean,
  reason?: string,
  approvalId?: string,
) {
  const safePath = assertSupportingFilePath(path);
  const resolved = await nodelClient.resolveNode(node);
  return withWriteLock(writeKey(resolved, `file:${safePath}`), async () => {
    const current = await nodelClient.getNodeFileContents(resolved, safePath);
    const currentHash = sha256(current);
    if (expectedHash && currentHash !== expectedHash)
      throw publicError("CONFLICT", `Supporting file expectedHash mismatch. Current hash is ${currentHash}.`);
    const editResult = applyTextEdits(current, edits);
    return saveNodeFile(
      nodelClient,
      config,
      resolved,
      safePath,
      normalizeTextContent(editResult.content),
      expectedHash,
      dryRun,
      reason,
      { operation: "apply_node_file_edit", edits: editResult.applied },
      approvalId,
      true,
    );
  });
}

export async function restartNode(
  nodelClient: Pick<NodelClient, "resolveNode" | "nodeRequest">,
  config: AppConfig,
  node: string,
  dryRun: boolean,
  approvalId?: string,
  reason?: string,
) {
  const resolved = await nodelClient.resolveNode(node);
  return withWriteLock(writeKey(resolved, "restart"), async () => {
    const approval = writeApproval(config, "restart_node", resolved.name, { node: resolved.name });
    const plan = {
      operation: "restart_node",
      node: resolved,
      restPath: "restart",
      method: "POST",
      approvalRequest: approval.request,
      dryRun: Boolean(dryRun),
      reason,
    };
    if (dryRun) return { ...plan, status: "dry_run" };
    assertNodeLifecycleEnabled(config);
    assertWriteApproved(config, approval.details, approvalId);
    logger.info("Restarting Nodel node", { node: resolved.name, reason });
    const audited = await auditedMutation(config, { operation: "restart_node", node: resolved.name, reason }, () =>
      nodelClient.nodeRequest(resolved, "restart", { method: "POST", responseMode: "json" }),
    );
    const verification = await waitForNodeReadyAfterWrite(nodelClient, config, resolved, {
      waitForReady: true,
      operation: "restart_node",
    });
    return {
      ...plan,
      status: verification.ready === true ? "succeeded_verified" : "succeeded_verification_pending",
      verification,
      response: audited.result.response,
      operationId: audited.operationId,
    };
  });
}

export async function createNode(
  nodelClient: Pick<NodelClient, "assertRuntimeUrlAllowed" | "runtimeRequest" | "nodeRequest">,
  config: AppConfig,
  name: string,
  runtimeUrl: string | undefined,
  dryRun: boolean,
  approvalId?: string,
  reason?: string,
) {
  assertNodeAllowed(name, config.allowedNodePrefixes);
  const resolvedRuntimeUrl = runtimeUrl ? normalizeRuntimeBaseUrl(runtimeUrl) : config.nodelBaseUrl;
  if (runtimeUrl) nodelClient.assertRuntimeUrlAllowed(resolvedRuntimeUrl);
  return withWriteLock(`${resolvedRuntimeUrl}:runtime:create:${name}`, async () => {
    const body = { value: name };
    const approval = writeApproval(config, "create_node", `${resolvedRuntimeUrl}:${name}`, {
      runtimeUrl: resolvedRuntimeUrl,
      body,
    });
    const plan = {
      operation: "create_node",
      runtime: runtimeUrl ? "explicit" : "local",
      runtimeUrl: resolvedRuntimeUrl,
      restPath: "newNode",
      method: "POST",
      body,
      approvalRequest: approval.request,
      dryRun: Boolean(dryRun),
      reason,
    };
    if (dryRun) return { ...plan, status: "dry_run" };
    assertNodeLifecycleEnabled(config);
    assertWriteApproved(config, approval.details, approvalId);
    logger.info("Creating Nodel node", { node: name, runtimeUrl: resolvedRuntimeUrl, reason });
    const audited = await auditedMutation(
      config,
      { operation: "create_node", node: name, runtimeUrl: resolvedRuntimeUrl, reason },
      () => nodelClient.runtimeRequest("newNode", { method: "POST", body, responseMode: "json" }, resolvedRuntimeUrl),
    );
    const verification = await verifyCreatedNode(nodelClient, config, name, resolvedRuntimeUrl);
    return {
      ...plan,
      status: verification.ok ? "succeeded_verified" : "succeeded_verification_pending",
      verification,
      response: audited.result,
      operationId: audited.operationId,
    };
  });
}

export async function deleteNode(
  nodelClient: NodelClient,
  config: AppConfig,
  node: string,
  confirmNodeName: string | undefined,
  dryRun: boolean,
  approvalId?: string,
  reason?: string,
) {
  const resolved = await nodelClient.resolveNode(node);
  return withWriteLock(writeKey(resolved, "delete"), async () => {
    const approval = writeApproval(config, "delete_node", resolved.name, { node: resolved.name });
    const plan = {
      operation: "delete_node",
      node: resolved,
      restPath: "",
      method: "DELETE",
      approvalRequest: approval.request,
      dryRun: Boolean(dryRun),
      reason,
    };
    if (dryRun) return { ...plan, status: "dry_run", requiredConfirmation: resolved.name };
    if (confirmNodeName !== resolved.name)
      throw publicError("VALIDATION", `Deletion requires exact confirmNodeName: ${resolved.name}`);
    assertDeletesEnabled(config);
    assertWriteApproved(config, approval.details, approvalId);
    logger.info("Deleting Nodel node", { node: resolved.name, reason });
    const audited = await auditedMutation(config, { operation: "delete_node", node: resolved.name, reason }, () =>
      nodelClient.nodeRequest(resolved, "", { method: "DELETE", responseMode: "json" }),
    );
    const verification = await verifyDeletedNode(nodelClient, config, resolved.name);
    return {
      ...plan,
      status: verification.ok ? "succeeded_verified" : "succeeded_verification_pending",
      verification,
      response: audited.result.response,
      operationId: audited.operationId,
    };
  });
}

async function verifyCreatedNode(
  nodelClient: Pick<NodelClient, "nodeRequest">,
  config: AppConfig,
  name: string,
  runtimeUrl: string,
) {
  const deadline = Date.now() + (config.postWriteReadyTimeoutSeconds ?? 20) * 1000;
  const node = createdNodeReference(runtimeUrl, name);
  let attempts = 0;
  let lastError: string | undefined;
  while (Date.now() <= deadline) {
    attempts += 1;
    try {
      await nodelClient.nodeRequest(node, "actions", { responseMode: "json" });
      return {
        attempted: true,
        ok: true,
        attempts,
        runtimeUrl,
        strategy: "Probe GET REST/actions on the runtime that accepted creation",
      };
    } catch (error) {
      lastError = sanitizeSensitiveMessage(error);
      if (Date.now() >= deadline) break;
      await sleep(250);
    }
  }
  return {
    attempted: true,
    ok: false,
    attempts,
    runtimeUrl,
    strategy: "Probe GET REST/actions on the runtime that accepted creation",
    lastError,
    message: "Create was accepted but the node could not be resolved and readied before the verification deadline.",
  };
}

function createdNodeReference(runtimeUrl: string, name: string): ResolvedNode {
  const nodeBaseUrl = new URL(`nodes/${encodeURIComponent(name)}/`, `${runtimeUrl}/`).toString();
  return {
    input: name,
    scope: "remote",
    name,
    address: nodeBaseUrl,
    url: nodeBaseUrl,
    nodeBaseUrl,
    allowed: true,
    resolutionSource: "discovery",
  };
}

export async function verifyDeletedNode(
  nodelClient: Pick<NodelClient, "resolveNode"> & Partial<Pick<NodelClient, "resolveNodeForDeletion">>,
  config: AppConfig,
  name: string,
) {
  const deadline = Date.now() + (config.postWriteReadyTimeoutSeconds ?? 20) * 1000;
  let attempts = 0;
  let lastError: string | undefined;
  while (Date.now() <= deadline) {
    attempts += 1;
    try {
      await (nodelClient.resolveNodeForDeletion ?? nodelClient.resolveNode)(name);
    } catch (error) {
      if (error instanceof NodeResolutionNotFoundError)
        return {
          attempted: true,
          ok: true,
          attempts,
          strategy: "Poll node resolution until the deleted node is absent",
        };
      if (error instanceof NodeResolutionInconclusiveError) lastError = sanitizeSensitiveMessage(error);
      else lastError = sanitizeSensitiveMessage(error);
    }
    if (Date.now() >= deadline) break;
    await sleep(250);
  }
  return {
    attempted: true,
    ok: false,
    attempts,
    strategy: "Poll node resolution until the deleted node is absent",
    lastError,
    message: "Delete was accepted but node absence could not be verified before the verification deadline.",
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readOptionalNodeFileBytes(
  nodelClient: Pick<NodelClient, "getNodeFileBytes">,
  node: ResolvedNode,
  path: string,
) {
  try {
    return await nodelClient.getNodeFileBytes(node, path);
  } catch (error) {
    if (!(error instanceof NodelNotFoundError)) throw error;
    return undefined;
  }
}

async function verifyRecipeScriptReadBack(nodelClient: NodelClient, node: ResolvedNode, expectedHash: string) {
  return verifySupportingFileReadBack(nodelClient, node, SCRIPT_PATH, expectedHash);
}

async function verifySupportingFileReadBack(
  nodelClient: NodelClient,
  node: ResolvedNode,
  path: string,
  expectedHash: string,
) {
  try {
    const bytes = await nodelClient.getNodeFileBytes(node, path);
    const actualHash = sha256(bytes);
    return {
      attempted: true,
      ok: actualHash === expectedHash,
      expectedHash,
      actualHash,
      strategy: "GET REST/files/contents hash comparison",
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      expectedHash,
      strategy: "GET REST/files/contents hash comparison",
      message: sanitizeSensitiveMessage(error),
    };
  }
}

function filePaths(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  return entries.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (!isRecord(entry)) return [];
    const path = [entry.path, entry.name, entry.file, entry.filename].find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );
    return path ? [path] : [];
  });
}
function recipePathWarnings(path: string) {
  const warning = contentAssetPathWarning(path);
  return warning ? [warning] : [];
}
function writeKey(node: { nodeBaseUrl: string; name: string }, resource: string) {
  return `${node.nodeBaseUrl}:${node.name}:${resource}`;
}
function writeApproval(config: AppConfig, operation: string, target: string, payload: unknown) {
  const details = writeApprovalDetails(operation, target, payload);
  return { details, request: approvalRequest(config, details) };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
