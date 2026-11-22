import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { requestWriteApproval, unavailableElicitInput } from "../dist/mcp/tools/approvals.js";
import { createTestConfig } from "../dist/config.js";
import { collectToolSpecs } from "../dist/mcp/registry/toolRegistry.js";
import { startHttpServer } from "../dist/mcp/server.js";
import { createHttpApp } from "../dist/mcp/server.js";
import { assertWriteApproved } from "../dist/safety/approvals.js";
import { stateStore } from "../dist/state/store.js";
import { publicError } from "../dist/shared/publicErrors.js";

/** @typedef {{content: Array<{text: string}>, isError?: boolean}} TextToolResponse */

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
    stateDir,
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

test("requestWriteApproval uses unchecked boolean schema and exact full identity, without typed confirmation", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    const result = await requestWriteApproval(
      config(stateDir),
      async (params) => {
        assert.equal(params.mode, "form");
        assert.deepEqual(params.requestedSchema, {
          type: "object",
          properties: {
            approved: {
              type: "boolean",
              title: "Approve this change",
              description: "Approve only the reviewed proposal identified above.",
              default: false,
            },
          },
          required: ["approved"],
        });
        assert.ok(params.message.includes(`Operation: ${input.operation}`));
        assert.ok(params.message.includes(`Target: ${input.target}`));
        assert.ok(params.message.includes(`Full proposal hash: ${input.proposalHash}`));
        assert.match(params.message, /single-use.*600 seconds after approval creation/u);
        assert.match(params.message, /does not itself modify Nodel/u);
        assert.doesNotMatch(params.message, /Assistant-supplied summary/u);
        assert.ok(!params.message.includes(input.confirmText));
        return { action: "accept", content: { approved: true } };
      },
      input,
    );

    assert.equal(result.ok, true);
    assert.equal("source" in result ? result.source : undefined, "elicitation");
    assert.equal(result.outcome, "approved");
    assert.equal(result.fallbackAvailable, false);
    assert.equal("action" in result ? result.action : undefined, "accept");
    assert.ok("approvalId" in result && result.approvalId);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("collected approval tool uses its injected elicitor and mints a single-use approval", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  let calls = 0;
  const elicitInput = async (params) => {
    calls += 1;
    assert.equal(params.message.includes(input.proposalHash), true);
    return { action: "accept", content: { approved: true } };
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
    assert.equal(result.action, undefined);
    assert.equal(result.outcome, "unavailable");
    assert.equal(result.fallbackAvailable, true);
    assert.match(result.fallback, /nodel\.approve_write/u);
    assert.equal(result.approvalId, undefined);
    assert.doesNotMatch(JSON.stringify(result), /INTERNAL|TypeError/u);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

/** @type {Array<[string, any, string]>} */
const negativeResponses = [
  ["unchecked", { action: "accept", content: { approved: false } }, "not_approved"],
  ["decline", { action: "decline" }, "declined"],
  ["cancel", { action: "cancel" }, "cancelled"],
  ["no content", { action: "accept" }, "invalid_response"],
  ["no field", { action: "accept", content: {} }, "invalid_response"],
  ["string true", { action: "accept", content: { approved: "true" } }, "invalid_response"],
  ["number", { action: "accept", content: { approved: 1 } }, "invalid_response"],
  ["old typed form", { action: "accept", content: { confirmText: input.confirmText } }, "invalid_response"],
  ["unexpected action", { action: "approve", content: { approved: true } }, "invalid_response"],
  ["null response", null, "invalid_response"],
  ["primitive content", { action: "accept", content: true }, "invalid_response"],
  ["array content", { action: "accept", content: [true] }, "invalid_response"],
];

for (const [name, response, outcome] of negativeResponses) {
  test(`native approval fails closed without fallback: ${name}`, async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
    try {
      const result = await invokeApprovalTool(config(stateDir), async () => response);
      assert.equal(result.ok, true);
      assert.equal(result.resultOk, false);
      assert.equal(result.outcome, outcome);
      assert.equal(result.fallbackAvailable, false);
      assert.equal(result.action, response?.action);
      assert.equal("fallback" in result, false);
      assert.equal("approvalId" in result, false);
      assert.equal(existsSync(join(stateDir, "approvals.json")), false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

test("requestWriteApproval does not mint an approval after cancellation", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  const controller = new AbortController();
  try {
    const pending = approvalTool(config(stateDir), async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { action: "accept", content: { approved: true } };
    }).handler(input, { requestId: 1, signal: controller.signal });
    controller.abort();
    const response = /** @type {{ content: Array<{ text: string }> }} */ (await pending);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.resultOk, false);
    assert.equal(result.outcome, "cancelled");
    assert.equal(result.action, "accept");
    assert.equal(result.fallbackAvailable, false);
    assert.equal("fallback" in result, false);
    assert.equal("approvalId" in result, false);
    assert.equal(existsSync(join(stateDir, "approvals.json")), false);
    assert.match("message" in result ? result.message : "", /cancelled/u);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("arbitrary elicitation exceptions fail closed, redact diagnostics, and never infer unsupported from text", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    const result =
      /** @type {{ ok: false, outcome: string, fallbackAvailable: boolean, message: string, fallback?: string }} */ (
        await requestWriteApproval(
          config(stateDir),
          async () => {
            throw new Error("unsupported timeout disconnect token=private Bearer private-token\nsecret second line");
          },
          input,
        )
      );

    assert.equal(result.ok, false);
    assert.equal(result.outcome, "failed");
    assert.equal(result.fallbackAvailable, false);
    assert.match(result.message, /unsupported/u);
    assert.doesNotMatch(result.message, /private|second line/u);
    assert.equal(result.fallback, undefined);
    assert.equal(existsSync(join(stateDir, "approvals.json")), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("requestWriteApproval reports no approval needed when disabled by config", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    const result = await requestWriteApproval(
      config(stateDir, { writeApprovalRequired: false }),
      async () => {
        throw new Error("must not prompt");
      },
      input,
    );

    assert.equal(result.ok, true);
    assert.equal(result.approvalRequired, false);
    assert.equal(result.outcome, "not_required");
    assert.equal(result.fallbackAvailable, false);
    assert.equal("approvalId" in result, false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("pre-aborted requests do not prompt or offer fallback, including fallbackOnly and unavailable elicitors", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    const controller = new AbortController();
    controller.abort();
    for (const fallbackOnly of [false, true]) {
      let calls = 0;
      const result = await requestWriteApproval(
        config(stateDir),
        async () => {
          calls += 1;
          return unavailableElicitInput(/** @type {never} */ ({}));
        },
        { ...input, fallbackOnly },
        { signal: controller.signal },
      );
      assert.equal(calls, 0);
      assert.equal(result.outcome, "cancelled");
      assert.equal(result.fallbackAvailable, false);
      assert.equal("fallback" in result, false);
      assert.equal("action" in result, false);
    }
    assert.equal(existsSync(join(stateDir, "approvals.json")), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("abort during a rejected elicitation takes precedence over failure and unavailability", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    for (const unavailable of [false, true]) {
      const controller = new AbortController();
      const result = await requestWriteApproval(
        config(stateDir),
        async () => {
          controller.abort();
          if (unavailable) return unavailableElicitInput(/** @type {never} */ ({}));
          throw new Error("transport cancelled");
        },
        input,
        { signal: controller.signal },
      );
      assert.equal(result.outcome, "cancelled");
      assert.equal(result.fallbackAvailable, false);
      assert.equal("fallback" in result, false);
      assert.equal("approvalId" in result, false);
      assert.equal("action" in result, false);
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("fallbackOnly is explicit, validated, and never calls the elicitor", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    let calls = 0;
    const result = await requestWriteApproval(
      config(stateDir),
      async () => {
        calls += 1;
        throw new Error("must not prompt");
      },
      { ...input, fallbackOnly: true },
    );
    assert.equal(result.outcome, "manual_required");
    assert.equal(result.fallbackAvailable, true);
    assert.equal(calls, 0);
    assert.match("fallback" in result ? result.fallback : "", /nodel\.approve_write/u);
    assert.equal("action" in result, false);
    assert.equal("approvalId" in result, false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

const invalidInputs = [
  { operation: " " },
  { target: "" },
  { proposalHash: "abcdefabcdef" },
  { proposalHash: `${input.proposalHash}\n` },
  { confirmText: "APPROVE wrong" },
  { confirmText: undefined },
  { operation: "Bearer credential" },
  { target: "Node Bearer credential" },
  { reason: "Bearer credential" },
  { approvedBy: "Bearer credential" },
  { summary: " " },
  { summary: "a".repeat(2001) },
  { summary: 123 },
];

for (const [index, invalid] of invalidInputs.entries()) {
  test(`preflight rejects invalid metadata before prompting or fallback (${index})`, async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
    try {
      for (const fallbackOnly of [false, true]) {
        let calls = 0;
        const response = /** @type {TextToolResponse} */ (
          await approvalTool(config(stateDir), async () => {
            calls += 1;
            return { action: "accept", content: { approved: true } };
          }).handler({ ...input, ...invalid, fallbackOnly })
        );
        const result = JSON.parse(response.content[0].text);
        assert.equal(response.isError, true);
        assert.equal(result.ok, false);
        assert.ok(["VALIDATION", "APPROVAL_REQUIRED"].includes(result.error.code), JSON.stringify(result));
        assert.equal(calls, 0);
        assert.equal("fallback" in result, false);
        assert.equal("approvalId" in result, false);
        assert.equal(existsSync(join(stateDir, "approvals.json")), false);
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

const invalidNativeInputs = [
  { target: "Node\nFull proposal hash: other" },
  { target: "Node\tother" },
  { operation: "save\u0000script" },
  { target: "Node\u202eother" },
  { target: "Node\u2028other" },
  { target: "Node\ud800other" },
  { target: "Node\u034fother" },
  { operation: "save\u034fscript" },
  { target: " Node" },
  { target: "Node " },
  { operation: " save_recipe_script" },
  { operation: "save_recipe_script " },
  { target: "Room 👩‍💻" },
];

for (const [index, invalid] of invalidNativeInputs.entries()) {
  test(`native-only identity restrictions fail before prompting without fallback; explicit fallback preserves exact identity (${index})`, async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
    try {
      let calls = 0;
      /** @type {import("../dist/mcp/tools/approvals.js").ElicitInput} */
      const elicit = async () => {
        calls += 1;
        return { action: "accept", content: { approved: true } };
      };
      const args = { ...input, ...invalid };
      const response = /** @type {TextToolResponse} */ (await approvalTool(config(stateDir), elicit).handler(args));
      const result = JSON.parse(response.content[0].text);
      assert.equal(response.isError, true);
      assert.equal(result.error.code, "VALIDATION");
      assert.equal("fallback" in result, false);
      assert.equal("approvalId" in result, false);

      const manual = await requestWriteApproval(config(stateDir), elicit, { ...args, fallbackOnly: true });
      assert.equal(manual.outcome, "manual_required");
      assert.equal(manual.fallbackAvailable, true);
      assert.equal("target" in manual && manual.target, args.target);
      assert.equal("operation" in manual && manual.operation, args.operation);
      assert.equal(calls, 0);
      assert.equal(existsSync(join(stateDir, "approvals.json")), false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

test("summary helper contract is enforced even when approvals are not required", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    for (const summary of ["", " ", "x".repeat(2001), 123]) {
      let calls = 0;
      const response = /** @type {TextToolResponse} */ (
        await approvalTool(config(stateDir, { writeApprovalRequired: false }), async () => {
          calls += 1;
          throw new Error("must not prompt");
        }).handler({ ...input, summary })
      );
      const result = JSON.parse(response.content[0].text);
      assert.equal(response.isError, true);
      assert.equal(result.error.code, "VALIDATION");
      assert.equal("approvalId" in result, false);
      assert.equal("fallback" in result, false);
      assert.equal(calls, 0);
    }
    assert.equal(existsSync(join(stateDir, "approvals.json")), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("summary schema trims, bounds, and remains optional without adding an approved tool argument", () => {
  const spec = approvalTool(config("/unused"));
  const schema = /** @type {import("zod").ZodType<{summary?: string}>} */ (spec.inputSchema);
  assert.equal(schema.parse(input).summary, undefined);
  assert.equal(schema.parse({ ...input, summary: "  context  " }).summary, "context");
  assert.equal(schema.parse({ ...input, summary: "a".repeat(2000) }).summary.length, 2000);
  for (const summary of ["", " ", "a".repeat(2001), true])
    assert.equal(schema.safeParse({ ...input, summary }).success, false);
  assert.equal(schema.safeParse({ ...input, approved: true }).success, false);
});

test("prompt preserves long identity exactly while bounding and redacting unverified summary only", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  const target = `Node:${"long name ".repeat(100)}Ω`;
  const summary =
    '  Replace script; reloads node. token=hidden password=hidden2 Bearer hidden3 https://user:pass@example.test/path?key=hidden4\nUNTRUSTED context "secret": "hidden five words" password=\'hidden six words\' Authorization: Basic dXNlcjp0ZXN0LXNlY3JldA== token\u0000=secret-value  ';
  try {
    const result = await requestWriteApproval(
      config(stateDir),
      async (params) => {
        assert.ok(params.message.includes(`Target: ${target}\n`));
        assert.ok(params.message.includes(`Full proposal hash: ${input.proposalHash}\n`));
        assert.match(params.message, /Assistant-supplied summary \(not server-verified\)/u);
        assert.match(params.message, /Replace script; reloads node/u);
        assert.match(params.message, /UNTRUSTED context/u);
        assert.doesNotMatch(
          params.message,
          /hidden|five words|six words|user:pass|dXNlcjp0ZXN0LXNlY3JldA|secret-value/u,
        );
        return { action: "accept", content: { approved: true } };
      },
      { ...input, target, summary },
    );
    assert.equal(result.outcome, "approved");
    const saved = JSON.parse(readFileSync(join(stateDir, "approvals.json"), "utf8"));
    assert.equal(saved.version, 2);
    assert.equal(saved.approvals[0].target, target);
    assert.equal("summary" in saved.approvals[0], false);
    assert.doesNotMatch(JSON.stringify(saved), /hidden|UNTRUSTED/u);
    assertWriteApproved(config(stateDir), { ...input, target }, "approvalId" in result ? result.approvalId : "");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an injected accepted response cannot change the displayed approval identity across the await", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    const mutable = { ...input };
    const result = await requestWriteApproval(
      config(stateDir),
      async () => {
        mutable.target = "Different node";
        return { action: "accept", content: { approved: true } };
      },
      mutable,
    );
    assert.equal("target" in result ? result.target : undefined, input.target);
    assertWriteApproved(config(stateDir), input, "approvalId" in result ? result.approvalId : "");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

for (const summary of [
  "Authorization: Basic dXNlcjp0ZXN0LXNlY3JldA==",
  "Basic dXNlcjp0ZXN0LXNlY3JldA==",
  "token=Bearer fake-private-token",
  "Authorization: Token fake-private-token",
  "Authorization: ApiKey fake-private-token",
  "Authorization: CustomScheme fake-private-token",
  'Authorization: Digest username="fake-private-token", response="fake-private-token"',
  '"authorization": "ApiKey fake-private-token"',
  "Authorization: Token fake-\u0000private-token",
  '"authorization": "Basic dXNlcjp0ZXN0LXNlY3JldA=="',
  "token\u0000=secret-value",
  "token\u034f=secret-value",
  "token=secret-\u0000value",
]) {
  test(`summary redaction normalizes before detecting complete credentials: ${JSON.stringify(summary)}`, async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
    try {
      const result = await requestWriteApproval(
        config(stateDir),
        async (params) => {
          assert.match(params.message, /\[redacted\]/u);
          assert.doesNotMatch(params.message, /dXNlcjp0ZXN0LXNlY3JldA|secret-|value|fake-private-token/u);
          return { action: "decline" };
        },
        { ...input, summary },
      );
      assert.equal(result.outcome, "declined");
      assert.equal(result.fallbackAvailable, false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

test("summary redaction preserves ordinary Basic prose and text following a header line", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    await requestWriteApproval(
      config(stateDir),
      async (params) => {
        assert.match(params.message, /Basic reload is required/u);
        assert.match(params.message, /Basic configuration remains unchanged/u);
        assert.doesNotMatch(params.message, /fake-private-token/u);
        return { action: "decline" };
      },
      {
        ...input,
        summary:
          "Basic reload is required\nAuthorization: Token fake-private-token\nBasic configuration remains unchanged",
      },
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

for (const authorization of [
  "Authorization: AWS4-HMAC-SHA256 Credential=fake-private-credential, SignedHeaders=host;x-amz-date, Signature=fake-private-signature",
  'Authorization: Digest username="fake-private-user;realm", response="fake-private-response"',
  "Authorization:\n  Token fake-private-token",
  "Authorization:\r\n\tApiKey fake-private-token",
  "Authorization:\nToken fake-private-token",
  "Authorization:\n\n  \nToken fake-private-token",
  "Authorization: AWS4-HMAC-SHA256 fake-private-credential\n  SignedHeaders=host;x-amz-date,\n\tSignature=fake-private-signature",
  "Authorization: Token fake-private-token\n\n  fake-private-continuation",
  "Authorization: Token fake-private-token\n  fake-private-continuation Authorization: fake-private-tail",
  "Authorization:\nfake-private-value Authorization: fake-private-tail",
  '"authorization": "Digest fake-private-user;fake-private-response"; fake-private-tail',
  "Authorization:\u2028  Token fake-private-token\u2029  fake-private-continuation",
]) {
  test(`authorization redaction consumes complete lines and continuations: ${JSON.stringify(authorization)}`, async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
    try {
      const result = await requestWriteApproval(
        config(stateDir),
        async (params) => {
          assert.doesNotMatch(params.message, /fake-private-/u);
          assert.match(params.message, /\[redacted\]/u);
          assert.match(params.message, /Basic reload is required/u);
          assert.match(params.message, /Separate context remains/u);
          return { action: "decline" };
        },
        { ...input, summary: `${authorization}\nBasic reload is required\nSeparate context remains` },
      );
      assert.equal(result.outcome, "declined");
      assert.equal(result.fallbackAvailable, false);
      assert.equal(existsSync(join(stateDir, "approvals.json")), false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

test("per-request SDK incompatibility does not leak a stateful session reservation", async (t) => {
  const app = await bindApprovalApp({}, { maxStatefulMcpSessions: 1 });
  const originalGet = Reflect.get;
  const get = t.mock.method(Reflect, "get", (target, property, ...rest) =>
    property === "_requestHandlerAbortControllers" ? undefined : originalGet(target, property, ...rest),
  );
  const post = () =>
    fetch(app.baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(initialize()),
    });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await post();
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "invalid_request");
      assert.equal(app.runtime.activeMcpRequests.size, 0);
    }
    get.mock.restore();
    const response = await post();
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("mcp-session-id"));
    await json(response);
    assert.equal(app.runtime.activeMcpRequests.size, 1);
  } finally {
    get.mock.restore();
    await app.close();
  }
});

test("writes-disabled helper raises policy error and write approval tools are not registered", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    const cfg = config(stateDir, { writesEnabled: false });
    let calls = 0;
    await assert.rejects(
      requestWriteApproval(
        cfg,
        async () => {
          calls += 1;
          throw new Error("must not prompt");
        },
        input,
      ),
      { code: "POLICY" },
    );
    assert.equal(calls, 0);
    assert.ok(
      !collectToolSpecs(cfg).some(
        (entry) => entry.name === "nodel.request_write_approval" || entry.name === "nodel.approve_write",
      ),
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

for (const afterPersistence of [false, true]) {
  test(`native acceptance preserves state errors without fallback (persisted before error: ${afterPersistence})`, async (t) => {
    const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
    try {
      const cfg = config(stateDir);
      const store = stateStore(stateDir);
      const original = store.atomicWrite.bind(store);
      t.mock.method(store, "atomicWrite", (path, contents) => {
        if (afterPersistence) original(path, contents);
        throw publicError("STATE", "Unable to persist state file.");
      });
      const response = /** @type {TextToolResponse} */ (
        await approvalTool(cfg, async () => ({ action: "accept", content: { approved: true } })).handler(input)
      );
      const result = JSON.parse(response.content[0].text);
      assert.equal(response.isError, true);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "STATE");
      assert.equal("outcome" in result, false);
      assert.equal("fallback" in result, false);
      assert.equal("approvalId" in result, false);
      // A failed durability operation is not proof that no record reached disk.
      assert.equal(existsSync(join(stateDir, "approvals.json")), afterPersistence);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

test("corrupt approval state after acceptance remains a classified recovery error", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    writeFileSync(join(stateDir, "approvals.json"), "{corrupt");
    const response = /** @type {TextToolResponse} */ (
      await approvalTool(config(stateDir), async () => ({ action: "accept", content: { approved: true } })).handler(
        input,
      )
    );
    const result = JSON.parse(response.content[0].text);
    assert.equal(response.isError, true);
    assert.equal(result.error.code, "STATE");
    assert.match(result.error.message, /quarantined/u);
    assert.equal("fallback" in result, false);
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
      assert.deepEqual(request.params.requestedSchema.required, ["approved"]);
      assert.equal(request.params.requestedSchema.properties.approved.default, false);
      return action === "accept" ? { action: "accept", content: { approved: true } } : { action };
    });
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
    await client.connect(transport);

    let response = await client.callTool({ name: "nodel.request_write_approval", arguments: input });
    let result = JSON.parse(response.content[0].text);
    assert.equal(result.ok, true);
    assert.equal(result.resultOk, true, JSON.stringify(result));
    assert.equal(result.source, "elicitation");
    assert.equal(result.outcome, "approved");
    assert.ok(result.approvalId);

    action = "decline";
    response = await client.callTool({ name: "nodel.request_write_approval", arguments: input });
    result = JSON.parse(response.content[0].text);
    assert.equal(result.resultOk, false);
    assert.equal(result.action, "decline");
    assert.equal(result.outcome, "declined");
    assert.equal(result.fallbackAvailable, false);
    assert.equal(result.fallback, undefined);
    assert.equal(result.approvalId, undefined);

    action = "cancel";
    response = await client.callTool({ name: "nodel.request_write_approval", arguments: input });
    result = JSON.parse(response.content[0].text);
    assert.equal(result.outcome, "cancelled");
    assert.equal(result.fallbackAvailable, false);
    assert.equal(result.fallback, undefined);

    response = await client.callTool({
      name: "nodel.request_write_approval",
      arguments: { ...input, fallbackOnly: true },
    });
    result = JSON.parse(response.content[0].text);
    assert.equal(result.resultOk, false);
    assert.match(result.fallback, /nodel\.approve_write/u);
    assert.equal(result.outcome, "manual_required");
    assert.equal(elicitationCount, 3);
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
      content: { approved: true },
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

/** @type {Array<[string, import("@modelcontextprotocol/sdk/types.js").ClientCapabilities]>} */
const unsupportedCapabilities = [
  ["absent", {}],
  ["URL-only", { elicitation: { url: {} } }],
];
for (const [name, capabilities] of unsupportedCapabilities) {
  test(`${name} form support returns unavailable without issuing an elicitation request`, async () => {
    const app = await bindApprovalApp();
    let client;
    let transport;
    let elicitationCount = 0;
    try {
      client = new Client({ name: "unsupported-client", version: "1" }, { capabilities });
      transport = new StreamableHTTPClientTransport(new URL(app.baseUrl));
      await client.connect(transport);
      const onmessage = transport.onmessage;
      transport.onmessage = (message) => {
        if ("method" in message && message.method === "elicitation/create") elicitationCount += 1;
        onmessage?.(message);
      };
      const response = await client.callTool({ name: "nodel.request_write_approval", arguments: input });
      const result = JSON.parse(response.content[0].text);
      assert.equal(result.resultOk, false);
      assert.equal(result.outcome, "unavailable");
      assert.equal(result.fallbackAvailable, true);
      assert.match(result.fallback, /nodel\.approve_write/u);
      assert.equal("action" in result, false);
      assert.equal("approvalId" in result, false);
      assert.equal(elicitationCount, 0);
    } finally {
      if (client) await client.close();
      await app.close();
    }
  });
}

test("advertised form support does not fall back after SDK validation errors or client failures", async () => {
  const app = await bindApprovalApp();
  let client;
  let transport;
  let fail = false;
  try {
    client = new Client({ name: "broken-form-client", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, async () => {
      if (fail) throw new Error("Client does not support form elicitation. token=do-not-leak");
      return { action: "accept", content: { approved: "true" } };
    });
    transport = new StreamableHTTPClientTransport(new URL(app.baseUrl));
    await client.connect(transport);
    for (fail of [false, true]) {
      const response = await client.callTool({ name: "nodel.request_write_approval", arguments: input });
      const result = JSON.parse(response.content[0].text);
      assert.equal(result.ok, true);
      assert.equal(result.resultOk, false);
      assert.equal(result.outcome, "failed");
      assert.equal(result.fallbackAvailable, false);
      assert.equal("fallback" in result, false);
      assert.equal("approvalId" in result, false);
      assert.doesNotMatch(result.message, /do-not-leak/u);
    }
  } finally {
    if (transport) await transport.terminateSession();
    if (client) await client.close();
    await app.close();
  }
});

test("concurrent native forms preserve JSON-RPC response correlation and request options", async () => {
  const app = await bindApprovalApp();
  let client;
  let transport;
  const pending = [];
  try {
    client = new Client({ name: "concurrent-client", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    let formsReceived;
    const received = new Promise((resolve) => {
      formsReceived = resolve;
    });
    client.setRequestHandler(
      ElicitRequestSchema,
      (request) =>
        new Promise((resolve) => {
          pending.push({ message: request.params.message, resolve });
          if (pending.length === 2) formsReceived();
        }),
    );
    transport = new StreamableHTTPClientTransport(new URL(app.baseUrl));
    await client.connect(transport);
    const first = client.callTool({
      name: "nodel.request_write_approval",
      arguments: { ...input, target: "First node" },
    });
    const second = client.callTool({
      name: "nodel.request_write_approval",
      arguments: { ...input, target: "Second node" },
    });
    await received;
    pending.find((entry) => entry.message.includes("Second node")).resolve({ action: "decline" });
    pending
      .find((entry) => entry.message.includes("First node"))
      .resolve({ action: "accept", content: { approved: true } });
    const results = (await Promise.all([first, second])).map((response) => JSON.parse(response.content[0].text));
    assert.equal(results[0].target, "First node");
    assert.equal(results[0].outcome, "approved");
    assert.equal(results[1].target, "Second node");
    assert.equal(results[1].outcome, "declined");
  } finally {
    for (const entry of pending) entry.resolve({ action: "cancel" });
    if (transport) await transport.terminateSession();
    if (client) await client.close();
    await app.close();
  }
});

test("injected elicitor receives the original correlation and abort options", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-"));
  try {
    const controller = new AbortController();
    const extra = { requestId: "parent-request", signal: controller.signal };
    await approvalTool(config(stateDir), async (_params, options) => {
      assert.equal(options.relatedRequestId, extra.requestId);
      assert.equal(options.signal, extra.signal);
      return { action: "decline" };
    }).handler(input, extra);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

for (const requestId of [0, "", 7, "approval-request"]) {
  test(
    `HTTP cancellation prevents approval after late acceptance for request id ${JSON.stringify(requestId)}`,
    { timeout: 5000 },
    async () => {
      const app = await bindApprovalApp();
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      let reader;
      try {
        const initialized = await fetch(app.baseUrl, { method: "POST", headers, body: JSON.stringify(initialize()) });
        const sessionId = initialized.headers.get("mcp-session-id");
        assert.ok(sessionId);
        await json(initialized);
        const sessionHeaders = { ...headers, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-11-25" };
        const post = (message) =>
          fetch(app.baseUrl, { method: "POST", headers: sessionHeaders, body: JSON.stringify(message) });
        assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
        const response = await post({
          jsonrpc: "2.0",
          id: requestId,
          method: "tools/call",
          params: { name: "nodel.request_write_approval", arguments: input },
        });
        assert.equal(response.status, 200);
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        let elicitation;
        while (!elicitation) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false, "tool stream closed before elicitation");
          buffered += decoder.decode(chunk.value, { stream: true });
          const event = /^data: ([^\r\n]+)\r?\n/mu.exec(buffered);
          if (event) elicitation = JSON.parse(event[1]);
        }
        assert.equal(elicitation.method, "elicitation/create");
        assert.equal(
          (
            await post({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId, reason: "operator cancelled" },
            })
          ).status,
          202,
        );
        // A response already in flight may still say yes after cancellation was acknowledged.
        assert.equal(
          (
            await post({
              jsonrpc: "2.0",
              id: elicitation.id,
              result: { action: "accept", content: { approved: true } },
            })
          ).status,
          202,
        );
        // A subsequent round trip is a server-event-loop barrier: all synchronous
        // approval continuations from the late response have run before this reply.
        const barrier = await post({ jsonrpc: "2.0", id: "cancellation-barrier", method: "ping" });
        assert.deepEqual((await json(barrier)).result, {});
        assert.equal(existsSync(join(app.stateDir, "approvals.json")), false);
      } finally {
        if (reader) await reader.cancel();
        await app.close();
      }
    },
  );
}

test("explicit fallback preserves a joiner-containing identity through manual tool approval and consumption", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-elicit-manual-"));
  try {
    const cfg = config(stateDir);
    const args = { ...input, target: "Room 👩‍💻" };
    const fallback = await requestWriteApproval(
      cfg,
      async () => {
        throw new Error("must not prompt");
      },
      { ...args, fallbackOnly: true },
    );
    assert.equal(fallback.outcome, "manual_required");
    const tool = collectToolSpecs(cfg).find((entry) => entry.name === "nodel.approve_write");
    const response = /** @type {TextToolResponse} */ (await tool.handler(args));
    const approval = JSON.parse(response.content[0].text);
    assert.equal(response.isError, undefined);
    assert.equal(approval.ok, true);
    assert.equal(approval.target, args.target);
    assertWriteApproved(cfg, args, approval.approvalId);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
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

test("stateful session endpoints enforce expiry, capacity, refresh, GET, and DELETE status", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-17T10:00:00.000Z") });
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

    t.mock.timers.tick(20);
    response = await fetch(app.baseUrl, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(response.status, 200);
    await json(response);

    response = await fetch(app.baseUrl, { method: "POST", headers, body: JSON.stringify(initialize(3)) });
    assert.equal(response.status, 503);
    t.mock.timers.tick(20);
    response = await fetch(app.baseUrl, { method: "POST", headers, body: JSON.stringify(initialize(4)) });
    assert.equal(response.status, 503);
    t.mock.timers.tick(11);
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
