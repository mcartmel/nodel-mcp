import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestConfig } from "../src/config.js";
import { NodelClient } from "../src/nodel/client.js";
import { registerUiTools } from "../src/mcp/tools/ui.js";
import { defaultUiVerificationPath } from "../src/mcp/tools/uiGuidance.js";
import { PINNED_V2_CONTRACT, PINNED_V2_PROVENANCE, decodeV2Contract } from "../src/domain/ui/v2/contract.js";
import { workflowGuidance } from "../src/mcp/tools/guidance.js";
import type { UiAdvisoryEnvelope } from "../src/domain/ui/advisory-types.js";
import type { UiCapabilities } from "../src/domain/ui/capabilities-types.js";

type Json = Record<string, unknown>;
type ReferenceItem = {
  name: string;
  attributes: Page;
  commonAttributes: string;
  detailStatus?: string;
};
type Page = {
  items: ReferenceItem[];
  offset: number;
  limit: number;
  total: number;
  returned: number;
  nextOffset: number;
  hasMore: boolean;
  truncated: boolean;
  status?: string;
};
// SDK JSON is unknown, not the implementation's inferred return type. Each scenario
// asserts the material wire shape; this interface only types the assertion paths.
type ToolBody = {
  selection: { selected?: string; reason: string };
  capability: {
    state: string;
    target: { name: string };
    resolution: { reason: string };
    recommendation: { format: string };
  };
  contract: { contractSource: string; deploymentApplicable: boolean; compatibility: string; contentHash: string };
  deployedContract?: unknown;
  options: string[];
  components: ReferenceItem[];
  componentIndex: Page;
  commonAttributes: Page;
  detailsPage: Page;
  page?: unknown;
  unknownComponents: Array<{ suggestions: string[] }>;
  output: { truncated: boolean };
  starterProvenance: { deploymentApplicable: boolean; sha256: string };
  error: { code: string };
  path: string;
  uiFeedback: UiAdvisoryEnvelope;
  recognition: {
    complete: boolean;
    truncated: boolean;
    selectedFormat?: string;
    candidate: { complete: boolean; truncated: boolean };
  };
  warnings: string[];
  fieldResponse: Omit<Page, "items"> & { items: unknown[]; textLimit: number };
};
type TextSegment = {
  text: string;
  offset: number;
  returned: number;
  total: number;
  hasMore: boolean;
  nextOffset?: number;
};
type State = {
  paths: string[];
  closed: string[];
  rootCount: number;
  rootStatus: number;
  rootDelay: number;
  rootBody?: string;
  fileDelay: number;
  assetDelay: number;
  fileStatus: number;
  fileContent: string;
  assetStatus: number;
  changeTarget: boolean;
  degradeAfterContract: boolean;
  stallAssets: boolean;
  contract: unknown;
};
async function fixture(
  run: (
    call: (name: string, args?: Json) => Promise<{ body: ToolBody; text: string; isError: boolean }>,
    state: State,
  ) => Promise<void>,
  timeout = 1000,
  allowedNodePrefixes?: string[],
) {
  const state: State = {
    paths: [],
    closed: [],
    rootCount: 0,
    rootStatus: 200,
    rootDelay: 0,
    fileDelay: 0,
    assetDelay: 0,
    fileStatus: 200,
    fileContent: "<pages><page/></pages>",
    assetStatus: 200,
    changeTarget: false,
    degradeAfterContract: false,
    stallAssets: false,
    contract: PINNED_V2_CONTRACT,
  };
  let contractReads = 0;
  const server = createServer((request, response) => {
    const path = request.url!;
    state.paths.push(path);
    response.on("close", () => state.closed.push(path));
    const send = (body: string, status = 200, mime = "application/json", delay = 0) => {
      const finish = () => {
        response.writeHead(status, { "content-type": mime });
        response.end(body);
      };
      if (delay) {
        const timer = setTimeout(finish, delay);
        response.on("close", () => clearTimeout(timer));
      } else finish();
    };
    if (path === "/prefix/REST") {
      state.rootCount++;
      const name = state.changeTarget && state.rootCount > 1 ? "Target B" : "Target A";
      return send(
        state.rootBody ?? JSON.stringify({ nodes: { display: { name } } }),
        state.rootStatus,
        undefined,
        state.rootDelay,
      );
    }
    if (path.includes("/REST/files/contents?"))
      return send(state.fileContent, state.fileStatus, "text/plain", state.fileDelay);
    if (path.includes("/v2/")) {
      if (state.stallAssets) {
        response.writeHead(200, {
          "content-type": path.endsWith(".json")
            ? "application/json"
            : path.endsWith(".js")
              ? "application/javascript"
              : "text/css",
        });
        response.write(" ");
        return;
      }
      const contract = path.endsWith(".json");
      const status = state.degradeAfterContract && contract && contractReads++ > 0 ? 503 : state.assetStatus;
      return send(
        contract
          ? JSON.stringify(state.contract)
          : path.endsWith(".js")
            ? "export const runtime = true;"
            : "body { color: red }",
        status,
        contract ? "application/json" : path.endsWith(".js") ? "application/javascript" : "text/css",
        state.assetDelay,
      );
    }
    if (path.endsWith("/REST/files")) return send("[]");
    if (path.includes("/REST/")) return send("{}");
    send("", 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const nodel = new NodelClient(
    createTestConfig({
      nodelBaseUrl: `http://127.0.0.1:${address.port}/prefix`,
      nodelRequestTimeoutMs: timeout,
      ...(allowedNodePrefixes ? { allowedNodePrefixes } : {}),
    }),
  );
  const mcp = new McpServer({ name: "stage4-test", version: "1" });
  registerUiTools(mcp, nodel);
  const sdk = new Client({ name: "stage4-test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await sdk.connect(clientTransport);
  try {
    await run(async (name, args = {}) => {
      const result = await sdk.callTool({ name: `nodel.${name}`, arguments: args });
      const content = result.content as Array<{ type: string; text: string }>;
      assert.equal(content[0]!.type, "text");
      const text = content[0]!.text;
      // SDK schema rejection precedes the handler's JSON envelope.
      if (!text.startsWith("{")) {
        assert.equal(result.isError, true);
        assert.match(text, /^MCP error/u);
        return { body: { error: { code: "SDK_SCHEMA" } } as ToolBody, text, isError: true };
      }
      return { body: JSON.parse(text) as ToolBody, text, isError: result.isError === true };
    }, state);
  } finally {
    await sdk.close();
    await mcp.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

for (const tool of ["get_ui_guidelines", "get_ui_component_reference"]) {
  void test(`${tool}: auto refresh pins one target and one available observation`, async () => {
    await fixture(async (call, state) => {
      state.changeTarget = true;
      state.degradeAfterContract = true;
      const { body, isError } = await call(tool, { format: "auto", node: "display", refresh: true });
      assert.equal(isError, false);
      assert.equal(body.selection.selected, "v2");
      assert.equal(body.capability.state, "available");
      assert.equal(body.capability.target.name, "Target A");
      assert.equal(body.contract.contractSource, "deployed");
      assert.equal(state.rootCount, 1, "must not re-resolve after format selection");
      assert.equal(state.paths.filter((path) => path.endsWith("/v2/nodel-components.json")).length, 1);
      assert(state.paths.filter((path) => path.includes("/v2/")).every((path) => path.includes("/TargetA/")));
      state.degradeAfterContract = false;
      const changed = await call(tool, { format: "auto", node: "display" });
      assert.equal(changed.body.capability.target.name, "Target B");
      assert.equal(
        state.paths.filter((path) => path.endsWith("/v2/nodel-components.json")).length,
        2,
        "a changed target must not reuse the prior target's observation",
      );
      const cached = await call(tool, { format: "auto", node: "display" });
      assert.equal(cached.body.capability.target.name, "Target B");
      assert.equal(
        state.paths.filter((path) => path.endsWith("/v2/nodel-components.json")).length,
        2,
        "the stable second target should reuse its own observation",
      );
    });
  });

  void test(`${tool}: resolution 503 gives unknown/options or explicit offline fallback, not tool failure`, async () => {
    await fixture(async (call, state) => {
      state.rootStatus = 503;
      for (const format of ["auto", "v2"]) {
        const { body, isError } = await call(tool, { format, node: "display", components: ["nodel-buttn"] });
        assert.equal(isError, false);
        assert.equal(body.capability.state, "unknown");
        assert.equal(body.capability.resolution.reason, "resolution_http_503");
        if (format === "auto") {
          assert.equal(body.selection.selected, undefined);
          assert.deepEqual(body.options, ["v1", "v2"]);
        } else {
          assert.equal(body.contract.contractSource, "bundled");
          assert.equal(body.contract.deploymentApplicable, false);
          assert.equal(body.deployedContract, undefined);
        }
      }
      assert.equal(state.paths.filter((path) => path.includes("/v2/")).length, 0);
    });
  });

  void test(`${tool}: new-path 404 is conditional absence; auth/server failures are not absence`, async () => {
    await fixture(async (call, state) => {
      for (const status of [404, 401, 503]) {
        state.fileStatus = status;
        const { body, isError } = await call(tool, { format: "auto", node: "display", path: "content/new.html" });
        assert.equal(isError, false);
        assert.equal(body.capability.state, "available");
        assert.equal(body.selection.selected, status === 404 ? "v2" : undefined);
        assert.match(body.selection.reason, status === 404 ? /HTTP 404.*conditional/u : /do not assume absence/u);
      }
      assert(state.paths.every((path) => !path.includes("/save")));
    });
  });

  void test(`${tool}: saved format survives host recommendation but incomplete/mixed documents do not auto-select`, async () => {
    await fixture(async (call, state) => {
      const cases = [
        { content: "<pages><page/></pages>", path: "content/index.xml", format: "v1" },
        { content: "<nodel-button>Test</nodel-button>", path: "content/control.html", format: "v2" },
        {
          content: "<nodel-button></nodel-button>" + "<div>".repeat(140),
          path: "content/control.html",
          format: undefined,
        },
        { content: "<pages><nodel-button></nodel-button></pages>", path: "content/control.html", format: undefined },
      ];
      for (const entry of cases) {
        state.fileContent = entry.content;
        const { body } = await call(tool, { format: "auto", node: "display", path: entry.path });
        assert.equal(body.selection.selected, entry.format);
        assert.equal(body.capability.state, "available");
      }
      state.assetStatus = 404;
      state.fileContent = "<nodel-button>Test</nodel-button>";
      const { body } = await call(tool, {
        format: "auto",
        node: "display",
        path: "content/control.html",
        refresh: true,
      });
      assert.equal(body.selection.selected, "v2");
      assert.equal(body.capability.state, "not_detected");
      assert.equal(body.contract.contractSource, "bundled");
      assert.equal(body.contract.deploymentApplicable, false);
      assert.equal(body.deployedContract, undefined);
    });
  });

  void test(`${tool}: missing XML/non-UI paths never become new HTML starter paths`, async () => {
    await fixture(async (call, state) => {
      state.fileStatus = 404;
      const xml = await call(tool, { format: "auto", node: "display", path: "content/index.xml" });
      assert.equal(xml.body.selection.selected, "v1");
      assert.equal(xml.body.capability.recommendation.format, "preserve_v1");
      assert.match(xml.body.selection.reason, /Preserve the XML path/u);
      const json = await call(tool, { format: "auto", node: "display", path: "content/config.json" });
      assert.equal(json.body.selection.selected, undefined);
      assert.match(json.body.selection.reason, /not an HTML UI path/u);
    });
  });

  void test(`${tool}: explicit v2 references skip stalled saved-page reads`, async () => {
    await fixture(async (call, state) => {
      state.fileDelay = 10000;
      const start = performance.now();
      const { body } = await call(tool, { format: "v2", node: "display", path: "content/control.html" });
      assert.equal(body.capability.state, "available");
      assert.equal(body.contract.contractSource, "deployed");
      assert(performance.now() - start < 250);
      assert(!state.paths.some((path) => path.includes("/files/contents?")));
    }, 300);
  });
}

void test("UI reference projections drop unknown fields recursively, deduplicate and bound actual SDK output", async () => {
  await fixture(async (call, state) => {
    const contract = structuredClone(PINNED_V2_CONTRACT);
    const button = contract.elements.find((entry) => entry.name === "nodel-button");
    assert(button);
    delete button.composition;
    const baseAttribute = button.attributes.find((entry) => entry.name === "label") ?? button.attributes[0]!;
    button.attributes = Array.from({ length: 80 }, (_, index) => ({
      ...baseAttribute,
      name: `attribute-${index}`,
      valueType: "number",
      defaultValue: "1",
      values: undefined,
      description: "x".repeat(15000),
      numeric: { min: 0, max: 10, future: "DO_NOT_ECHO" },
      future: { hidden: "DO_NOT_ECHO", value: "y".repeat(1000) },
    }));
    button.actionBindings = [
      Object.assign({ attribute: "attribute-0", phases: ["default"] }, { future: "DO_NOT_ECHO" }),
    ];
    button.signalBindings = [
      Object.assign(
        {
          attribute: "attribute-0",
          defaultTarget: "value",
          targets: [Object.assign({ name: "value", aggregations: [] }, { future: "DO_NOT_ECHO" })],
        },
        { future: "DO_NOT_ECHO" },
      ),
    ];
    button.composition = Object.assign({ requiredParent: undefined }, { future: "DO_NOT_ECHO" });
    button.events = [
      Object.assign(
        { name: "example", description: "Example event", bubbles: true, composed: true, detailFields: ["value"] },
        { future: "DO_NOT_ECHO" },
      ),
    ];
    Object.assign(button, { future: "DO_NOT_ECHO" });
    contract.elements = [button];
    Object.assign(contract.commonAttributes[0]!, { future: "DO_NOT_ECHO" });
    Object.assign(contract.styles.semanticClasses[0]!, { future: "DO_NOT_ECHO" });
    assert.equal(decodeV2Contract(contract).ok, true);
    assert(Buffer.byteLength(JSON.stringify(contract)) > 1_000_000);
    state.contract = contract;
    const { body, text } = await call("get_ui_component_reference", {
      format: "v2",
      node: "display",
      components: Array(20).fill("nodel-button"),
      attributesLimit: 200,
    });
    assert(Buffer.byteLength(text) <= 64 * 1024, `output was ${Buffer.byteLength(text)} bytes`);
    assert(!text.includes("DO_NOT_ECHO"));
    assert.equal(body.components.length, 1, "duplicate component requests must not amplify details");
    assert.equal(body.output.truncated, true);
    assert.equal(body.detailsPage.total, 1);
    assert.equal(body.detailsPage.returned, 1);
    assert.equal(body.components[0]!.detailStatus, "field_selection_required");
    assert.equal(body.components[0]!.attributes.hasMore, false);
    assert.equal(body.detailsPage.hasMore, false);
    const focused = await call("get_ui_component_reference", {
      format: "v2",
      node: "display",
      components: ["nodel-button"],
      field: "attributes",
      fieldOffset: 79,
      fieldLimit: 1,
    });
    const item = focused.body.fieldResponse.items[0] as { name: TextSegment };
    assert.equal(item.name.text, "attribute-79");
    assert.equal(focused.body.contract.contentHash, body.contract.contentHash, "cache must retain stable observation");
  });
});

void test("default index follows authoring visibility rules, paginates accurately, and common attributes appear once", async () => {
  await fixture(async (call, state) => {
    const contract = structuredClone(PINNED_V2_CONTRACT);
    const eligible = contract.elements.filter(
      (entry) => entry.audience === "custom" && entry.completion === "recommended" && entry.catalogue !== false,
    );
    assert(eligible.length > 4);
    eligible[0]!.completion = "hidden";
    eligible[1]!.catalogue = false;
    eligible[2]!.completion = "advanced";
    state.contract = contract;
    const { body } = await call("get_ui_component_reference", {
      format: "v2",
      node: "display",
      indexOffset: 1,
      indexLimit: 2,
    });
    assert.equal(body.components, undefined);
    assert.equal(body.page, undefined);
    const expected = contract.elements.filter(
      (entry) => entry.audience === "custom" && entry.completion === "recommended" && entry.catalogue !== false,
    );
    assert.deepEqual(
      body.componentIndex.items.map((entry) => entry.name),
      expected.slice(1, 3).map((entry) => entry.name),
    );
    assert.equal(body.componentIndex.offset, 1);
    assert.equal(body.componentIndex.limit, 2);
    assert.equal(body.componentIndex.total, expected.length);
    assert.equal(body.componentIndex.hasMore, expected.length > 3);
    assert.equal(body.componentIndex.truncated, false);
    const selected = await call("get_ui_component_reference", {
      format: "v2",
      node: "display",
      components: ["nodel-button", "nodel-text"],
    });
    assert.equal(selected.body.components.length, 2);
    assert.equal(selected.body.commonAttributes.items.filter((entry) => entry.name === "visibility").length, 1);
    assert(
      selected.body.components.every((entry) => !entry.attributes.items.some((attr) => attr.name === "visibility")),
    );
    assert.match(selected.body.components[0]!.commonAttributes, /applies to each component/u);
    const internal = contract.elements.find((entry) => entry.audience === "internal");
    assert(internal);
    const exact = await call("get_ui_component_reference", {
      format: "v2",
      node: "display",
      components: [internal.name],
    });
    assert.equal(exact.body.components[0]!.name, internal.name);
    assert.match(exact.body.warnings[0]!, /internal host/u);
  });
});

void test("offline and unknown-component responses always normalize fallback provenance; starter remains separate", async () => {
  await fixture(async (call) => {
    const reference = await call("get_ui_component_reference", { format: "v2", components: ["nodel-buttn"] });
    assert.equal(reference.body.contract.contractSource, "bundled");
    assert.equal(reference.body.contract.deploymentApplicable, false);
    assert.equal(reference.body.contract.compatibility, "unverified");
    assert(reference.body.unknownComponents[0]!.suggestions.includes("nodel-button"));
    const guide = await call("get_ui_guidelines", { format: "v2" });
    assert.equal(guide.body.deployedContract, undefined);
    assert.equal(guide.body.contract.contractSource, "bundled");
    assert.equal(guide.body.starterProvenance.deploymentApplicable, false);
    assert.notEqual(guide.body.contract.contentHash, guide.body.starterProvenance.sha256);
  });
});

void test("policy resolution failures remain real tool errors, not offline advice", async () => {
  await fixture(
    async (call) => {
      const result = await call("get_ui_component_reference", { format: "v2", node: "display" });
      assert.equal(result.isError, true);
      assert.equal(result.body.error.code, "POLICY");
    },
    1000,
    ["Allowed"],
  );
});

for (const failure of ["503", "timeout"]) {
  void test(`SDK explicit v2 verification retains full fallback provenance and static findings after resolution ${failure}`, async () => {
    await fixture(async (call, state) => {
      const sensitive = "SENSITIVE_REMOTE_BODY_TOKEN_password=do-not-expose";
      state.rootBody = sensitive;
      state.rootStatus = 503;
      if (failure === "timeout") state.rootDelay = 2000;
      const { body, isError, text } = await call("verify_ui_file", {
        node: "display",
        format: "v2",
        content: '<nodel-app offline-mode="bad-enum"></nodel-app>',
      });
      assert.equal(isError, false, text);
      const feedback = body.uiFeedback;
      assert.equal(feedback.selectedFormat, "v2");
      assert.equal(feedback.validation.status, "errors");
      assert.equal(feedback.validation.complete, false);
      assert(feedback.issues.some(({ code }) => code === "UI_V2_ENUM_INVALID"));
      assert(feedback.checks.some(({ name, state }) => name === "deployed-contract" && state === "failed"));
      assert(feedback.checks.some(({ name, state }) => name === "runtime-support" && state === "skipped"));
      const provenance = feedback.provenance!;
      assert.equal(provenance.contractSource, "bundled");
      assert.equal(provenance.schemaVersion, PINNED_V2_PROVENANCE.schemaVersion);
      assert.equal(provenance.packageVersion, PINNED_V2_PROVENANCE.packageVersion);
      assert.equal(provenance.contentHash, PINNED_V2_PROVENANCE.contentHash);
      assert.equal(provenance.repositoryRevision, PINNED_V2_PROVENANCE.revision);
      assert.equal(provenance.repository, PINNED_V2_PROVENANCE.repository);
      assert.equal(provenance.license, PINNED_V2_PROVENANCE.license);
      assert.equal(provenance.deploymentApplicable, false);
      assert.equal(provenance.compatibility, "unverified");
      assert.equal(typeof provenance.detectionFailure, "string");
      const capability = feedback.capabilities as unknown as UiCapabilities;
      assert.equal(capability.state, "unknown");
      assert.equal(capability.resolution?.state, "failed");
      assert.equal(typeof capability.resolution?.reason, "string");
      assert.equal(capability.contract.contractSource, "bundled");
      assert.equal(capability.contract.deploymentApplicable, false);
      assert.equal(capability.recommendation.format, "undetermined");
      assert.equal(state.rootCount, 1, "failed resolution must not be attempted again for live enrichment");
      assert.deepEqual(state.paths, ["/prefix/REST"]);
      assert(!text.includes(sensitive));
      assert(!text.includes("do-not-expose"));
    }, 100);
  });
}

void test("SDK explicit v2 verifier preserves policy rejection as a real error", async () => {
  await fixture(
    async (call) => {
      const result = await call("verify_ui_file", {
        node: "display",
        format: "v2",
        content: '<nodel-app offline-mode="bad-enum"></nodel-app>',
      });
      assert.equal(result.isError, true);
      assert.equal(result.body.error.code, "POLICY");
      assert.equal(result.body.uiFeedback, undefined);
    },
    1000,
    ["Allowed"],
  );
});

void test("SDK deployed 0.2.0 contract reports dynamic binding and foreign presentation uncertainty honestly", async () => {
  await fixture(async (call, state) => {
    const verify = (markup: string) =>
      call("verify_ui_file", {
        node: "display",
        format: "v2",
        content:
          '<!doctype html><html><head><link rel="stylesheet" href="./v2/nodel-webui.css">' +
          '<script type="module" src="./v2/nodel-webui.js"></script></head><body>' +
          `<nodel-app><nodel-page title="Home">${markup}</nodel-page></nodel-app></body></html>`,
      });
    for (const value of [
      "${condition ? first : second}:visibility",
      "{{first; second}}:visibility",
      "${select(first, second)}:visibility",
    ]) {
      const result = await verify(`<div signals="${value}"></div>`);
      assert.equal(result.isError, false, result.text);
      const feedback = result.body.uiFeedback;
      assert.equal(feedback.provenance?.contractSource, "deployed");
      assert.equal(feedback.provenance?.packageVersion, "0.2.0");
      assert.equal(feedback.validation.status, "incomplete");
      assert.equal(feedback.validation.complete, false);
      assert(feedback.issues.some(({ code }) => code === "UI_V2_SCHEMA_CHECK_SKIPPED"));
      assert(!feedback.issues.some(({ code }) => code === "UI_V2_EVENT_MISSING"));
    }
    for (const value of [
      "${condition /* } */ ? 'ignored;Fake:visibility;' : 'safe'}",
      "${/}/.test(value) ? 'ignored;Fake:visibility;' : 'safe'}",
      "${condition // } ;Fake:visibility;\n ? first : second}",
      "${first\n;Fake:visibility;second}",
      "${`text ${nested};Fake:visibility;`}",
      "${({ nested: { value: /}/ } });Fake:visibility;}",
      "${'unterminated};Fake:visibility;",
      "{{unclosed;Fake:visibility;",
      "${" + "{".repeat(30_000) + "}".repeat(30_000) + "/};Fake:visibility;",
    ]) {
      const result = await verify(
        `<div signals="Before:visibility;${value}:visibility;After:visibility" visibility="Separate..path;SeparateMissing"></div>`,
      );
      assert.equal(result.isError, false);
      const feedback = result.body.uiFeedback;
      assert.equal(feedback.provenance?.contractSource, "deployed");
      assert.equal(feedback.provenance?.packageVersion, "0.2.0");
      assert.equal(feedback.validation.complete, false);
      assert(feedback.issues.some(({ code }) => code === "UI_V2_SCHEMA_CHECK_SKIPPED"));
      assert(!feedback.issues.some(({ severity, attribute }) => severity === "error" && attribute === "signals"));
      const missing = feedback.issues.filter(({ code }) => code === "UI_V2_EVENT_MISSING");
      assert.equal(missing.length, 1);
      assert.match(missing[0]!.message, /SeparateMissing/u);
      assert.equal(feedback.issues.filter(({ code }) => code === "UI_V2_SIGNAL_BINDING_INVALID").length, 1);
    }
    for (const markup of [
      '<svg><path visibility="InHeRiT"></path></svg>',
      '<svg><path visibility="var(--native-visibility)"></path></svg>',
      '<div signal="Missing:visibility"></div>',
    ]) {
      const result = await verify(markup);
      assert.equal(result.isError, false, result.text);
      const feedback = result.body.uiFeedback;
      assert.equal(feedback.provenance?.packageVersion, "0.2.0");
      assert.equal(feedback.validation.status, "incomplete");
      assert(!feedback.issues.some(({ code }) => code === "UI_V2_EVENT_MISSING"));
      const skipped = feedback.checks.find(({ name }) => name === "component-runtime-rules");
      assert.equal(skipped?.state, "skipped");
      assert.match(skipped?.reason ?? "", /declared features.*element namespace/u);
      assert(!skipped?.reason?.includes("version is outside"));
    }
    assert.equal(state.paths.filter((path) => path.endsWith("/v2/nodel-components.json")).length, 1);
  });
});

void test("auto operation shares the configured lower deadline across resolve, file and capability and cancels HTTP", async () => {
  await fixture(async (call, state) => {
    state.rootDelay = 100;
    state.fileDelay = 100;
    state.stallAssets = true;
    const start = performance.now();
    const { body } = await call("get_ui_component_reference", {
      format: "auto",
      node: "display",
      path: "content/control.html",
    });
    const elapsed = performance.now() - start;
    assert(elapsed >= 250 && elapsed < 500, `shared 300ms deadline took ${elapsed}ms`);
    assert.notEqual(body.capability.state, "available");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      state.closed.filter((path) => path.includes("/v2/")).length,
      3,
      "must close all actual stalled response bodies",
    );
  }, 300);
});

void test(
  "auto operation retains a 10s absolute ceiling with 20s configured request timeout",
  { timeout: 14000 },
  async () => {
    await fixture(async (call, state) => {
      state.rootDelay = 350;
      state.fileDelay = 350;
      state.stallAssets = true;
      const start = performance.now();
      const { body } = await call("get_ui_guidelines", {
        format: "auto",
        node: "display",
        path: "content/control.html",
      });
      const elapsed = performance.now() - start;
      assert(elapsed >= 9500 && elapsed < 10400, `10s aggregate ceiling took ${elapsed}ms`);
      assert.notEqual(body.capability.state, "available");
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(state.closed.filter((path) => path.includes("/v2/")).length, 3);
    }, 20000);
  },
);

void test("default verification path uses bounded structure, never comment markers or canonical-path bias", async () => {
  const commentXml = "<pages><!-- <nodel-button> --><page/></pages>";
  const runtimeFragment = '<script type="module" src="./v2/nodel-webui.js"></script>';
  assert.equal(defaultUiVerificationPath("auto", commentXml), "content/index.xml");
  assert.equal(defaultUiVerificationPath("auto", runtimeFragment), "content/index.html");
  assert.equal(defaultUiVerificationPath("auto", "<!-- <html><nodel-button> -->"), "content/index.html");
  assert.equal(defaultUiVerificationPath("auto", '<script>"<nodel-button>"</script>'), "content/index.html");
  await fixture(async (call) => {
    const xml = await call("verify_ui_file", { node: "display", content: commentXml });
    assert.equal(xml.body.path, "content/index.xml");
    assert.equal(xml.body.uiFeedback.selectedFormat, "v1");
    const html = await call("verify_ui_file", { node: "display", content: runtimeFragment });
    assert.equal(html.body.path, "content/index.html");
    assert.equal(html.body.uiFeedback.selectedFormat, "v2");
    const legacy = await call("verify_ui_file", { node: "display" });
    assert.equal(legacy.body.path, "content/index.xml");
    const unrecognized = await call("verify_ui_file", {
      node: "display",
      format: "auto",
      content: '<script>"<nodel-button>"</script>',
    });
    assert.equal(unrecognized.body.uiFeedback.selectedFormat, undefined);
  });
});

void test("generic exact-edit guidance includes the advisory UI sequence without authorization enforcement", () => {
  const guide = workflowGuidance(createTestConfig({ writesEnabled: true }), "node_file_edit");
  const text = guide.recommendedWorkflow.join("\n");
  assert.match(text, /Inspect the existing page.*preserve its format/u);
  assert.match(text, /get_ui_component_reference/u);
  assert.match(text, /actions\/signals/u);
  assert.match(text, /never authorize or block/u);
  assert.match(text, /read-back and static checks are not browser verification/u);
});

void test("SDK omitted-format legacy verification retains XML parse errors; explicit auto stays conservative", async () => {
  await fixture(async (call) => {
    for (const content of ["<pages", "<pages><page>"]) {
      const legacy = await call("verify_ui_file", { node: "display", content });
      assert.equal(legacy.body.path, "content/index.xml");
      assert.equal(legacy.body.uiFeedback.selectedFormat, "v1");
      assert.equal(legacy.body.uiFeedback.validation.status, "errors");
    }
    const auto = await call("verify_ui_file", { node: "display", content: "<pages", format: "auto" });
    assert.equal(auto.body.uiFeedback.selectedFormat, undefined);
    const canonical = await call("verify_ui_file", {
      node: "display",
      content: "<pages",
      path: "content/index.xml",
      format: "auto",
    });
    assert.equal(canonical.body.uiFeedback.selectedFormat, "v1");
    assert.equal(canonical.body.uiFeedback.validation.status, "errors");
    const v2 = await call("verify_ui_file", {
      node: "display",
      content: '<script type="module" src="./v2/nodel-webui.js"></script>',
    });
    assert.equal(v2.body.path, "content/index.html");
    assert.equal(v2.body.uiFeedback.selectedFormat, "v2");
  });
});

void test("SDK legacy fallback never overrides positive mixed or truncated v2 structure", async () => {
  await fixture(async (call) => {
    for (const content of [
      "<pages><nodel-button></nodel-button></pages>",
      "<nodel-button></nodel-button>" + "<div>".repeat(140),
      '<pages><script src="./v2/nodel-webui.js"></script></pages>',
    ]) {
      const result = await call("verify_ui_file", { node: "display", content });
      assert.equal(result.isError, false);
      assert.equal(result.body.uiFeedback.selectedFormat, undefined);
      assert.match(result.text, /mixed|incomplete|Both v1 and v2/u);
      const forced = await call("verify_ui_file", { node: "display", content, format: "v1" });
      assert.equal(forced.body.uiFeedback.selectedFormat, "v1");
    }
    for (const content of ["<unknown/>", "<!-- <nodel-button> -->", '<script>"<nodel-button>"</script>']) {
      const result = await call("verify_ui_file", { node: "display", content });
      assert.equal(result.body.path, "content/index.xml");
      assert.equal(result.body.uiFeedback.selectedFormat, "v1");
    }
  });
});

void test("SDK exact segments and overview clipping preserve Unicode scalars with UTF-16 cursors", async () => {
  await fixture(async (call, state) => {
    const contract = structuredClone(PINNED_V2_CONTRACT);
    const button = contract.elements.find((entry) => entry.name === "nodel-button")!;
    button.description = "a".repeat(511) + "😀" + "z";
    state.contract = contract;
    const args = { format: "v2", node: "display", components: [button.name] };
    const scalarPoints = (text: string) => {
      const points = Array.from(text, (character) => character.codePointAt(0)!);
      assert(
        points.every((point) => point < 0xd800 || point > 0xdfff),
        "wire segment must not contain lone surrogates",
      );
      assert.equal(Buffer.from(text, "utf8").toString("utf8"), text);
      return points;
    };
    const recovered: number[] = [];
    let offset = 0;
    for (let page = 0; page < 5; page++) {
      const result = await call("get_ui_component_reference", { ...args, field: "component", textOffset: offset });
      assert.equal(result.isError, false);
      assert(Buffer.byteLength(result.text) <= 65536);
      const segment = (result.body.fieldResponse.items[0] as { description: TextSegment }).description;
      assert.equal(segment.offset, offset);
      if (page === 0) assert.equal(segment.returned, 511);
      recovered.push(...scalarPoints(segment.text));
      if (!segment.hasMore) break;
      assert(segment.nextOffset! > offset);
      offset = segment.nextOffset!;
    }
    // Code-point concatenation models scalar-oriented clients; JS string joining
    // alone would conceal a high/low surrogate split across separate responses.
    assert.deepEqual(recovered, scalarPoints(button.description));
    const one = await call("get_ui_component_reference", {
      ...args,
      field: "component",
      textOffset: 511,
      textLimit: 1,
    });
    const segment = (one.body.fieldResponse.items[0] as { description: TextSegment }).description;
    assert.equal(segment.text, "😀");
    assert.equal(segment.returned, 2);
    assert.equal(segment.nextOffset, 513);
    const invalid = await call("get_ui_component_reference", { ...args, field: "component", textOffset: 512 });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.body.error.code, "VALIDATION");
    const overview = await call("get_ui_component_reference", args);
    const strings = (value: unknown): void => {
      if (typeof value === "string") scalarPoints(value);
      else if (value && typeof value === "object") Object.values(value).forEach(strings);
    };
    strings(overview.body);
  });
});

void test("SDK independent Unicode cursors ignore unselected array items and sibling text properties", async () => {
  await fixture(async (call, state) => {
    const contract = structuredClone(PINNED_V2_CONTRACT);
    const button = contract.elements.find((entry) => entry.name === "nodel-button")!;
    const attribute = button.attributes[0]!;
    attribute.valueType = "enum";
    delete attribute.numeric;
    delete attribute.defaultValue;
    attribute.values = ["a😀x", "😀y"];
    button.description = "a😀x";
    button.snippet = "😀y";
    Object.assign(button, { future: "DO_NOT_ECHO" });
    assert.equal(decodeV2Contract(contract).ok, true);
    state.contract = contract;
    const base = { format: "v2", node: "display", components: [button.name], fieldLimit: 1, textLimit: 1 };
    for (const entry of [
      { selectors: { field: "attribute.values", attributeName: attribute.name, fieldOffset: 0 }, expected: "a😀x" },
      { selectors: { field: "attribute.values", attributeName: attribute.name, fieldOffset: 1 }, expected: "😀y" },
      { selectors: { field: "component", textProperty: "description" }, expected: button.description },
      { selectors: { field: "component", textProperty: "snippet" }, expected: button.snippet },
    ]) {
      let textOffset = 0;
      const points: number[] = [];
      for (let page = 0; page < 10; page++) {
        const result = await call("get_ui_component_reference", { ...base, ...entry.selectors, textOffset });
        assert.equal(result.isError, false, result.text);
        assert(Buffer.byteLength(result.text) <= 65536);
        assert(!result.text.includes("DO_NOT_ECHO"));
        const item = result.body.fieldResponse.items[0];
        const property = entry.selectors.textProperty;
        const segment = property ? (item as Record<string, TextSegment>)[property]! : (item as TextSegment);
        if (property) {
          const sibling = property === "description" ? "snippet" : "description";
          assert.equal((item as Record<string, unknown>)[sibling], undefined);
        }
        const chunk = Array.from(segment.text, (character) => character.codePointAt(0)!);
        assert(chunk.every((point) => point < 0xd800 || point > 0xdfff));
        assert.equal(Buffer.from(segment.text).toString("utf8"), segment.text);
        points.push(...chunk);
        if (!segment.hasMore) break;
        assert(segment.nextOffset! > textOffset);
        textOffset = segment.nextOffset!;
      }
      assert.deepEqual(
        points,
        Array.from(entry.expected, (character) => character.codePointAt(0)!),
      );
    }
    for (const textProperty of ["future", "__proto__", "numeric.unit"]) {
      const invalid = await call("get_ui_component_reference", { ...base, field: "component", textProperty });
      assert.equal(invalid.isError, true);
      assert(!invalid.text.includes("DO_NOT_ECHO"));
    }
  });
});

void test("SDK truncated neutral prefixes never acquire implicit legacy v1 evidence", async () => {
  await fixture(async (call) => {
    const content = "<div>".repeat(140) + "<nodel-button></nodel-button>";
    for (const format of [undefined, "auto"]) {
      const result = await call("verify_ui_file", { node: "display", content, ...(format ? { format } : {}) });
      assert.equal(result.isError, false);
      assert.equal(result.body.uiFeedback.selectedFormat, undefined);
      assert.match(result.text, /incomplete|truncated/u);
    }
    const malformed = await call("verify_ui_file", { node: "display", content: "<pages" });
    assert.equal(malformed.body.uiFeedback.selectedFormat, "v1");
    assert.equal(malformed.body.uiFeedback.validation.status, "errors");
  });
});

void test("SDK resource-truncated one-sided roots require explicit format for partial validation", async () => {
  await fixture(async (call) => {
    for (const entry of [
      { root: "<pages>", suffix: "<nodel-button></nodel-button>", format: "v1", path: "content/index.xml" },
      { root: "<nodel-button></nodel-button>", suffix: "<pages></pages>", format: "v2", path: "content/index.html" },
    ]) {
      const content = entry.root + "<div>".repeat(140) + entry.suffix;
      for (const format of [undefined, "auto"]) {
        for (const path of [undefined, entry.path]) {
          const result = await call("verify_ui_file", {
            node: "display",
            content,
            ...(format ? { format } : {}),
            ...(path ? { path } : {}),
          });
          assert.equal(result.isError, false);
          assert.equal(result.body.uiFeedback.selectedFormat, undefined);
          assert.match(result.text, /resource-truncated/u);
        }
      }
      const forced = await call("verify_ui_file", { node: "display", content, format: entry.format });
      assert.equal(forced.isError, false);
      assert.equal(forced.body.uiFeedback.selectedFormat, entry.format);
      assert.match(forced.text, /static-validation/u);
      assert.notEqual(forced.body.uiFeedback.validation.status, "passed");
    }
  });
});

void test("SDK default-path uncertainty survives HTML recovery of XML-truncated input", async () => {
  await fixture(async (call, state) => {
    const content =
      "<pages>" +
      "<p>".repeat(140) +
      "<textarea><nodel-button></nodel-button></textarea>" +
      "</p>".repeat(140) +
      "</pages>";
    for (const format of [undefined, "auto"]) {
      const result = await call("verify_ui_file", { node: "display", content, ...(format ? { format } : {}) });
      assert.equal(result.isError, false);
      assert.equal(result.body.uiFeedback.selectedFormat, undefined);
      assert.equal(result.body.recognition.selectedFormat, undefined);
      assert.equal(result.body.uiFeedback.validation.status, "not_run");
      assert.equal(result.body.uiFeedback.validation.complete, false);
      assert.equal(result.body.recognition.complete, false);
      assert.equal(result.body.recognition.truncated, true);
      assert.equal(result.body.recognition.candidate.complete, true, "HTML path recovery itself completes");
      assert.equal(result.body.recognition.candidate.truncated, false);
      assert.match(result.text, /resource-truncated in XML/u);
    }
    assert.equal(state.paths.length, 0, "unselected supplied candidates must not start network enrichment");
    for (const format of ["v1", "v2"]) {
      const result = await call("verify_ui_file", { node: "display", content, format });
      assert.equal(result.isError, false);
      assert.equal(result.body.uiFeedback.selectedFormat, format);
      assert.notEqual(result.body.uiFeedback.validation.status, "not_run");
      assert(!result.text.includes("Default-path recognition"));
    }
    const suppliedPath = await call("verify_ui_file", {
      node: "display",
      content,
      format: "auto",
      path: "content/control.html",
    });
    assert.equal(suppliedPath.body.uiFeedback.selectedFormat, "v1", "explicit paths retain their own parser semantics");
    assert(!suppliedPath.text.includes("Default-path recognition"));
    const ordinaryHtml = await call("verify_ui_file", {
      node: "display",
      format: "auto",
      content: "<nodel-button></nodel-button>" + "<p>text".repeat(140),
    });
    assert.equal(ordinaryHtml.body.uiFeedback.selectedFormat, "v2");
    assert.equal(ordinaryHtml.body.recognition.truncated, false);
    assert(!ordinaryHtml.text.includes("Default-path recognition"));
  });
});

void test("large single-component references always advance and exact field text segments reconstruct long supported data", async () => {
  await fixture(async (call, state) => {
    const contract = structuredClone(PINNED_V2_CONTRACT);
    const button = contract.elements.find((entry) => entry.name === "nodel-button")!;
    delete button.composition;
    const description = "event-description-" + "x".repeat(2500);
    button.events = Array.from({ length: 80 }, (_, i) =>
      Object.assign(
        { name: `event-${i}`, description, bubbles: true, composed: false, detailFields: ["value"] },
        { future: "DO_NOT_ECHO" },
      ),
    );
    button.snippet = "<script>untrusted reference data</script>" + "\u0000".repeat(15000);
    contract.elements = [button];
    assert.equal(decodeV2Contract(contract).ok, true);
    assert(Buffer.byteLength(JSON.stringify(contract)) > 200000);
    state.contract = contract;
    const overview = await call("get_ui_component_reference", {
      format: "v2",
      node: "display",
      components: [button.name],
      detailsLimit: 1,
      attributesLimit: 1,
      commonLimit: 1,
      stylesLimit: 1,
    });
    assert(Buffer.byteLength(overview.text) <= 65536);
    assert.equal(overview.body.components.length, 1);
    assert.equal(overview.body.components[0]!.name, button.name);
    assert.equal(overview.body.detailsPage.returned, 1);
    assert.equal(overview.body.detailsPage.hasMore, false);
    assert.equal(overview.body.detailsPage.nextOffset, undefined);
    assert.equal(overview.body.components[0]!.detailStatus, "field_selection_required");
    const events = await call("get_ui_component_reference", {
      format: "v2",
      node: "display",
      components: [button.name],
      field: "events",
      fieldLimit: 100,
    });
    assert(Buffer.byteLength(events.text) <= 65536);
    assert(events.body.fieldResponse.returned > 0);
    assert.equal(events.body.fieldResponse.total, 80);
    if (events.body.fieldResponse.hasMore)
      assert(events.body.fieldResponse.nextOffset > events.body.fieldResponse.offset);
    else assert.equal(events.body.fieldResponse.returned, 80);
    let recovered = "";
    let textOffset = 0;
    for (let i = 0; i < 40; i++) {
      const result = await call("get_ui_component_reference", {
        format: "v2",
        node: "display",
        components: [button.name],
        field: "component",
        fieldLimit: 1,
        textOffset,
      });
      assert(Buffer.byteLength(result.text) <= 65536);
      assert(!result.text.includes("DO_NOT_ECHO"));
      const snippet = (result.body.fieldResponse.items[0] as { snippet: TextSegment }).snippet;
      recovered += snippet.text;
      if (!snippet.hasMore) break;
      assert(snippet.nextOffset! > textOffset);
      textOffset = snippet.nextOffset!;
    }
    assert.equal(
      recovered,
      button.snippet,
      "exact snippets are retrievable as data, with no inserted ellipses or execution",
    );
    const event = await call("get_ui_component_reference", {
      format: "v2",
      node: "display",
      components: [button.name],
      field: "events",
      fieldOffset: 79,
      fieldLimit: 1,
      textOffset: 2400,
    });
    const projected = event.body.fieldResponse.items[0] as { description: TextSegment };
    assert.equal(projected.description.text, description.slice(2400));
    assert.equal(event.body.fieldResponse.hasMore, false);
    assert(!event.text.includes("DO_NOT_ECHO"));
  });
});

void test("all nested enum/phase/target/composition/event tails have bounded explicit field pages", async () => {
  await fixture(async (call, state) => {
    const contract = structuredClone(PINNED_V2_CONTRACT);
    const button = contract.elements.find((entry) => entry.name === "nodel-button")!;
    const attribute = button.attributes[0]!;
    attribute.valueType = "enum";
    delete attribute.numeric;
    delete attribute.defaultValue;
    attribute.values = Array.from({ length: 25 }, (_, i) => `value-${i}`);
    const action = button.actionBindings[0]!;
    action.phases = Array.from({ length: 25 }, (_, i) => `phase-${i}`);
    action.defaultPhase = action.phases[0];
    const signal = button.signalBindings[0]!;
    signal.targets = Array.from({ length: 25 }, (_, i) =>
      Object.assign({ name: `target-${i}`, aggregations: ["any", "all"] }, { future: "DO_NOT_ECHO" }),
    );
    signal.defaultTarget = signal.targets[0]!.name;
    button.aggregateSignalTargets = signal.targets.map((entry) => entry.name);
    button.events = [
      {
        name: "test-event",
        description: "test",
        bubbles: true,
        composed: true,
        detailFields: Array.from({ length: 25 }, (_, i) => `detail-${i}`),
      },
    ];
    const stub = structuredClone(button.attributes[1]!);
    contract.elements = [
      button,
      ...Array.from({ length: 24 }, (_, i) => ({
        name: `nodel-extra-${i}`,
        description: "Extra reference element",
        attributes: [stub],
        audience: "custom",
        registration: "lazy",
        completion: "recommended",
        actionBindings: [],
        signalBindings: [],
        events: [],
      })),
    ];
    button.composition = {
      requiredDirectChildren: contract.elements.map((entry) => entry.name),
      advisoryDirectChildren: contract.elements.map((entry) => entry.name),
    };
    const common = contract.commonAttributes[0]!;
    common.valueType = "enum";
    delete common.defaultValue;
    common.values = attribute.values;
    assert.equal(decodeV2Contract(contract).ok, true);
    state.contract = contract;
    const cases = [
      { field: "attribute.values", attributeName: attribute.name, expected: attribute.values },
      { field: "commonAttribute.values", attributeName: common.name, expected: common.values },
      { field: "actionBinding.phases", bindingAttribute: action.attribute, expected: action.phases },
      {
        field: "signalBinding.targets",
        bindingAttribute: signal.attribute,
        expected: signal.targets.map((entry) => entry.name),
        named: true,
      },
      { field: "aggregateSignalTargets", expected: button.aggregateSignalTargets },
      { field: "composition.requiredDirectChildren", expected: button.composition.requiredDirectChildren! },
      { field: "composition.advisoryDirectChildren", expected: button.composition.advisoryDirectChildren! },
      { field: "event.detailFields", eventName: "test-event", expected: button.events[0]!.detailFields },
    ];
    for (const entry of cases) {
      let offset = 0;
      const actual: string[] = [];
      for (let page = 0; page < 10; page++) {
        const { expected: _expected, named: _named, ...selectors } = entry;
        const result = await call("get_ui_component_reference", {
          format: "v2",
          node: "display",
          components: [button.name],
          ...selectors,
          fieldOffset: offset,
          fieldLimit: 7,
        });
        assert(Buffer.byteLength(result.text) <= 65536);
        assert(!result.text.includes("DO_NOT_ECHO"));
        actual.push(
          ...result.body.fieldResponse.items.map((item) =>
            entry.named ? (item as { name: TextSegment }).name.text : (item as TextSegment).text,
          ),
        );
        if (!result.body.fieldResponse.hasMore) break;
        assert(result.body.fieldResponse.nextOffset > offset);
        offset = result.body.fieldResponse.nextOffset;
      }
      assert.deepEqual(actual, entry.expected, entry.field);
    }
    const aggregations = await call("get_ui_component_reference", {
      format: "v2",
      node: "display",
      components: [button.name],
      field: "signalTarget.aggregations",
      bindingAttribute: signal.attribute,
      targetName: "target-24",
      fieldOffset: 1,
      fieldLimit: 1,
    });
    assert.equal((aggregations.body.fieldResponse.items[0] as TextSegment).text, "all");
  });
});
