import assert from "node:assert/strict";
import test from "node:test";

import { CompatibilityToolError, safeLogMessage } from "../scripts/nodel-compatibility-smoke-helpers.mjs";
import {
  parseMcpResponseBody,
  parseSseDataEnvelope,
  parseToolResultEnvelope,
} from "../scripts/nodel-compatibility-smoke-helpers.mjs";
import {
  assertCompatibleServer,
  assertRequiredTools,
  createCompatibilityRunner,
  isRetryablePollError,
} from "../scripts/nodel-compatibility-smoke.mjs";

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

test("parseMcpResponseBody parses JSON payloads", () => {
  assert.deepEqual(parseMcpResponseBody('{"hello":"world"}'), { hello: "world" });
});

test("parseMcpResponseBody parses SSE data envelopes", () => {
  const envelope = parseMcpResponseBody(
    [": heartbeat", "event: message", 'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}', ""].join("\n"),
  );
  assert.deepEqual(envelope, { jsonrpc: "2.0", id: 1, result: { ok: true } });
});

test("parseSseDataEnvelope extracts the final JSON event", () => {
  const envelope = parseSseDataEnvelope(["event: message", 'data: {"step":1}', "", 'data: {"final":true}'].join("\n"));
  assert.deepEqual(envelope, { step: 1 });
});

test("parseToolResultEnvelope parses tool content text", () => {
  const payload = parseToolResultEnvelope({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify({ ok: true, operation: "ping" }) }] },
  });
  assert.deepEqual(payload, { ok: true, operation: "ping" });
});

test("parseToolResultEnvelope surfaces MCP JSON-RPC errors as stable codes", async () => {
  let error;
  try {
    parseToolResultEnvelope({
      jsonrpc: "2.0",
      id: 1,
      error: { code: "MCP_ERROR" },
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.equal(error.message, "MCP_ERROR");
  assert.equal(error.code, "MCP_ERROR");
});

test("parseToolResultEnvelope rejects public payload ok:false with stable error code only", () => {
  let error;
  try {
    parseToolResultEnvelope({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: { code: "VALIDATION", message: "Invalid tool request", details: "user-supplied payload" },
            }),
          },
        ],
      },
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.equal(error.code, "VALIDATION");
  assert.equal(error.message, "VALIDATION");
});

test("callTool unwraps a full JSON-RPC tool envelope payload", async () => {
  const runner = createCompatibilityRunner({
    fetchImpl: async (_url, options) => {
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({ ok: true, payload: "pong" }) }] },
      });
    },
  });

  const payload = await runner.callTool("nodel.ping", { input: 1 });
  assert.deepEqual(payload, { ok: true, payload: "pong" });
});

test("tools/list result is validated and passed through assertRequiredTools", () => {
  const valid = {
    tools: [
      { name: "nodel.list_local_nodes" },
      { name: "nodel.create_node" },
      { name: "nodel.set_node_parameter" },
      { name: "nodel.get_node_parameters" },
      { name: "nodel.verify_node_ready" },
      { name: "nodel.delete_node" },
    ],
  };
  assert.doesNotThrow(() => assertRequiredTools(valid));

  let missingError;
  try {
    assertRequiredTools({
      tools: [{ name: "nodel.list_local_nodes" }, { name: "nodel.create_node" }],
    });
  } catch (caught) {
    missingError = caught;
  }

  assert.ok(missingError);
  assert.equal(missingError.code, "MCP_TOOLS_LIST_MISSING");
});

test("version mismatch in initialize envelope fails with stable code", () => {
  let mismatch;
  try {
    assertCompatibleServer(
      {
        serverInfo: {
          name: "nodel-ai",
          version: "0.0.0",
        },
      },
      {
        name: "nodel-ai",
        version: "0.1.0",
      },
    );
  } catch (caught) {
    mismatch = caught;
  }

  assert.ok(mismatch);
  assert.equal(mismatch.code, "INITIALIZE_VERSION_MISMATCH");
});

test("waitFor tolerates transient tool errors then succeeds", async () => {
  let attempts = 0;
  const runner = createCompatibilityRunner({
    pollTimeoutMs: 200,
    pollIntervalMs: 5,
    fetchImpl: async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
  });

  const result = await runner.waitFor(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new CompatibilityToolError("MCP_TOOL_FAILURE");
      }

      return true;
    },
    200,
    5,
  );

  assert.equal(result, true);
  assert.equal(attempts, 3);
});

test("waitFor does not retry non-retriable errors", async () => {
  const runner = createCompatibilityRunner({
    pollTimeoutMs: 120,
    pollIntervalMs: 5,
    fetchImpl: async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
  });

  let error;
  try {
    await runner.waitFor(
      () => {
        throw new CompatibilityToolError("UNRETRYABLE");
      },
      120,
      5,
      () => false,
    );
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof CompatibilityToolError);
  assert.equal(error.code, "UNRETRYABLE");
});

test("isRetryablePollError returns true for transient stable tool errors", () => {
  const transient = new CompatibilityToolError("MCP_TOOL_FAILURE");
  const hard = new CompatibilityToolError("UNRECOVERABLE");
  assert.equal(isRetryablePollError(transient), true);
  assert.equal(isRetryablePollError(hard), false);
});

test("safeLogMessage redacts credentials before truncation", () => {
  const logged = safeLogMessage(
    'Authorization=Bearer topsecret-token token="x-api-key" password: supersecret secret: shhh api_key=myapikey key=12345 https://user:pass@host/path',
    4_000,
  );

  assert.equal(logged.includes("topsecret-token"), false);
  assert.equal(logged.includes("x-api-key"), false);
  assert.equal(logged.includes("supersecret"), false);
  assert.equal(logged.includes("shhh"), false);
  assert.equal(logged.includes("myapikey"), false);
  assert.equal(logged.includes("12345"), false);
  assert.equal(logged.includes("https://user:pass@"), false);
});

test("safeLogMessage redaction still truncates", () => {
  const logged = safeLogMessage("token=" + "a".repeat(2000), 50);
  assert.equal(logged.length <= 50, true);
  assert.equal(logged.includes("a".repeat(1000)), false);
});
