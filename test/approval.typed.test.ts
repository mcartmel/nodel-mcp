import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { completeTestConfig } from "./fixtures/config.js";
import { approvalRequest, approveWrite, assertWriteApproved, validateApprovalInput } from "../src/state/approvals.js";
import { requestWriteApproval } from "../src/mcp/tools/approvals.js";
import { StateStore } from "../src/state/store.js";

void test("approval ids persist, match complete details, and are single-use", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-typed-approval-"));
  try {
    const config = completeTestConfig({ stateDir, writesEnabled: true, writeApprovalRequired: true });
    const details = {
      operation: "create_node",
      target: "Example 4",
      proposalHash: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    };
    const request = approvalRequest(config, details);
    const approval = approveWrite(config, details, request.confirmText, "unit test", "node:test");
    assert.ok(approval.approvalId);
    assert.match(readFileSync(join(stateDir, "approvals.json"), "utf8"), /create_node/u);
    assert.doesNotThrow(() => assertWriteApproved(config, details, approval.approvalId));
    assert.throws(() => assertWriteApproved(config, details, approval.approvalId), /not found|expired/u);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

void test("approval rejects mismatched confirmation text", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-typed-approval-"));
  try {
    assert.throws(
      () =>
        approveWrite(
          completeTestConfig({ stateDir, writesEnabled: true, writeApprovalRequired: true }),
          {
            operation: "x",
            target: "y",
            proposalHash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          },
          "APPROVE nope",
        ),
      /confirmation mismatch/u,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

const nativeDetails = {
  operation: "create_node",
  target: "Native example",
  proposalHash: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
};

void test("native approval persists compatible v2 state and binds operation, exact target, and full hash", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-typed-native-"));
  try {
    const config = completeTestConfig({ stateDir, writesEnabled: true, writeApprovalRequired: true });
    const request = approvalRequest(config, nativeDetails);
    const approval = await requestWriteApproval(
      config,
      async () => ({ action: "accept", content: { approved: true } }),
      { ...nativeDetails, confirmText: request.confirmText, summary: "Create a test node; no runtime is called." },
    );
    assert.ok("approvalId" in approval);
    assert.equal(approval.outcome, "approved");
    const envelope = JSON.parse(readFileSync(join(stateDir, "approvals.json"), "utf8")) as {
      version: number;
      approvals: Array<Record<string, unknown>>;
    };
    assert.equal(envelope.version, 2);
    assert.equal(envelope.approvals.length, 1);
    assert.equal(envelope.approvals[0].proposalHash, nativeDetails.proposalHash);
    assert.equal("summary" in envelope.approvals[0], false);

    const independentStore = new StateStore(stateDir);
    for (const mismatch of [
      { operation: "delete_node" },
      { target: "Native Example" },
      { target: `${nativeDetails.target} ` },
      // Same 12-character confirmation prefix, different full proposal hash.
      { proposalHash: `${nativeDetails.proposalHash.slice(0, 63)}e` },
    ]) {
      assert.throws(
        () =>
          assertWriteApproved(config, { ...nativeDetails, ...mismatch }, approval.approvalId, {
            store: independentStore,
          }),
        { code: "CONFLICT" },
      );
    }
    // Matching failures must not consume the valid id; the independent reader uses
    // exactly the existing persisted-state loader, without a native-only record type.
    assert.doesNotThrow(() =>
      assertWriteApproved(config, nativeDetails, approval.approvalId, { store: independentStore }),
    );
    assert.throws(() => assertWriteApproved(config, nativeDetails, approval.approvalId), { code: "APPROVAL_REQUIRED" });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

void test("native approval expires at the exact configured TTL boundary", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-typed-native-"));
  try {
    const config = completeTestConfig({
      stateDir,
      writesEnabled: true,
      writeApprovalRequired: true,
      writeApprovalTtlSeconds: 60,
    });
    const approval = await requestWriteApproval(
      config,
      async () => ({ action: "accept", content: { approved: true } }),
      { ...nativeDetails, confirmText: approvalRequest(config, nativeDetails).confirmText },
    );
    assert.ok("approvalId" in approval);
    const envelope = JSON.parse(readFileSync(join(stateDir, "approvals.json"), "utf8")) as {
      approvals: Array<{ createdAt: string; expiresAt: string }>;
    };
    assert.equal(Date.parse(approval.expiresAt) - Date.parse(envelope.approvals[0].createdAt), 60000);
    assert.throws(
      () =>
        assertWriteApproved(config, nativeDetails, approval.approvalId, { now: () => new Date(approval.expiresAt) }),
      { code: "APPROVAL_REQUIRED" },
    );
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir, "approvals.json"), "utf8")), { version: 2, approvals: [] });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

void test("approval validation is side-effect-free and manual approval repeats all essential preflight checks", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-typed-native-"));
  try {
    const config = completeTestConfig({ stateDir, writesEnabled: true, writeApprovalRequired: true });
    const confirmText = approvalRequest(config, nativeDetails).confirmText;
    assert.doesNotThrow(() => validateApprovalInput(nativeDetails, confirmText));
    for (const invalid of [
      { operation: " " },
      { proposalHash: `${nativeDetails.proposalHash}\n` },
      { proposalHash: "bad hash" },
      { target: "Bearer credential" },
    ]) {
      assert.throws(() => validateApprovalInput({ ...nativeDetails, ...invalid }, confirmText), { code: "VALIDATION" });
      assert.throws(() => approveWrite(config, { ...nativeDetails, ...invalid }, confirmText), { code: "VALIDATION" });
    }
    assert.throws(() => validateApprovalInput(nativeDetails, `${confirmText} `), { code: "APPROVAL_REQUIRED" });
    assert.throws(() => validateApprovalInput(nativeDetails, confirmText, "Bearer credential"), { code: "VALIDATION" });
    assert.throws(() => approveWrite(config, nativeDetails, confirmText, undefined, "Bearer credential"), {
      code: "VALIDATION",
    });
    assert.equal(existsSync(join(stateDir, "approvals.json")), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

void test("manual approvals retain exact-name compatibility independently of native display restrictions", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "nodel-ai-typed-manual-"));
  try {
    const config = completeTestConfig({ stateDir, writesEnabled: true, writeApprovalRequired: true });
    for (const target of ["Room 👩‍💻", " Room ", "Room\u034f", "Room\nlegacy"]) {
      const details = { ...nativeDetails, target };
      const confirmText = approvalRequest(config, details).confirmText;
      assert.doesNotThrow(() => validateApprovalInput(details, confirmText));
      const approval = approveWrite(config, details, confirmText);
      assert.equal(approval.target, target);
      assert.doesNotThrow(() => assertWriteApproved(config, details, approval.approvalId));
      assert.throws(() => assertWriteApproved(config, details, approval.approvalId), { code: "APPROVAL_REQUIRED" });
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
