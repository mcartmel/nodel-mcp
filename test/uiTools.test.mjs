import assert from "node:assert/strict";
import test from "node:test";
import { componentReference, registerUiTools } from "../dist/mcp/tools/ui.js";

test("component reference returns an index by default", () => {
  const result = componentReference(undefined);

  assert.ok(result.componentIndex.some((entry) => entry.name === "meter"));
  assert.equal(result.components, undefined);
});

test("component reference filters exact component details", () => {
  const result = componentReference(["meter"], true, true, true, ["meter-number-reposition"]);

  assert.equal(result.components.length, 1);
  assert.equal(result.components[0].name, "meter");
  assert.ok(result.components[0].markup.significantDescendants.some((entry) => /p/u.test(entry)));
  assert.equal(result.cssRecipes[0].name, "meter-number-reposition");
});

test("component reference rejects unknown names with suggestions", () => {
  assert.throws(() => componentReference(["metre"]), /Suggestions: meter/u);
});

test("UI tools are registered with saved and proposed validation inputs", () => {
  const tools = new Map();
  registerUiTools(
    asServer({
      registerTool(name, config, handler) {
        tools.set(name, { config, handler });
        return /** @type {import("@modelcontextprotocol/sdk/server/mcp.js").RegisteredTool} */ (
          /** @type {unknown} */ (undefined)
        );
      },
    }),
    asClient({}),
  );

  assert.ok(tools.has("nodel.get_ui_guidelines"));
  assert.ok(tools.has("nodel.get_ui_component_reference"));
  assert.ok(tools.has("nodel.verify_ui_file"));
  const schema = tools.get("nodel.verify_ui_file").config.inputSchema;
  for (const name of ["node", "path", "content", "includeLiveValues", "dynamicOptionWarningThreshold", "maxIssues"]) {
    assert.ok(Object.hasOwn(schema, name));
  }
});

/** @param {unknown} value @returns {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} */
function asServer(value) {
  return /** @type {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} */ (/** @type {unknown} */ (value));
}

/** @param {unknown} value @returns {import("../dist/nodel/client.js").NodelClient} */
function asClient(value) {
  return /** @type {import("../dist/nodel/client.js").NodelClient} */ (/** @type {unknown} */ (value));
}
