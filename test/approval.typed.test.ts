import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { completeTestConfig } from "./fixtures/config.js";
import { approvalRequest, approveWrite, assertWriteApproved } from "../src/state/approvals.js";

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
