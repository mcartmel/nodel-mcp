import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { classifyToolError, toolResult } from "../dist/mcp/tools/common.js";
import {
  NodelHttpError,
  NodelInvalidJsonError,
  NodelNotFoundError,
  NodelRedirectError,
  NodelTimeoutError,
} from "../dist/nodel/http/errors.js";
import { PostSideEffectAuditError } from "../dist/state/audit.js";
import { PublicError, sanitizeSensitiveMessage } from "../dist/shared/publicErrors.js";
import { createTestConfig } from "../dist/config.js";

test("tool results use the stable success and error envelope", async () => {
  const success = await toolResult(async () => ({ nested: { ok: false, body: "unchanged" } }));
  assert.deepEqual(JSON.parse(success.content[0].text), { ok: true, nested: { ok: false, body: "unchanged" } });
  const semantic = await toolResult(async () => ({ ok: false, error: "Nodel unavailable", resultOk: "overwritten" }));
  assert.deepEqual(JSON.parse(semantic.content[0].text), { ok: true, error: "Nodel unavailable", resultOk: false });

  const failure = await toolResult(async () => {
    throw new PublicError("VALIDATION", "invalid input");
  });
  const payload = JSON.parse(failure.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "VALIDATION");
  assert.equal(payload.error.retryable, false);
  assert.equal(failure.isError, true);
  assert.doesNotMatch(payload.error.message, /stack|at /iu);
});

test("domain result ok fields become resultOk without changing tool success", async () => {
  for (const value of [
    { ok: false, nodel: { ok: false } },
    { ok: false, issues: ["invalid"] },
    { ok: false, warnings: ["check"] },
    { ok: false, ready: false },
    { ok: false, fallback: true },
  ]) {
    const result = await toolResult(async () => value);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.resultOk, false);
    assert.equal(result.isError, undefined);
  }
});

test("typed public errors and Nodel errors have stable mappings", () => {
  assert.deepEqual(classifyToolError(new PublicError("VALIDATION", "bad input")), {
    code: "VALIDATION",
    message: "bad input",
    retryable: false,
  });
  assert.deepEqual(classifyToolError(new PublicError("CONFLICT", "stale hash")), {
    code: "CONFLICT",
    message: "stale hash",
    retryable: false,
  });
  assert.deepEqual(classifyToolError(new PublicError("APPROVAL_REQUIRED", "approve first")), {
    code: "APPROVAL_REQUIRED",
    message: "approve first",
    retryable: false,
  });
  assert.deepEqual(classifyToolError(new PublicError("STATE", "state unavailable")), {
    code: "STATE",
    message: "state unavailable",
    retryable: false,
  });
  const url = new URL("http://user:password@example.test/REST");
  assert.equal(classifyToolError(new NodelNotFoundError(url, "Bearer sidecar-secret")).code, "NODEL_NOT_FOUND");
  assert.equal(
    classifyToolError(new NodelHttpError(url, 401, "Unauthorized", "password=remote-secret")).retryable,
    false,
  );
  assert.equal(
    classifyToolError(new NodelHttpError(url, 500, "Server Error", "token=remote-secret")).ambiguous,
    undefined,
  );
  assert.equal(
    classifyToolError(new NodelInvalidJsonError(url, "Bearer remote-secret", new Error("parse"))).ambiguous,
    undefined,
  );
  assert.equal(classifyToolError(new NodelTimeoutError(url, 100)).ambiguous, undefined);
  assert.equal(classifyToolError(new NodelRedirectError(url, "redirect")).ambiguous, undefined);
  assert.deepEqual(classifyToolError(new Error("unexpected failure")), {
    code: "INTERNAL",
    message: "unexpected failure",
    retryable: false,
  });
});

test("sensitive messages are sanitized in generic and typed paths", () => {
  const text = sanitizeSensitiveMessage(
    "Bearer sidecar-secret authorization=abc password=remote-secret http://user:pass@example.test/x\nraw body secret",
  );
  assert.doesNotMatch(text, /sidecar-secret|remote-secret|user:pass|raw body/iu);
  assert.match(text, /redacted/iu);
  const typed = classifyToolError(new PublicError("VALIDATION", "Bearer sidecar-secret password=remote-secret"));
  assert.doesNotMatch(typed.message, /sidecar-secret|remote-secret/iu);
  const generic = classifyToolError(new Error("Bearer sidecar-secret\nremote body password=remote-secret"));
  assert.doesNotMatch(generic.message, /sidecar-secret|remote-secret|remote body/iu);
});

test("typed transport and post-side-effect audit failures preserve distinct status", () => {
  const timeout = classifyToolError(new NodelTimeoutError(new URL("http://127.0.0.1/REST"), 100));
  assert.deepEqual(timeout, { code: "NODEL_TIMEOUT", message: timeout.message, retryable: true });
  const audit = classifyToolError(new PostSideEffectAuditError("op-1", new Error("disk failure")));
  assert.deepEqual(audit, {
    code: "AUDIT_POST_SIDE_EFFECT",
    message: audit.message,
    retryable: false,
    ambiguous: true,
    operationId: "op-1",
    status: "succeeded_audit_failed",
  });
});

test("create_node public schema does not accept removed ignored fields", async () => {
  const { collectToolSpecs } = await import("../dist/mcp/registry/toolRegistry.js");
  const spec = collectToolSpecs(
    createTestConfig({ writesEnabled: true, nodeLifecycleEnabled: true, deletesEnabled: true }),
  ).find((entry) => entry.name === "nodel.create_node");
  assert.ok(spec);
  assert.deepEqual(Object.keys(spec.jsonInputSchema.properties).sort(), [
    "approvalId",
    "dryRun",
    "name",
    "reason",
    "runtimeUrl",
  ]);
  assert.equal(spec.jsonInputSchema.additionalProperties, false);
});

test("every registered public tool has a documented stable schema", async () => {
  const { collectToolSpecs } = await import("../dist/mcp/registry/toolRegistry.js");
  const specs = collectToolSpecs(
    createTestConfig({ writesEnabled: true, nodeLifecycleEnabled: true, deletesEnabled: true }),
  );
  const reference = await readFile(new URL("../docs/tool-reference.generated.md", import.meta.url), "utf8");
  assert.equal(new Set(specs.map((spec) => spec.name)).size, specs.length);
  for (const spec of specs) {
    assert.ok(reference.includes(`| \`${spec.name}\` | ${spec.capability} | ${spec.stability} | ${spec.gate} |`));
    const row = reference.split("\n").find((line) => line.includes(`| \`${spec.name}\` |`)) ?? "";
    assert.ok(reference.includes(`### \`${spec.name}\``), `${spec.name} is missing its schema section`);
    for (const field of Object.keys(spec.jsonInputSchema.properties ?? {}))
      assert.ok(reference.includes(`"${field}"`), `${spec.name} is missing schema field ${field}`);
  }
});
