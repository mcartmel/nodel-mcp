import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestConfig } from "../dist/config.js";
import { createHttpApp, startHttpServer } from "../dist/mcp/server.js";
import { collectToolSpecs } from "../dist/mcp/registry/toolRegistry.js";
import { NodelHttpError, NodelNotFoundError, NodelTimeoutError } from "../dist/nodel/http/errors.js";

const token = Array.from({ length: 32 }, (_, index) => String.fromCharCode(33 + index)).join("");
const protocolHeaders = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-11-25",
};

function fakeNodel({ ready = true } = {}) {
  return asNodelClient({
    async getHostStatus() {
      if (!ready) throw new Error("upstream credentials and response body must not escape");
      return { started: true, nodes: {} };
    },
  });
}

/** @param {unknown} value @returns {import("../dist/nodel/client.js").NodelClient} */
function asNodelClient(value) {
  return /** @type {import("../dist/nodel/client.js").NodelClient} */ (/** @type {unknown} */ (value));
}

async function bind(config, nodelClient = asNodelClient(fakeNodel())) {
  const runtime = createHttpApp(config, { nodelClient });
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose an address");
  const { port } = address;
  return {
    runtime,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await runtime.closeActiveMcpRequests();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function rpc(baseUrl, body, headers = {}) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...protocolHeaders, authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  });
}

// Streamable HTTP can return either application/json or a one-event SSE body.
// This helper keeps raw-envelope tests independent of an SDK client session.
async function rpcJson(response) {
  const text = await response.text();
  const data = text.split(/\r?\n/u).find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice("data: ".length) : text);
}

function initialize(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "http-boundary-test", version: "1" },
    },
  };
}

async function callTool(baseUrl, name, args, id = 50) {
  const response = await rpc(baseUrl, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  assert.equal(response.status, 200);
  const message = await rpcJson(response);
  return { requestId: response.headers.get("x-request-id"), result: JSON.parse(message.result.content[0].text) };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function responseError(response, status, error) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error, error);
  assert.equal(body.requestId, response.headers.get("x-request-id"));
  assert.match(body.requestId, /^[0-9a-f-]{36}$/u);
}

function mutableParameterClient() {
  const node = { name: "Demo", nodeBaseUrl: "http://fake.invalid/nodes/Demo/" };
  let parameters = { retained: true };
  return {
    async getHostStatus() {
      return { started: true, nodes: { Demo: { name: "Demo" } } };
    },
    async resolveNode() {
      return node;
    },
    async nodeRequest(_node, restPath, options = {}) {
      if (restPath === "params") return { node, response: parameters };
      if (restPath === "params/save") {
        parameters = options.body;
        return { node, response: { saved: true } };
      }
      throw new Error(`Unexpected fake Nodel path: ${restPath}`);
    },
  };
}

/** @param {{ failure?: unknown, readinessFailure?: boolean }} options */
async function fakeNodelRuntime({ failure, readinessFailure = false } = {}) {
  let parameters = { retained: true };
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake-nodel.invalid");
    const send = (status, body, contentType = "application/json") => {
      res.writeHead(status, { "content-type": contentType });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (url.pathname === "/REST") return send(200, { started: true, nodes: { Demo: { name: "Demo" } } });
    if (url.pathname === "/nodes/Demo/REST/params" && req.method === "GET") return send(200, parameters);
    if (url.pathname === "/nodes/Demo/REST/actions" && req.method === "GET") {
      return readinessFailure ? send(500, "secret=readiness-secret", "text/plain") : send(200, {});
    }
    if (url.pathname === "/nodes/Demo/REST/params/save" && req.method === "POST") {
      if (failure && typeof failure === "object" && "kind" in failure && failure.kind === "timeout") return;
      if (failure && typeof failure === "object" && "status" in failure && "body" in failure)
        return send(failure.status, failure.body, "text/plain");
      let text = "";
      for await (const chunk of req) text += chunk;
      parameters = JSON.parse(text);
      return send(200, { saved: true });
    }
    return send(404, "secret=missing-secret", "text/plain");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose an address");
  const { port } = address;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get parameters() {
      return parameters;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("health is minimal and every response has an untrusted-safe request ID", async () => {
  const app = await bind(createTestConfig({ mcpToken: token }));
  try {
    const response = await fetch(`${app.baseUrl}/healthz`, {
      headers: { "x-request-id": "attacker-supplied-request-id" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, version: "0.1.0" });
    assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/u);
    assert.equal(response.headers.get("x-powered-by"), null);
  } finally {
    await app.close();
  }

  const trusted = await bind(createTestConfig({ mcpToken: token, trustInboundRequestId: true }));
  try {
    const response = await fetch(`${trusted.baseUrl}/healthz`, { headers: { "x-request-id": "trusted-proxy-id" } });
    assert.equal(response.headers.get("x-request-id"), "trusted-proxy-id");
    for (const requestId of ["invalid", "x".repeat(129)]) {
      const rejected = await fetch(`${trusted.baseUrl}/healthz`, { headers: { "x-request-id": requestId } });
      assert.match(rejected.headers.get("x-request-id"), /^[0-9a-f-]{36}$/u);
      assert.notEqual(rejected.headers.get("x-request-id"), requestId);
    }
  } finally {
    await trusted.close();
  }
});

test("readyz and MCP enforce token, exact Origin, JSON, and safe parser errors", async () => {
  const app = await bind(
    createTestConfig({ mcpToken: token, allowedOrigins: ["https://console.example"], requestBodyLimitBytes: 1024 }),
    fakeNodel({ ready: false }),
  );
  try {
    let response = await fetch(`${app.baseUrl}/readyz`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "unauthorized");

    response = await fetch(`${app.baseUrl}/readyz`, {
      headers: /** @type {HeadersInit} */ ({
        authorization: `Bearer ${token}`,
        origin: "https://console.example.evil",
      }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "origin_forbidden");

    response = await fetch(`${app.baseUrl}/readyz`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "nodel_unavailable",
      requestId: response.headers.get("x-request-id"),
    });

    response = await rpc(app.baseUrl, initialize(), { origin: "https://console.example.evil" });
    assert.equal(response.status, 403);
    response = await rpc(app.baseUrl, initialize(), { authorization: "Basic ignored" });
    assert.equal(response.status, 401);
    response = await rpc(app.baseUrl, initialize(), { "content-type": "text/plain" });
    assert.equal(response.status, 415);
    response = await fetch(`${app.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{",
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_json");
    response = await fetch(`${app.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ payload: "x".repeat(2048) }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, "request_too_large");
  } finally {
    await app.close();
  }
});

test("Bearer authentication runs before Origin policy and every boundary error is request-correlated", async () => {
  const app = await bind(
    createTestConfig({ mcpToken: token, allowedOrigins: ["https://console.example"], requestBodyLimitBytes: 1024 }),
    fakeNodel({ ready: false }),
  );
  const originalWrite = process.stdout.write;
  const logs = [];
  process.stdout.write = (chunk, ...args) => {
    logs.push(String(chunk));
    return originalWrite.call(process.stdout, chunk, ...args);
  };
  try {
    for (const authorization of [undefined, "Bearer wrong", "Basic ignored"]) {
      for (const origin of [undefined, "https://console.example", "https://console.example.evil", "not an origin"]) {
        /** @type {Record<string, string>} */
        const headers = {};
        if (authorization) headers.authorization = authorization;
        if (origin) headers.origin = origin;
        await responseError(await fetch(`${app.baseUrl}/readyz`, { headers }), 401, "unauthorized");
        await responseError(
          await fetch(`${app.baseUrl}/mcp`, {
            method: "POST",
            headers: { ...protocolHeaders, ...headers },
            body: JSON.stringify(initialize()),
          }),
          401,
          "unauthorized",
        );
      }
    }
    for (const origin of [undefined, "https://console.example"]) {
      const headers = { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) };
      await responseError(await fetch(`${app.baseUrl}/readyz`, { headers }), 503, "nodel_unavailable");
      assert.equal((await rpc(app.baseUrl, initialize(), headers)).status, 200);
    }
    for (const origin of ["https://console.example.evil", "not an origin"]) {
      const headers = { authorization: `Bearer ${token}`, origin };
      await responseError(await fetch(`${app.baseUrl}/readyz`, { headers }), 403, "origin_forbidden");
      await responseError(await rpc(app.baseUrl, initialize(), headers), 403, "origin_forbidden");
    }
    await responseError(
      await fetch(`${app.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "text/plain", authorization: `Bearer ${token}` },
        body: "x",
      }),
      415,
      "unsupported_media_type",
    );
    await responseError(
      await fetch(`${app.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: "{",
      }),
      400,
      "invalid_json",
    );
    await responseError(
      await fetch(`${app.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ payload: "x".repeat(2048) }),
      }),
      413,
      "request_too_large",
    );
    assert.ok(
      logs.some(
        (line) => line.includes('"message":"HTTP request unauthorized"') && /"requestId":"[0-9a-f-]{36}"/u.test(line),
      ),
    );
    assert.ok(
      logs.some(
        (line) =>
          line.includes('"message":"HTTP request JSON parsing failed"') && /"requestId":"[0-9a-f-]{36}"/u.test(line),
      ),
    );
  } finally {
    process.stdout.write = originalWrite;
    await app.close();
  }
});

test("stateless MCP envelopes initialize, list tools, ping, and clean transports across gates", async () => {
  const gates = [
    {},
    { writesEnabled: true },
    { writesEnabled: true, nodeLifecycleEnabled: true },
    { writesEnabled: true, nodeLifecycleEnabled: true, deletesEnabled: true },
  ];
  for (const gate of gates) {
    const app = await bind(createTestConfig({ mcpToken: token, ...gate }));
    try {
      let response = await rpc(app.baseUrl, initialize());
      assert.equal(response.status, 200);
      assert.equal((await rpcJson(response)).result.serverInfo.version, "0.1.0");
      response = await rpc(app.baseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      assert.equal(response.status, 200);
      const registered = (await rpcJson(response)).result.tools.map((tool) => tool.name).sort();
      assert.deepEqual(
        registered,
        collectToolSpecs(createTestConfig({ mcpToken: token, ...gate }))
          .map((tool) => tool.name)
          .sort(),
      );
      response = await rpc(app.baseUrl, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "nodel.ping", arguments: { echo: "safe" } },
      });
      assert.equal(response.status, 200);
      assert.match(JSON.stringify(await rpcJson(response)), /safe/u);
      const concurrent = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          rpc(app.baseUrl, {
            jsonrpc: "2.0",
            id: 10 + index,
            method: "tools/call",
            params: { name: "nodel.ping", arguments: { echo: index } },
          }),
        ),
      );
      assert.deepEqual(
        concurrent.map((entry) => entry.status),
        Array(8).fill(200),
      );
      await Promise.all(concurrent.map(rpcJson));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(app.runtime.activeMcpRequests.size, 0);
    } finally {
      await app.close();
    }
  }
});

test("bounded shutdown is idempotent and releases the state lock", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-http-shutdown-"));
  try {
    const server = await startHttpServer(
      createTestConfig({ stateDir, mcpPort: 0, mcpToken: token, shutdownTimeoutMs: 1000 }),
      { nodelClient: fakeNodel() },
    );
    assert.equal(server.listening, true);
    const [first, second] = await Promise.all([server.shutdown(), server.shutdown()]);
    assert.deepEqual(first, second);
    assert.equal(server.runtime.activeMcpRequests.size, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("bounded shutdown force-closes an active MCP socket and releases its lock", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-http-forced-shutdown-"));
  /** @type {(value: unknown) => void} */
  let resolveRemote;
  const hangingClient = {
    getHostStatus: () =>
      new Promise((resolve) => {
        resolveRemote = resolve;
      }),
  };
  try {
    const server = await startHttpServer(
      createTestConfig({ stateDir, mcpPort: 0, mcpToken: token, shutdownTimeoutMs: 1000 }),
      { nodelClient: asNodelClient(hangingClient), closeActiveMcpRequest: () => new Promise(() => {}) },
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose an address");
    const { port } = address;
    const pending = rpc(`http://127.0.0.1:${port}`, {
      jsonrpc: "2.0",
      id: 91,
      method: "tools/call",
      params: { name: "nodel.health", arguments: { checkNodel: true } },
    })
      .then((response) => response.text())
      .then(
        () => undefined,
        (error) => error,
      );
    await waitFor(() => server.runtime.activeMcpRequests.size === 1);
    const socketsBeforeShutdown = await new Promise((resolve, reject) =>
      server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
    );
    assert.ok(socketsBeforeShutdown > 0);
    const [first, second] = await Promise.all([server.shutdown(), server.shutdown()]);
    assert.deepEqual(first, { forced: true });
    assert.deepEqual(second, first);
    assert.ok((await pending) instanceof Error);
    assert.equal(server.runtime.activeMcpRequests.size, 0);
    assert.equal(existsSync(join(stateDir, ".instance.lock")), false);
    if (resolveRemote) resolveRemote({ started: true, nodes: {} });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("real Nodel HTTP transport completes MCP proposal, approval, parameter apply, audit, and read-back", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-http-write-"));
  const nodel = await fakeNodelRuntime();
  const app = await bind(
    createTestConfig({
      stateDir,
      nodelBaseUrl: nodel.baseUrl,
      mcpToken: token,
      writesEnabled: true,
      writeApprovalRequired: true,
      postWriteSettleMs: 0,
    }),
    null,
  );
  try {
    const input = {
      node: "Demo",
      values: { brightness: 75 },
      dryRun: true,
      waitForReady: false,
      reason: "HTTP integration test",
    };
    const proposed = await callTool(app.baseUrl, "nodel.set_node_parameters", input);
    assert.equal(proposed.result.status, "dry_run");
    const approval = proposed.result.approvalRequest;
    const approved = await callTool(
      app.baseUrl,
      "nodel.approve_write",
      {
        operation: approval.operation,
        target: approval.target,
        proposalHash: approval.proposalHash,
        confirmText: approval.confirmText,
        approvedBy: "node:test",
      },
      51,
    );
    const applied = await callTool(
      app.baseUrl,
      "nodel.set_node_parameters",
      { ...input, dryRun: false, approvalId: approved.result.approvalId },
      52,
    );
    assert.equal(applied.result.status, "succeeded_verification_pending");
    assert.equal(applied.result.verification.ok, true);
    const audit = readFileSync(join(stateDir, "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(audit.length, 2);
    assert.deepEqual(
      audit.map((entry) => entry.outcome),
      ["attempted", "succeeded"],
    );
    assert.ok(audit.every((entry) => entry.requestId === applied.requestId));
    const readBack = await callTool(app.baseUrl, "nodel.get_node_parameters", { node: "Demo" }, 53);
    assert.deepEqual(readBack.result.parameters, { retained: true, brightness: 75 });
  } finally {
    await app.close();
    await nodel.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("real Nodel HTTP failures preserve typed envelopes, sanitization, audit correlation, and readiness outcomes", async () => {
  const cases = [
    [{ status: 404, body: "secret=not-found-secret" }, "NODEL_NOT_FOUND", false],
    [{ status: 401, body: "secret=unauthorized-secret" }, "NODEL_HTTP", false],
    [{ status: 500, body: "secret=server-secret Bearer super-secret-token" }, "NODEL_HTTP", false],
    [{ kind: "timeout" }, "NODEL_TIMEOUT", true],
  ];
  for (const [failure, code, ambiguous] of cases) {
    const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-http-failure-"));
    const nodel = await fakeNodelRuntime({ failure });
    const app = await bind(
      createTestConfig({
        stateDir,
        nodelBaseUrl: nodel.baseUrl,
        mcpToken: token,
        writesEnabled: true,
        nodelRequestTimeoutMs: /** @type {{ kind?: string }} */ (failure).kind === "timeout" ? 1000 : 10000,
      }),
      null,
    );
    try {
      const proposal = await callTool(app.baseUrl, "nodel.set_node_parameters", {
        node: "Demo",
        values: { changed: true },
        dryRun: true,
        waitForReady: false,
      });
      const request = proposal.result.approvalRequest;
      const approval = await callTool(
        app.baseUrl,
        "nodel.approve_write",
        {
          operation: request.operation,
          target: request.target,
          proposalHash: request.proposalHash,
          confirmText: request.confirmText,
        },
        61,
      );
      const applied = await callTool(
        app.baseUrl,
        "nodel.set_node_parameters",
        { node: "Demo", values: { changed: true }, approvalId: approval.result.approvalId, waitForReady: false },
        62,
      );
      assert.equal(applied.result.error.code, code);
      assert.equal(Boolean(applied.result.error.ambiguous), ambiguous);
      const audit = readFileSync(join(stateDir, "audit.jsonl"), "utf8");
      assert.match(
        audit,
        new RegExp(
          `"outcome":"${/** @type {{ kind?: string }} */ (failure).kind === "timeout" ? "ambiguous" : "failed"}"`,
          "u",
        ),
      );
      assert.match(audit, new RegExp(`"requestId":"${applied.requestId}"`, "u"));
      assert.doesNotMatch(
        `${JSON.stringify(applied.result)}\n${audit}`,
        /(?:not-found|unauthorized|server|missing)-secret|super-secret-token/u,
      );
    } finally {
      await app.close();
      await nodel.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  }

  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-http-readiness-"));
  const nodel = await fakeNodelRuntime({ readinessFailure: true });
  const app = await bind(
    createTestConfig({
      stateDir,
      nodelBaseUrl: nodel.baseUrl,
      mcpToken: token,
      writesEnabled: true,
      postWriteSettleMs: 0,
      postWriteReadyTimeoutSeconds: 1,
    }),
    null,
  );
  try {
    const proposal = await callTool(app.baseUrl, "nodel.set_node_parameters", {
      node: "Demo",
      values: { changed: true },
      dryRun: true,
    });
    const request = proposal.result.approvalRequest;
    const approval = await callTool(
      app.baseUrl,
      "nodel.approve_write",
      {
        operation: request.operation,
        target: request.target,
        proposalHash: request.proposalHash,
        confirmText: request.confirmText,
      },
      71,
    );
    const applied = await callTool(
      app.baseUrl,
      "nodel.set_node_parameters",
      { node: "Demo", values: { changed: true }, approvalId: approval.result.approvalId },
      72,
    );
    assert.equal(applied.result.status, "succeeded_verification_pending");
    assert.equal(applied.result.postWrite.ready, false);
    assert.equal(applied.result.verification.ok, true);
  } finally {
    await app.close();
    await nodel.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("HTTP MCP pre-handler validation and unknown tools use the stable safe envelope", async () => {
  const app = await bind(createTestConfig({ mcpToken: token }));
  try {
    for (const args of [{}, { node: 42 }]) {
      const response = await rpc(app.baseUrl, {
        jsonrpc: "2.0",
        id: 70,
        method: "tools/call",
        params: { name: "nodel.describe_node", arguments: args },
      });
      assert.equal(response.status, 200);
      const message = await rpcJson(response);
      const result = JSON.parse(message.result.content[0].text);
      assert.deepEqual(result, {
        ok: false,
        status: "failed",
        error: {
          code: "VALIDATION",
          message: "Invalid arguments for tool. Check the advertised input schema.",
          retryable: false,
        },
      });
      assert.equal(message.result.isError, true);
    }
    const response = await rpc(app.baseUrl, {
      jsonrpc: "2.0",
      id: 71,
      method: "tools/call",
      params: { name: "nodel.not_a_tool", arguments: {} },
    });
    const message = await rpcJson(response);
    const result = JSON.parse(message.result.content[0].text);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "TOOL_UNAVAILABLE");
    assert.equal(message.result.isError, true);
    assert.doesNotMatch(message.result.content[0].text, /ZodError|stack|at /iu);
  } finally {
    await app.close();
  }
});

test("HTTP tool validation rejects unknown fields before lifecycle and read handlers run", async () => {
  let lifecycleCalls = 0;
  let healthCalls = 0;
  const app = await bind(
    createTestConfig({ mcpToken: token, writesEnabled: true, nodeLifecycleEnabled: true }),
    asNodelClient({
      async runtimeRequest() {
        lifecycleCalls += 1;
        return { accepted: true };
      },
      async getHostStatus() {
        healthCalls += 1;
        return { started: true, nodes: {} };
      },
    }),
  );
  const expected = {
    ok: false,
    status: "failed",
    error: {
      code: "VALIDATION",
      message: "Invalid arguments for tool. Check the advertised input schema.",
      retryable: false,
    },
  };
  try {
    for (const [name, arguments_] of [
      ["nodel.create_node", { name: "Demo", description: "removed", files: {} }],
      ["nodel.health", { checkNodel: true, unknown: true }],
    ]) {
      const response = await rpc(app.baseUrl, {
        jsonrpc: "2.0",
        id: 80,
        method: "tools/call",
        params: { name, arguments: arguments_ },
      });
      assert.equal(response.status, 200);
      const message = await rpcJson(response);
      assert.deepEqual(JSON.parse(message.result.content[0].text), expected);
      assert.equal(message.result.isError, true);
    }
    assert.equal(lifecycleCalls, 0);
    assert.equal(healthCalls, 0);
  } finally {
    await app.close();
  }
});

test("HTTP edit tools reject unknown fields inside edits", async () => {
  const app = await bind(
    createTestConfig({ mcpToken: token, writesEnabled: true, nodeLifecycleEnabled: true }),
    fakeNodel(),
  );
  try {
    for (const name of ["nodel.apply_recipe_script_edit", "nodel.apply_node_file_edit"]) {
      const response = await rpc(app.baseUrl, {
        jsonrpc: "2.0",
        id: 81,
        method: "tools/call",
        params: {
          name,
          arguments: {
            node: "Demo",
            path: "content/test.txt",
            expectedHash: "hash",
            edits: [{ oldText: "a", newText: "b", unknown: true }],
          },
        },
      });
      const message = await rpcJson(response);
      const result = JSON.parse(message.result.content[0].text);
      assert.equal(result.error.code, "VALIDATION");
      assert.equal(message.result.isError, true);
    }
  } finally {
    await app.close();
  }
});
