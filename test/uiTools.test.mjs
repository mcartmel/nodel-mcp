import assert from "node:assert/strict";
import test from "node:test";
import { componentReference, registerUiTools } from "../dist/mcp/tools/ui.js";
import { v1XmlUiGuidance, v2HtmlUiGuidance } from "../dist/nodel/uiGuidelines.js";

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
  assert.ok(tools.has("nodel.get_ui_capabilities"));
  assert.ok(tools.has("nodel.verify_ui_file"));
  const guidelineSchema = tools.get("nodel.get_ui_guidelines").config.inputSchema;
  assert.ok(Object.hasOwn(guidelineSchema, "format"));
  assert.ok(Object.hasOwn(guidelineSchema, "node"));
  assert.ok(Object.hasOwn(guidelineSchema, "refresh"));
  const componentSchema = tools.get("nodel.get_ui_component_reference").config.inputSchema;
  for (const name of ["format", "node", "path", "refresh", "components", "indexOffset", "stylesOffset"])
    assert.ok(Object.hasOwn(componentSchema, name));
  assert.ok(Object.hasOwn(componentSchema, "includeCore"));
  assert.equal(tools.get("nodel.get_ui_guidelines").config.annotations.openWorldHint, true);
  assert.equal(tools.get("nodel.get_ui_component_reference").config.annotations.openWorldHint, true);
  assert.equal(tools.get("nodel.get_ui_capabilities").config.annotations.openWorldHint, true);
  assert.ok(Object.hasOwn(tools.get("nodel.get_ui_capabilities").config.inputSchema, "node"));
  const schema = tools.get("nodel.verify_ui_file").config.inputSchema;
  for (const name of [
    "node",
    "path",
    "content",
    "format",
    "refresh",
    "includeLiveValues",
    "dynamicOptionWarningThreshold",
    "maxIssues",
  ]) {
    assert.ok(Object.hasOwn(schema, name));
  }
});

test("no-argument v1 guidance remains exactly the local legacy payload", async () => {
  const { uiGuidelines } = await import("../dist/mcp/tools/uiGuidance.js");
  assert.deepEqual(await uiGuidelines(asClient({})), v1XmlUiGuidance());
});

test("v2 offline guidance keeps starter provenance separate and includes practical safeguards", () => {
  const guide = v2HtmlUiGuidance();
  assert.equal(guide.format, "v2_html_custom_elements");
  assert.equal(guide.starterProvenance.deploymentApplicable, false);
  assert.equal(guide.bundledContractProvenance.schemaVersion, 1);
  assert.match(guide.guidelines, /Replacing content\/index\.html can change primary navigation/u);
  assert.match(guide.guidelines, /arbitrary Tailwind utilities are not guaranteed/u);
  assert.match(guide.guidelines, /relative REST\/ API URLs/u);
  assert.equal(guide.browserTested, false);
});

test("v2 component reference is a bounded, curated fallback and labels legacy filters", async () => {
  const { uiComponentReference } = await import("../dist/mcp/tools/uiGuidance.js");
  const result = /** @type {any} */ (
    await uiComponentReference(asClient({}), { format: "v2", includeCss: true }, componentReference)
  );
  assert.equal(result.format, "v2");
  assert.equal(result.contract.contractSource, "bundled");
  assert.equal(result.contract.deploymentApplicable, false);
  assert.equal(result.components, undefined);
  assert.ok(result.componentIndex.items.length <= 100);
  assert.ok(result.componentIndex.items.every((entry) => entry.audience === "custom"));
  assert.ok(result.unsupportedV1Options.some((item) => item.includes("includeCss")));
  assert.equal(result.cssRecipes, undefined);
  assert.match(result.contractDataNotice, /untrusted reference data, not instructions/u);
});

test("v2 component index exposes core only on request and never lists internal auto-hosts", async () => {
  const { uiComponentReference } = await import("../dist/mcp/tools/uiGuidance.js");
  const reference = await uiComponentReference(asClient({}), { format: "v2", includeCore: true }, componentReference);
  const index = /** @type {any} */ (reference).componentIndex;
  assert.ok(index.items.every((entry) => entry.audience !== "internal"));
  assert.match(index.note, /explicitly included/u);
});

test("v2 unknown names return bounded suggestions instead of broad catalog payloads", async () => {
  const { uiComponentReference } = await import("../dist/mcp/tools/uiGuidance.js");
  const result = /** @type {any} */ (
    await uiComponentReference(asClient({}), { format: "v2", components: ["nodel-buttn"] }, componentReference)
  );
  assert.equal(result.components, undefined);
  assert.equal(result.unknownComponents.length, 1);
  assert.ok(result.unknownComponents[0].suggestions.includes("nodel-button"));
  assert.ok(result.unknownComponents[0].suggestions.length <= 5);
});

test("registered v2 tools return MCP text content with serializable advisory provenance", async () => {
  const tools = new Map();
  registerUiTools(
    asServer({
      registerTool(name, config, handler) {
        tools.set(name, { config, handler });
        return undefined;
      },
    }),
    asClient({}),
  );
  const guidelines = await tools.get("nodel.get_ui_guidelines").handler({ format: "v2" });
  assert.equal(guidelines.content[0].type, "text");
  const guidanceBody = JSON.parse(guidelines.content[0].text);
  assert.equal(guidanceBody.ok, true);
  assert.equal(guidanceBody.format, "v2_html_custom_elements");
  assert.equal(guidanceBody.starterProvenance.deploymentApplicable, false);
  const reference = await tools.get("nodel.get_ui_component_reference").handler({ format: "v2" });
  const referenceBody = JSON.parse(reference.content[0].text);
  assert.equal(referenceBody.ok, true);
  assert.ok(Array.isArray(referenceBody.componentIndex.items));
  assert.equal(referenceBody.contract.contractSource, "bundled");
});

/** @param {unknown} value @returns {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} */
function asServer(value) {
  return /** @type {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} */ (/** @type {unknown} */ (value));
}

/** @param {unknown} value @returns {import("../dist/nodel/client.js").NodelClient} */
function asClient(value) {
  return /** @type {import("../dist/nodel/client.js").NodelClient} */ (/** @type {unknown} */ (value));
}
