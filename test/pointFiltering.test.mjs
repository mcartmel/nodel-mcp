import assert from "node:assert/strict";
import test from "node:test";
import { compileSafeFilterRegex, filterDefinitions } from "../dist/mcp/tools/pointFiltering.js";
import { registerNodeReadTools } from "../dist/mcp/tools/nodeReads.js";

const node = {
  input: "Demo",
  scope: "local",
  name: "Demo",
  url: "http://node",
  nodeBaseUrl: "http://node",
  allowed: true,
};

test("point filters match definition names case-insensitively by default", () => {
  const result = filterDefinitions(
    {
      Play: { title: "Play", group: "transport" },
      Stop: { title: "Stop", group: "transport" },
    },
    { names: ["play"] },
  );

  assert.equal(result.totalCount, 2);
  assert.equal(result.matchedCount, 1);
  assert.deepEqual(Object.keys(result.value), ["Play"]);
  assert.deepEqual(
    result.summaries.map((summary) => summary.name),
    ["Play"],
  );
});

test("point filters support case-sensitive matching", () => {
  const result = filterDefinitions({ Play: { title: "Play" } }, { names: ["play"], caseSensitive: true });

  assert.equal(result.totalCount, 1);
  assert.equal(result.matchedCount, 0);
  assert.deepEqual(result.value, {});
});

test("point filters preserve array API forms and can return no matches", () => {
  const source = [
    { name: "Play", title: "Play" },
    { name: "Stop", title: "Stop" },
  ];
  const matched = filterDefinitions(source, { filter: "^stop$" });
  const empty = filterDefinitions(source, { names: ["Missing"] });

  assert.ok(Array.isArray(matched.value));
  assert.deepEqual(
    matched.value.map((entry) => entry.name),
    ["Stop"],
  );
  assert.equal(empty.totalCount, 2);
  assert.equal(empty.matchedCount, 0);
  assert.deepEqual(empty.value, []);
});

test("filter regular expressions reject unsafe forms without dependencies", () => {
  assert.equal(compileSafeFilterRegex("play|stop")?.test("Play"), true);
  assert.throws(() => compileSafeFilterRegex("(a+)++"), /quantified groups/u);
  assert.throws(() => compileSafeFilterRegex("(a+)\\1"), /backreferences/u);
  assert.throws(() => compileSafeFilterRegex("["), /potentially unsafe|valid regular expression/u);
});

test("point filters reject simultaneous names and regex selectors", () => {
  assert.throws(() => filterDefinitions({ Play: {} }, { names: ["Play"], filter: "Play" }), /mutually exclusive/u);
});

test("node read tools expose point filtering inputs", () => {
  const tools = registeredTools({});

  for (const toolName of ["nodel.get_node_actions", "nodel.get_node_signals", "nodel.get_node_bindings"]) {
    const inputSchema = tools.get(toolName).config.inputSchema;
    for (const field of ["names", "filter", "caseSensitive", "summaryOnly"]) {
      assert.equal(Object.hasOwn(inputSchema, field), true, `${toolName} should expose ${field}`);
    }
  }
});

test("get_node_actions preserves default shape and filters only when requested", async () => {
  const tools = registeredTools({
    getNodeActions: async () => ({
      node,
      actions: {
        Play: { title: "Play", group: "transport" },
        Stop: { title: "Stop", group: "transport" },
      },
    }),
  });
  const tool = tools.get("nodel.get_node_actions");

  const unfiltered = await readToolPayload(tool.handler({ node: "Demo" }));
  assert.deepEqual(Object.keys(unfiltered.actions), ["Play", "Stop"]);
  assert.equal(unfiltered.totalCount, undefined);
  assert.equal(unfiltered.summaries, undefined);
  assert.deepEqual(
    unfiltered.summary.map((summary) => summary.name),
    ["Play", "Stop"],
  );

  const filtered = await readToolPayload(tool.handler({ node: "Demo", filter: "^st" }));
  assert.deepEqual(Object.keys(filtered.actions), ["Stop"]);
  assert.equal(filtered.totalCount, 2);
  assert.equal(filtered.matchedCount, 1);
  assert.deepEqual(
    filtered.summaries.map((summary) => summary.name),
    ["Stop"],
  );

  const summaryOnly = await readToolPayload(tool.handler({ node: "Demo", summaryOnly: true }));
  assert.equal(summaryOnly.actions, undefined);
  assert.equal(summaryOnly.totalCount, 2);
  assert.equal(summaryOnly.matchedCount, 2);
  assert.deepEqual(
    summaryOnly.summaries.map((summary) => summary.name),
    ["Play", "Stop"],
  );
});

test("get_node_bindings filters schema config and status together", async () => {
  const tools = registeredTools({
    getNodeBindings: async () => ({ node, schema: bindingSchema(), bindings: bindingConfig() }),
    getNodeActivity: async () => ({
      node,
      activity: [
        { source: "remote", type: "actionBinding", action: "PowerOn", connected: true },
        { source: "remote", type: "eventBinding", event: "LampStatus", connected: false },
        { source: "remote", type: "eventBinding", event: "DoorStatus", connected: true },
      ],
    }),
  });

  const payload = await readToolPayload(
    tools.get("nodel.get_node_bindings").handler({
      node: "Demo",
      includeStatus: true,
      names: ["PowerOn", "LampStatus"],
    }),
  );

  assert.equal(payload.totalCount, 5);
  assert.equal(payload.matchedCount, 2);
  assert.deepEqual(Object.keys(payload.schema.properties.actions.properties), ["PowerOn"]);
  assert.deepEqual(Object.keys(payload.schema.properties.events.properties), ["LampStatus"]);
  assert.deepEqual(Object.keys(payload.bindings.actions), ["PowerOn"]);
  assert.deepEqual(Object.keys(payload.bindings.events), ["LampStatus"]);
  assert.deepEqual(
    payload.bindingStatus.map((entry) => entry.action ?? entry.event),
    ["PowerOn", "LampStatus"],
  );
  assert.deepEqual(
    payload.summaries.map((summary) => `${summary.kind}:${summary.name}`),
    ["actions:PowerOn", "events:LampStatus"],
  );
  assert.equal(payload.summaries[0].configured, true);
  assert.equal(payload.summaries[0].inSchema, true);
  assert.equal(payload.summaries[0].statusCount, 1);
});

test("get_node_bindings summaryOnly can return schema and status-only matches", async () => {
  const tools = registeredTools({
    getNodeBindings: async () => ({ node, schema: bindingSchema(), bindings: bindingConfig() }),
    getNodeActivity: async () => ({
      node,
      activity: [{ source: "remote", type: "eventBinding", event: "DoorStatus", connected: true }],
    }),
  });

  const payload = await readToolPayload(
    tools.get("nodel.get_node_bindings").handler({
      node: "Demo",
      includeStatus: true,
      names: ["DoorStatus"],
      summaryOnly: true,
    }),
  );

  assert.equal(payload.schema, undefined);
  assert.equal(payload.bindings, undefined);
  assert.equal(payload.bindingStatus, undefined);
  assert.equal(payload.totalCount, 5);
  assert.equal(payload.matchedCount, 1);
  assert.equal(payload.summaries[0].name, "DoorStatus");
  assert.equal(payload.summaries[0].configured, false);
  assert.equal(payload.summaries[0].inSchema, true);
  assert.equal(payload.summaries[0].statusCount, 1);
});

function registeredTools(client) {
  const tools = new Map();
  registerNodeReadTools(
    asServer({
      registerTool(name, config, handler) {
        tools.set(name, { config, handler });
        return /** @type {import("@modelcontextprotocol/sdk/server/mcp.js").RegisteredTool} */ (
          /** @type {unknown} */ (undefined)
        );
      },
    }),
    client,
  );
  return tools;
}

/** @param {unknown} value @returns {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} */
function asServer(value) {
  return /** @type {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} */ (/** @type {unknown} */ (value));
}

async function readToolPayload(resultPromise) {
  const result = await resultPromise;
  return JSON.parse(result.content[0].text);
}

function bindingSchema() {
  return {
    type: "object",
    properties: {
      actions: {
        properties: {
          PowerOn: { title: "Power On", type: "object" },
          PowerOff: { title: "Power Off", type: "object" },
        },
      },
      events: {
        properties: {
          LampStatus: { title: "Lamp Status", type: "object" },
          DoorStatus: { title: "Door Status", type: "object" },
        },
      },
    },
  };
}

function bindingConfig() {
  return {
    actions: {
      PowerOn: { node: "Projector", action: "On" },
    },
    events: {
      LampStatus: { node: "Lamp", event: "State" },
      ConfigOnly: { node: "Other", event: "Ping" },
    },
  };
}
