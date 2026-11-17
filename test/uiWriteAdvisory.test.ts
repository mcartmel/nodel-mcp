import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestConfig, type AppConfig } from "../src/config.js";
import { NodelClient } from "../src/nodel/client.js";
import type { ResolvedNode } from "../src/nodel/types.js";
import { registerRecipeWriteTools } from "../src/mcp/tools/recipeWrites.js";
import { verifyWritePlan, workflowGuidance } from "../src/mcp/tools/guidance.js";
import {
  applyNodeFileEdit,
  applyTextEdits,
  normalizeTextContent,
  proposeNodeFile,
  saveNodeFile,
} from "../src/domain/recipes/service.js";
import type { UiAdvisoryEnvelope } from "../src/domain/ui/advisory-types.js";
import { PINNED_V2_CONTRACT } from "../src/domain/ui/v2/contract.js";
import { recipeWriteProposalHash } from "../src/domain/recipes/plans.js";
import { approveWrite, type ApprovalDetails } from "../src/state/approvals.js";
import { publicError } from "../src/shared/publicErrors.js";
import { sha256 } from "../src/shared/canonicalJson.js";

const HTML = '<nodel-button action="Missing" invalid="yes">雪😀</nodel-button>';
const PATH = "content/control.html";
type Body = {
  status: string;
  operationId: string;
  nextHash: string;
  currentHash: string;
  proposedContent?: string;
  approvalReady: boolean;
  approvalRequest: ApprovalDetails & { confirmText: string };
  verification: { ok: boolean; expectedHash: string; actualHash?: string; message?: string };
  uiFeedback?: UiAdvisoryEnvelope;
  error: { code: string };
};
type State = {
  bytes: Buffer;
  paths: string[];
  saves: Buffer[];
  assetStatus: number;
  saveStatus: number;
  readBackStatus: number;
  wrongReadBack: boolean;
  stallAssets: boolean;
  stallLive: boolean;
  active: Set<string>;
  afterNextFileRead?: Buffer;
};
async function fixture(
  run: (
    call: (name: string, args: Record<string, unknown>) => Promise<{ body: Body; isError: boolean; text: string }>,
    state: State,
    config: AppConfig,
    client: NodelClient,
    sdk: Client,
  ) => Promise<void>,
  overrides: Partial<AppConfig> = {},
) {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-advisory-write-"));
  const state: State = {
    bytes: Buffer.from(HTML),
    paths: [],
    saves: [],
    assetStatus: 200,
    saveStatus: 200,
    readBackStatus: 200,
    wrongReadBack: false,
    stallAssets: false,
    stallLive: false,
    active: new Set(),
  };
  let verificationPending = false;
  const http = createServer(async (request, response) => {
    const path = request.url!;
    state.paths.push(path);
    const send = (body: string | Buffer, status = 200, mime = "application/json") => {
      response.writeHead(status, { "content-type": mime });
      response.end(body);
    };
    if (path === "/prefix/REST") return send(JSON.stringify({ nodes: { display: { name: "Test Display" } } }));
    if (path.includes("/REST/files/save?")) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (state.saveStatus !== 200) return send("secret remote body", state.saveStatus);
      state.bytes = Buffer.concat(chunks);
      state.saves.push(state.bytes);
      verificationPending = true;
      return send("{}");
    }
    if (path.includes("/REST/files/contents?")) {
      const verifying = verificationPending;
      verificationPending = false;
      if (verifying && state.readBackStatus !== 200) return send("unavailable", state.readBackStatus);
      const bytes = state.bytes;
      if (state.afterNextFileRead) {
        state.bytes = state.afterNextFileRead;
        state.afterNextFileRead = undefined;
      }
      return send(verifying && state.wrongReadBack ? Buffer.from("wrong bytes") : bytes, 200, "text/plain");
    }
    const asset = path.includes("/v2/");
    if ((asset && state.stallAssets) || (!asset && state.stallLive)) {
      state.active.add(path);
      response.on("close", () => state.active.delete(path));
      response.writeHead(200, { "content-type": "application/json" });
      response.write(" ");
      return;
    }
    if (asset)
      return send(
        path.endsWith(".json")
          ? JSON.stringify(PINNED_V2_CONTRACT)
          : path.endsWith(".js")
            ? "export const runtime = true;"
            : "body { color: red }",
        state.assetStatus,
        path.endsWith(".json") ? "application/json" : path.endsWith(".js") ? "application/javascript" : "text/css",
      );
    if (path.endsWith("/REST/files")) return send("[]");
    if (path.includes("/REST/")) return send("{}");
    return send("", 404);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert(address && typeof address !== "string");
  const config = createTestConfig({
    stateDir,
    writesEnabled: true,
    writeApprovalRequired: false,
    nodelRequestTimeoutMs: 1000,
    nodelBaseUrl: `http://127.0.0.1:${address.port}/prefix`,
    ...overrides,
  });
  const client = new NodelClient(config);
  const mcp = new McpServer({ name: "write-advisory", version: "1" });
  registerRecipeWriteTools(mcp, client, config);
  const sdk = new Client({ name: "write-advisory-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st);
  await sdk.connect(ct);
  try {
    await run(
      async (name, args) => {
        const result = await sdk.callTool({
          name: `nodel.${name}`,
          arguments: { node: "display", path: PATH, ...args },
        });
        const text = (result.content as Array<{ text: string }>)[0]!.text;
        return {
          body: text.startsWith("{") ? (JSON.parse(text) as Body) : ({ error: { code: "SDK_SCHEMA" } } as Body),
          text,
          isError: result.isError === true,
        };
      },
      state,
      config,
      client,
      sdk,
    );
  } finally {
    await sdk.close();
    await mcp.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(stateDir, { force: true, recursive: true });
  }
}
const advice = (body: Body) => {
  assert(body.uiFeedback);
  assert.equal(body.uiFeedback.sha256, body.nextHash);
  assert.equal(body.uiFeedback.advisory, true);
  assert.equal(body.uiFeedback.browserTested, false);
  return body.uiFeedback;
};

void test("actual SDK exposes six default-auto schemas; omitted selection reaches every handler", async () => {
  await fixture(async (call, state, _config, _client, sdk) => {
    const schemas = (await sdk.listTools()).tools;
    const tools = [
      "propose_node_file_text",
      "propose_node_file_base64",
      "propose_node_file_edit",
      "save_node_file_text",
      "save_node_file_base64",
      "apply_node_file_edit",
    ];
    for (const tool of tools) {
      const schema = schemas.find((entry) => entry.name === `nodel.${tool}`)!.inputSchema.properties!.uiFeedback as {
        default: string;
        enum: string[];
      };
      assert.equal(schema.default, "auto");
      assert.deepEqual(schema.enum, ["auto", "skip", "v1", "v2"]);
      const edit = tool.includes("edit");
      const args = edit
        ? { edits: [{ oldText: "雪", newText: "雨" }], includeContent: false }
        : tool.includes("base64")
          ? { contentBase64: Buffer.from(HTML + "!").toString("base64") }
          : { content: HTML + "!" };
      const result = await call(tool, { ...args, dryRun: true });
      assert.equal(result.isError, false, result.text);
      advice(result.body);
      if (edit && tool.startsWith("propose")) assert.equal(result.body.proposedContent, undefined);
    }
    assert.equal(state.saves.length, 0);
    const bad = await call("propose_node_file_text", { content: HTML, uiFeedback: "mandatory" });
    assert.equal(bad.body.error.code, "SDK_SCHEMA");
  });
});

void test("real HTTP base64 save preserves BOM/Unicode bytes and edit hashes preserve existing text decoding", async () => {
  await fixture(async (call, state, config) => {
    const bytes = Buffer.from("\uFEFF" + HTML + "\r\n");
    const result = await call("save_node_file_base64", {
      contentBase64: bytes.toString("base64"),
      expectedHash: sha256(state.bytes),
    });
    assert.equal(result.isError, false, result.text);
    assert.equal(result.body.status, "succeeded_verified");
    assert.deepEqual(state.saves[0], bytes);
    assert.equal(advice(result.body).sha256, sha256(bytes));
    assert.equal(result.body.verification.actualHash, sha256(bytes));
    const audit = readFileSync(join(config.stateDir, "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { operationId: string; outcome: string });
    assert.deepEqual(
      audit.map((entry) => entry.outcome),
      ["attempted", "succeeded"],
    );
    assert(audit.every((entry) => entry.operationId === result.body.operationId));
    // fetch/text strips BOM: preserve the established edit currentHash semantics,
    // while original advisory evidence and candidate hashes use actual bytes.
    const proposal = await call("propose_node_file_edit", {
      edits: [{ oldText: "雪", newText: "雨" }],
      includeContent: false,
    });
    assert.equal(proposal.body.currentHash, sha256(bytes.subarray(3)));
    assert.equal(advice(proposal.body).coverage.originalSha256, sha256(bytes));
    const stale = await call("apply_node_file_edit", {
      edits: [{ oldText: "雪", newText: "雨" }],
      expectedHash: proposal.body.currentHash,
    });
    assert.equal(stale.body.error.code, "CONFLICT", "existing raw-byte gate must not silently change for BOM edits");
    const edited = await call("apply_node_file_edit", { edits: [{ oldText: "雪", newText: "雨" }] });
    assert.equal(edited.body.status, "succeeded_verified");
    assert.equal(advice(edited.body).sha256, sha256(state.bytes));
    assert.equal(state.bytes.toString("utf8"), (HTML + "\r\n").replace("雪", "雨"));
  });
});

void test("auto/skip/failure/live changes never alter approval hashes; approved invalid UI still saves", async () => {
  await fixture(
    async (call, state, config, client) => {
      const content = HTML + "changed";
      const automatic = await call("propose_node_file_text", { content });
      const skipped = await call("propose_node_file_text", { content, uiFeedback: "skip" });
      assert.equal(advice(skipped.body).validation.status, "not_run");
      assert.equal(skipped.body.approvalRequest.proposalHash, automatic.body.approvalRequest.proposalHash);
      assert.equal(
        automatic.body.approvalRequest.proposalHash,
        recipeWriteProposalHash("save_node_file", "Test Display:" + PATH, sha256(state.bytes), sha256(content), PATH, {
          operation: "save_node_file",
        }),
      );
      const originalRequest = client.nodeRequest.bind(client);
      client.nodeRequest = new Proxy(originalRequest, {
        apply(target, thisArg, args: unknown[]) {
          if (["actions", "events", "files"].includes(String(args[1])))
            throw publicError("POLICY", "Bearer DO_NOT_LEAK https://user:password@example.invalid/");
          return Reflect.apply(target, thisArg, args);
        },
      });
      const failed = await call("propose_node_file_text", { content });
      assert.equal(advice(failed.body).validation.status, "not_run");
      assert(!JSON.stringify(failed.body.uiFeedback).includes("DO_NOT_LEAK"));
      assert.equal(failed.body.approvalRequest.proposalHash, automatic.body.approvalRequest.proposalHash);
      const approval = approveWrite(config, automatic.body.approvalRequest, automatic.body.approvalRequest.confirmText);
      state.assetStatus = 404;
      const saved = await call("save_node_file_text", {
        content,
        expectedHash: automatic.body.currentHash,
        approvalId: approval.approvalId,
      });
      assert.equal(saved.isError, false, saved.text);
      assert.equal(saved.body.status, "succeeded_verified");
      assert.equal(saved.body.approvalRequest.proposalHash, automatic.body.approvalRequest.proposalHash);
      assert.equal(advice(saved.body).validation.status, "not_run");
      assert.equal(saved.body.verification.ok, true);
      assert.equal(state.saves.length, 1);
      // A fresh client observes an actual deployment change rather than a
      // cached earlier observation. Content approval is still identical.
      client.nodeRequest = originalRequest;
      state.bytes = Buffer.from(HTML);
      const secondApproval = approveWrite(
        config,
        automatic.body.approvalRequest,
        automatic.body.approvalRequest.confirmText,
      );
      const changedDeployment = await saveNodeFile(
        new NodelClient(config),
        config,
        "display",
        PATH,
        normalizeTextContent(content),
        automatic.body.currentHash,
        false,
        undefined,
        { operation: "save_node_file" },
        secondApproval.approvalId,
      );
      assert.equal(changedDeployment.status, "succeeded_verified");
      assert.equal(changedDeployment.approvalRequest.proposalHash, automatic.body.approvalRequest.proposalHash);
      assert.equal(changedDeployment.uiFeedback!.capabilities!.state, "not_detected");
      assert.equal(
        changedDeployment.uiFeedback!.validation.status,
        "errors",
        "static UI errors cannot block authorized saves",
      );
    },
    { writeApprovalRequired: true },
  );
});

void test("approval/stale/path/write gates and malformed base64 fail unchanged before advisory I/O", async () => {
  await fixture(
    async (call, state, config) => {
      const content = HTML + "changed";
      const proposal = await call("propose_node_file_text", { content, uiFeedback: "skip" });
      const wrong = approveWrite(
        config,
        { ...proposal.body.approvalRequest, proposalHash: "f".repeat(64) },
        "APPROVE " + "f".repeat(12),
      );
      const expired = approveWrite(
        config,
        proposal.body.approvalRequest,
        proposal.body.approvalRequest.confirmText,
        undefined,
        undefined,
        { now: () => new Date(Date.now() - 3_600_000) },
      );
      const cases = [
        { args: { content }, code: "APPROVAL_REQUIRED" },
        { args: { content, approvalId: wrong.approvalId }, code: "CONFLICT" },
        { args: { content, approvalId: expired.approvalId }, code: "APPROVAL_REQUIRED" },
        { args: { content, expectedHash: "stale" }, code: "CONFLICT" },
        { args: { content, path: "script.py" }, code: "VALIDATION" },
        { args: { content, path: "../escape.html" }, code: "VALIDATION" },
      ];
      for (const entry of cases) {
        state.paths.length = 0;
        const result = await call("save_node_file_text", entry.args);
        assert.equal(result.isError, true, result.text);
        assert.equal(result.body.error.code, entry.code);
        assert(!state.paths.some((path) => /\/v2\/|\/REST\/(?:actions|events|files)$/u.test(path)));
      }
      const base64 = await call("save_node_file_base64", { contentBase64: "not base64" });
      assert.equal(base64.body.error.code, "VALIDATION");
      assert.equal(state.saves.length, 0);
    },
    { writeApprovalRequired: true },
  );
  await fixture(
    async (call, state, config, client, sdk) => {
      assert(!(await sdk.listTools()).tools.some((entry) => entry.name === "nodel.save_node_file_text"));
      await assert.rejects(
        saveNodeFile(client, config, "display", PATH, normalizeTextContent(HTML + "changed"), undefined, false),
        { code: "POLICY" },
      );
      assert.equal(state.saves.length, 0);
      const plan = await call("propose_node_file_text", { content: HTML + "changed" });
      advice(plan.body);
    },
    { writesEnabled: false },
  );
});

void test("edit approvals ignore feedback selection and still bind the exact once-composed edits", async () => {
  await fixture(
    async (call, state, config) => {
      const edits = [{ oldText: "雪", newText: "雨" }];
      const automatic = await call("propose_node_file_edit", { edits, includeContent: false });
      const skipped = await call("propose_node_file_edit", { edits, includeContent: false, uiFeedback: "skip" });
      assert.equal(automatic.body.approvalRequest.proposalHash, skipped.body.approvalRequest.proposalHash);
      const approval = approveWrite(config, automatic.body.approvalRequest, automatic.body.approvalRequest.confirmText);
      const applied = await call("apply_node_file_edit", {
        edits,
        expectedHash: automatic.body.currentHash,
        approvalId: approval.approvalId,
        uiFeedback: "skip",
      });
      assert.equal(applied.body.status, "succeeded_verified", applied.text);
      assert.equal(applied.body.approvalRequest.proposalHash, automatic.body.approvalRequest.proposalHash);
      assert.equal(advice(applied.body).validation.status, "not_run");
      assert.equal(state.bytes.toString(), HTML.replace("雪", "雨"));
    },
    { writeApprovalRequired: true },
  );
});

void test("core proposal policy failures remain errors, and the legacy alreadyLocked API performs no advice", async () => {
  await fixture(
    async (call, state) => {
      const result = await call("propose_node_file_text", { content: HTML });
      assert.equal(result.isError, true);
      assert.equal(result.body.error.code, "POLICY");
      assert.equal(result.body.uiFeedback, undefined);
      assert(!state.paths.some((path) => path.includes("/v2/")));
    },
    { allowedNodePrefixes: ["Allowed"] },
  );
  const result = await saveNodeFile(
    { getNodeFileBytes: async () => Buffer.from(HTML) } as unknown as NodelClient,
    createTestConfig({}),
    resolvedNode(),
    PATH,
    normalizeTextContent(HTML),
    undefined,
    false,
    undefined,
    {},
    undefined,
    true,
  );
  assert.equal(result.status, "no_change");
  assert.equal(result.uiFeedback, undefined, "outer lock owners get core-only results; no hidden network enrichment");
});

void test("unrelated files (including plain HTML) stay envelope/network-free with partial clients", async () => {
  await fixture(async (call, state) => {
    for (const path of [
      "content/app.js",
      "content/style.css",
      "content/schema.json",
      "helper.py",
      "logo.png",
      "content/plain.html",
      "content/config.xml",
    ]) {
      state.bytes = Buffer.from(path.endsWith(".xml") ? "<ordinary>plain" : "<ordinary>plain</ordinary>");
      state.paths.length = 0;
      const result = await call("propose_node_file_edit", { path, edits: [{ oldText: "plain", newText: "next" }] });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.body.uiFeedback, undefined);
      assert.equal(state.paths.filter((entry) => entry.includes("/files/contents?")).length, 1);
      assert.equal(state.paths.length, 2, "only core resolve and file read");
    }
  });
  const node = resolvedNode();
  const result = await proposeNodeFile(
    { resolveNode: async () => node, getNodeFileBytes: async () => Buffer.from("old") } as unknown as NodelClient,
    createTestConfig({}),
    "demo",
    "data.json",
    normalizeTextContent("new"),
  );
  assert.equal(result.uiFeedback, undefined, "no capability methods required on unrelated partial mocks");
});

void test("binary/invalid UTF-8/oversize HTML gets exact-byte not_run; skip never calls advisory endpoints", async () => {
  await fixture(async (call, state) => {
    for (const bytes of [
      Buffer.from([0xff, 0xfe, 0x80]),
      Buffer.from([0, 1, 2, 3]),
      Buffer.alloc(2 * 1024 * 1024 + 1, 120),
    ]) {
      state.paths.length = 0;
      const result = await call("save_node_file_base64", { contentBase64: bytes.toString("base64") });
      assert.equal(result.body.status, "succeeded_verified", result.text);
      assert.equal(advice(result.body).validation.status, "not_run");
      assert.equal(result.body.nextHash, sha256(bytes));
      assert(!state.paths.some((path) => path.includes("/v2/") || path.endsWith("/REST/actions")));
    }
    state.bytes = Buffer.from(HTML);
    for (const tool of [
      "propose_node_file_text",
      "save_node_file_text",
      "propose_node_file_edit",
      "apply_node_file_edit",
    ]) {
      state.paths.length = 0;
      const result = await call(tool, {
        content: HTML + "next",
        edits: [{ oldText: "雪", newText: "雪!" }],
        uiFeedback: "skip",
      });
      assert.equal(advice(result.body).validation.status, "not_run");
      assert(!state.paths.some((path) => /\/v2\/|\/REST\/(?:actions|events|files)$/u.test(path)));
    }
  });
});

void test("marker removal retains original classification; no-change/dry-run/forced-format retain advice", async () => {
  await fixture(async (call, state) => {
    const original = state.bytes;
    const edits = [{ oldText: HTML, newText: "<main>neutral</main>" }];
    const proposed = await call("propose_node_file_edit", { edits, includeContent: false });
    assert.equal(
      state.paths.filter((path) => path.includes("/files/contents?")).length,
      1,
      "raw original capture must not duplicate or reread the source",
    );
    assert.equal(advice(proposed.body).selectedFormat, "v2");
    assert(advice(proposed.body).detection.basis.includes("original_content"));
    assert.equal(advice(proposed.body).coverage.originalSha256, sha256(original));
    const applied = await call("apply_node_file_edit", { edits, expectedHash: proposed.body.currentHash });
    assert.equal(applied.body.status, "succeeded_verified");
    assert.equal(advice(applied.body).selectedFormat, "v2");
    assert.equal(applied.body.nextHash, proposed.body.nextHash);
    const noChange = await call("save_node_file_text", { content: state.bytes.toString(), uiFeedback: "v2" });
    assert.equal(noChange.body.status, "no_change");
    assert.equal(advice(noChange.body).selectedFormat, "v2");
    const dryRun = await call("save_node_file_text", { content: "<pages>", uiFeedback: "v1", dryRun: true });
    assert.equal(dryRun.body.status, "dry_run");
    assert.equal(advice(dryRun.body).validation.status, "errors");
    assert.equal(state.saves.length, 1);
  });
});

void test("automatic issue output is capped at 200 without hiding diagnostic totals or blocking saves", async () => {
  await fixture(async (call) => {
    const content = '<nodel-button invalid="x"></nodel-button>'.repeat(300);
    const result = await call("save_node_file_text", { content });
    assert.equal(result.body.status, "succeeded_verified");
    const feedback = advice(result.body);
    assert.equal(feedback.issues.length, 200);
    assert(feedback.validation.errors + feedback.validation.warnings + feedback.validation.info >= 300);
    assert.notEqual(feedback.validation.status, "passed");
    assert.equal(feedback.validation.complete, false);
    assert(feedback.checks.some((check) => check.name === "issue-output" && check.state === "truncated"));
  });
});

void test("real mutation failures are not advisory failures; read-back pending/error statuses and audits survive", async () => {
  await fixture(async (call, state, config) => {
    state.saveStatus = 503;
    const failed = await call("save_node_file_text", { content: HTML + "next" });
    assert.equal(failed.isError, true);
    assert.equal(failed.body.uiFeedback, undefined);
    assert(!state.paths.some((path) => path.includes("/v2/")));
    state.saveStatus = 200;
    for (const unavailable of [false, true]) {
      state.wrongReadBack = !unavailable;
      state.readBackStatus = unavailable ? 503 : 200;
      const result = await call("save_node_file_text", { content: HTML + String(unavailable) });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.body.status, "succeeded_verification_pending");
      assert.equal(result.body.verification.ok, false);
      advice(result.body);
      if (unavailable) assert(result.body.verification.message);
      state.readBackStatus = 200;
    }
    const audit = readFileSync(join(config.stateDir, "audit.jsonl"), "utf8");
    assert.match(audit, /"outcome":"failed"/u);
    assert.equal(audit.split('"outcome":"succeeded"').length - 1, 2);
  });
});

function resolvedNode(): ResolvedNode {
  return {
    input: "demo",
    name: "demo",
    allowed: true,
    scope: "local",
    url: "http://localhost/nodes/demo/",
    nodeBaseUrl: "http://localhost/nodes/demo/",
  };
}
void test("advice runs after lock/read-back; second edit proceeds, first never rereads/recomposes/re-saves", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-advisory-lock-"));
  try {
    let bytes = Buffer.from(HTML);
    let textReads = 0,
      byteReads = 0,
      saves = 0,
      probes = 0;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = {
      resolveNode: async () => resolvedNode(),
      getNodeFileContents: async () => {
        textReads++;
        return bytes.toString();
      },
      getNodeFileBytes: async () => {
        byteReads++;
        return bytes;
      },
      nodeRequest: async (_node: unknown, path: string, options?: { body?: Uint8Array }) => {
        if (path.startsWith("files/save?")) {
          saves++;
          bytes = Buffer.from(options!.body!);
          return { response: {} };
        }
        assert.equal(saves, 1, "first advisory starts after mutation");
        assert.equal(byteReads, 3, "first advisory starts after composition source + core gate + read-back");
        probes++;
        entered();
        await blocked;
        return { response: path === "files" ? [] : {} };
      },
    } as unknown as NodelClient;
    const config = createTestConfig({ stateDir, writesEnabled: true, writeApprovalRequired: false });
    const first = applyNodeFileEdit(client, config, "demo", PATH, [{ oldText: "雪", newText: "雨" }], undefined, false);
    await waiting;
    const second = await Promise.race([
      applyNodeFileEdit(
        client,
        config,
        "demo",
        PATH,
        [{ oldText: "雨", newText: "風" }],
        undefined,
        false,
        undefined,
        undefined,
        "skip",
      ),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("second write blocked by advisory lock")), 500);
        timer.unref();
      }),
    ]);
    assert.equal(second.status, "succeeded_verified");
    release();
    const result = await first;
    assert.equal(result.status, "succeeded_verified");
    assert.equal(result.uiFeedback!.sha256, sha256(HTML.replace("雪", "雨")));
    assert.equal(result.uiFeedback!.coverage.originalSha256, sha256(HTML));
    assert.equal(bytes.toString(), HTML.replace("雪", "風"));
    assert.equal(saves, 2);
    assert.equal(textReads, 0, "UI text is decoded from the single raw composition snapshot, not fetched again");
    assert.equal(byteReads, 6, "only composition source + core gate + verification per save");
    assert.equal(probes, 3, "one live enrichment set, not duplicate apply/save advice");
  } finally {
    rmSync(stateDir, { force: true, recursive: true });
  }
});

void test(
  "automatic aggregate deadline cancels real pending HTTP bodies without changing save success",
  { timeout: 6000 },
  async () => {
    await fixture(
      async (call, state) => {
        state.stallAssets = true;
        state.stallLive = true;
        const start = performance.now();
        const saved = await call("save_node_file_text", { content: HTML + "next" });
        const elapsed = performance.now() - start;
        assert.equal(saved.body.status, "succeeded_verified", saved.text);
        assert(elapsed >= 2800 && elapsed < 3900, `3s automatic ceiling took ${elapsed}ms`);
        assert.notEqual(advice(saved.body).validation.status, "passed");
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(state.active.size, 0, "actual sockets/body reads must be cancelled, not orphaned by a race");
        assert.equal(state.saves.length, 1);
      },
      { nodelRequestTimeoutMs: 20000 },
    );
  },
);

void test("verifyWritePlan summarizes untrusted UI advice separately; hashes only explain staleness", () => {
  const config = createTestConfig({ writesEnabled: true });
  const base = { operation: "save_node_file", path: PATH, nextHash: "a".repeat(64), approvalReady: true };
  const good = verifyWritePlan(config, "node_file", base);
  const badUi = verifyWritePlan(config, "node_file", {
    ...base,
    uiFeedback: {
      sha256: "b".repeat(64),
      validation: { status: "errors", errors: 42, complete: true },
      message: "Bearer DO_NOT_LEAK",
    },
  });
  assert.equal(badUi.ok, good.ok);
  assert.deepEqual(badUi.errors, good.errors);
  assert.deepEqual(badUi.approval, good.approval);
  assert.equal(badUi.advisory!.errors, 42);
  assert.equal(badUi.advisory!.candidateHashMatchesPlan, false);
  assert.match(badUi.advisory!.message, /may be stale/u);
  assert(!JSON.stringify(badUi).includes("DO_NOT_LEAK"));
  for (const task of ["node_file", "node_file_edit"] as const) {
    const guide = workflowGuidance(config, task);
    assert.match(guide.recommendedWorkflow.join("\n"), /uiFeedback=skip/u);
    assert.match(guide.warnings.join("\n"), /Byte read-back is separate/u);
  }
});

void test("real HTTP repeated BOM edit decoding matches legacy text for every selection and HTML/txt path", async () => {
  await fixture(async (call, state, _config, client) => {
    const resolved = await client.resolveNode("display");
    const edits = [{ oldText: "雪", newText: "雨" }];
    for (const path of [PATH, "content/note.txt"]) {
      for (const bomCount of [2, 3]) {
        const raw = Buffer.from("\uFEFF".repeat(bomCount) + HTML);
        state.bytes = raw;
        // Real getNodeFileContents is the baseline, not an assumed number of
        // BOMs. In Node 24.15 Response.text removes two; TextDecoder removes one.
        const legacy = await client.getNodeFileContents(resolved, path);
        const composed = applyTextEdits(legacy, edits);
        const nextHash = normalizeTextContent(composed.content).hash;
        const extra = { operation: "apply_node_file_edit", edits: composed.applied };
        const target = `Test Display:${path}`;
        const legacyProposalHash = recipeWriteProposalHash(
          "apply_node_file_edit",
          target,
          sha256(legacy),
          nextHash,
          path,
          extra,
        );
        const legacyApplyHash = recipeWriteProposalHash(
          "apply_node_file_edit",
          target,
          sha256(raw),
          nextHash,
          path,
          extra,
        );
        for (const uiFeedback of ["auto", "skip", "v1", "v2"]) {
          state.paths.length = 0;
          const proposal = await call("propose_node_file_edit", { path, edits, uiFeedback });
          assert.equal(proposal.isError, false, proposal.text);
          assert.equal(proposal.body.currentHash, sha256(legacy));
          assert.equal(proposal.body.nextHash, nextHash);
          assert.equal(proposal.body.proposedContent, composed.content);
          assert.equal(proposal.body.approvalRequest.proposalHash, legacyProposalHash);
          assert.equal(
            state.paths.filter((entry) => entry.includes("/files/contents?")).length,
            1,
            "no duplicate source fetch for raw evidence",
          );
          state.paths.length = 0;
          const applied = await call("apply_node_file_edit", { path, edits, dryRun: true, uiFeedback });
          assert.equal(applied.isError, false, applied.text);
          assert.equal(applied.body.status, "dry_run");
          assert.equal(applied.body.currentHash, sha256(raw), "core raw-byte gate semantics are unchanged");
          assert.equal(applied.body.nextHash, nextHash);
          assert.equal(applied.body.approvalRequest.proposalHash, legacyApplyHash);
          assert.equal(
            state.paths.filter((entry) => entry.includes("/files/contents?")).length,
            2,
            "one composition read and the existing core gate read",
          );
          // This older decoded-text-vs-raw expectedHash conflict is deliberately
          // not fixed here. Only the new proposal/apply decoding mismatch is fixed.
          const conflict = await call("apply_node_file_edit", {
            path,
            edits,
            dryRun: true,
            uiFeedback,
            expectedHash: proposal.body.currentHash,
          });
          assert.equal(conflict.body.error.code, "CONFLICT");
        }
      }
    }
    assert.equal(state.saves.length, 0);
  });
});

void test("unavailable original classification survives plain replacements in all supporting-file paths without UI reads", async () => {
  await fixture(async (call, state, _config, client) => {
    const resolved = await client.resolveNode("display");
    const replacement = "<main>neutral replacement</main>";
    const originals = [
      Buffer.concat([Buffer.from(HTML), Buffer.from([0xff])]),
      Buffer.from(HTML + "x".repeat(2 * 1024 * 1024)),
    ];
    for (const original of originals) {
      for (const path of [PATH, "content/control.xml", "content/note.txt"]) {
        state.bytes = original;
        const source = await client.getNodeFileContents(resolved, path);
        const edits = [{ oldText: source, newText: replacement }];
        for (const uiFeedback of path.endsWith(".txt") ? ["auto", "v2"] : ["auto", "skip", "v1", "v2"]) {
          for (const tool of [
            "propose_node_file_text",
            "save_node_file_text",
            "propose_node_file_edit",
            "apply_node_file_edit",
          ]) {
            state.paths.length = 0;
            const result = await call(tool, {
              path,
              content: replacement,
              edits,
              dryRun: true,
              includeContent: false,
              uiFeedback,
            });
            assert.equal(result.isError, false, result.text);
            if (path.endsWith(".txt") && uiFeedback === "auto") {
              assert.equal(result.body.uiFeedback, undefined, "non-UI text paths without known intent stay unaffected");
            } else {
              const feedback = advice(result.body);
              assert.equal(feedback.validation.status, "not_run");
              assert.equal(feedback.validation.complete, false);
              assert.equal(feedback.coverage.originalSha256, sha256(original));
              assert.equal(feedback.coverage.originalClassificationAvailable, false);
              assert(
                feedback.checks.some((check) => check.name === "original-classification" && check.state === "skipped"),
              );
              assert.match(
                feedback.detection.explanation!,
                uiFeedback === "skip" ? /explicitly skipped/u : /original format classification is unavailable/u,
              );
            }
            assert(
              !state.paths.some((entry) => /\/v2\/|\/REST\/(?:actions|events|files)$/u.test(entry)),
              "unknown original classification must not start advisory enrichment",
            );
          }
        }
      }
    }
    assert.equal(state.saves.length, 0);
  });
});

void test("concurrent-client change between edit source and core gate cannot replace advisory original evidence", async () => {
  await fixture(async (call, state) => {
    const source = Buffer.from(HTML);
    const external = Buffer.from("<main>changed by a different client</main>");
    const candidate = "<main>candidate with final marker removed</main>";
    state.bytes = source;
    state.afterNextFileRead = external;
    const result = await call("apply_node_file_edit", { edits: [{ oldText: HTML, newText: candidate }], dryRun: true });
    assert.equal(result.isError, false, result.text);
    assert.equal(result.body.status, "dry_run");
    assert.equal(
      result.body.currentHash,
      sha256(external),
      "preserve the later core snapshot; do not claim cross-client atomicity",
    );
    assert.equal(result.body.nextHash, sha256(candidate));
    const feedback = advice(result.body);
    assert.equal(feedback.selectedFormat, "v2");
    assert(feedback.detection.basis.includes("original_content"));
    assert.equal(
      feedback.coverage.originalSha256,
      sha256(source),
      "original evidence is the exact composition source, not the later core read",
    );
    assert.equal(
      state.paths.filter((entry) => entry.includes("/files/contents?")).length,
      2,
      "no later reread/recomposition",
    );
    assert.deepEqual(state.bytes, external);
    assert.equal(state.saves.length, 0);
  });
});

void test("actual saves with unavailable original classification remain verified without advisory network reads", async () => {
  await fixture(async (call, state) => {
    const replacement = "<main>neutral replacement</main>";
    for (const original of [
      Buffer.concat([Buffer.from(HTML), Buffer.from([0xff])]),
      Buffer.from(HTML + "x".repeat(2 * 1024 * 1024)),
    ]) {
      for (const uiFeedback of ["auto", "skip"]) {
        state.bytes = original;
        state.paths.length = 0;
        const saved = await call("save_node_file_text", {
          content: replacement,
          expectedHash: sha256(original),
          uiFeedback,
        });
        assert.equal(saved.isError, false, saved.text);
        assert.equal(saved.body.status, "succeeded_verified");
        assert.equal(saved.body.verification.ok, true);
        assert.equal(advice(saved.body).validation.status, "not_run");
        assert.equal(advice(saved.body).coverage.originalSha256, sha256(original));
        assert.equal(advice(saved.body).coverage.originalClassificationAvailable, false);
        assert(!state.paths.some((entry) => /\/v2\/|\/REST\/(?:actions|events|files)$/u.test(entry)));
        assert.equal(state.paths.filter((entry) => entry.includes("/files/save?")).length, 1);
        assert.equal(
          state.paths.filter((entry) => entry.includes("/files/contents?")).length,
          2,
          "only core original and read-back",
        );
      }
    }
    assert.equal(state.saves.length, 4);
  });
});
