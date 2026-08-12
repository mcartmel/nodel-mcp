import assert from "node:assert/strict";
import test from "node:test";
import { createTestConfig } from "../dist/config.js";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callAction, setParameters } from "../dist/domain/config/writes.js";
import { setBindings, applyBindingPlan } from "../dist/domain/bindings/writes.js";
import {
  createNode,
  restartNode,
  saveRecipeScript,
  saveNodeFile,
  normalizeTextContent,
} from "../dist/domain/recipes/service.js";
import { stableJsonHash, sha256 } from "../dist/shared/canonicalJson.js";
import { approveWrite, approvalRequest, assertWriteApproved } from "../dist/state/approvals.js";

const node = /** @type {import("../dist/nodel/types.js").ResolvedNode} */ ({
  input: "Demo",
  scope: "local",
  name: "Demo",
  url: "http://127.0.0.1:8085/nodes/Demo/",
  nodeBaseUrl: "http://127.0.0.1:8085/nodes/Demo/",
  allowed: true,
});
const configBase = createTestConfig({ writesEnabled: true, writeApprovalRequired: true, writeApprovalTtlSeconds: 600 });

async function withState(run) {
  const stateDir = await mkdtemp(join(tmpdir(), "nodel-stage6-"));
  try {
    return await run({ ...configBase, stateDir });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

/** @param {unknown} value @returns {import("../dist/nodel/client.js").NodelClient} */
function asClient(value) {
  return /** @type {import("../dist/nodel/client.js").NodelClient} */ (value);
}

/** @param {unknown} value @returns {{ ok?: boolean, ready?: boolean, runtimeUrl?: string, message?: string }} */
function verificationOf(value) {
  return /** @type {{ ok?: boolean, ready?: boolean, runtimeUrl?: string, message?: string }} */ (
    /** @type {unknown} */ (/** @type {{ verification: unknown }} */ (value).verification)
  );
}

test("recipe script and supporting file no-ops do not save or create audit state", async () =>
  withState(async (config) => {
    const script = "NAME = 'demo'\n";
    const calls = [];
    const client = {
      resolveNode: async () => node,
      getNodeFileContents: async () => script,
      getNodeFileBytes: async () => new TextEncoder().encode("same\n"),
      nodeRequest: async (_node, path) => {
        calls.push(path);
        throw new Error("save must not occur");
      },
    };
    const scriptResult = await saveRecipeScript(
      asClient(client),
      config,
      node,
      script,
      sha256(script),
      false,
      false,
      undefined,
    );
    const fileResult = await saveNodeFile(
      asClient(client),
      config,
      node,
      "content/a.txt",
      normalizeTextContent("same\n"),
      sha256(new TextEncoder().encode("same\n")),
      false,
    );
    assert.equal(scriptResult.status, "no_change");
    assert.equal(fileResult.status, "no_change");
    assert.deepEqual(calls, []);
  }));

test("parameter and binding no-ops preserve a consumable approval", async () =>
  withState(async (config) => {
    const parameters = { value: 1 };
    const bindings = { actions: {}, events: {} };
    const calls = [];
    const client = {
      resolveNode: async () => node,
      nodeRequest: async (_node, path) => {
        calls.push(path);
        return { node, response: parameters };
      },
      getNodeBindings: async () => ({
        node,
        schema: { properties: { actions: { properties: {} }, events: { properties: {} } } },
        bindings,
      }),
    };
    const parameterResult = await setParameters(asClient(client), config, {
      operation: "set_node_parameters",
      node: "Demo",
      values: { value: 1 },
      mode: "merge",
      dryRun: false,
      waitForReady: false,
    });
    const bindingResult = await setBindings(asClient(client), config, {
      operation: "set_node_bindings",
      node: "Demo",
      bindings: {},
      mode: "merge",
      dryRun: false,
    });
    assert.equal(parameterResult.status, "no_change");
    assert.equal(bindingResult.status, "no_change");
    assert.deepEqual(calls, ["params"]);
    const details = {
      operation: "set_node_parameters",
      target: "Demo",
      proposalHash: parameterResult.approvalRequest.proposalHash,
    };
    const approval = approveWrite(config, details, parameterResult.approvalRequest.confirmText);
    assert.doesNotThrow(() => assertWriteApproved(config, details, approval.approvalId));
  }));

test("all-skipped binding plans return no_change before proposal errors or writes", async () =>
  withState(async (config) => {
    const currentBindings = { actions: { light: { node: "Target", action: "on" } }, events: {} };
    const schema = {
      properties: { actions: { properties: { light: { title: "Light" } } }, events: { properties: {} } },
    };
    const calls = [];
    const client = {
      resolveNode: async () => node,
      getNodeBindings: async () => ({ node, schema, bindings: currentBindings }),
      getNodeActions: async (name) => {
        calls.push(`actions:${name}`);
        return { node: { name: "Target", nodeBaseUrl: node.nodeBaseUrl }, actions: [{ name: "on" }] };
      },
      getNodeSignals: async (name) => {
        calls.push(`signals:${name}`);
        return { node: { name: "Target", nodeBaseUrl: node.nodeBaseUrl }, signals: [] };
      },
      nodeRequest: async () => {
        calls.push("remote/save");
        throw new Error("write must not occur");
      },
    };
    const result = await applyBindingPlan(asClient(client), config, {
      node: "Demo",
      targetNode: "Target",
      expectedHash: stableJsonHash(currentBindings),
      kinds: "actions",
      overwrite: false,
      minScore: 45,
      dryRun: false,
    });
    assert.equal(result.status, "no_change");
    assert.equal(result.changed, false);
    assert.equal(calls.includes("remote/save"), false);
    const details = {
      operation: "apply_node_binding_plan",
      target: "Demo",
      proposalHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };
    const approval = approveWrite(config, details, approvalRequest(config, details).confirmText);
    const before = await readdir(config.stateDir);
    const second = await applyBindingPlan(asClient(client), config, {
      node: "Demo",
      targetNode: "Target",
      expectedHash: stableJsonHash(currentBindings),
      kinds: "actions",
      overwrite: false,
      minScore: 45,
      dryRun: false,
    });
    const after = await readdir(config.stateDir);
    assert.equal(second.status, "no_change");
    assert.deepEqual(after, before);
    assert.doesNotThrow(() => assertWriteApproved(config, details, approval.approvalId));
  }));

test("accepted writes distinguish verified and pending verification", async () =>
  withState(async (baseConfig) => {
    const config = {
      ...baseConfig,
      writeApprovalRequired: false,
      nodeLifecycleEnabled: true,
      postWriteReadyTimeoutSeconds: 2,
      postWriteSettleMs: 0,
    };
    const current = { value: 1 };
    let readinessCalls = 0;
    const client = {
      resolveNode: async () => node,
      getNodeActions: async () => ({ node, actions: [{ name: "on" }] }),
      getNodeActivity: async () => ({ node, activity: [{ type: "action", alias: "on" }] }),
      nodeRequest: async (_node, path) => {
        if (path === "actions") {
          readinessCalls += 1;
          return { node, response: {} };
        }
        if (path === "params") return { node, response: current };
        if (path === "params/save") {
          current.value = 2;
          return { node, response: { accepted: true } };
        }
        return { node, response: { accepted: true } };
      },
    };
    const verified = await setParameters(asClient(client), config, {
      operation: "set_node_parameters",
      node: "Demo",
      values: { value: 2 },
      mode: "merge",
      dryRun: false,
      waitForReady: true,
    });
    assert.equal(verified.status, "succeeded_verified");
    assert.equal(verificationOf(verified).ok, true);
    assert.equal(readinessCalls, 2);

    const pending = await callAction(asClient(client), config, {
      node: "Demo",
      action: "on",
      args: undefined,
      method: "POST",
      dryRun: false,
    });
    assert.equal(pending.status, "succeeded_verified");
    assert.equal(verificationOf(pending).ok, true);
    const restart = await restartNode(asClient(client), config, "Demo", false);
    assert.equal(restart.status, "succeeded_verified");
    assert.equal(verificationOf(restart).ready, true);
  }));

test("action activity verification requires a matching action entry", async () =>
  withState(async (baseConfig) => {
    const config = { ...baseConfig, writeApprovalRequired: false };
    let activity = /** @type {unknown[]} */ ([]);
    const client = {
      resolveNode: async () => node,
      getNodeActions: async () => ({ node, actions: [{ name: "on" }] }),
      getNodeActivity: async () => ({ node, activity }),
      nodeRequest: async () => ({ node, response: { accepted: true } }),
    };
    for (const [entries, expected] of [
      [[], "succeeded_verification_pending"],
      [[{ type: "action", alias: "off" }], "succeeded_verification_pending"],
      [[{ type: "action", alias: "on" }], "succeeded_verified"],
      [[{ actionName: "on" }], "succeeded_verified"],
    ]) {
      activity = /** @type {unknown[]} */ (/** @type {unknown} */ (entries));
      const result = await callAction(asClient(client), config, {
        node: "Demo",
        action: "on",
        method: "POST",
        dryRun: false,
      });
      assert.equal(result.status, expected);
    }
  }));

test("explicit create verification probes the runtime that accepted creation", async () =>
  withState(async (baseConfig) => {
    const config = {
      ...baseConfig,
      allowedNodePrefixes: [],
      nodelBaseUrl: "http://local.example:8085",
      nodeLifecycleEnabled: true,
      postWriteReadyTimeoutSeconds: 1,
      writeApprovalRequired: false,
    };
    const remoteRuntime = "http://remote.example:8085";
    const client = {
      assertRuntimeUrlAllowed: (url) => assert.equal(url, remoteRuntime),
      runtimeRequest: async (_path, _options, url) => {
        assert.equal(url, remoteRuntime);
        return { accepted: true };
      },
      resolveNode: async () => {
        throw new Error("configured local resolver must not verify an explicit runtime");
      },
      nodeRequest: async (resolved, path) => {
        assert.equal(resolved.nodeBaseUrl, "http://remote.example:8085/nodes/SameName/");
        assert.equal(path, "actions");
        return { node: resolved, response: { actions: {} } };
      },
    };
    const result = await createNode(asClient(client), config, "SameName", remoteRuntime, false);
    assert.equal(result.status, "succeeded_verified");
    assert.equal(verificationOf(result).runtimeUrl, remoteRuntime);

    const localClient = {
      runtimeRequest: async () => ({ accepted: true }),
      assertRuntimeUrlAllowed: () => undefined,
      nodeRequest: async () => {
        throw new Error("node is still starting");
      },
    };
    const pending = await createNode(asClient(localClient), config, "LocalOnly", undefined, false);
    assert.equal(pending.status, "succeeded_verification_pending");
    assert.equal(verificationOf(pending).runtimeUrl, "http://local.example:8085");
  }));

test("exact sidecar token in current parameter state rejects mutation before save", async () =>
  withState(async (baseConfig) => {
    const config = { ...baseConfig, writeApprovalRequired: false, mcpToken: "sidecar-token" };
    let saves = 0;
    const client = {
      resolveNode: async () => node,
      nodeRequest: async (_node, path) => {
        if (path === "params") return { node, response: { nested: { value: "sidecar-token" } } };
        saves += 1;
        return { node, response: {} };
      },
    };
    await assert.rejects(
      setParameters(asClient(client), config, {
        operation: "set_node_parameters",
        node: "Demo",
        values: { updated: true },
        mode: "merge",
        dryRun: false,
        waitForReady: false,
      }),
      /faithful backup cannot be persisted/iu,
    );
    assert.equal(saves, 0);
  }));

test("binding writes return verified or pending read-back results", async () =>
  withState(async (baseConfig) => {
    const config = { ...baseConfig, writeApprovalRequired: false };
    let bindings = { actions: {}, events: {} };
    let reads = 0;
    let failReadBack = false;
    const client = {
      resolveNode: async () => node,
      getNodeBindings: async () => {
        reads += 1;
        if (failReadBack && reads > 1) throw new Error("readback unavailable token=secret");
        return {
          node,
          schema: { properties: { actions: { properties: {} }, events: { properties: {} } } },
          bindings,
        };
      },
      nodeRequest: async (_node, path, options) => {
        assert.equal(path, "remote/save");
        bindings = structuredClone(options.body);
        return { node, response: { accepted: true } };
      },
    };
    const verified = await setBindings(asClient(client), config, {
      operation: "set_node_bindings",
      node: "Demo",
      bindings: { actions: { play: { node: "Player", action: "play" } } },
      mode: "merge",
      dryRun: false,
    });
    assert.equal(verified.status, "succeeded_verified");
    assert.equal(verificationOf(verified).ok, true);

    reads = 0;
    failReadBack = true;
    const pending = await setBindings(asClient(client), config, {
      operation: "set_node_bindings",
      node: "Demo",
      bindings: { events: { status: { node: "Player", event: "status" } } },
      mode: "merge",
      dryRun: false,
    });
    assert.equal(pending.status, "succeeded_verification_pending");
    assert.equal(verificationOf(pending).ok, false);
    assert.doesNotMatch(verificationOf(pending).message ?? "", /secret/u);
  }));
