import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestConfig, type AppConfig } from "../src/config.js";
import { NodelClient } from "../src/nodel/client.js";
import { createNode } from "../src/domain/recipes/service.js";
import { reduceNodelName } from "../src/shared/nodelName.js";
import { javaActionName } from "../src/domain/ui/v2/action-names.js";

// Independent, source-backed host simulation: HTTPSession percent-decodes the
// whole URI before NodelHostHTTPD splits '/', then SimpleName invokes Nodel.reduce.
// Fixture names need only ASCII case-folding after reduction (no dialect aliases).
function simulatedJavaKey(name: string) {
  let result = "",
    level = 0,
    previous = "";
  for (let index = 0; index < name.length; index++) {
    const character = name.charAt(index);
    if (character === "(") level += 1;
    else if (level > 0) {
      if (character === ")") level -= 1;
    } else if ((previous === "-" && character === "-") || (previous === "/" && character === "/")) break;
    else if (/^[a-z0-9]$/iu.test(character) || (character.charCodeAt(0) >= 128 && !/^\p{Z}$/u.test(character)))
      result += character;
    previous = character;
  }
  return result.toLowerCase();
}

type RuntimeState = {
  calls: string[];
  readyStatus: number;
  expectedName: string;
  nodes: Map<string, string>;
  lookups: string[];
};
async function runtime(prefix: string) {
  const state: RuntimeState = {
    calls: [],
    readyStatus: 200,
    expectedName: "Allowed Same",
    nodes: new Map([["allowedsame", "Allowed Same"]]),
    lookups: [],
  };
  const server = createServer(async (request, response) => {
    const path = request.url!;
    state.calls.push(`${request.method} ${path}`);
    const send = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (path === `${prefix}/REST`)
      return send({ nodes: Object.fromEntries([...state.nodes].map(([key, name]) => [key, { name }])) });
    if (path === `${prefix}/REST/newNode`) {
      assert.equal(request.method, "POST");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { value: state.expectedName });
      state.nodes.set(simulatedJavaKey(state.expectedName), state.expectedName);
      return send({ accepted: true });
    }
    if (path.startsWith(`${prefix}/nodes/`)) {
      const decoded = decodeURIComponent(path.slice(prefix.length).split("?")[0]!.replace(/\+/gu, " "));
      const parts = decoded.slice(1).split("/");
      const key = simulatedJavaKey(parts[1]!);
      if (parts.slice(2).join("/") !== "REST/actions") return send({ wrongPath: true }, 404);
      state.lookups.push(key);
      const name = state.nodes.get(key);
      if (!name) return send({ missing: true }, 404);
      return send({ runtime: prefix, name }, key === simulatedJavaKey(state.expectedName) ? state.readyStatus : 200);
    }
    if (path.startsWith(`${prefix}/REST/nodeURLs`)) return send([]);
    return send({}, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    server,
    state,
    origin: `http://127.0.0.1:${address.port}`,
    url: `http://127.0.0.1:${address.port}${prefix}`,
  };
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function fixture(
  run: (
    config: AppConfig,
    local: Awaited<ReturnType<typeof runtime>>,
    remote: Awaited<ReturnType<typeof runtime>>,
  ) => Promise<void>,
) {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-create-runtime-trust-"));
  const local = await runtime("/local/prefix");
  const remote = await runtime("/remote/prefix");
  const config = createTestConfig({
    stateDir,
    nodelBaseUrl: local.url,
    allowedRuntimeOrigins: [remote.origin],
    allowedNodePrefixes: ["Allowed"],
    writesEnabled: true,
    nodeLifecycleEnabled: true,
    writeApprovalRequired: false,
    nodelRequestTimeoutMs: 500,
    postWriteReadyTimeoutSeconds: 0.1,
  });
  try {
    await run(config, local, remote);
  } finally {
    await close(local.server);
    await close(remote.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
}

void test("real client creation readiness stays on the authorized remote runtime despite a local same-name node", async () => {
  await fixture(async (config, local, remote) => {
    const client = new NodelClient(config);
    for (const status of [200, 503]) {
      local.state.calls.length = 0;
      remote.state.calls.length = 0;
      remote.state.readyStatus = status;
      const result = await createNode(client, config, "Allowed Same", remote.url + "/REST", false);
      assert.equal(result.status, status === 200 ? "succeeded_verified" : "succeeded_verification_pending");
      assert("verification" in result);
      assert.equal(result.verification.runtimeUrl, remote.url);
      assert.equal(result.verification.ok, status === 200);
      assert.equal(remote.state.calls.filter((call) => call === "POST /remote/prefix/REST/newNode").length, 1);
      assert(remote.state.calls.some((call) => call === "GET /remote/prefix/nodes/AllowedSame/REST/actions"));
      assert.deepEqual(local.state.calls, [], "local readiness must never stand in for the remote runtime");
      assert(remote.state.calls.every((call) => /(?:REST\/newNode|nodes\/AllowedSame\/REST\/actions)$/u.test(call)));
    }
  });
});

void test("explicit runtime reference factory checks policies, fixes the namespace and never trusts copied objects", async () => {
  await fixture(async (config, local, remote) => {
    const client = new NodelClient(config);
    const reference = client.createRuntimeNodeReference(remote.url, "Allowed Same");
    assert(Object.isFrozen(reference));
    assert.equal(reference.nodeBaseUrl, remote.url + "/nodes/AllowedSame/");
    assert.equal(
      reference.resolutionSource,
      undefined,
      "authorized runtime references must not claim discovery evidence",
    );
    const result = await client.nodeRequest<{ runtime: string }>(reference, "actions");
    assert.equal(result.response!.runtime, "/remote/prefix");
    assert.equal(local.state.calls.length, 0);
    const remoteReads = remote.state.calls.length;
    await assert.rejects(client.nodeRequest({ ...reference }, "actions", { deadlineMs: Date.now() + 75 }));
    assert.equal(
      remote.state.calls.length,
      remoteReads,
      "copy loses the instance-local trust identity; discovery cannot authorize this target",
    );
    assert.throws(() => client.createRuntimeNodeReference("http://203.0.113.50:8085", "Allowed Same"), {
      code: "POLICY",
    });
    assert.throws(() => client.createRuntimeNodeReference(remote.url, "Forbidden"), { code: "POLICY" });
    assert.throws(
      () => client.createRuntimeNodeReference(remote.url.replace("http://", "http://user:password@"), "Allowed Same"),
      { code: "VALIDATION" },
    );
    assert.throws(() => client.createRuntimeNodeReference("file:///tmp/runtime", "Allowed Same"), {
      code: "VALIDATION",
    });
    // Encoded separators/dots from a display name never become authored URL paths.
    const scoped = client.createRuntimeNodeReference(remote.url, "Allowed ../Other?query#fragment");
    assert.equal(scoped.nodeBaseUrl, remote.url + "/nodes/AllowedOtherqueryfragment/");
    assert.equal(remote.state.calls.length, remoteReads);
  });
});

void test("real-client runtime creation retains runtime-origin, node-prefix, lifecycle and approval gates", async () => {
  await fixture(async (config, local, remote) => {
    for (const overrides of [
      { allowedRuntimeOrigins: [] },
      { allowedNodePrefixes: ["Other"] },
      { writesEnabled: false },
      { nodeLifecycleEnabled: false },
      { writeApprovalRequired: true },
    ]) {
      const denied = { ...config, ...overrides };
      await assert.rejects(
        createNode(new NodelClient(denied), denied, "Allowed Same", remote.url, false),
        (error: unknown) =>
          error instanceof Error && ["POLICY", "APPROVAL_REQUIRED"].includes((error as Error & { code: string }).code),
      );
      assert.deepEqual(local.state.calls, []);
      assert.deepEqual(remote.state.calls, [], "denied operations must not reach either runtime");
    }
    const dryRun = await createNode(new NodelClient(config), config, "Allowed Same", remote.url, true);
    assert.equal(dryRun.status, "dry_run");
    assert.deepEqual(remote.state.calls, []);
  });
});

const identities = [
  { name: "Allowed---Backup", reduced: "Allowed", neighbor: "AllowedBackup" },
  { name: "Allowed//Backup", reduced: "Allowed", neighbor: "AllowedBackup" },
  { name: "Allowed (comment) Backup", reduced: "AllowedBackup", neighbor: "Allowed" },
  { name: "Allowed (first (nested)) Backup -- ignored", reduced: "AllowedBackup", neighbor: "Allowed" },
  { name: "Allowed/(comment)/Backup", reduced: "AllowedBackup", neighbor: "Allowed" },
  { name: "Allowed 雪\u00A0東京 😀 / Back up", reduced: "Allowed雪東京😀Backup", neighbor: "Allowed雪東京😀" },
  { name: "Allowed \uFEFF雪／ Backup", reduced: "Allowed\uFEFF雪／Backup", neighbor: "Allowed雪Backup" },
  { name: "Allowed ../Other?query#fragment %2F", reduced: "AllowedOtherqueryfragment2F", neighbor: "Allowed" },
];

void test("source-backed Nodel reduction is shared with v2 matching and keeps exact host node identities", () => {
  for (const { name, reduced } of identities) {
    assert.equal(reduceNodelName(name), reduced);
    assert.equal(
      simulatedJavaKey(name),
      reduced.toLowerCase(),
      "fixed expectations are independent of the production reducer",
    );
    assert.equal(javaActionName(name), reduced.toLowerCase(), "v2 matching retains its existing reducer semantics");
    assert(!reduced.includes("/"), "no decoded ASCII path separator can survive reduction");
  }
  assert.equal(
    javaActionName("Crème (ignore) Brûlée -- note"),
    "cremebrulee",
    "v2 dialect flattening remains separate from case-preserving routing",
  );
});

void test("real-client readiness follows Java comment/parenthesis/Unicode routing, never an allowed-prefix neighbor", async () => {
  await fixture(async (config, local, remote) => {
    for (const { name, reduced, neighbor } of identities) {
      const scoped = { ...config, allowedNodePrefixes: name === "Allowed---Backup" ? ["Allowed-"] : ["Allowed"] };
      const client = new NodelClient(scoped);
      const reference = client.createRuntimeNodeReference(remote.url, name);
      assert.equal(reference.name, name, "policy and approval identity remains the original display name");
      assert.equal(reference.restPathSegment, reduced);
      assert.equal(reference.nodeBaseUrl, remote.url + `/nodes/${encodeURIComponent(reduced)}/`);
      if (name === "Allowed---Backup") {
        assert.throws(() => client.createRuntimeNodeReference(remote.url, neighbor), { code: "POLICY" });
        assert.throws(
          () => client.createRuntimeNodeReference(remote.url, reduced),
          { code: "POLICY" },
          "do not reauthorize an alias in place of the approved display name",
        );
      }
      local.state.nodes.set(simulatedJavaKey(name), name);
      for (const readyStatus of [200, 404]) {
        remote.state.expectedName = name;
        remote.state.readyStatus = readyStatus;
        remote.state.nodes = new Map([[simulatedJavaKey(neighbor), neighbor]]);
        remote.state.calls.length = 0;
        remote.state.lookups.length = 0;
        local.state.calls.length = 0;
        const result = await createNode(client, scoped, name, remote.url, false);
        assert.equal(
          result.status,
          readyStatus === 200 ? "succeeded_verified" : "succeeded_verification_pending",
          name,
        );
        assert("verification" in result);
        assert.equal(result.verification.runtimeUrl, remote.url);
        assert.equal(result.verification.ok, readyStatus === 200);
        assert.deepEqual(
          remote.state.lookups,
          [reduced.toLowerCase()],
          "only the exact newly-created Java identity is probed, even when a ready neighbor exists",
        );
        assert.deepEqual(remote.state.calls, [
          "POST /remote/prefix/REST/newNode",
          `GET /remote/prefix/nodes/${encodeURIComponent(reduced)}/REST/actions`,
        ]);
        assert.deepEqual(local.state.calls, [], "remote creation cannot acquire local same-name verification");
      }
    }
  });
});

void test("simulated NanoHTTPD routes decoded original names, but percent-encoded original slashes are not segment-safe", async () => {
  await fixture(async (_config, _local, remote) => {
    for (const { name, reduced } of identities) {
      remote.state.expectedName = name;
      remote.state.nodes.set(reduced.toLowerCase(), name);
      const response = await fetch(remote.url + `/nodes/${encodeURIComponent(name)}/REST/actions`);
      if (name.includes("/")) {
        assert.equal(response.status, 404, "whole-URI decoding happens before host path splitting");
      } else {
        assert.equal(response.status, 200);
        assert.equal(((await response.json()) as { name: string }).name, name);
      }
      if (!response.bodyUsed) await response.body?.cancel();
    }
  });
});
