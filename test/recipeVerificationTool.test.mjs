import assert from "node:assert/strict";
import test from "node:test";
import { registerRecipeWriteTools } from "../dist/mcp/tools/recipeWrites.js";
import { createTestConfig } from "../dist/config.js";

const resolved = {
  input: "Demo",
  scope: "local",
  name: "Demo",
  url: "http://node/",
  nodeBaseUrl: "http://node/",
  allowed: true,
};

test("verify_recipe_script reports the selected dependency path", async () => {
  const tool = registeredTools().get("nodel.verify_recipe_script");
  const result = await tool.handler({
    node: "Demo",
    path: "custom.py",
    script: "value = 1\n",
    verifyComposedRecipe: false,
  });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(result.isError, undefined);
  assert.equal(payload.path, "custom.py");
  assert.equal(payload.recipeVerification.path, "custom.py");
  assert.equal(payload.staticAnalysisOnly, true);
});

test("verify_recipe_script rejects non-Python paths", async () => {
  const tool = registeredTools().get("nodel.verify_recipe_script");
  const result = await tool.handler({
    node: "Demo",
    path: "content/config.json",
    script: "{}",
    verifyComposedRecipe: false,
  });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(result.isError, true);
  assert.match(payload.error.message, /must end with \.py/u);
});

function registeredTools() {
  const tools = new Map();
  registerRecipeWriteTools(
    asServer({
      registerTool(name, config, handler) {
        tools.set(name, { config, handler });
        return /** @type {import("@modelcontextprotocol/sdk/server/mcp.js").RegisteredTool} */ (
          /** @type {unknown} */ (undefined)
        );
      },
    }),
    asClient({ resolveNode: async () => resolved }),
    config(),
  );
  return tools;
}

/** @param {unknown} value @returns {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} */
function asServer(value) {
  return /** @type {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} */ (/** @type {unknown} */ (value));
}

/** @param {unknown} value @returns {import("../dist/nodel/client.js").NodelClient} */
function asClient(value) {
  return /** @type {import("../dist/nodel/client.js").NodelClient} */ (/** @type {unknown} */ (value));
}

function config() {
  return createTestConfig({
    nodelBaseUrl: "http://127.0.0.1:8086",
    writesEnabled: false,
    nodeLifecycleEnabled: false,
    deletesEnabled: false,
    writeApprovalRequired: true,
    writeApprovalTtlSeconds: 600,
    postWriteSettleMs: 3000,
    postWriteReadyTimeoutSeconds: 20,
    nodelRequestTimeoutMs: 1000,
    publicRecipeRequestTimeoutMs: 1000,
  });
}
