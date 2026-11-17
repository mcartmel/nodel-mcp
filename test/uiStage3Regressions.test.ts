import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createTestConfig } from "../src/config.js";
import { NodelClient } from "../src/nodel/client.js";
import { analyzeUiCandidate, verifyUiFile } from "../src/domain/ui/service.js";
import { validateV1Ui } from "../src/domain/ui/validator.js";
import { validateV2Ui } from "../src/domain/ui/v2/validator.js";
import { PINNED_V2_CONTRACT } from "../src/domain/ui/v2/contract.js";
import { javaActionName } from "../src/domain/ui/v2/action-names.js";
import type { UiAdvisoryEnvelope } from "../src/domain/ui/advisory-types.js";
import { getUiCapabilities, getUiCapabilityContext } from "../src/domain/ui/capabilities.js";
import { publicError } from "../src/shared/publicErrors.js";

const xml =
  '<?xml-stylesheet type="text/xsl" href="v1/index.xsl"?><pages><page title="Main"><row><column><button/></column></row></page></pages>';
const entries =
  '<link rel="stylesheet" href="./v2/nodel-webui.css"><script type="module" src="./v2/nodel-webui.js"></script>';
const html = `${entries}<nodel-app><nodel-page></nodel-page></nodel-app>`;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const validate = (content: string, extra: Partial<Parameters<typeof validateV2Ui>[0]> = {}) =>
  validateV2Ui({ path: "content/index.html", content, contract: PINNED_V2_CONTRACT, filePaths: [], ...extra });
const errors = (result: ReturnType<typeof validate>) => result.issues.filter((issue) => issue.severity === "error");

type State = {
  candidate: Uint8Array;
  actions: unknown;
  signals: unknown;
  activity: unknown;
  files: unknown;
  contract: unknown;
  contents: Record<string, string>;
  failures: Set<string>;
  stalls: Set<string>;
  scriptStatus: number;
  requests: string[];
  closed: string[];
  requestedAt: Map<string, number>;
};
async function fixture(run: (client: NodelClient, state: State, base: string) => Promise<void>, timeout = 1000) {
  const state: State = {
    candidate: Buffer.from(xml),
    actions: {},
    signals: {},
    activity: [],
    files: [],
    contract: PINNED_V2_CONTRACT,
    contents: {},
    failures: new Set(),
    stalls: new Set(),
    scriptStatus: 200,
    requests: [],
    closed: [],
    requestedAt: new Map(),
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture/");
    const key = url.pathname.split("/").at(-1)!;
    const path = url.searchParams.get("path");
    const label = path ?? key;
    state.requests.push(label);
    state.requestedAt.set(label, performance.now());
    response.on("close", () => state.closed.push(label));
    if (state.failures.has(label)) {
      response.writeHead(500);
      response.end("unavailable");
      return;
    }
    if (state.stalls.has(label)) {
      response.setHeader("content-type", "application/json");
      response.write(" ");
      return;
    }
    if (url.pathname === "/REST") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ nodes: { display: { name: "Display" } } }));
      return;
    }
    if (key === "nodel-components.json") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(state.contract));
      return;
    }
    if (key === "nodel-webui.js") {
      response.statusCode = state.scriptStatus;
      response.setHeader("content-type", "application/javascript");
      response.end("export const runtime = true;");
      return;
    }
    if (key === "nodel-webui.css") {
      response.setHeader("content-type", "text/css");
      response.end("body { color: red }");
      return;
    }
    if (key === "contents") {
      response.setHeader("content-type", "application/octet-stream");
      response.end(path === "content/index.xml" ? state.candidate : (state.contents[path ?? ""] ?? ""));
      return;
    }
    const data =
      key === "actions"
        ? state.actions
        : key === "events"
          ? state.signals
          : key === "files"
            ? state.files
            : key === "activity"
              ? state.activity
              : undefined;
    if (data !== undefined) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(data));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await run(new NodelClient(createTestConfig({ nodelBaseUrl: base, nodelRequestTimeoutMs: timeout })), state, base);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

void test("saved XML uses bounded bytes, rejects invalid UTF-8 without replacement, and hashes the original BOM bytes", async () => {
  await fixture(async (client, state) => {
    state.candidate = Buffer.concat([Buffer.from(xml), Buffer.from([0xff])]);
    const invalid = await verifyUiFile(client, "Display", "content/index.xml", undefined, false, 100, 200);
    assert.equal(invalid.uiFeedback.validation.status, "not_run");
    assert.equal(invalid.uiFeedback.sha256, hash(state.candidate));
    assert.match(invalid.uiFeedback.detection.explanation!, /not valid UTF-8/u);
    state.candidate = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)]);
    const bom = await verifyUiFile(client, "Display", "content/index.xml", undefined, false, 100, 200);
    assert.equal(bom.uiFeedback.sha256, hash(state.candidate));
    assert.equal("sha256" in bom && bom.sha256, hash(state.candidate));
    assert.equal(bom.uiFeedback.validation.status, "passed");
    assert.equal(bom.uiFeedback.validation.complete, true);
    assert.equal(state.requests.filter((entry) => entry === "content/index.xml").length, 2);
  });
});

void test("skip and ineligible candidate hashes remain byte-exact with zero network calls", async () => {
  const client = new Proxy(
    {},
    {
      get() {
        throw new Error("skip must not access client");
      },
    },
  ) as NodelClient;
  for (const candidate of ["\ufeff<nodel-app></nodel-app>", Buffer.from([0xef, 0xbb, 0xbf, 0xff])]) {
    const result = await analyzeUiCandidate(client, "Display", "content/index.html", candidate, { selection: "skip" });
    assert.equal(result.uiFeedback.sha256, hash(candidate));
    assert.equal(result.uiFeedback.validation.status, "not_run");
  }
  const result = await analyzeUiCandidate(client, "Display", "logo.png", Buffer.from([0xff]));
  assert.equal(result.uiFeedback.sha256, hash(Buffer.from([0xff])));
});

void test("v1/v2 full diagnostic totals survive maxIssues=0/1 and omitted diagnostics explicitly make coverage incomplete", async () => {
  await fixture(async (client) => {
    for (const maxIssues of [0, 1]) {
      const legacy = await analyzeUiCandidate(
        client,
        "Display",
        "content/index.xml",
        '<pages><button action="Missing"/></pages>',
        { maxIssues },
      );
      assert("summary" in legacy);
      assert(legacy.summary.errorCount >= 2);
      assert.equal(legacy.uiFeedback.validation.errors, legacy.summary.errorCount);
      assert.equal(legacy.uiFeedback.validation.status, "errors");
      assert.equal(legacy.uiFeedback.validation.complete, false);
      assert.equal(legacy.uiFeedback.issues.length, maxIssues);
      assert(legacy.uiFeedback.checks.some((check) => check.name === "issue-output" && check.state === "truncated"));
      const v2 = await analyzeUiCandidate(
        client,
        "Display",
        "content/index.html",
        `${entries}<nodel-app offline-mode="unknown"><nodel-control-space></nodel-control-space></nodel-app>`,
        { maxIssues },
      );
      assert("summary" in v2);
      assert(v2.summary.errorCount >= 2);
      assert.equal(v2.uiFeedback.validation.errors, v2.summary.errorCount);
      assert.equal(v2.uiFeedback.validation.status, "errors");
      assert.equal(v2.uiFeedback.validation.complete, false);
      assert.equal(v2.uiFeedback.issues.length, maxIssues);
    }
  });
});

void test("binding work and retained diagnostics are bounded before constructing 50k issues (isolated CPU ceiling)", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import {validateV2Ui} from './dist/domain/ui/v2/validator.js';
    import {PINNED_V2_CONTRACT as contract} from './dist/domain/ui/v2/contract.js';
    const start=performance.now();
    const r=validateV2Ui({path:'content/index.html',contract,content:'<nodel-button actions="'+ 'X;'.repeat(50000)+'"></nodel-button>',actions:new Set(),actionsAvailable:true,maxIssues:1});
    assert(r.summary.incomplete); assert(r.summary.bindingWorkTruncated || !r.parse.complete);
    assert(r.issues.length<=1); assert(r.summary.errorCount<=4096);
    assert(performance.now()-start<1000); console.log('bounded');
  `,
    ],
    { cwd: new URL("..", import.meta.url), timeout: 2500, killSignal: "SIGKILL" },
  );
  assert.match(stdout, /bounded/u);
  // This list is below the parser tag-size limit, so the binding budget itself,
  // rather than the parser guard, is exercised.
  const result = validate(`<nodel-button actions="${"X;".repeat(25000)}"></nodel-button>`, {
    actions: new Set(),
    actionsAvailable: true,
    maxIssues: 1,
  });
  assert.equal(result.summary.bindingWorkTruncated, true);
  assert.equal(result.summary.countsAreLowerBounds, true);
  assert.equal(result.summary.errorCount, 4096);
  assert.equal(result.issues.length, 1);
});

void test("composition siblings and repeated large schemas cannot amplify synchronous work quadratically", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import {validateV2Ui} from './dist/domain/ui/v2/validator.js';
    import {PINNED_V2_CONTRACT as contract} from './dist/domain/ui/v2/contract.js';
    const start=performance.now();
    const wide='<nodel-column>'+'<nodel-group hidden fill></nodel-group>'.repeat(8000)+'</nodel-column>';
    const r=validateV2Ui({path:'content/index.html',contract,content:wide,maxIssues:0});
    assert.equal(r.parse.complete,true);
    assert.equal(r.summary.errorCount,0);
    const schema=Object.fromEntries(Array.from({length:30000},(_,i)=>['unknown'+i,null]));
    const s=validateV2Ui({path:'content/index.html',contract,content:'<nodel-button actions="'+'Go;'.repeat(4095)+'Go" arg="'+'x'.repeat(16000)+'"></nodel-button>',actionDefinitions:[{name:'Go',schema}],maxIssues:1});
    assert.equal(s.summary.errorCount,0);
    assert(s.summary.schemaChecksSkipped>=4095);
    assert(performance.now()-start<2500); console.log('bounded composition/schema');
  `,
    ],
    { cwd: new URL("..", import.meta.url), timeout: 4500, killSignal: "SIGKILL" },
  );
  assert.match(stdout, /bounded composition\/schema/u);
});

void test("the existing v1 maxIssues option still honors bounded explicit values above the default 200", async () => {
  await fixture(async (client) => {
    const result = await verifyUiFile(
      client,
      "Display",
      "content/index.xml",
      `<pages>${"<row/>".repeat(600)}</pages>`,
      false,
      100,
      500,
    );
    assert("summary" in result);
    assert.equal(result.summary.returnedIssueCount, 500);
    assert.equal(result.uiFeedback.issues.length, 500);
    assert.equal(result.summary.errorCount, result.uiFeedback.validation.errors);
    assert.equal(result.uiFeedback.validation.complete, false);
  });
});

void test("actual v1 parser/rules stop on deep XML and node/attribute/work limits without recursion overflow", async () => {
  const deep = `<pages>${"<row>".repeat(12000)}${"</row>".repeat(12000)}</pages>`;
  const direct = validateV1Ui({
    path: "content/index.xml",
    content: deep,
    source: "provided",
    actions: {},
    signals: {},
    filePaths: [],
  });
  assert.equal(direct.parse.complete, false);
  assert.equal(direct.parse.truncationReason, "depth");
  assert(direct.summary.elementCount <= 128);
  const malformedFirst = validateV1Ui({
    path: "content/index.xml",
    content: deep.replace("<pages>", "<pages>&unknown;"),
    source: "provided",
    actions: {},
    signals: {},
    filePaths: [],
  });
  assert.equal(malformedFirst.parse.complete, false);
  assert(malformedFirst.issues.some((issue) => issue.code === "UI_XML_NOT_WELL_FORMED"));
  assert(malformedFirst.summary.errorCount > 0, "resource stops must preserve earlier definite XML errors");
  await fixture(async (client) => {
    const result = await analyzeUiCandidate(client, "Display", "content/index.xml", deep, {
      automatic: true,
      selection: "v1",
    });
    assert.equal(result.uiFeedback.validation.complete, false);
    assert(result.uiFeedback.checks.some((check) => check.name === "static-validation" && check.state === "truncated"));
  });
  const wide = validateV1Ui({
    path: "content/index.xml",
    content: `<pages>${"<row/>".repeat(22000)}</pages>`,
    source: "provided",
    actions: {},
    signals: {},
    filePaths: [],
  });
  assert.equal(wide.parse.truncationReason, "node_count");
  const attrs = validateV1Ui({
    path: "content/index.xml",
    content: `<pages ${Array.from({ length: 400 }, (_, i) => `a${i}=""`).join(" ")}/>`,
    source: "provided",
    actions: {},
    signals: {},
    filePaths: [],
  });
  assert.equal(attrs.parse.truncationReason, "attributes_per_tag");
});

void test("automatic candidate analysis declines resource-truncated format evidence, including original content", async () => {
  await fixture(async (client, state) => {
    const nested = "<div>".repeat(140);
    for (const entry of [
      { path: "content/index.xml", content: `<pages>${nested}<nodel-button/>` },
      { path: "content/index.html", content: `<nodel-button></nodel-button>${nested}<pages/>` },
      { path: "content/index.xml", content: `<pages>${"<row/>".repeat(22000)}</pages>` },
      { path: "content/index.xml", content: `<pages ${Array.from({ length: 400 }, (_, i) => `a${i}=""`).join(" ")}/>` },
    ]) {
      for (const original of [false, true]) {
        const result = await analyzeUiCandidate(client, "Display", entry.path, original ? "<pages/>" : entry.content, {
          automatic: true,
          ...(original ? { originalContent: entry.content } : {}),
        });
        assert.equal(result.uiFeedback.selectedFormat, undefined);
        assert.equal(result.uiFeedback.validation.complete, false);
        assert.match(result.uiFeedback.detection.explanation!, /resource-truncated/u);
        assert(
          result.uiFeedback.checks.some((check) => check.name === "format-recognition" && check.state === "truncated"),
        );
        assert(!result.uiFeedback.checks.some((check) => check.name === "static-validation"));
        assert("recognition" in result);
        assert(result.recognition);
        assert.equal(result.recognition.selectedFormat, undefined);
      }
    }
    assert.equal(state.requests.length, 0, "declining format must not start enrichment");
  });
});

void test("40k real listing is capped before composition/path traversal, well inside the automatic deadline", async () => {
  await fixture(async (client, state) => {
    state.files = Array.from({ length: 40000 }, (_, index) => `ingredient${String(index).padStart(5, "0")}.py`);
    assert(Buffer.byteLength(JSON.stringify(state.files)) < 1024 * 1024);
    const start = performance.now();
    const result = await analyzeUiCandidate(client, "Display", "content/index.xml", xml, { automatic: true });
    assert(performance.now() - start < 1000, "bounded listing must not consume the 3s deadline");
    assert.equal(result.uiFeedback.validation.complete, false);
    assert(result.uiFeedback.checks.some((check) => check.name === "files" && check.state === "failed"));
    assert.equal(
      state.requests.some((request) => request.endsWith(".py")),
      false,
    );
  });
});

void test("stalled independent enrichment cancels real HTTP reads and does not erase static errors", async () => {
  await fixture(async (client, state) => {
    state.stalls.add("events");
    const start = performance.now();
    const result = await analyzeUiCandidate(
      client,
      "Display",
      "content/index.xml",
      '<pages><button action="Missing" event="Unknown"/></pages>',
      { automatic: true },
    );
    assert(performance.now() - start < 1000);
    assert.equal(result.uiFeedback.validation.status, "errors");
    assert.equal(result.uiFeedback.validation.complete, false);
    assert(result.uiFeedback.issues.some((issue) => issue.code === "UI_ACTION_MISSING"));
    assert.equal(
      result.uiFeedback.issues.some((issue) => issue.code === "UI_EVENT_MISSING"),
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert(state.closed.includes("events"));
  }, 100);
});

void test("a deployed contract with a 404 entry script cannot produce a complete pass", async () => {
  await fixture(async (client, state) => {
    state.scriptStatus = 404;
    const result = await analyzeUiCandidate(client, "Display", "content/index.html", html);
    const feedback = result.uiFeedback as UiAdvisoryEnvelope;
    assert.equal(feedback.provenance?.contractSource, "deployed");
    assert.notEqual(feedback.validation.status, "passed");
    assert.equal(feedback.validation.complete, false);
    assert(feedback.checks.some((check) => check.name === "runtime-support" && check.state !== "completed"));
    assert(feedback.issues.some((issue) => issue.code === "UI_V2_RUNTIME_SUPPORT_UNCONFIRMED"));
  });
  assert(
    errors(validate(html.replace('type="module" ', ""))).some((issue) => issue.code === "UI_V2_SCRIPT_MODULE_REQUIRED"),
  );
});

void test("unavailable/invalid nodeConfig leaves recipe load order unknown, not a fake successful default script", async () => {
  await fixture(async (client, state) => {
    state.files = ["nodeConfig.json", "script.py", "custom.py"];
    for (const badConfig of ["http_failure", "{invalid", '{"dependencies":false}', "null", "[]"]) {
      state.requests.length = 0;
      state.failures.clear();
      if (badConfig === "http_failure") state.failures.add("nodeConfig.json");
      else state.contents["nodeConfig.json"] = badConfig;
      const result = await analyzeUiCandidate(client, "Display", "content/index.xml", xml);
      assert.equal(result.uiFeedback.validation.complete, false);
      assert(
        result.uiFeedback.checks.some(
          (check) => check.name === "recipe-context" && check.state === "failed" && /unknown/u.test(check.reason ?? ""),
        ),
      );
      assert.equal(state.requests.includes("script.py"), false);
    }
  });
});

void test("pad/palette derive default phases; action-on/off aliases are literal, and action matching follows Java", () => {
  const result = validate(
    '<nodel-pad action="Move"></nodel-pad><nodel-palette action="Mix"></nodel-palette><nodel-button action-on="foo;bar" action-off="Other,Name" action="set light"></nodel-button>',
    {
      actions: new Set(["Move", "Mix", "foo;bar", "Other,Name", "Set-Light"]),
      actionsAvailable: true,
    },
  );
  assert.deepEqual(errors(result), []);
  assert.equal(javaActionName("Crème Brûlée"), "cremebrulee");
  assert.equal(javaActionName("Light (operator note) -- trailing comment"), "light");
  assert.equal(javaActionName("Éclair"), "eclair");
  assert.notEqual(javaActionName("Set–Light"), javaActionName("Set-Light")); // non-ASCII punctuation survives
  assert.notEqual(javaActionName("\ufeffGo"), javaActionName("Go"));
  const ambiguous = validate('<nodel-button action="set light" arg="5"></nodel-button>', {
    actionDefinitions: [
      { name: "Set-Light", schema: { type: "string" } },
      { name: "Set Light", schema: { type: "number" } },
    ],
  });
  assert(ambiguous.issues.some((issue) => issue.code === "UI_V2_ACTION_AMBIGUOUS"));
  assert(ambiguous.summary.schemaChecksSkipped > 0);
});

void test("signals require a real target, preserve FEFF, exact case/punctuation and escaped-dot property paths", () => {
  const missingTarget = validate('<nodel-pad signal="Status"></nodel-pad>', { signals: new Set(["Status"]) });
  assert(errors(missingTarget).some((issue) => issue.code === "UI_V2_SIGNAL_TARGET_INVALID"));
  const valid = validate('<nodel-button signals="\ufeffStatus:label;Door\\.West.state:active(any)"></nodel-button>', {
    signals: new Set(["\ufeffStatus", "Door.West"]),
  });
  assert.deepEqual(errors(valid), []);
  const invalid = validate(
    '<nodel-button signal="\ufeffStatus"></nodel-button><nodel-button signal="status"></nodel-button><nodel-button signal="Door..state"></nodel-button>',
    { signals: new Set(["Status", "Door"]) },
  );
  assert.equal(errors(invalid).filter((issue) => issue.code === "UI_V2_EVENT_MISSING").length, 2);
  assert(errors(invalid).some((issue) => issue.code === "UI_V2_SIGNAL_BINDING_INVALID"));
});

void test("shortcut strict grammar rejects empty lists/entries and trailing separators; code confirmation checks default ConfirmCode", () => {
  for (const action of ["Go;", "Go,", "", "Go:", ":trigger", "Go;;Other", "Go:click"]) {
    const result = validate(`<nodel-app><nodel-shortcut key="g" action="${action}"></nodel-shortcut></nodel-app>`, {
      actions: new Set(["Go", "Other"]),
    });
    assert(
      errors(result).some((issue) =>
        ["UI_V2_SHORTCUT_ACTION_GRAMMAR", "UI_V2_ACTION_BINDING_INVALID", "UI_V2_SHORTCUT_ACTION_REQUIRED"].includes(
          issue.code,
        ),
      ),
      action,
    );
  }
  assert.deepEqual(
    errors(
      validate('<nodel-app><nodel-shortcut key="g" action="Go:trigger"></nodel-shortcut></nodel-app>', {
        actions: new Set(["Go"]),
      }),
    ),
    [],
  );
  assert.deepEqual(
    errors(
      validate('<nodel-app><nodel-shortcut key=" " action="Go"></nodel-shortcut></nodel-app>', {
        actions: new Set(["Go"]),
      }),
    ),
    [],
  );
  const missing = validate('<nodel-button confirm-mode="code"></nodel-button>', { signals: new Set() });
  assert(
    errors(missing).some(
      (issue) => issue.code === "UI_V2_CONFIRM_SIGNAL_MISSING" && /ConfirmCode/u.test(issue.message),
    ),
  );
  assert.deepEqual(
    errors(validate('<nodel-button confirm-mode="code"></nodel-button>', { signals: new Set(["ConfirmCode"]) })),
    [],
  );
});

void test("local nodel-image assets are checked against file listing at page/base URLs; absence is only a warning", async () => {
  await fixture(async (client, state) => {
    const result = await analyzeUiCandidate(
      client,
      "Display",
      "content/index.html",
      `${html}<nodel-image src="missing.png"></nodel-image>`,
    );
    assert(
      result.uiFeedback.issues.some((issue) => issue.code === "UI_V2_ASSET_MISSING" && issue.severity === "warning"),
    );
    state.failures.add("files");
    const unavailable = await analyzeUiCandidate(
      client,
      "Display",
      "content/index.html",
      `${html}<nodel-image src="missing.png"></nodel-image>`,
    );
    assert.equal(unavailable.uiFeedback.validation.complete, false);
    assert(unavailable.uiFeedback.issues.some((issue) => issue.code === "UI_V2_ASSET_CHECK_SKIPPED"));
    assert.equal(
      unavailable.uiFeedback.issues.some((issue) => issue.code === "UI_V2_ASSET_MISSING"),
      false,
    );
  });
  const local = validate('<base href="../shared/"><nodel-image src="photo.png?version=1"></nodel-image>', {
    path: "content/room/control.html",
    filePaths: ["content/shared/photo.png"],
  });
  assert.equal(
    local.issues.some((issue) => issue.code === "UI_V2_ASSET_MISSING"),
    false,
  );
});

void test("safe static typed args use live action schemas; dynamic or unsupported schemas are explicitly skipped", async () => {
  await fixture(async (client, state) => {
    state.actions = { Go: { schema: { type: "string" } } };
    const result = await analyzeUiCandidate(
      client,
      "Display",
      "content/index.html",
      `${html}<nodel-button action="Go" arg-type="number" arg="5"></nodel-button>`,
    );
    assert(result.uiFeedback.issues.some((issue) => issue.code === "UI_V2_ARG_SCHEMA_MISMATCH"));
    assert.equal(result.uiFeedback.validation.status, "errors");
  });
  for (const [type, arg, schema] of [
    ["number", "5", { type: "number", minimum: 0, maximum: 10 }],
    ["boolean", "yes", { type: "boolean" }],
    ["json", "5", { type: "integer", enum: [5] }],
  ] as const) {
    const result = validate(`<nodel-button action="Go" arg-type="${type}" arg="${arg}"></nodel-button>`, {
      actionDefinitions: [{ name: "Go", schema }],
    });
    assert.deepEqual(errors(result), []);
    assert.equal(result.summary.schemaChecksSkipped, 0);
  }
  const unknown = validate('<nodel-button action="Go" arg="value"></nodel-button>', {
    actionDefinitions: [{ name: "Go", schema: { type: "string", pattern: "(a+)+$" } }],
  });
  assert.equal(unknown.summary.schemaChecksSkipped, 1);
  assert(unknown.issues.some((issue) => issue.code === "UI_V2_SCHEMA_CHECK_SKIPPED"));
  const dynamic = validate('<nodel-button action="Go" arg="{{value}}"></nodel-button>', {
    actionDefinitions: [{ name: "Go", schema: { type: "number" } }],
  });
  assert.equal(dynamic.summary.schemaChecksSkipped, 1);
  assert.equal(
    dynamic.issues.some((issue) => issue.code === "UI_V2_ARG_SCHEMA_MISMATCH"),
    false,
  );
  assert(
    errors(validate('<nodel-button action="Go" arg-type="number" arg="5cats"></nodel-button>')).some(
      (issue) => issue.code === "UI_V2_ARG_INVALID",
    ),
  );
});

void test("inline template children use rendered sibling parent; external template parent remains explicitly unknown", () => {
  const inline = validate(
    '<nodel-control-grid><nodel-template repeat="2"><template><nodel-control-space></nodel-control-space></template></nodel-template></nodel-control-grid>',
  );
  assert.equal(
    inline.issues.some((issue) => issue.code === "UI_V2_PARENT_REQUIRED"),
    false,
  );
  const nested = validate(
    "<nodel-control-grid><nodel-template><template><nodel-template><template><nodel-control-space></nodel-control-space></template></nodel-template></template></nodel-template></nodel-control-grid>",
  );
  assert.equal(
    nested.issues.some((issue) => issue.code === "UI_V2_PARENT_REQUIRED"),
    false,
  );
  const unknown = validate(
    '<template id="space"><nodel-control-space></nodel-control-space></template><nodel-template template="space"></nodel-template>',
  );
  assert.equal(
    unknown.issues.some((issue) => issue.code === "UI_V2_PARENT_REQUIRED"),
    false,
  );
  assert(unknown.issues.some((issue) => issue.code === "UI_V2_TEMPLATE_PARENT_UNKNOWN"));
  assert(
    errors(validate("<nodel-control-space></nodel-control-space>")).some(
      (issue) => issue.code === "UI_V2_PARENT_REQUIRED",
    ),
  );
});

void test("template repeat uses Number/truncation/fallback, not parseInt; integer-prefix parsing is explicit per component", () => {
  const empty = validate('<nodel-template repeat=""><template><div></div></template></nodel-template>');
  assert.equal(
    empty.issues.some((issue) => issue.code.startsWith("UI_V2_NUMBER")),
    false,
  );
  const fallback = validate('<nodel-template repeat="3cats"><template><div></div></template></nodel-template>');
  assert(
    fallback.issues.some((issue) => issue.code === "UI_V2_NUMBER_FALLBACK" && /fallback of 1/u.test(issue.message)),
  );
  assert.equal(
    fallback.issues.some((issue) => issue.code === "UI_V2_NUMBER_INVALID" || issue.code === "UI_V2_NUMBER_NORMALIZED"),
    false,
  );
  assert(
    validate('<nodel-template repeat="3.5"></nodel-template>').issues.some(
      (issue) => issue.code === "UI_V2_NUMBER_NORMALIZED",
    ),
  );
  const palette = validate('<nodel-palette columns="3cats" live-interval="1e3"></nodel-palette>');
  assert.deepEqual(errors(palette), []);
  assert.equal(palette.issues.filter((issue) => issue.code === "UI_V2_NUMBER_NORMALIZED").length, 2);
});

void test("strict live decoders reject malformed catalogues instead of proving an empty catalogue", async () => {
  await fixture(async (client, state) => {
    for (const [actions, signals, files] of [
      [[null], { error: "unavailable" }, [42]],
      [{ Go: {}, error: "unavailable" }, [null], [{ path: 42 }]],
      [JSON.parse('{"__proto__":{"schema":{}}}') as unknown, { error: "unavailable" }, [42]],
    ]) {
      state.actions = actions;
      state.signals = signals;
      state.files = files;
      for (const content of [xml, xml.replace("<button/>", '<button action="Missing" event="Unknown"/>')]) {
        const result = await analyzeUiCandidate(client, "Display", "content/index.xml", content);
        assert.equal(result.uiFeedback.validation.complete, false);
        assert.notEqual(result.uiFeedback.validation.status, "passed");
        for (const name of ["actions", "events", "files"])
          assert(
            result.uiFeedback.checks.some((check) => check.name === name && check.state === "failed"),
            name,
          );
        assert.equal(
          result.uiFeedback.issues.some((issue) => ["UI_ACTION_MISSING", "UI_EVENT_MISSING"].includes(issue.code)),
          false,
        );
      }
      const v2 = await analyzeUiCandidate(
        client,
        "Display",
        "content/index.html",
        `${html}<nodel-button action="Missing" signal="Unknown"></nodel-button>`,
      );
      assert.equal(v2.uiFeedback.validation.complete, false);
      assert.equal(
        v2.uiFeedback.issues.some((issue) => ["UI_V2_ACTION_MISSING", "UI_V2_EVENT_MISSING"].includes(issue.code)),
        false,
      );
    }
  });
});

void test("options-signal uses the source-backed options default only for declared selected-contract features", async () => {
  for (const component of ["nodel-select", "nodel-segmented"]) {
    const result = validate(`<${component} options-signal="AvailableOptions"></${component}>`, {
      signals: new Set(["AvailableOptions"]),
    });
    assert.deepEqual(errors(result), []);
    const invalid = validate(`<${component} options-signal="AvailableOptions:not-options"></${component}>`, {
      signals: new Set(["AvailableOptions"]),
    });
    assert(errors(invalid).some((issue) => issue.code === "UI_V2_SIGNAL_TARGET_INVALID"));
  }
  await fixture(async (client, state) => {
    state.signals = { AvailableOptions: { schema: { type: "array" } } };
    const result = await analyzeUiCandidate(
      client,
      "Display",
      "content/index.html",
      `${html}<nodel-select options-signal="AvailableOptions"></nodel-select><nodel-segmented options-signal="AvailableOptions"></nodel-segmented>`,
    );
    assert.equal(
      result.uiFeedback.issues.some((issue) => issue.code === "UI_V2_SIGNAL_TARGET_INVALID"),
      false,
    );
    assert.equal(result.uiFeedback.provenance?.contractSource, "deployed");
  });
  const older = structuredClone(PINNED_V2_CONTRACT);
  older.packageVersion = "0.1.0";
  const unknownDefault = validate('<nodel-select options-signal="AvailableOptions"></nodel-select>', {
    contract: older,
    signals: new Set(["AvailableOptions"]),
  });
  assert.equal(
    unknownDefault.issues.some((issue) => issue.code === "UI_V2_SIGNAL_TARGET_INVALID"),
    false,
  );
  assert(unknownDefault.issues.some((issue) => issue.code === "UI_V2_SIGNAL_DEFAULT_UNKNOWN"));
  assert.equal(unknownDefault.summary.incomplete, true);
});

void test("selected older/feature-reduced contracts never acquire hardcoded requirements from the bundled contract", async () => {
  const older = structuredClone(PINNED_V2_CONTRACT);
  older.packageVersion = "0.1.0";
  older.elements = older.elements.filter((element) => element.name !== "nodel-shortcut");
  const source = `${html}<nodel-shortcut></nodel-shortcut>`;
  const direct = validate(source, { contract: older });
  assert(direct.issues.some((issue) => issue.code === "UI_V2_COMPONENT_UNKNOWN"));
  assert.equal(
    direct.issues.some((issue) => issue.code.startsWith("UI_V2_SHORTCUT_")),
    false,
  );
  const unknownEntry = validate('<script src="./v2/nodel-webui.js"></script>', { contract: older });
  assert.equal(
    unknownEntry.issues.some((issue) => issue.code === "UI_V2_SCRIPT_MODULE_REQUIRED"),
    false,
  );
  assert(unknownEntry.issues.some((issue) => issue.code === "UI_V2_ENTRY_RULES_UNCHECKED"));
  assert.equal(unknownEntry.summary.incomplete, true);
  await fixture(async (client, state) => {
    state.contract = older;
    const result = await analyzeUiCandidate(client, "Display", "content/index.html", source);
    assert.equal(result.uiFeedback.provenance?.contractSource, "deployed");
    assert.equal(result.uiFeedback.provenance?.packageVersion, "0.1.0");
    assert(result.uiFeedback.issues.some((issue) => issue.code === "UI_V2_COMPONENT_UNKNOWN"));
    assert.equal(
      result.uiFeedback.issues.some((issue) => issue.code.startsWith("UI_V2_SHORTCUT_")),
      false,
    );
  });
  const reduced = structuredClone(PINNED_V2_CONTRACT);
  const absent = structuredClone(PINNED_V2_CONTRACT);
  absent.elements = absent.elements.filter((element) => element.name !== "nodel-shortcut");
  const unknownDocument = validate("<!doctype html><nodel-shortcut></nodel-shortcut>", { contract: absent });
  assert.deepEqual(errors(unknownDocument), []);
  assert(unknownDocument.issues.some((issue) => issue.code === "UI_V2_COMPONENT_UNKNOWN"));
  const shortcut = reduced.elements.find((element) => element.name === "nodel-shortcut")!;
  shortcut.attributes = shortcut.attributes.filter(
    (attribute) => !["key", "ctrl", "alt", "shift", "meta"].includes(attribute.name),
  );
  shortcut.actionBindings = [];
  const link = reduced.elements.find((element) => element.name === "nodel-link")!;
  link.attributes = link.attributes.filter((attribute) => !["href", "node", "event-binding"].includes(attribute.name));
  assert.equal(
    errors(
      validate("<nodel-app><nodel-shortcut></nodel-shortcut><nodel-link></nodel-link></nodel-app>", {
        contract: reduced,
      }),
    ).some((issue) => issue.code.startsWith("UI_V2_SHORTCUT_") || issue.code.startsWith("UI_V2_LINK_DESTINATION")),
    false,
  );
  reduced.elements = reduced.elements.filter((element) => element.name !== "nodel-template");
  const clone = validate(
    "<nodel-control-grid><nodel-template><template><nodel-control-space></nodel-control-space></template></nodel-template></nodel-control-grid>",
    { contract: reduced },
  );
  assert.equal(
    clone.issues.some((issue) => issue.code === "UI_V2_PARENT_REQUIRED"),
    false,
  );
  assert(clone.issues.some((issue) => issue.code === "UI_V2_TEMPLATE_PARENT_UNKNOWN"));
});

void test("UTF-16 strings and their exact UTF-8 byte encoding have identical analysis, including lone surrogates", async () => {
  await fixture(async (client) => {
    for (const [path, source] of [
      ["content/index.xml", xml.replace("<button/>", "<text>\ud800</text>")],
      ["content/index.html", `${html}<nodel-button label="\udfff"></nodel-button>`],
    ]) {
      const bytes = Buffer.from(source!, "utf8");
      const textResult = await analyzeUiCandidate(client, "Display", path!, source);
      const byteResult = await analyzeUiCandidate(client, "Display", path!, bytes);
      assert.equal(textResult.uiFeedback.sha256, hash(bytes));
      assert.equal(byteResult.uiFeedback.sha256, textResult.uiFeedback.sha256);
      assert.deepEqual(textResult.uiFeedback.validation, byteResult.uiFeedback.validation);
      assert.deepEqual(textResult.uiFeedback.issues, byteResult.uiFeedback.issues);
      assert.deepEqual(textResult.uiFeedback.detection, byteResult.uiFeedback.detection);
    }
  });
});

void test("pad direction bindings override the shared fallback only when every applicable direction has specific bindings", () => {
  const directions = ["up", "down", "left", "right", "center"];
  const all = directions.map((direction) => `${direction}-action="Go"`).join(" ");
  const complete = validate(`<nodel-pad action="Missing" ${all}></nodel-pad>`, { actions: new Set(["Go"]) });
  assert.equal(
    complete.issues.some((issue) => issue.code === "UI_V2_ACTION_MISSING"),
    false,
  );
  const partial = validate('<nodel-pad action="Missing" up-action="Go"></nodel-pad>', { actions: new Set(["Go"]) });
  assert(partial.issues.some((issue) => issue.code === "UI_V2_ACTION_MISSING" && /Missing/u.test(issue.message)));
  const emptyOverride = validate(
    `<nodel-pad action="Missing" ${directions.map((direction) => `${direction}-actions="${direction === "center" ? "; ," : "Go"}"`).join(" ")}></nodel-pad>`,
    { actions: new Set(["Go"]) },
  );
  assert(emptyOverride.issues.some((issue) => issue.code === "UI_V2_ACTION_MISSING"));
  const hiddenCenter = validate(
    `<nodel-pad center="hide" action="Missing" ${directions
      .slice(0, 4)
      .map((direction) => `${direction}-actions="Go:click"`)
      .join(" ")}></nodel-pad>`,
    { actions: new Set(["Go"]) },
  );
  assert.equal(
    hiddenCenter.issues.some((issue) => issue.code === "UI_V2_ACTION_MISSING"),
    false,
  );
});

void test("asset resolution uses canonical segment encoding and leaves outside-content browser paths unknown", () => {
  for (const folder of ["100%25", "literal%", "room name", "灯光"]) {
    const result = validate('<nodel-image src="logo.png"></nodel-image>', {
      path: `content/${folder}/index.html`,
      filePaths: [`content/${folder}/logo.png`],
    });
    assert.equal(
      result.issues.some((issue) => issue.code === "UI_V2_ASSET_MISSING"),
      false,
      folder,
    );
  }
  const outside = validate('<nodel-image src="logo.png"></nodel-image>', { path: "custom/index.html", filePaths: [] });
  assert.equal(
    outside.issues.some((issue) => issue.code === "UI_V2_ASSET_MISSING"),
    false,
  );
  assert(outside.issues.some((issue) => issue.code === "UI_V2_ASSET_PATH_UNCHECKED"));
  assert.equal(outside.summary.incomplete, true);
});

void test("missing action discovery leaves generated/dynamic argument schema coverage skipped without a literal arg", async () => {
  await fixture(async (client, state) => {
    state.failures.add("actions");
    const result = await analyzeUiCandidate(
      client,
      "Display",
      "content/index.html",
      `${html}<nodel-pad action="Move"></nodel-pad>`,
    );
    assert(result.uiFeedback.checks.some((check) => check.name === "actions" && check.state === "failed"));
    assert(result.uiFeedback.checks.some((check) => check.name === "point-schemas" && check.state === "skipped"));
    assert(result.uiFeedback.issues.some((issue) => issue.code === "UI_V2_SCHEMA_CHECK_SKIPPED"));
    assert.equal(result.uiFeedback.validation.complete, false);
    assert.equal(
      result.uiFeedback.issues.some((issue) => issue.code === "UI_V2_ACTION_MISSING"),
      false,
    );
    const noLiteralBindings = await analyzeUiCandidate(
      client,
      "Display",
      "content/index.html",
      `${html}<nodel-pad></nodel-pad>`,
    );
    assert(
      noLiteralBindings.uiFeedback.checks.some((check) => check.name === "point-schemas" && check.state === "skipped"),
    );
  });
});

for (const [automatic, budget] of [
  [true, 3000],
  [false, 10000],
] as const) {
  void test(`${automatic ? "automatic 3s" : "explicit 10s"} deadline: stalled actions do not delay fast files, recipe, or schema enrichment`, async () => {
    await fixture(async (client, state) => {
      state.stalls.add("actions");
      state.files = ["script.py", "content/schemas.json"];
      state.contents["script.py"] = "# loadIndexFile schemaMap schemaMap.get(eType)";
      state.contents["content/schemas.json"] = "{}";
      const start = performance.now();
      const result = await analyzeUiCandidate(client, "Display", "content/index.xml", xml, { automatic });
      const elapsed = performance.now() - start;
      assert(elapsed >= budget - 200 && elapsed < budget + 1200, `aggregate budget was ${elapsed}ms`);
      for (const path of ["script.py", "content/schemas.json"]) {
        assert(state.requestedAt.has(path), path);
        assert(state.requestedAt.get(path)! - start < 1000, `${path} must start before the stalled action deadline`);
      }
      for (const name of ["files", "recipe-context", "schemas"])
        assert(
          result.uiFeedback.checks.some((check) => check.name === name && check.state === "completed"),
          name,
        );
      assert(result.uiFeedback.checks.some((check) => check.name === "actions" && check.state === "failed"));
      assert("frontendParser" in result);
      assert.equal(result.frontendParser.detected, true);
      assert.equal(result.frontendParser.schemaFilePresent, true);
      assert.equal(result.uiFeedback.validation.complete, false);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert(state.closed.includes("actions"));
    }, 20000);
  });
}

void test("a stalled nodeConfig read does not delay or discard an independent completed schemas file", async () => {
  await fixture(async (client, state) => {
    state.files = ["nodeConfig.json", "script.py", "content/schemas.json"];
    state.stalls.add("nodeConfig.json");
    state.contents["content/schemas.json"] = "{}";
    const result = await analyzeUiCandidate(client, "Display", "content/index.xml", xml);
    assert(result.uiFeedback.checks.some((check) => check.name === "recipe-context" && check.state === "failed"));
    assert(result.uiFeedback.checks.some((check) => check.name === "schemas" && check.state === "completed"));
    assert.equal(state.requests.includes("content/schemas.json"), true);
  }, 100);
});

void test("operation identity stays pinned while standalone capability refresh re-resolves", async () => {
  await fixture(async (clientA, stateA) => {
    await fixture(async (clientB, stateB) => {
      const a = await clientA.resolveNode("Display");
      const b = await clientB.resolveNode("Display");
      stateA.contract = { invalid: true };
      stateA.scriptStatus = 404;
      let stringResolutions = 0;
      const facade = new Proxy(clientA, {
        get(target, property) {
          if (property === "resolveStaticAssetRequest")
            return (
              node: Parameters<NodelClient["resolveStaticAssetRequest"]>[0],
              ...args: Parameters<NodelClient["resolveStaticAssetRequest"]> extends [unknown, ...infer R] ? R : never
            ) => {
              if (typeof node === "string") {
                stringResolutions++;
                return clientB.resolveStaticAssetRequest(b, ...args);
              }
              return (node === b ? clientB : clientA).resolveStaticAssetRequest(node, ...args);
            };
          if (property === "readStaticAsset")
            return (
              node: Parameters<NodelClient["readStaticAsset"]>[0],
              ...args: Parameters<NodelClient["readStaticAsset"]> extends [unknown, ...infer R] ? R : never
            ) => (node === b ? clientB : clientA).readStaticAsset(node, ...args);
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const result = await analyzeUiCandidate(facade, a, "content/index.html", html, { refresh: true });
      assert.equal(result.uiFeedback.provenance?.deploymentApplicable, false);
      assert.equal(result.uiFeedback.capabilities?.state, "incompatible_contract");
      assert.equal(stringResolutions, 0);
      assert.equal(stateB.requests.filter((entry) => entry.startsWith("nodel-")).length, 0);
      assert(stateA.requests.includes("actions"));
      stateA.contents["content/index.html"] = html;
      const saved = await analyzeUiCandidate(facade, "Display", "content/index.html", undefined, { refresh: true });
      assert.equal(saved.uiFeedback.provenance?.deploymentApplicable, false);
      assert.equal(saved.uiFeedback.sha256, hash(html));
      assert.equal(stringResolutions, 0);
      const standalone = await getUiCapabilities(facade, "Display", "content/index.html", { refresh: true });
      assert.equal(stringResolutions, 1);
      assert.equal(standalone.state, "available");
      const pinned = await getUiCapabilityContext(facade, a, "content/index.html", { refresh: true });
      assert.equal(pinned.provenance.deploymentApplicable, false);
      assert.equal(stringResolutions, 1);
    });
  });
});

void test("unnamed array definitions never fabricate numeric identities or authoritative absence", async () => {
  await fixture(async (client, state) => {
    for (const definitions of [[{}], [{ name: " " }], [{ title: "" }], { " ": {} }]) {
      state.actions = definitions;
      const result = await analyzeUiCandidate(
        client,
        "Display",
        "content/index.xml",
        xml.replace("<button/>", '<button action="0"/>'),
      );
      assert.equal(result.uiFeedback.validation.complete, false);
      assert(result.uiFeedback.checks.some((check) => check.name === "actions" && check.state === "failed"));
      assert(!result.uiFeedback.issues.some((issue) => issue.code === "UI_ACTION_MISSING"));
    }
    for (const definitions of [[{ name: "0" }], [{ title: "0" }], { "0": {} }]) {
      state.actions = definitions;
      const result = await analyzeUiCandidate(
        client,
        "Display",
        "content/index.xml",
        xml.replace("<button/>", '<button action="0"/>'),
      );
      assert.equal(result.uiFeedback.validation.complete, true);
    }
  });
});

void test("unsafe file listing isolates failure, preserves completed actions and closes a stalled event request", async () => {
  await fixture(async (client, state) => {
    state.files = ["../unsafe.py"];
    state.stalls.add("events");
    const result = await analyzeUiCandidate(
      client,
      "Display",
      "content/index.xml",
      xml.replace("<button/>", '<button action="Missing"/>'),
    );
    assert(result.uiFeedback.checks.some((check) => check.name === "actions" && check.state === "completed"));
    assert(result.uiFeedback.issues.some((issue) => issue.code === "UI_ACTION_MISSING"));
    assert.equal(result.uiFeedback.validation.complete, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert(state.closed.includes("events"), "actual HTTP response closed before fixture cleanup");
    assert(!state.requests.includes("../unsafe.py"));
  }, 150);
});

void test("parser truncation cannot assert a missing shell or child from an unparsed suffix", () => {
  const result = validate(
    `<!doctype html><html><body><nodel-button bad-attribute="x"></nodel-button><div data-long="${"x".repeat(70000)}"></div><nodel-app><nodel-page></nodel-page></nodel-app></body></html>`,
  );
  assert.equal(result.parse.complete, false);
  assert(!result.issues.some((issue) => issue.code === "UI_V2_APP_SHELL_MISSING"));
  assert(result.issues.some((issue) => issue.code === "UI_V2_ATTRIBUTE_UNKNOWN"));
  const contract = structuredClone(PINNED_V2_CONTRACT);
  contract.elements.find((entry) => entry.name === "nodel-app")!.composition = {
    requiredDirectChildren: ["nodel-page"],
  };
  const partialChildren = validate(
    `<nodel-app><div data-long="${"x".repeat(70000)}"></div><nodel-page></nodel-page></nodel-app>`,
    { contract },
  );
  assert.equal(partialChildren.parse.complete, false);
  assert(!partialChildren.issues.some((issue) => issue.code === "UI_V2_CHILD_REQUIRED"));
});

void test("an early file policy rejection cancels and drains independent real HTTP reads", async () => {
  await fixture(async (client, state) => {
    state.stalls.add("events");
    const facade = new Proxy(client, {
      get(target, property) {
        if (property === "nodeRequest")
          return async (...args: Parameters<NodelClient["nodeRequest"]>) => {
            if (args[1] === "files") {
              await new Promise((resolve) => setTimeout(resolve, 50));
              throw publicError("POLICY", "Fixture file policy rejection.");
            }
            return client.nodeRequest(...args);
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await assert.rejects(analyzeUiCandidate(facade, "Display", "content/index.xml", xml), { code: "POLICY" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert(state.requests.includes("events"));
    assert(state.closed.includes("events"), "policy propagation must not leave a real request alive");
  }, 2000);
});

void test("malformed activity and schema bodies are failed evidence, not successful empty catalogues", async () => {
  await fixture(async (client, state) => {
    for (const activity of [{ error: "unavailable" }, [{}], [{ alias: "Value" }], [{ alias: "", arg: 1 }]]) {
      state.activity = activity;
      const result = await analyzeUiCandidate(client, "Display", "content/index.xml", xml, { includeLiveValues: true });
      assert.equal(result.uiFeedback.validation.complete, false);
      assert(result.uiFeedback.checks.some((check) => check.name === "live-values" && check.state === "failed"));
    }
    for (const activity of [[], { entries: [] }, [{ alias: "Value", arg: null }]]) {
      state.activity = activity;
      const result = await analyzeUiCandidate(client, "Display", "content/index.xml", xml, { includeLiveValues: true });
      assert(result.uiFeedback.checks.some((check) => check.name === "live-values" && check.state === "completed"));
    }
    state.files = ["content/schemas.json"];
    for (const schema of ["{bad", "[]", "null", ""]) {
      state.contents["content/schemas.json"] = schema;
      const result = await analyzeUiCandidate(client, "Display", "content/index.xml", xml);
      assert.equal(result.uiFeedback.validation.complete, false);
      assert(result.uiFeedback.checks.some((check) => check.name === "schemas" && check.state === "failed"));
      assert("summary" in result && result.summary.incomplete);
      assert(result.uiFeedback.issues.some((issue) => issue.code === "UI_FRONTEND_SCHEMA_CHECK_SKIPPED"));
    }
  });
});

void test("valid Nodel activity without optional arg does not suppress available option-value diagnostics", async () => {
  await fixture(async (client, state) => {
    const value = { seq: 1, source: "local", type: "event", alias: "Options", arg: [{ value: 123 }] };
    state.activity = [
      value,
      { seq: 2, source: "local", type: "action", alias: "Go" },
      { seq: 3, source: "local", type: "event", alias: "Options" },
      { seq: 4, source: "unbound", type: "eventBinding", alias: "Other" },
    ];
    const result = await analyzeUiCandidate(
      client,
      "Display",
      "content/index.xml",
      xml.replace("<button/>", '<dynamicselect data="Options"/>'),
      { includeLiveValues: true },
    );
    assert(result.uiFeedback.checks.some((check) => check.name === "live-values" && check.state === "completed"));
    assert(result.uiFeedback.issues.some((issue) => issue.code === "UI_DYNAMIC_OPTION_SHAPE_INVALID"));
    state.activity = { error: "unavailable" };
    const malformed = await analyzeUiCandidate(client, "Display", "content/index.xml", xml, {
      includeLiveValues: true,
    });
    assert(malformed.uiFeedback.checks.some((check) => check.name === "live-values" && check.state === "failed"));
  });
});

void test("schema policy failure immediately cancels stalled config and catalogue HTTP reads before draining", async () => {
  await fixture(async (client, state) => {
    state.files = ["content/schemas.json", "nodeConfig.json"];
    state.stalls.add("nodeConfig.json");
    state.stalls.add("events");
    const rejection = publicError("POLICY", "Fixture schema policy rejection.");
    const facade = new Proxy(client, {
      get(target, property) {
        if (property === "getNodeFileContents")
          return async (...args: Parameters<NodelClient["getNodeFileContents"]>) => {
            if (args[1] === "content/schemas.json") {
              await new Promise((resolve) => setTimeout(resolve, 60));
              throw rejection;
            }
            return client.getNodeFileContents(...args);
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const start = performance.now();
    await assert.rejects(
      analyzeUiCandidate(facade, "Display", "content/index.xml", xml, { automatic: true }),
      (error: unknown) => error === rejection,
    );
    assert(performance.now() - start < 1000, "schema policy must not wait for the 3s context deadline");
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const path of ["events", "nodeConfig.json"]) {
      assert(state.requests.includes(path), `${path} was started`);
      assert(state.closed.includes(path), `${path} was cancelled before fixture cleanup`);
    }
  }, 5000);
});

void test("partial v1 parsing suppresses child absence while retaining definite catalog issues", async () => {
  await fixture(async (client) => {
    const content = `<?xml-stylesheet type="text/xsl" href="v1/index.xsl"?><pages bogus="x"><page title="${"x".repeat(70000)}"><row><column><button/></column></row></page></pages>`;
    const result = await analyzeUiCandidate(client, "Display", "content/index.xml", content, { selection: "v1" });
    assert.equal(result.uiFeedback.validation.complete, false);
    assert(result.uiFeedback.checks.some((check) => check.name === "static-validation" && check.state === "truncated"));
    assert(!result.uiFeedback.issues.some((issue) => issue.code === "UI_CHILD_REQUIRED"));
    assert(result.uiFeedback.issues.some((issue) => issue.code === "UI_ATTRIBUTE_UNSUPPORTED"));
    const complete = await analyzeUiCandidate(
      client,
      "Display",
      "content/index.xml",
      '<?xml-stylesheet type="text/xsl" href="v1/index.xsl"?><pages/>',
    );
    assert(complete.uiFeedback.issues.some((issue) => issue.code === "UI_CHILD_REQUIRED"));
  });
});

void test("inert template entry scripts are not active runtime evidence but components are still validated", () => {
  const result = validate(
    `${html}<template><template><script src="./v2/nodel-webui.js"></script><nodel-button bad-attribute="x"></nodel-button></template></template>`,
  );
  assert(!result.issues.some((issue) => issue.code === "UI_V2_SCRIPT_MODULE_REQUIRED"));
  assert(result.issues.some((issue) => issue.code === "UI_V2_ATTRIBUTE_UNKNOWN"));
});

void test("missing module type and missing assets carry exact authored attribute locations and suggestions", () => {
  const source =
    '\ufeff<section>\n  <script src="./v2/nodel-webui.js"></script>\n  <nodel-image src="missing.png"></nodel-image>\n  <link rel="stylesheet" href="missing.css">\n</section>';
  const result = validate(source);
  for (const [code, attributeSource] of [
    ["UI_V2_SCRIPT_MODULE_REQUIRED", 'src="./v2/nodel-webui.js"'],
    ["UI_V2_ASSET_MISSING", 'src="missing.png"'],
    ["UI_V2_ASSET_MISSING", 'href="missing.css"'],
  ]) {
    const start = source.indexOf(attributeSource!);
    const issue = result.issues.find((entry) => entry.code === code && entry.location?.startOffset === start);
    assert(issue, `${code}: ${attributeSource}`);
    assert.equal(source.slice(issue.location!.startOffset, issue.location!.endOffset), attributeSource);
    const prefix = source.slice(0, start).split("\n");
    assert.equal(issue.line, prefix.length);
    assert.equal(issue.column, prefix.at(-1)!.length + 1);
    assert(issue.suggestion);
  }
  const wrongType = validate('<script type="text/javascript" src="./v2/nodel-webui.js"></script>');
  const moduleIssue = wrongType.issues.find((issue) => issue.code === "UI_V2_SCRIPT_MODULE_REQUIRED")!;
  assert.equal(
    '<script type="text/javascript" src="./v2/nodel-webui.js"></script>'.slice(
      moduleIssue.location?.startOffset,
      moduleIssue.location?.endOffset,
    ),
    'type="text/javascript"',
  );
});
