import assert from "node:assert/strict";
import test from "node:test";
import {
  NodelClient,
  NodelHttpError,
  NodelInvalidJsonError,
  NodelNotFoundError,
  NodelRedirectError,
  NodelTimeoutError,
  fetchWithTimeout,
  normalizeRuntimeBaseUrl,
  runtimeRestUrl,
} from "../dist/nodel/client.js";
import {
  decodeActivity,
  decodeBindings,
  decodeBindingsSchema,
  decodeConsole,
  decodeDefinitions,
  decodeDiscoveredNodes,
  decodeFiles,
  decodeHostStatus,
} from "../dist/nodel/contracts/decoders.js";
import { NodelHttpTransport } from "../dist/nodel/http/transport.js";
import { createTestConfig } from "../dist/config.js";

test("normalizeRuntimeBaseUrl accepts host roots and REST URLs", () => {
  assert.equal(normalizeRuntimeBaseUrl("http://example.local:8085"), "http://example.local:8085");
  assert.equal(normalizeRuntimeBaseUrl("http://example.local:8085/REST"), "http://example.local:8085");
  assert.equal(normalizeRuntimeBaseUrl("https://example.local:8443/REST/"), "https://example.local:8443");
  assert.equal(runtimeRestUrl("http://example.local:8085", "newNode"), "http://example.local:8085/REST/newNode");
  assert.throws(() => normalizeRuntimeBaseUrl("file:///tmp/nodel"), /http or https/u);
  assert.throws(() => normalizeRuntimeBaseUrl("http://user:pass@example.local:8085"), /embedded credentials/u);
});

test("resolveNode resolves local node URLs from trusted local status", async () =>
  withFetch(async (calls) => {
    globalThis.fetch = async (url) => {
      calls.push(url.toString());
      assert.equal(url.toString(), "http://127.0.0.1:8086/REST");
      return jsonResponse({ nodes: { Brightsign: { name: "Brightsign" } } });
    };
    const resolved = await new NodelClient(testConfig()).resolveNode("http://127.0.0.1:8086/nodes/Brightsign/");
    assert.equal(resolved.scope, "local");
    assert.equal(resolved.nodeBaseUrl, "http://127.0.0.1:8086/nodes/Brightsign/");
    assert.equal(calls.length, 1);
  }));

test("local runtime requests preserve configured base path prefixes", async () =>
  withFetch(async (calls) => {
    globalThis.fetch = async (url, init) => {
      calls.push(url.toString());
      if (url.toString() === "https://host/prefix/REST")
        return jsonResponse({ nodes: { Display: { name: "Display" } } });
      if (url.toString() === "https://host/prefix/REST/Toolkit") return jsonResponse({ toolkit: true });
      if (url.toString() === "https://host/prefix/REST/nodeURLs") {
        assert.equal(JSON.parse(init.body).filter, "Display");
        return jsonResponse([]);
      }
      if (url.toString() === "https://host/prefix/REST/nodeURLsForNode") {
        assert.equal(JSON.parse(init.body).name, "Display");
        return jsonResponse([]);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const client = new NodelClient(testConfig({ nodelBaseUrl: "https://host/prefix" }));
    await client.getHostStatus();
    await client.getToolkit();
    await client.listNetworkNodeUrls("Display");
    await client.listNetworkNodeUrlsForNode("Display");
    const resolved = await client.resolveNode("Display");
    assert.equal(resolved.nodeBaseUrl, "https://host/prefix/nodes/Display/");
    assert.deepEqual(calls, [
      "https://host/prefix/REST",
      "https://host/prefix/REST/Toolkit",
      "https://host/prefix/REST/nodeURLs",
      "https://host/prefix/REST/nodeURLsForNode",
      "https://host/prefix/REST",
    ]);
  }));

test("arbitrary caller URL is never fetched and fails without a trusted discovery match", async () =>
  withFetch(async (calls) => {
    globalThis.fetch = async (url, init) => {
      calls.push(url.toString());
      if (url.toString() === "http://127.0.0.1:8086/REST") return jsonResponse({ nodes: {} });
      if (url.toString() === "http://127.0.0.1:8086/REST/nodeURLsForNode") {
        assert.equal(JSON.parse(init.body).name, "Display");
        return jsonResponse([{ node: "Display", address: "http://trusted.local:8085/nodes/Display/" }]);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    await assert.rejects(
      () => new NodelClient(testConfig()).resolveNode("http://attacker.invalid:8085/nodes/Display/"),
      /not found/u,
    );
    assert.equal(
      calls.some((url) => url.includes("attacker.invalid")),
      false,
    );
    assert.equal(
      calls.every((url) => url.startsWith("http://127.0.0.1:8086/")),
      true,
    );
  }));

test("discovery endpoint addresses are trusted without probing the caller URL", async () =>
  withFetch(async (calls) => {
    globalThis.fetch = async (url, init) => {
      calls.push(url.toString());
      if (url.toString() === "http://127.0.0.1:8086/REST") return jsonResponse({ nodes: {} });
      if (url.toString() === "http://127.0.0.1:8086/REST/nodeURLs") {
        assert.equal(JSON.parse(init.body).filter, "Display");
        return jsonResponse([{ node: "Display", address: "http://203.0.113.8:8085/nodes/Display/" }]);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const client = new NodelClient(testConfig());
    const resolved = await client.resolveNode("Display");
    assert.equal(resolved.nodeBaseUrl, "http://203.0.113.8:8085/nodes/Display/");
    assert.equal(
      calls.some((url) => url.startsWith("http://203.0.113.8")),
      false,
    );
  }));

test("stale cached discovery is rejected when trusted endpoint metadata changes", async () =>
  withFetch(async () => {
    let found = true;
    globalThis.fetch = async (url) => {
      if (url.toString() === "http://127.0.0.1:8086/REST") return jsonResponse({ nodes: {} });
      if (url.toString() === "http://127.0.0.1:8086/REST/nodeURLs") return jsonResponse(found ? [remoteDisplay()] : []);
      if (url.toString() === "http://203.0.113.216:8085/nodes/RemoteDisplay/REST")
        return jsonResponse({ name: "Changed name" });
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const client = new NodelClient(testConfig());
    await client.resolveNode("Remote Display");
    found = false;
    await assert.rejects(() => client.resolveNode("Remote Display"), /not found/u);
  }));

test("ambiguous trusted discovery fails safely", async () =>
  withFetch(async () => {
    globalThis.fetch = async (url) => {
      if (url.toString() === "http://127.0.0.1:8086/REST") return jsonResponse({ nodes: {} });
      if (url.toString() === "http://127.0.0.1:8086/REST/nodeURLs")
        return jsonResponse([
          { node: "Display", address: "http://203.0.113.1:8085/nodes/Display/" },
          { node: "Display", address: "http://203.0.113.2:8085/nodes/Display/" },
        ]);
      throw new Error(`Unexpected fetch: ${url}`);
    };
    await assert.rejects(() => new NodelClient(testConfig()).resolveNode("Display"), /ambiguous/u);
  }));

test("only HTTP 404 maps to typed not-found", async () =>
  withFetch(async () => {
    globalThis.fetch = async () => new Response("missing", { status: 404 });
    await assert.rejects(
      () => new NodelClient(testConfig()).runtimeRequest("missing"),
      (error) => error instanceof NodelNotFoundError && error.code === "NOT_FOUND",
    );
    globalThis.fetch = async () => new Response("failure\n?token=secret", { status: 503, statusText: "Unavailable" });
    await assert.rejects(
      () => new NodelClient(testConfig()).runtimeRequest("missing"),
      (error) =>
        error instanceof NodelHttpError &&
        !(error instanceof NodelNotFoundError) &&
        error.details.diagnostic === "failure ?token=[redacted]",
    );
    globalThis.fetch = async () => new Response("not json", { status: 200 });
    await assert.rejects(() => new NodelClient(testConfig()).runtimeRequest("invalid"), NodelInvalidJsonError);
  }));

test("empty successful JSON responses remain undefined through transport and facade", async () =>
  withFetch(async () => {
    globalThis.fetch = async () => new Response("", { status: 200 });
    const transport = new NodelHttpTransport(1000);
    assert.equal(await transport.request("http://127.0.0.1:8086/REST/empty", {}, "json"), undefined);
    const response = await new NodelClient(testConfig()).runtimeRequest("empty", { responseMode: "json" });
    assert.equal(response, undefined);
  }));

test("facade methods use an already resolved node without resolving again", async () =>
  withFetch(async (calls) => {
    globalThis.fetch = async (url) => {
      calls.push(url.toString());
      assert.equal(url.toString(), "http://203.0.113.8:8085/nodes/Display/REST/actions");
      return jsonResponse({ go: { title: "Go" } });
    };
    const node = /** @type {import("../dist/nodel/types.js").ResolvedNode} */ ({
      input: "Display",
      scope: "remote",
      name: "Display",
      address: "http://203.0.113.8:8085/nodes/Display/",
      url: "http://203.0.113.8:8085/nodes/Display/",
      nodeBaseUrl: "http://203.0.113.8:8085/nodes/Display/",
      allowed: true,
      resolutionSource: "discovery",
    });
    const result = await new NodelClient(testConfig()).getNodeActions(node);
    assert.equal(result.node, node);
    assert.deepEqual(calls, ["http://203.0.113.8:8085/nodes/Display/REST/actions"]);
  }));

test("transport composes timeout and external abort signals", async () =>
  withFetch(async () => {
    globalThis.fetch = async (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }),
      );
    await assert.rejects(() => fetchWithTimeout("http://example.test/REST", {}, 5, "test"), NodelTimeoutError);
    const controller = new AbortController();
    const request = fetchWithTimeout("http://example.test/REST", { signal: controller.signal }, 1000, "test");
    controller.abort();
    await assert.rejects(request, (error) => /** @type {{ code: string }} */ (error).code === "NETWORK");
  }));

test("transport bounds body consumption after headers for every response mode", async () =>
  withFetch(async () => {
    globalThis.fetch = async (_url, init) => new Response(stallingBody(init.signal), { status: 200 });
    const transport = new NodelHttpTransport(10);
    for (const mode of ["json", "text", "bytes", "empty"]) {
      if (mode === "empty")
        await assert.rejects(() => transport.request("http://example.test/REST", {}, "empty"), NodelTimeoutError);
      else if (mode === "json")
        await assert.rejects(() => transport.request("http://example.test/REST", {}, "json"), NodelTimeoutError);
      else if (mode === "text")
        await assert.rejects(() => transport.request("http://example.test/REST", {}, "text"), NodelTimeoutError);
      else await assert.rejects(() => transport.request("http://example.test/REST", {}, "bytes"), NodelTimeoutError);
    }
  }));

test("exported fetchWithTimeout buffers the body while its timeout remains active", async () =>
  withFetch(async () => {
    globalThis.fetch = async (_url, init) => new Response(stallingBody(init.signal), { status: 200 });
    await assert.rejects(() => fetchWithTimeout("http://example.test/REST", {}, 10, "test"), NodelTimeoutError);
  }));

test("manual redirects permit only bounded credential-free same-origin reads", async () =>
  withFetch(async (calls) => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: url.toString(), init });
      if (url.toString().endsWith("/first")) return new Response("", { status: 302, headers: { location: "/second" } });
      return jsonResponse({ ok: true });
    };
    const transport = new NodelHttpTransport(1000);
    assert.deepEqual(await transport.request("http://example.test/first", {}, "json"), { ok: true });
    assert.equal(calls.length, 2);
    assert.equal(
      calls.every((call) => call.init.redirect === "manual"),
      true,
    );
  }));

test("manual redirects reject cross-origin metadata, loops, and mutations without replay", async () =>
  withFetch(async (calls) => {
    globalThis.fetch = async (url) => {
      calls.push(url.toString());
      return new Response("", { status: 302, headers: { location: "https://attacker.invalid/next" } });
    };
    const transport = new NodelHttpTransport(1000);
    await assert.rejects(() => transport.request("http://example.test/first", {}, "json"), NodelRedirectError);
    assert.deepEqual(calls, ["http://example.test/first"]);
    calls.length = 0;
    await assert.rejects(
      () => transport.request("http://example.test/first", { method: "POST" }, "json"),
      NodelRedirectError,
    );
    assert.deepEqual(calls, ["http://example.test/first"]);
    globalThis.fetch = async (url) => {
      calls.push(url.toString());
      return new Response("", { status: 302, headers: { location: "/first" } });
    };
    calls.length = 0;
    await assert.rejects(() => transport.request("http://example.test/first", {}, "json"), NodelRedirectError);
    assert.equal(calls.length, 2);
  }));

test("decoders retain supported legacy response shapes and reject unsafe discoveries", () => {
  const host = decodeHostStatus({
    started: true,
    nodes: { Display: { name: "Display", webSocketPort: 8080, legacy: "kept" } },
  });
  assert.equal(host.nodes.Display.raw.legacy, "kept");
  assert.deepEqual(
    decodeDiscoveredNodes({ one: { node: "Display", address: "http://203.0.113.1:8085/nodes/Display/" } }),
    [{ name: "Display", address: "http://203.0.113.1:8085/nodes/Display/", restPathSegment: "Display" }],
  );
  assert.deepEqual(decodeDiscoveredNodes([{ node: "Unsafe", address: "file:///etc/passwd" }]), []);
  assert.deepEqual(decodeDefinitions([{ name: "go" }]), [{ name: "go" }]);
  assert.deepEqual(decodeDefinitions({ go: { title: "Go" } }), { go: { title: "Go" } });
  assert.deepEqual(decodeFiles(["script.py", { path: "content/index.html", size: 10 }]), [
    "script.py",
    { path: "content/index.html", size: 10 },
  ]);
  assert.deepEqual(decodeFiles({ script: { path: "script.py" } }), { script: { path: "script.py" } });
  assert.deepEqual(decodeBindingsSchema({ actions: {} }), { actions: {} });
  assert.deepEqual(decodeBindings({ actions: {} }), { actions: {} });
  assert.deepEqual(decodeActivity([{ type: "action" }]), [{ type: "action" }]);
  assert.deepEqual(decodeActivity({ entries: [] }), { entries: [] });
  assert.equal(decodeConsole("legacy console"), "legacy console");
  assert.deepEqual(decodeConsole({ logs: [] }), { logs: [] });
  assert.throws(() => decodeDefinitions(["unsafe"]), /Malformed/u);
  assert.throws(() => decodeHostStatus({ nodes: [] }), /Malformed/u);
});

test("explicit runtime URLs must use configured allowed origins", async () =>
  withFetch(async (calls) => {
    globalThis.fetch = async (url) => {
      calls.push(url.toString());
      return jsonResponse({});
    };
    const client = new NodelClient(testConfig());
    client.assertRuntimeUrlAllowed("http://127.0.0.1:8086");
    assert.throws(() => client.assertRuntimeUrlAllowed("http://203.0.113.8:8085"), /NODEL_ALLOWED_RUNTIME_ORIGINS/u);
    await assert.rejects(
      () => client.runtimeRequest("newNode", {}, "http://203.0.113.8:8085"),
      /NODEL_ALLOWED_RUNTIME_ORIGINS/u,
    );
    assert.deepEqual(calls, []);
  }));

function testConfig(overrides = {}) {
  return createTestConfig({
    nodelBaseUrl: "http://127.0.0.1:8086",
    mcpPort: 8765,
    mcpBindAddress: "127.0.0.1",
    mcpToken: undefined,
    allowedOrigins: [],
    allowedRuntimeOrigins: [],
    requestBodyLimitBytes: 1024,
    allowedNodePrefixes: [],
    stateDir: ".state",
    writesEnabled: false,
    nodeLifecycleEnabled: false,
    deletesEnabled: false,
    writeApprovalRequired: true,
    unsafeWriteMode: false,
    configWarnings: [],
    writeApprovalTtlSeconds: 600,
    postWriteSettleMs: 3000,
    postWriteReadyTimeoutSeconds: 20,
    nodelRequestTimeoutMs: 1000,
    publicRecipeRequestTimeoutMs: 1000,
    ...overrides,
  });
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
function stallingBody(signal) {
  return new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    },
  });
}
function remoteDisplay() {
  return { node: "Remote Display", address: "http://203.0.113.216:8085/nodes/RemoteDisplay/" };
}
async function withFetch(fn) {
  const original = globalThis.fetch;
  try {
    await fn([]);
  } finally {
    globalThis.fetch = original;
  }
}
