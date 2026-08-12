import assert from "node:assert/strict";
import test from "node:test";
import {
  destructiveWriteToolAnnotations,
  localReadOnlyToolAnnotations,
  proposalToolAnnotations,
  remoteReadOnlyToolAnnotations,
  writeToolAnnotations,
} from "../dist/mcp/toolAnnotations.js";

test("read-only annotation presets identify non-destructive tools", () => {
  for (const annotations of [localReadOnlyToolAnnotations, remoteReadOnlyToolAnnotations, proposalToolAnnotations]) {
    assert.equal(annotations.readOnlyHint, true);
    assert.equal(annotations.destructiveHint, false);
    assert.equal(annotations.idempotentHint, true);
  }
});

test("write annotation presets identify destructive non-idempotent tools", () => {
  for (const annotations of [writeToolAnnotations, destructiveWriteToolAnnotations]) {
    assert.equal(annotations.readOnlyHint, false);
    assert.equal(annotations.destructiveHint, true);
    assert.equal(annotations.idempotentHint, false);
  }
});
