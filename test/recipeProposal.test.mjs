import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSupportingFilePath,
  nodeFileSaveRequest,
  normalizeBase64Content,
  normalizeRecipeScript,
  normalizeTextContent,
  recipeScriptSaveRequest,
} from "../dist/mcp/tools/recipeWrites.js";
import {
  normalizeRecipeScript as normalizeRecipeScriptInDomain,
  proposeRecipeScript,
} from "../dist/domain/recipes/service.js";
import { createTestConfig } from "../dist/config.js";

/** @param {unknown} value @returns {import("../dist/nodel/client.js").NodelClient} */
function asClient(value) {
  return /** @type {import("../dist/nodel/client.js").NodelClient} */ (/** @type {unknown} */ (value));
}

const VALID_SCRIPT = "NAME = 'demo'\n";

test("recipeScriptSaveRequest always uses script/save JSON body", () => {
  const request = recipeScriptSaveRequest(VALID_SCRIPT);

  assert.equal(request.restPath, "script/save");
  assert.equal(request.method, "POST");
  assert.equal(request.headers["content-type"], "application/json");
  assert.deepEqual(request.body, { script: VALID_SCRIPT });
});

test("nodeFileSaveRequest uses files/save with raw bytes", () => {
  const bytes = new Uint8Array([0, 1, 2, 3]);
  const request = nodeFileSaveRequest("content/logo.png", bytes);

  assert.equal(request.restPath, "files/save?path=content%2Flogo.png");
  assert.equal(request.method, "POST");
  assert.equal(request.headers["content-type"], "application/octet-stream");
  assert.equal(request.body, bytes);
});

test("nodeFileSaveRequest rejects script.py", () => {
  assert.throws(() => nodeFileSaveRequest("script.py", new Uint8Array()), /recipe script tools/u);
});

test("assertSupportingFilePath accepts safe supporting paths", () => {
  assert.equal(assertSupportingFilePath("content/table.html"), "content/table.html");
});

test("assertSupportingFilePath rejects traversal and script.py", () => {
  assert.throws(() => assertSupportingFilePath("../script.py"), /parent-directory/u);
  assert.throws(() => assertSupportingFilePath("script.py"), /recipe script tools/u);
});

test("normalizeTextContent returns UTF-8 bytes without recipe validation", () => {
  const normalized = normalizeTextContent("<main></main>\n");

  assert.equal(normalized.mode, "text");
  assert.equal(normalized.text, "<main></main>\n");
  assert.equal(normalized.byteLength, 14);
  assert.equal(Object.hasOwn(normalized, "recipeVerification"), false);
});

test("normalizeBase64Content returns raw bytes and allows zero-byte content", () => {
  const normalized = normalizeBase64Content("AAECAw==");
  const empty = normalizeBase64Content("");

  assert.equal(normalized.mode, "base64");
  assert.deepEqual([...normalized.bytes], [0, 1, 2, 3]);
  assert.equal(empty.byteLength, 0);
});

test("normalizeRecipeScript runs recipe validation", () => {
  const normalized = normalizeRecipeScript(VALID_SCRIPT);

  assert.equal(normalized.mode, "text");
  assert.equal(normalized.script, VALID_SCRIPT);
  assert.equal(normalized.recipeVerification.ok, true);
  assert.equal(normalizeRecipeScript, normalizeRecipeScriptInDomain);
});

test("domain recipe proposal owns hashes and approval-ready plan construction", async () => {
  const plan = await proposeRecipeScript(
    asClient({
      resolveNode: async () => ({
        input: "Demo",
        scope: "local",
        name: "Demo",
        url: "http://localhost/nodes/Demo/",
        nodeBaseUrl: "http://localhost/nodes/Demo/",
        allowed: true,
      }),
      getNodeFileContents: async () => VALID_SCRIPT,
    }),
    createTestConfig({ writesEnabled: false, writeApprovalRequired: false }),
    "Demo",
    "NAME = 'next'\n",
  );

  assert.equal(plan.operation, "save_recipe_script");
  assert.equal(plan.path, "script.py");
  assert.notEqual(plan.currentHash, plan.nextHash);
  assert.equal(plan.approvalReady, true);
});

test("supporting Python-like files are not recipe-validated", () => {
  const normalized = normalizeTextContent("def invalid_py3(arg: str):\n    pass\n");

  assert.equal(Object.hasOwn(normalized, "recipeVerification"), false);
});
