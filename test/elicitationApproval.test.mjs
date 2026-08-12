import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { requestWriteApproval } from "../dist/mcp/tools/approvals.js";
import { createTestConfig } from "../dist/config.js";
import { collectToolSpecs } from "../dist/mcp/registry/toolRegistry.js";
import { startHttpServer } from "../dist/mcp/server.js";
import { createHttpApp } from "../dist/mcp/server.js";
import { assertWriteApproved } from "../dist/safety/approvals.js";

function config(stateDir, overrides = {}) {
  return createTestConfig({
    stateDir,
    writesEnabled: true,
    writeApprovalRequired: true,
    writeApprovalTtlSeconds: 600,
    ...overrides,
  });
}

const input = {
  operation: "save_recipe_script",
  target: "Node:script.py",
  proposalHash: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  confirmText: "APPROVE abcdefabcdef",
};

function approvalTool(config, elicitInput) {
  const spec = collectToolSpecs(config, undefined, elicitInput).find(
    (entry) => entry.name === "nodel.request_write_approval",
  );
  assert.ok(spec);
  return spec;
}

async function invokeApprovalTool(config, elicitInput, arguments_ = input) {
  const response = /** @type {{ content: Array<{ text: string }> }} */ (
    await approvalTool(config, elicitInput).handler(arguments_)
  );
  return JSON.parse(response.content[0].text);
}

async function bindApprovalApp(overrides = {}, options = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-http-"));
  const runtime = createHttpApp(
    createTestConfig({ stateDir, writesEnabled: true, writeApprovalRequired: true, ...overrides }),
    { nodelClient: /** @type {import("../dist/nodel/client.js").NodelClient} */ ({}), ...options },
  );
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose an address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/mcp`,
    runtime,
    async close() {
      await runtime.closeActiveMcpRequests();
      await new Promise((resolve) => server.close(resolve));
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

function initialize(id = 1, capabilities = { elicitation: { form: {} } }) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities, clientInfo: { name: "approval-test", version: "1" } },
  };
}

async function json(response) {
  const text = await response.text();
  const data = text.split(/\r?\n/u).find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice("data: ".length) : text);
}

test("requestWriteApproval creates approval id after exact elicited confirmation", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    const result = /** @type {{ ok: true, source: string, approvalId?: string }} */ (
      await requestWriteApproval(
        config(stateDir),
        async () => ({ action: "accept", content: { confirmText: input.confirmText } }),
        input,
      )
    );

    assert.equal(result.ok, true);
    assert.equal(result.source, "elicitation");
    assert.ok(result.approvalId);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("collected approval tool uses its injected elicitor and mints a single-use approval", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  let calls = 0;
  const elicitInput = async (params) => {
    calls += 1;
    assert.equal(params.message.includes(input.confirmText), true);
    return { action: "accept", content: { confirmText: input.confirmText } };
  };
  try {
    const configForTest = config(stateDir);
    const result = await invokeApprovalTool(configForTest, elicitInput);

    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.resultOk, true, JSON.stringify(result));
    assert.equal(result.source, "elicitation");
    assert.ok(result.approvalId);
    assert.doesNotThrow(() => assertWriteApproved(configForTest, input, result.approvalId));
    assert.throws(() => assertWriteApproved(configForTest, input, result.approvalId), /not found|expired/u);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("collected approval tool without a live elicitor returns the manual fallback", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    const result = await invokeApprovalTool(config(stateDir));

    assert.equal(result.ok, true);
    assert.equal(result.resultOk, false);
    assert.equal(result.action, "decline");
    assert.match(result.fallback, /nodel\.approve_write/u);
    assert.equal(result.approvalId, undefined);
    assert.doesNotMatch(JSON.stringify(result), /INTERNAL|TypeError/u);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("requestWriteApproval rejects mismatched elicited confirmation", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    const result = /** @type {{ ok: false, message: string, approvalId?: string }} */ (
      await requestWriteApproval(
        config(stateDir),
        async () => ({ action: "accept", content: { confirmText: "APPROVE nope" } }),
        input,
      )
    );

    assert.equal(result.ok, false);
    assert.match(result.message, /did not match/u);
    assert.equal(result.approvalId, undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("requestWriteApproval does not mint an approval after cancellation", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  const controller = new AbortController();
  try {
    const pending = approvalTool(config(stateDir), async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { action: "accept", content: { confirmText: input.confirmText } };
    }).handler(input, { requestId: 1, signal: controller.signal });
    controller.abort();
    const response = /** @type {{ content: Array<{ text: string }> }} */ (await pending);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.resultOk, false);
    assert.equal("approvalId" in result, false);
    assert.match("message" in result ? result.message : "", /cancelled/u);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("requestWriteApproval returns fallback when elicitation fails", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    const result = /** @type {{ ok: false, message: string, fallback: string }} */ (
      await requestWriteApproval(
        config(stateDir),
        async () => {
          throw new Error("unsupported");
        },
        input,
      )
    );

    assert.equal(result.ok, false);
    assert.match(result.message, /unsupported/u);
    assert.match(result.fallback, /nodel\.approve_write/u);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("requestWriteApproval reports no approval needed when disabled by config", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    const result = /** @type {{ ok: true, approvalRequired: false, approvalId?: string }} */ (
      await requestWriteApproval(
        config(stateDir, { writeApprovalRequired: false }),
        async () => ({ action: "accept", content: { confirmText: input.confirmText } }),
        input,
      )
    );

    assert.equal(result.ok, true);
    assert.equal(result.approvalRequired, false);
    assert.equal(result.approvalId, undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Streamable HTTP client elicits approval confirmation without a Nodel mutation", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-http-"));
  let action = "accept";
  let elicitationCount = 0;
  let server;
  let client;
  let transport;
  try {
    server = await startHttpServer(
      createTestConfig({
        stateDir,
        mcpPort: 0,
        mcpBindAddress: "127.0.0.1",
        writesEnabled: true,
        writeApprovalRequired: true,
      }),
      { nodelClient: /** @type {import("../dist/nodel/client.js").NodelClient} */ ({}) },
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose an address");
    client = new Client(
      { name: "elicitation-http-test", version: "1" },
      { capabilities: { elicitation: { form: {} } } },
    );
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicitationCount += 1;
      assert.equal(request.method, "elicitation/create");
      assert.equal(request.params.mode, "form");
      assert.equal(request.params.requestedSchema.required.includes("confirmText"), true);
      return action === "accept"
        ? { action: "accept", content: { confirmText: input.confirmText } }
        : { action: "decline" };
    });
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
    await client.connect(transport);

    let response = await client.callTool({ name: "nodel.request_write_approval", arguments: input });
    let result = JSON.parse(response.content[0].text);
    assert.equal(result.ok, true);
    assert.equal(result.resultOk, true, JSON.stringify(result));
    assert.equal(result.source, "elicitation");
    assert.ok(result.approvalId);

    action = "decline";
    response = await client.callTool({ name: "nodel.request_write_approval", arguments: input });
    result = JSON.parse(response.content[0].text);
    assert.equal(result.resultOk, false);
    assert.equal(result.action, "decline");
    assert.equal(result.approvalId, undefined);

    response = await client.callTool({
      name: "nodel.request_write_approval",
      arguments: { ...input, fallbackOnly: true },
    });
    result = JSON.parse(response.content[0].text);
    assert.equal(result.resultOk, false);
    assert.match(result.fallback, /nodel\.approve_write/u);
    assert.equal(elicitationCount, 2);
  } finally {
    if (transport) await transport.terminateSession();
    if (client) await client.close();
    if (server) await server.shutdown();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("legacy empty elicitation capability is normalized for a real SDK client", async () => {
  const app = await bindApprovalApp();
  let client;
  let transport;
  try {
    client = new Client({ name: "legacy-elicit-client", version: "1" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: "accept",
      content: { confirmText: input.confirmText },
    }));
    transport = new StreamableHTTPClientTransport(new URL(app.baseUrl));
    await client.connect(transport);
    const response = await client.callTool({ name: "nodel.request_write_approval", arguments: input });
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.resultOk, true, JSON.stringify(result));
    assert.equal(result.source, "elicitation");
  } finally {
    if (transport) await transport.terminateSession();
    if (client) await client.close();
    await app.close();
  }
});

test("stateful sessions publish before the first SDK tool call and clean up through DELETE", async () => {
  const app = await bindApprovalApp();
  let client;
  let transport;
  try {
    client = new Client({ name: "session-race-client", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "decline" }));
    transport = new StreamableHTTPClientTransport(new URL(app.baseUrl));
    await client.connect(transport);
    assert.ok(transport.sessionId);
    const response = await client.callTool({ name: "nodel.request_write_approval", arguments: input });
    assert.equal(JSON.parse(response.content[0].text).action, "decline");
    await transport.terminateSession();
    assert.equal(app.runtime.activeMcpRequests.size, 0);
  } finally {
    if (client) await client.close();
    await app.close();
  }
});

test("stateful session endpoints enforce expiry, capacity, refresh, GET, and DELETE status", async () => {
  const app = await bindApprovalApp({}, { maxStatefulMcpSessions: 1, statefulMcpSessionIdleMs: 30 });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  try {
    let response = await fetch(app.baseUrl, { method: "DELETE", headers });
    assert.equal(response.status, 400);
    response = await fetch(app.baseUrl, { method: "DELETE", headers: { ...headers, "mcp-session-id": "unknown" } });
    assert.equal(response.status, 404);
    response = await fetch(app.baseUrl, { method: "GET" });
    assert.equal(response.status, 405);
    response = await fetch(app.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { capabilities: {} } }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("mcp-session-id"), null);
    assert.ok((await json(response)).error);

    response = await fetch(app.baseUrl, { method: "POST", headers, body: JSON.stringify(initialize()) });
    assert.equal(response.status, 200);
    const sessionId = response.headers.get("mcp-session-id");
    assert.ok(sessionId);
    response = await fetch(app.baseUrl, {
      method: "GET",
      headers: { "mcp-session-id": sessionId, accept: "text/event-stream", "mcp-protocol-version": "2025-11-25" },
    });
    assert.equal(response.status, 200);
    response.body?.cancel();

    await new Promise((resolve) => setTimeout(resolve, 20));
    response = await fetch(app.baseUrl, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(response.status, 200);
    await json(response);

    response = await fetch(app.baseUrl, { method: "POST", headers, body: JSON.stringify(initialize(3)) });
    assert.equal(response.status, 503);
    await new Promise((resolve) => setTimeout(resolve, 35));
    response = await fetch(app.baseUrl, { method: "POST", headers, body: JSON.stringify(initialize(4)) });
    assert.equal(response.status, 200);
    const replacementId = response.headers.get("mcp-session-id");
    assert.ok(replacementId);
    response = await fetch(app.baseUrl, { method: "DELETE", headers: { "mcp-session-id": replacementId } });
    assert.equal(response.status, 200);
    assert.equal(app.runtime.activeMcpRequests.size, 0);

    response = await fetch(app.baseUrl, { method: "POST", headers, body: JSON.stringify(initialize(5)) });
    assert.equal(response.status, 200);
    await app.runtime.closeActiveMcpRequests();
    assert.equal(app.runtime.activeMcpRequests.size, 0);
  } finally {
    await app.close();
  }
});
