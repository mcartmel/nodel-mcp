import assert from "node:assert/strict";
import test from "node:test";
import { filterDefinitions } from "../dist/mcp/tools/pointFiltering.js";
import { registerNodeWriteTools } from "../dist/mcp/tools/nodeWrites.js";
import { registerRecipeWriteTools } from "../dist/mcp/tools/recipeWrites.js";
import { registerUiTools } from "../dist/mcp/tools/ui.js";
import { registerRecipeReadTools } from "../dist/mcp/tools/recipeReads.js";
import { createTestConfig } from "../dist/config.js";

function toolsFor(register, client = {}) {
  const tools = new Map();
  register(
    {
      registerTool(name, _definition, handler) {
        tools.set(name, handler);
      },
    },
    client,
    config(),
  );
  return tools;
}

function config() {
  return createTestConfig({
    writesEnabled: false,
    writeApprovalRequired: true,
    nodeLifecycleEnabled: false,
    deletesEnabled: false,
    publicRecipeRequestTimeoutMs: 1000,
    stateDir: ".state",
  });
}

/** @param {unknown} error @returns {string | undefined} */
function errorCode(error) {
  return /** @type {{ code?: string }} */ (/** @type {unknown} */ (error)).code;
}

test("invalid action and signal names map to VALIDATION", async () => {
  const client = {
    getNodeActions: async () => ({ node: { name: "Demo" }, actions: [{ name: "known" }] }),
    getNodeSignals: async () => ({ node: { name: "Demo" }, signals: [{ name: "known" }] }),
  };
  const tools = toolsFor(registerNodeWriteTools, client);
  for (const [name, input] of [["nodel.read_signal", { node: "Demo", signal: "missing" }]]) {
    const result = await tools.get(name)(input);
    assert.equal(JSON.parse(result.content[0].text).error.code, "VALIDATION");
  }
});

test("invalid UI component and path map to VALIDATION", async () => {
  const tools = toolsFor(registerUiTools);
  const component = await tools.get("nodel.get_ui_component_reference")({ components: ["not-a-component"] });
  assert.equal(JSON.parse(component.content[0].text).error.code, "VALIDATION");
  const verify = await tools.get("nodel.verify_ui_file")({ node: "Demo", path: "content/index.json", content: "{}" });
  assert.equal(JSON.parse(verify.content[0].text).error.code, "VALIDATION");
});

test("invalid recipe path maps to VALIDATION", async () => {
  const tools = toolsFor(registerRecipeWriteTools, { resolveNode: async () => ({ name: "Demo" }) });
  const result = await tools.get("nodel.verify_recipe_script")({
    node: "Demo",
    path: "content/index.json",
    script: "{}",
  });
  assert.equal(JSON.parse(result.content[0].text).error.code, "VALIDATION");
});

test("invalid point filters map to VALIDATION", () => {
  assert.throws(
    () => filterDefinitions({ known: {} }, { names: ["known"], filter: "known" }),
    (error) => errorCode(error) === "VALIDATION",
  );
  assert.throws(
    () => filterDefinitions({ known: {} }, { filter: "(" }),
    (error) => errorCode(error) === "VALIDATION",
  );
});

test("public recipe fetch errors exclude arbitrary response bodies", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("private remote body secret=do-not-leak", { status: 500, statusText: "Upstream Failure" });
  try {
    const tools = toolsFor(registerRecipeReadTools);
    const result = await tools.get("nodel.list_public_recipes")({ filter: "", limit: 10, includeRetired: false });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.error.code, "REMOTE");
    assert.doesNotMatch(payload.error.message, /private remote body|do-not-leak/iu);
    assert.match(payload.error.message, /500|Upstream Failure/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public recipe timeout includes a body that stalls after response headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          init.signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        },
      }),
      { status: 200 },
    );
  try {
    const tools = toolsFor(registerRecipeReadTools, {});
    const result = await tools.get("nodel.list_public_recipes")({ filter: "", limit: 10, includeRetired: false });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.error.code, "REMOTE");
    assert.equal(payload.error.retryable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
