import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:net";
import { approveWrite, assertWriteApproved, approvalRequest } from "../dist/state/approvals.js";
import { auditedMutation, auditWrite, backupParameterState, RemoteFailureAuditError } from "../dist/state/audit.js";
import { withWriteLock } from "../dist/state/locks.js";
import { StateStore } from "../dist/state/store.js";
import { stateStore } from "../dist/state/store.js";
import { listWriteAudit } from "../dist/mcp/tools/auditReads.js";
import { readOptionalNodeFileBytes } from "../dist/mcp/tools/recipeWrites.js";
import {
  NodelHttpError,
  NodelNotFoundError,
  NodelRedirectError,
  NodelTimeoutError,
} from "../dist/nodel/http/errors.js";
import { classifyToolError, toolResult } from "../dist/mcp/tools/common.js";
import { logger } from "../dist/logger.js";
import { registerNodeWriteTools } from "../dist/mcp/tools/nodeWrites.js";
import { registerRecipeWriteTools } from "../dist/mcp/tools/recipeWrites.js";
import { createTestConfig } from "../dist/config.js";
import { requireBearerToken, startHttpServer } from "../dist/mcp/server.js";
import { NodeResolutionNotFoundError } from "../dist/nodel/resolution/resolver.js";
import { verifyDeletedNode } from "../dist/domain/recipes/service.js";
import { PublicError } from "../dist/shared/publicErrors.js";

function config(stateDir) {
  return createTestConfig({
    stateDir,
    writesEnabled: true,
    writeApprovalRequired: true,
    writeApprovalTtlSeconds: 60,
    auditMaxBytes: 1024 * 1024,
    auditRetentionFiles: 5,
    backupRetentionDays: 30,
    backupRetentionPerNodeKind: 50,
  });
}

/** @param {unknown} error @returns {string | undefined} */
function errorCode(error) {
  return /** @type {{ code?: string }} */ (/** @type {unknown} */ (error)).code;
}

/** @param {unknown} value @returns {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} */
function asServer(value) {
  return /** @type {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} */ (/** @type {unknown} */ (value));
}

/** @param {unknown} value @returns {import("../dist/nodel/client.js").NodelClient} */
function asClient(value) {
  return /** @type {import("../dist/nodel/client.js").NodelClient} */ (/** @type {unknown} */ (value));
}

/** @param {unknown} value @returns {import("express").Request} */
function asRequest(value) {
  return /** @type {import("express").Request} */ (/** @type {unknown} */ (value));
}

/** @param {unknown} value @returns {import("express").Response} */
function asResponse(value) {
  return /** @type {import("express").Response} */ (/** @type {unknown} */ (value));
}

test("truncated approval state is quarantined and fails closed", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-corrupt-"));
  try {
    writeFileSync(join(stateDir, "approvals.json"), '{"version":2,', "utf8");
    assert.throws(
      () =>
        approveWrite(
          config(stateDir),
          {
            operation: "x",
            target: "y",
            proposalHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          },
          "APPROVE 0123456789ab",
        ),
      /corrupt.*quarantined/iu,
    );
    assert.equal(existsSync(join(stateDir, "approvals.json")), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("approval quarantine rename failures preserve corrupt state and fail closed accurately", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-quarantine-failure-"));
  const path = join(stateDir, "approvals.json");
  const native = {
    appendFileSync,
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
  };
  try {
    writeFileSync(path, "{invalid", "utf8");
    const store = new StateStore(stateDir, {
      ...native,
      renameSync() {
        throw new Error("rename denied");
      },
    });
    const details = {
      operation: "x",
      target: "y",
      proposalHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };
    assert.throws(
      () => assertWriteApproved(config(stateDir), details, "approval", { store }),
      /could not be quarantined.*original file was preserved/iu,
    );
    assert.equal(existsSync(path), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("approval quarantine chmod failures report the moved quarantine path", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-quarantine-chmod-"));
  const path = join(stateDir, "approvals.json");
  const native = {
    appendFileSync,
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
  };
  try {
    writeFileSync(path, "{invalid", "utf8");
    const store = new StateStore(stateDir, {
      ...native,
      chmodSync(target, mode) {
        if (String(target).includes(".corrupt-")) throw new Error("chmod denied");
        return chmodSync(target, mode);
      },
    });
    const details = {
      operation: "x",
      target: "y",
      proposalHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };
    assert.throws(
      () => assertWriteApproved(config(stateDir), details, "approval", { store }),
      /was quarantined at .*permission hardening failed.*original path .* was moved/iu,
    );
    assert.equal(existsSync(path), false);
    assert.ok(readdirSync(stateDir).some((name) => name.includes(".corrupt-")));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("malformed approval envelopes are quarantined through the injected state filesystem", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-envelope-"));
  const native = {
    appendFileSync,
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
  };
  try {
    const malformed = {
      version: 2,
      approvals: [
        {
          id: "",
          operation: "",
          target: " ",
          proposalHash: "not-a-hash",
          createdAt: "not-a-date",
          expiresAt: "also-not-a-date",
        },
      ],
    };
    writeFileSync(join(stateDir, "approvals.json"), JSON.stringify(malformed), "utf8");
    let reads = 0;
    let renames = 0;
    const store = new StateStore(
      stateDir,
      {
        ...native,
        readFileSync: /** @type {typeof native.readFileSync} */ (
          /** @type {unknown} */ (
            function (...args) {
              reads += 1;
              return native.readFileSync(args[0], args[1]);
            }
          )
        ),
        renameSync(...args) {
          renames += 1;
          return renameSync(...args);
        },
      },
      { now: () => new Date(0) },
      { pid: 1, uuid: () => "quarantine-id", isProcessAlive: () => false },
    );
    const details = {
      operation: "x",
      target: "y",
      proposalHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };
    assert.throws(
      () =>
        assertWriteApproved(config(stateDir), details, "any", {
          store,
          now: () => new Date(0),
          uuid: () => "approval-id",
        }),
      /unsupported schema.*quarantined/iu,
    );
    assert.equal(reads, 1);
    assert.equal(renames, 1);
    assert.ok(readdirSync(stateDir).some((name) => name.includes(".corrupt-0-approval-id")));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("approval envelope validation rejects each persisted approval invariant", () => {
  const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const valid = {
    id: "id",
    operation: "write",
    target: "Node",
    proposalHash: hash,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:01:00.000Z",
  };
  const cases = [
    { ...valid, id: "" },
    { ...valid, operation: " " },
    { ...valid, target: "" },
    { ...valid, proposalHash: "bad" },
    { ...valid, createdAt: "invalid" },
    { ...valid, expiresAt: "invalid" },
    { ...valid, expiresAt: valid.createdAt },
  ];
  for (const approval of cases) {
    const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-envelope-case-"));
    try {
      writeFileSync(join(stateDir, "approvals.json"), JSON.stringify({ version: 2, approvals: [approval] }), "utf8");
      assert.throws(
        () => assertWriteApproved(config(stateDir), { operation: "write", target: "Node", proposalHash: hash }, "id"),
        /unsupported schema.*quarantined/iu,
      );
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
});

test("legacy pending approvals are invalidated while replacing them with v2 state", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-legacy-"));
  try {
    const details = {
      operation: "x",
      target: "y",
      proposalHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };
    writeFileSync(
      join(stateDir, "approvals.json"),
      JSON.stringify([
        {
          id: "legacy",
          ...details,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      ]),
      "utf8",
    );
    assert.throws(() => assertWriteApproved(config(stateDir), details, "legacy"), /not found|expired/iu);
    assert.equal(JSON.parse(readFileSync(join(stateDir, "approvals.json"), "utf8")).version, 2);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("approval persistence uses restrictive permissions and expires or consumes ids once", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-approval-"));
  try {
    const cfg = config(stateDir);
    const details = {
      operation: "x",
      target: "y",
      proposalHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };
    const expired = approveWrite(cfg, details, approvalRequest(cfg, details).confirmText, undefined, undefined, {
      now: () => new Date(0),
      uuid: () => "expired",
    });
    assert.throws(
      () => assertWriteApproved(cfg, details, expired.approvalId, { now: () => new Date(61000) }),
      /not found|expired/iu,
    );
    const active = approveWrite(cfg, details, approvalRequest(cfg, details).confirmText, undefined, undefined, {
      uuid: () => "active",
    });
    assert.doesNotThrow(() => assertWriteApproved(cfg, details, active.approvalId));
    assert.throws(() => assertWriteApproved(cfg, details, active.approvalId), /not found|expired/iu);
    assert.equal(statSync(join(stateDir, "approvals.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("backups preserve non-exact token substrings faithfully", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-audit-"));
  try {
    const cfg = { ...config(stateDir), mcpToken: "sidecar-bearer-secret" };
    const first = backupParameterState(
      cfg,
      "Node",
      {
        authorization: "Bearer nodel-credential",
        nested: { password: "faithful", accidentalSidecarToken: "prefix-sidecar-bearer-secret-suffix" },
      },
      "one",
      { now: () => new Date(0), uuid: () => "backup-one" },
    );
    const second = backupParameterState(cfg, "Node", { authorization: "Bearer nodel-credential" }, "two", {
      now: () => new Date(0),
      uuid: () => "backup-two",
    });
    assert.notEqual(first, second);
    assert.match(readFileSync(first, "utf8"), /nodel-credential/u);
    assert.match(readFileSync(first, "utf8"), /prefix-sidecar-bearer-secret-suffix/u);
    const successful = await auditedMutation(cfg, { operation: "write", node: "Node" }, async () => "ok");
    assert.equal(successful.result, "ok");
    await assert.rejects(
      auditedMutation(cfg, { operation: "write", node: "Node" }, async () => {
        throw new Error("remote failed");
      }),
      /remote failed/u,
    );
    const events = readFileSync(join(stateDir, "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.outcome === "attempted"));
    assert.ok(events.some((event) => event.outcome === "succeeded"));
    assert.ok(events.some((event) => event.outcome === "failed"));
    assert.ok(events.every((event) => typeof event.operationId === "string"));
    assert.equal(statSync(join(stateDir, "audit.jsonl")).mode & 0o777, 0o600);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("backups reject an exact sidecar token and operation ids containing separators remain prunable", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-backup-token-"));
  try {
    const cfg = { ...config(stateDir), mcpToken: "sidecar-token", backupRetentionPerNodeKind: 0 };
    assert.throws(
      () => backupParameterState(cfg, "Node", { nested: ["sidecar-token"] }, "blocked"),
      /faithful backup cannot be persisted/iu,
    );
    const separatorOperation = "operation--with--separator";
    const encoded = backupParameterState(cfg, "Node", { value: "safe" }, separatorOperation);
    assert.match(encoded, /--op_[A-Za-z0-9_-]+--/u);
    auditWrite(cfg, { operation: "x", operationId: separatorOperation, outcome: "succeeded" });
    backupParameterState(cfg, "Node", { value: "trigger" }, "unresolved");
    assert.equal(existsSync(encoded), false);
    const legacy = join(stateDir, "backups", "parameters", "2000-01-01--legacy-op--legacy-id--Node.json");
    writeFileSync(legacy, "{}\n", "utf8");
    auditWrite(cfg, { operation: "x", operationId: "legacy-op", outcome: "succeeded" });
    backupParameterState(cfg, "Node", { value: "trigger-two" }, "unresolved-two");
    assert.equal(existsSync(legacy), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("ambiguous mutation audits retain backups and expose an operation id on the typed error", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-ambiguous-"));
  try {
    const cfg = { ...config(stateDir), backupRetentionPerNodeKind: 0 };
    const backup = backupParameterState(cfg, "Node", { value: 1 }, "timeout-operation");
    const timeout = new NodelTimeoutError(new URL("http://127.0.0.1/REST"), 1);
    await assert.rejects(
      auditedMutation(cfg, { operation: "write", operationId: "timeout-operation" }, async () => {
        throw timeout;
      }),
      (error) =>
        error === timeout && /** @type {{ operationId?: string }} */ (error).operationId === "timeout-operation",
    );
    assert.equal(existsSync(backup), true);
    const events = readFileSync(join(stateDir, "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.at(-1).version, 3);
    assert.equal(events.at(-1).outcome, "ambiguous");
    assert.deepEqual(classifyToolError(timeout).operationId, "timeout-operation");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("redirected mutations are ambiguous, retain backups, and expose the audited operation id", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-redirect-"));
  try {
    const cfg = { ...config(stateDir), backupRetentionPerNodeKind: 0 };
    const operationId = "redirect-operation";
    const backup = backupParameterState(cfg, "Node", { value: 1 }, operationId);
    const redirect = new NodelRedirectError(new URL("http://127.0.0.1/REST"), "redirect");
    const result = await toolResult(async () =>
      auditedMutation(cfg, { operation: "write", operationId }, async () => {
        throw redirect;
      }),
    );
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.status, "ambiguous");
    assert.equal(payload.error.code, "NODEL_REDIRECT");
    assert.equal(payload.error.ambiguous, true);
    assert.equal(payload.error.operationId, operationId);
    assert.equal(existsSync(backup), true);
    const events = readFileSync(join(stateDir, "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.at(-1).outcome, "ambiguous");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("delete verification accepts only typed node-resolution absence", async () => {
  const cfg = { ...config("/tmp/nodel-ai-delete-verification"), postWriteReadyTimeoutSeconds: 0 };
  const absent = await verifyDeletedNode(
    {
      resolveNode: async () => {
        throw new NodeResolutionNotFoundError("Gone");
      },
    },
    cfg,
    "Gone",
  );
  assert.equal(absent.ok, true);

  for (const error of [
    new PublicError("VALIDATION", "Node name is ambiguous in discovery: Gone"),
    new PublicError("VALIDATION", "Malformed discovery payload token=must-not-leak"),
    new Error("resolver unavailable token=must-not-leak"),
  ]) {
    const pending = await verifyDeletedNode(
      {
        resolveNode: async () => {
          throw error;
        },
      },
      cfg,
      "Gone",
    );
    assert.equal(pending.ok, false);
    assert.match(pending.message, /absence could not be verified/u);
    assert.doesNotMatch(pending.lastError ?? "", /must-not-leak/u);
  }
});

test("logs and audit reasons recursively redact sensitive free-form values", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-redaction-"));
  const originalWrite = process.stdout.write;
  let line = "";
  try {
    process.stdout.write = (value) => {
      line += String(value);
      return true;
    };
    logger.info("write", { nested: { reason: "Bearer top-secret password=remote-secret" } });
    auditWrite(config(stateDir), { operation: "write", reason: "https://user:pass@example.test/?token=token-secret" });
    const audit = readFileSync(join(stateDir, "audit.jsonl"), "utf8");
    assert.doesNotMatch(`${line}${audit}`, /top-secret|remote-secret|user:pass|token-secret/iu);
  } finally {
    process.stdout.write = originalWrite;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("in-process write locks serialize concurrent operations by resource key", async () => {
  const order = [];
  await Promise.all([
    withWriteLock("same", async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("first-end");
    }),
    withWriteLock("same", async () => {
      order.push("second");
    }),
  ]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});

test("synchronous approvals cannot interleave creation or duplicate consumption in one process", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-sync-"));
  try {
    const cfg = config(stateDir);
    const details = {
      operation: "x",
      target: "y",
      proposalHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };
    const approvals = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        Promise.resolve().then(() =>
          approveWrite(cfg, details, approvalRequest(cfg, details).confirmText, undefined, undefined, {
            uuid: () => `approval-${index}`,
          }),
        ),
      ),
    );
    assert.equal(new Set(approvals.map((approval) => approval.approvalId)).size, 20);
    const target = approvals[0].approvalId;
    const outcomes = await Promise.allSettled(
      [0, 1].map(() => Promise.resolve().then(() => assertWriteApproved(cfg, details, target))),
    );
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("registered parameter writes serialize read-plan-save sequences for one node", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-parameter-lock-"));
  try {
    const cfg = {
      ...config(stateDir),
      writeApprovalRequired: false,
      postWriteSettleMs: 0,
      postWriteReadyTimeoutSeconds: 1,
    };
    const tools = new Map();
    const node = { name: "Node", nodeBaseUrl: "http://127.0.0.1:8085/Node" };
    let parameters = { existing: true };
    const client = {
      resolveNode: async () => node,
      nodeRequest: async (_node, path, options = {}) => {
        if (path === "params") {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { node, response: structuredClone(parameters) };
        }
        if (path === "params/save") {
          parameters = structuredClone(options.body);
          return { node, response: { saved: true } };
        }
        throw new Error(`unexpected path ${path}`);
      },
    };
    registerNodeWriteTools(
      asServer({
        registerTool(name, _definition, handler) {
          tools.set(name, handler);
          return /** @type {import("@modelcontextprotocol/sdk/server/mcp.js").RegisteredTool} */ (
            /** @type {unknown} */ (undefined)
          );
        },
      }),
      asClient(client),
      cfg,
    );
    const setParameter = tools.get("nodel.set_node_parameter");
    await Promise.all([
      setParameter({ node: "Node", name: "first", value: 1, dryRun: false, waitForReady: false }),
      setParameter({ node: "Node", name: "second", value: 2, dryRun: false, waitForReady: false }),
    ]);
    assert.deepEqual(parameters, { existing: true, first: 1, second: 2 });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("audited mutation distinguishes post-side-effect and remote-plus-audit failures", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-audit-failure-"));
  try {
    const cfg = config(stateDir);
    const writes = [];
    await assert.rejects(
      auditedMutation(cfg, { operation: "x" }, async () => "remote-success", {
        write: (event) => {
          writes.push(event.outcome);
          if (event.outcome === "succeeded") throw new Error("success audit disk failure");
          return event.operationId ?? "operation-success";
        },
      }),
      /may have succeeded.*success audit disk failure/iu,
    );
    assert.deepEqual(writes, ["attempted", "succeeded"]);
    await assert.rejects(
      auditedMutation(
        cfg,
        { operation: "x" },
        async () => {
          throw new Error("remote broken");
        },
        {
          write: (event) => {
            if (event.outcome === "failed") throw new Error("failed audit disk failure");
            return event.operationId ?? "operation-failure";
          },
        },
      ),
      (error) =>
        error instanceof RemoteFailureAuditError && /remote broken.*failed audit disk failure/iu.test(error.message),
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("audit append and rotation use the injected state filesystem seam", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-audit-seam-"));
  const native = {
    appendFileSync,
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
  };
  try {
    const appendFailingStore = new StateStore(stateDir, {
      ...native,
      appendFileSync() {
        throw new Error("append denied");
      },
    });
    assert.throws(
      () => auditWrite(config(stateDir), { operation: "x" }, { store: appendFailingStore }),
      /append denied/u,
    );

    const rotatingStore = new StateStore(stateDir, {
      ...native,
      renameSync() {
        throw new Error("rotation rename denied");
      },
    });
    auditWrite(
      { ...config(stateDir), auditMaxBytes: 1 },
      { operation: "first" },
      { store: new StateStore(stateDir, native) },
    );
    assert.throws(
      () => auditWrite({ ...config(stateDir), auditMaxBytes: 1 }, { operation: "second" }, { store: rotatingStore }),
      /rotation rename denied/u,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("MCP bearer authentication accepts only a timing-safe exact match", () => {
  const middleware = requireBearerToken({ mcpToken: "a".repeat(32) });
  const response = () => ({
    statusCode: undefined,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
    },
  });
  let nextCalls = 0;
  middleware(asRequest({ header: () => `Bearer ${"a".repeat(32)}` }), asResponse(response()), () => {
    nextCalls += 1;
  });
  const rejected = response();
  middleware(asRequest({ header: () => `Bearer ${"a".repeat(31)}b` }), asResponse(rejected), () => {
    nextCalls += 1;
  });
  assert.equal(nextCalls, 1);
  assert.equal(rejected.statusCode, 401);
});

test("backup pruning retains every unresolved operation backup", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-retention-"));
  try {
    const cfg = { ...config(stateDir), backupRetentionPerNodeKind: 1 };
    const first = backupParameterState(cfg, "Node", { value: 1 }, "terminal", { uuid: () => "first" });
    auditWrite(cfg, { operation: "x", operationId: "terminal", outcome: "succeeded" });
    const second = backupParameterState(cfg, "Node", { value: 2 }, "pending-one", { uuid: () => "second" });
    const third = backupParameterState(cfg, "Node", { value: 3 }, "pending-two", { uuid: () => "third" });
    assert.equal(existsSync(first), false);
    assert.equal(existsSync(second), true);
    assert.equal(existsSync(third), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("backup pruning removes expired terminal backups before applying the fresh cap", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-retention-mixed-"));
  try {
    const highCap = { ...config(stateDir), backupRetentionPerNodeKind: 99, backupRetentionDays: 1 };
    const old = backupParameterState(highCap, "Node", { value: "old" }, "terminal-old");
    auditWrite(highCap, { operation: "x", operationId: "terminal-old", outcome: "succeeded" });
    const freshOne = backupParameterState(highCap, "Node", { value: "fresh-one" }, "terminal-one");
    auditWrite(highCap, { operation: "x", operationId: "terminal-one", outcome: "succeeded" });
    const freshTwo = backupParameterState(highCap, "Node", { value: "fresh-two" }, "terminal-two");
    auditWrite(highCap, { operation: "x", operationId: "terminal-two", outcome: "succeeded" });
    const unresolved = backupParameterState(highCap, "Node", { value: "unresolved" }, "unresolved");
    const oldDate = new Date(Date.now() - 2 * 86400000);
    utimesSync(old, oldDate, oldDate);

    backupParameterState({ ...highCap, backupRetentionPerNodeKind: 4 }, "Node", { value: "trigger" }, "trigger");
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(freshOne), true);
    assert.equal(existsSync(freshTwo), true);
    assert.equal(existsSync(unresolved), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("audit reader returns rotated and active logs chronologically and marks legacy attempts", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-audit-read-"));
  try {
    writeFileSync(
      join(stateDir, "audit.jsonl.2"),
      `${JSON.stringify({ operation: "old", node: "A" })}\nnot-json\n`,
      "utf8",
    );
    writeFileSync(
      join(stateDir, "audit.jsonl.1"),
      `${JSON.stringify({ version: 2, operation: "middle", operationId: "m", outcome: "succeeded" })}\n`,
      "utf8",
    );
    writeFileSync(
      join(stateDir, "audit.jsonl"),
      `${JSON.stringify({ version: 2, operation: "new", operationId: "n", outcome: "attempted" })}\n`,
      "utf8",
    );
    const result = listWriteAudit(config(stateDir), 10);
    assert.deepEqual(
      result.entries.map((entry) => entry.operation),
      ["old", "middle", "new"],
    );
    assert.equal(result.entries[0].outcome, "attempted");
    assert.equal(result.entries[0].operationId, undefined);
    assert.equal(result.entries[2].outcome, "attempted");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("synchronous audit rotation retains chronological active and rotated records", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-rotation-"));
  try {
    const cfg = { ...config(stateDir), auditMaxBytes: 1, auditRetentionFiles: 3 };
    auditWrite(cfg, { operation: "first", operationId: "first", outcome: "attempted" });
    auditWrite(cfg, { operation: "second", operationId: "second", outcome: "attempted" });
    auditWrite(cfg, { operation: "third", operationId: "third", outcome: "attempted" });
    assert.equal(existsSync(join(stateDir, "audit.jsonl.2")), true);
    assert.deepEqual(
      listWriteAudit(cfg, 10).entries.map((entry) => entry.operation),
      ["first", "second", "third"],
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("optional supporting-file reads treat only typed 404 as missing", async () => {
  const url = new URL("http://127.0.0.1:8085/REST/files/contents");
  const missing = {
    getNodeFileBytes: async () => {
      throw new NodelNotFoundError(url, "missing");
    },
  };
  const resolvedNode = /** @type {import("../dist/nodel/types.js").ResolvedNode} */ ({
    input: "Node",
    scope: "local",
    name: "Node",
    url: "http://node/",
    nodeBaseUrl: "http://node/",
    allowed: true,
  });
  assert.equal(await readOptionalNodeFileBytes(missing, resolvedNode, "content/file.txt"), undefined);
  for (const error of [
    new NodelHttpError(url, 401, "Unauthorized", "no"),
    new NodelHttpError(url, 500, "Error", "no"),
    new NodelTimeoutError(url, 1),
  ]) {
    await assert.rejects(
      readOptionalNodeFileBytes(
        {
          getNodeFileBytes: async () => {
            throw error;
          },
        },
        resolvedNode,
        "content/file.txt",
      ),
      (actual) => actual === error,
    );
  }
});

test("supporting-file proposal and save handlers only treat typed 404 reads as missing", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-file-handler-"));
  try {
    const url = new URL("http://127.0.0.1:8085/REST/files/contents");
    const node = { name: "Node", nodeBaseUrl: "http://127.0.0.1:8085/Node" };
    const run = async (readError) => {
      const tools = new Map();
      let saves = 0;
      const client = {
        resolveNode: async () => node,
        getNodeFileBytes: async () => {
          throw readError;
        },
        nodeRequest: async () => {
          saves += 1;
          return { node, response: { saved: true } };
        },
      };
      registerRecipeWriteTools(
        asServer({
          registerTool(name, _definition, handler) {
            tools.set(name, handler);
            return /** @type {import("@modelcontextprotocol/sdk/server/mcp.js").RegisteredTool} */ (
              /** @type {unknown} */ (undefined)
            );
          },
        }),
        asClient(client),
        { ...config(stateDir), writeApprovalRequired: false, postWriteSettleMs: 0, postWriteReadyTimeoutSeconds: 1 },
      );
      const proposal = await tools.get("nodel.propose_node_file_text")({
        node: "Node",
        path: "content/file.txt",
        content: "next",
      });
      const save = await tools.get("nodel.save_node_file_text")({
        node: "Node",
        path: "content/file.txt",
        content: "next",
        dryRun: false,
      });
      return { proposal, save, saves };
    };
    const missing = await run(new NodelNotFoundError(url, "missing"));
    assert.equal(missing.proposal.isError, undefined);
    assert.equal(missing.save.isError, undefined);
    assert.equal(missing.saves, 1);
    for (const error of [
      new NodelHttpError(url, 401, "Unauthorized", "no"),
      new NodelHttpError(url, 500, "Error", "no"),
      new NodelTimeoutError(url, 1),
    ]) {
      const result = await run(error);
      assert.equal(result.proposal.isError, true);
      assert.equal(result.save.isError, true);
      assert.equal(result.saves, 0);
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("state store aborts an atomic write when its filesystem seam fails", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-fault-"));
  try {
    const failingFs = {
      appendFileSync,
      chmodSync,
      closeSync,
      existsSync,
      fsyncSync,
      mkdirSync,
      openSync,
      readFileSync,
      readdirSync,
      renameSync,
      statSync,
      unlinkSync,
      writeFileSync() {
        throw new Error("simulated disk failure");
      },
    };
    const store = new StateStore(stateDir, failingFs);
    assert.throws(
      () => store.atomicWrite(join(stateDir, "state.json"), "value"),
      (error) => errorCode(error) === "STATE",
    );
    assert.equal(existsSync(join(stateDir, "state.json")), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("state filesystem seams fail closed for directory, fsync, rename, and lock-write failures", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-seams-"));
  const native = {
    appendFileSync,
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
  };
  try {
    assert.throws(
      () =>
        new StateStore(join(stateDir, "blocked"), {
          ...native,
          mkdirSync() {
            throw new Error("mkdir denied");
          },
        }).initialize(),
      (error) => errorCode(error) === "STATE",
    );
    assert.throws(
      () =>
        new StateStore(stateDir, {
          ...native,
          fsyncSync() {
            throw new Error("fsync denied");
          },
        }).atomicWrite(join(stateDir, "fsync.json"), "value"),
      (error) => errorCode(error) === "STATE",
    );
    assert.equal(existsSync(join(stateDir, "fsync.json")), false);
    assert.throws(
      () =>
        new StateStore(stateDir, {
          ...native,
          renameSync() {
            throw new Error("rename denied");
          },
        }).atomicWrite(join(stateDir, "rename.json"), "value"),
      (error) => errorCode(error) === "STATE",
    );
    assert.equal(existsSync(join(stateDir, "rename.json")), false);
    const lockStore = new StateStore(stateDir, {
      ...native,
      writeFileSync() {
        throw new Error("lock write denied");
      },
    });
    assert.throws(
      () => lockStore.acquireStartupLock(),
      (error) => errorCode(error) === "STATE",
    );
    assert.equal(existsSync(join(stateDir, ".instance.lock")), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("startup lock rejects live owners, recovers dead owners, protects recent malformed locks, and cleans up", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-lock-"));
  try {
    const runtime = { pid: 1234, uuid: () => "runtime-id", isProcessAlive: (pid) => pid === 1234 };
    const first = new StateStore(stateDir, undefined, undefined, runtime);
    first.acquireStartupLock();
    assert.throws(
      () => new StateStore(stateDir, undefined, undefined, { ...runtime, pid: 9999 }).acquireStartupLock(),
      /live PID 1234/u,
    );
    first.close();
    assert.equal(existsSync(join(stateDir, ".instance.lock")), false);

    writeFileSync(join(stateDir, ".instance.lock"), JSON.stringify({ version: 1, pid: 4567 }), "utf8");
    const recovered = new StateStore(stateDir, undefined, undefined, {
      pid: 9999,
      uuid: () => "recovered",
      isProcessAlive: () => false,
    });
    recovered.acquireStartupLock();
    assert.ok(
      readdirSync(stateDir).some((name) => name.includes(".instance.lock.stale-") && name.endsWith("-recovered")),
    );
    recovered.close();

    writeFileSync(join(stateDir, ".instance.lock"), "not-a-lock", "utf8");
    assert.throws(
      () =>
        new StateStore(stateDir, undefined, undefined, {
          pid: 9999,
          uuid: () => "recent",
          isProcessAlive: () => false,
        }).acquireStartupLock(),
      /recent malformed/u,
    );
    utimesSync(join(stateDir, ".instance.lock"), new Date(0), new Date(0));
    const malformed = new StateStore(stateDir, undefined, undefined, {
      pid: 9999,
      uuid: () => "malformed",
      isProcessAlive: () => false,
    });
    malformed.acquireStartupLock();
    malformed.close();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("listen failure releases the startup lock", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-state-listen-"));
  const blocker = createServer();
  try {
    blocker.listen(0, "127.0.0.1");
    await once(blocker, "listening");
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("Blocker did not expose an address");
    const port = address.port;
    await assert.rejects(
      startHttpServer(createTestConfig({ stateDir, mcpPort: port })),
      (error) => errorCode(error) === "EADDRINUSE",
    );
    assert.equal(existsSync(join(stateDir, ".instance.lock")), false);
    stateStore(stateDir).acquireStartupLock();
    stateStore(stateDir).close();
  } finally {
    blocker.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
