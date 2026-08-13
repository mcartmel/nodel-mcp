import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deleteNode } from "../src/domain/recipes/service.js";
import { completeTestConfig } from "./fixtures/config.js";
import { approveWrite } from "../src/state/approvals.js";
import { NodeResolutionNotFoundError } from "../src/nodel/resolution/resolver.js";
import type { NodelClient } from "../src/nodel/client.js";
import type { ResolvedNode } from "../src/nodel/types.js";

const resolvedNode: ResolvedNode = {
  input: "Demo",
  scope: "local",
  name: "Demo",
  address: "http://127.0.0.1:8085/nodes/Demo/",
  url: "http://127.0.0.1:8085/nodes/Demo/",
  nodeBaseUrl: "http://127.0.0.1:8085/nodes/Demo/",
  allowed: true,
};

void test("deleteNode uses Nodel remove confirmation and verifies absence", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-delete-node-"));
  try {
    const config = completeTestConfig({
      stateDir,
      writesEnabled: true,
      nodeLifecycleEnabled: true,
      deletesEnabled: true,
      writeApprovalRequired: true,
      postWriteReadyTimeoutSeconds: 0,
    });
    const calls: Array<{ path: string; options: unknown }> = [];
    const client = {
      resolveNode: async () => resolvedNode,
      resolveNodeForDeletion: async () => {
        throw new NodeResolutionNotFoundError("Demo");
      },
      nodeRequest: async (_node: ResolvedNode, path: string, options: unknown) => {
        calls.push({ path, options });
        return { node: resolvedNode, response: undefined };
      },
    } as unknown as NodelClient;

    const dryRun = await deleteNode(client, config, "Demo", undefined, true);
    assert.equal(dryRun.restPath, "remove?confirm=true");
    assert.equal(dryRun.method, "GET");
    assert.equal(calls.length, 0);

    await assert.rejects(() => deleteNode(client, config, "Demo", "demo", false), /exact confirmNodeName/u);
    assert.equal(calls.length, 0);

    await assert.rejects(
      () => deleteNode(client, { ...config, writesEnabled: false }, "Demo", "Demo", false),
      /Write\/action tools are disabled/u,
    );
    await assert.rejects(
      () => deleteNode(client, { ...config, nodeLifecycleEnabled: false }, "Demo", "Demo", false),
      /Node lifecycle tools are disabled/u,
    );
    await assert.rejects(
      () => deleteNode(client, { ...config, deletesEnabled: false }, "Demo", "Demo", false),
      /Delete tools are disabled/u,
    );
    await assert.rejects(() => deleteNode(client, config, "Demo", "Demo", false), /Write approval is required/u);
    assert.equal(calls.length, 0);

    const plan = await deleteNode(client, config, "Demo", undefined, true);
    const approval = approveWrite(config, plan.approvalRequest, plan.approvalRequest.confirmText, "test");
    const result = await deleteNode(client, config, "Demo", "Demo", false, approval.approvalId);

    assert.deepEqual(calls, [
      {
        path: "remove?confirm=true",
        options: { method: "GET", responseMode: "empty" },
      },
    ]);
    assert.equal(result.status, "succeeded_verified");
    assert.equal("verification" in result && result.verification.ok, true);
    if (!("operationId" in result)) assert.fail("delete result did not include an operation ID");
    const { operationId } = result;
    const audit = readFileSync(join(stateDir, "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      audit.map(({ operation, node, operationId, outcome }) => ({ operation, node, operationId, outcome })),
      [
        { operation: "delete_node", node: "Demo", operationId, outcome: "attempted" },
        { operation: "delete_node", node: "Demo", operationId, outcome: "succeeded" },
      ],
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
