import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { validateV2Ui } from "../src/domain/ui/v2/validator.js";
import { validateV2Bindings } from "../src/domain/ui/v2/bindings.js";
import { PINNED_V2_CONTRACT } from "../src/domain/ui/v2/contract.js";
import { analyzeUiCandidate } from "../src/domain/ui/service.js";
import type { UiAdvisoryEnvelope } from "../src/domain/ui/advisory-types.js";
import { validateV1Ui } from "../src/domain/ui/validator.js";
import type { NodelClient } from "../src/nodel/client.js";

const validate = (content: string, extra: Partial<Parameters<typeof validateV2Ui>[0]> = {}) =>
  validateV2Ui({ path: "content/index.html", content, contract: PINNED_V2_CONTRACT, ...extra });

void test("validates Quickstart-style app and fragments without imposing a document shell", () => {
  const starter =
    '<!doctype html><html><head><link rel="stylesheet" href="./v2/nodel-webui.css"><script type="module" src="./v2/nodel-webui.js"></script></head><body><nodel-app theme="dark"><nodel-page title="Home"><nodel-row><nodel-column><nodel-button action="Lights.On">On</nodel-button></nodel-column></nodel-row></nodel-page></nodel-app></body></html>';
  const result = validate(starter, {
    actions: new Set(["Lights.On"]),
    actionsAvailable: true,
    signalsAvailable: true,
    capabilities: { target: { name: "node", nodeBaseUrl: "https://node.example/" } } as never,
  });
  assert.equal(result.summary.errorCount, 0);
  assert.equal(result.page.references.filter((entry) => entry.state === "matches_node_root").length, 2);
  assert.equal(validate("<nodel-button></nodel-button>").summary.errorCount, 0);
});

void test("checks contract attributes, boolean presence, enums, clamping and composition", () => {
  const result = validate(
    '<nodel-app offline-mode="mystery" background-brightness="900"><nodel-page min-height="viewport"><nodel-page></nodel-page><nodel-group fill="false"></nodel-group></nodel-page><nodel-control-space></nodel-control-space><nodel-button mystery="x" disabled="false"></nodel-button></nodel-app>',
  );
  const codes = result.issues.map((issue) => issue.code);
  assert.ok(codes.includes("UI_V2_ENUM_INVALID"));
  assert.ok(codes.includes("UI_V2_NUMBER_NORMALIZED"));
  assert.ok(codes.includes("UI_V2_BOOLEAN_PRESENCE"));
  assert.ok(codes.includes("UI_V2_PARENT_REQUIRED"));
  assert.ok(codes.includes("UI_V2_PAGE_VIEWPORT_GROUP"));
  assert.ok(codes.includes("UI_V2_ATTRIBUTE_UNKNOWN"));
});

void test("binding validation preserves exact signal aliases, escaped paths and target aggregation", () => {
  const valid = validate(
    '<nodel-button signals="Door\\.West.state:active(any);Temperature.value:label" action=" Set Light :click"></nodel-button>',
    {
      actions: new Set(["Set Light"]),
      signals: new Set(["Door.West", "Temperature"]),
      actionsAvailable: true,
      signalsAvailable: true,
    },
  );
  assert.equal(valid.summary.errorCount, 0);
  const invalid = validate(
    '<nodel-button signals="door.west:active(any);Room.State:label(all)" action="Go:CLICK"></nodel-button>',
    {
      actions: new Set(["go"]),
      signals: new Set(["Door.West", "Room.State"]),
      actionsAvailable: true,
      signalsAvailable: true,
    },
  );
  assert.ok(invalid.issues.some(({ code }) => code === "UI_V2_EVENT_MISSING"));
  assert.ok(invalid.issues.some(({ code }) => code === "UI_V2_SIGNAL_TARGET_INVALID"));
  assert.ok(invalid.issues.some(({ code }) => code === "UI_V2_ACTION_BINDING_INVALID"));
});

void test("global visibility bindings validate on ordinary HTML without applying component rules", () => {
  const check = (content: string, signals = new Set(["PresentSignal"])) =>
    validate(content, { signals, signalsAvailable: true });
  const missing = check('<div visibility="MissingSignal" visible-value="on"></div>', new Set());
  assert.equal(missing.issues.filter(({ code }) => code === "UI_V2_EVENT_MISSING").length, 1);
  assert.equal(
    missing.issues.some(({ code }) => code === "UI_V2_ATTRIBUTE_UNKNOWN"),
    false,
  );

  const valid = check('<div visibility="PresentSignal"></div>');
  assert.equal(
    valid.issues.some(({ code }) => code === "UI_V2_EVENT_MISSING"),
    false,
  );
  const wrongCase = check('<div visibility="presentsignal"></div>');
  assert.ok(wrongCase.issues.some(({ code }) => code === "UI_V2_EVENT_MISSING"));
  const malformed = check('<div visibility="PresentSignal..value"></div>');
  assert.ok(malformed.issues.some(({ code }) => code === "UI_V2_SIGNAL_BINDING_INVALID"));
  const explicit = check('<div signals="OtherSignal:visibility;PresentSignal:visibility(any)"></div>');
  assert.ok(
    explicit.issues.some(({ code, message }) => code === "UI_V2_EVENT_MISSING" && message.includes("OtherSignal")),
  );
  assert.equal(
    explicit.issues.some(({ code }) => code === "UI_V2_SIGNAL_TARGET_INVALID"),
    false,
  );
  const dynamic = check('<div visibility="{{selectedSignal}}"></div>', new Set());
  assert.equal(
    dynamic.issues.some(({ code }) => code === "UI_V2_EVENT_MISSING"),
    false,
  );
  assert.ok(dynamic.issues.some(({ code }) => code === "UI_V2_SCHEMA_CHECK_SKIPPED"));

  const oldContract = structuredClone(PINNED_V2_CONTRACT);
  oldContract.packageVersion = "older-1.0";
  assert.equal(
    validate('<div visibility="MissingSignal"></div>', {
      contract: oldContract,
      signals: new Set(),
      signalsAvailable: true,
    }).issues.some(({ code }) => code === "UI_V2_EVENT_MISSING"),
    false,
  );
});

void test("recognizes link exclusivity, runtime modes, custom self-closing syntax and templates", () => {
  const result = validate(
    '<nodel-app data-nodel-runtime="memory"><nodel-link href="/a" node="b"></nodel-link><nodel-button/><template><nodel-button action="{{action}}"></nodel-button></template></nodel-app>',
  );
  const codes = result.issues.map(({ code }) => code);
  assert.ok(codes.includes("UI_V2_LINK_DESTINATION"));
  assert.ok(codes.includes("UI_V2_CUSTOM_SELF_CLOSING"));
  assert.ok(codes.includes("UI_V2_MEMORY_RUNTIME"));
  assert.ok(codes.includes("UI_V2_TEMPLATE_STATIC_LIMITATION"));
  assert.equal(
    result.issues.some(({ code }) => code === "UI_V2_ACTION_MISSING"),
    false,
  );
});

void test("global visibility uses runtime target grammar and ignores unrelated ordinary-HTML targets", () => {
  // The pinned common metadata declares signals, not singular signal. Exercise
  // the runtime's singular parser only when the selected contract declares it.
  const contract = structuredClone(PINNED_V2_CONTRACT);
  contract.commonAttributes.push({
    ...contract.commonAttributes.find(({ name }) => name === "signals")!,
    name: "signal",
  });
  for (const attribute of ["signal", "signals"]) {
    for (const mode of ["ANY", "aLl", "LaSt"]) {
      const result = validate(`<div ${attribute}="Missing:visibility(${mode})"></div>`, {
        signals: new Set(),
        signalsAvailable: true,
        contract,
      });
      assert.equal(result.issues.filter(({ code }) => code === "UI_V2_EVENT_MISSING").length, 1);
      assert(!result.issues.some(({ code }) => code === "UI_V2_SIGNAL_TARGET_INVALID"));
    }
  }
  for (const content of [
    '<div signal="Missing"></div>',
    '<div signals="Missing:label;Bad..path:unsupported;Missing:Visibility(ANY)"></div>',
    '<div visibility="Missing:label"></div>',
  ]) {
    const result = validate(content, { signals: new Set(), signalsAvailable: true, contract });
    assert(!result.issues.some(({ code }) => code.startsWith("UI_V2_SIGNAL_") || code === "UI_V2_EVENT_MISSING"));
  }
  const exact = validate('<div signals="Door\\.West.state:visibility(ANY);door\\.West:visibility"></div>', {
    signals: new Set(["Door.West"]),
    signalsAvailable: true,
  });
  assert.equal(exact.issues.filter(({ code }) => code === "UI_V2_EVENT_MISSING").length, 1);
  assert(exact.issues.some(({ code, message }) => code === "UI_V2_EVENT_MISSING" && message.includes("door.West")));
});

void test("global signal placeholders retain unknown coverage even when the whole target is dynamic", () => {
  const contract = structuredClone(PINNED_V2_CONTRACT);
  contract.commonAttributes.push({
    ...contract.commonAttributes.find(({ name }) => name === "signals")!,
    name: "signal",
  });
  for (const attribute of ["visibility", "signal", "signals"]) {
    for (const value of ["{{binding}}", "${binding}", "Missing:{{target}}", "{{alias}}:visibility(ANY)"]) {
      const result = validate(`<div ${attribute}="${value}"></div>`, {
        signals: new Set(),
        signalsAvailable: true,
        contract,
      });
      assert.equal(result.summary.incomplete, true, `${attribute}=${value}`);
      assert(result.summary.schemaChecksSkipped > 0);
      assert(!result.issues.some(({ code }) => code === "UI_V2_EVENT_MISSING"));
    }
  }
});

void test("global visibility respects each selected common attribute and unknown runtime coverage", () => {
  for (const removed of ["signals", "signal", "visibility"]) {
    const contract = structuredClone(PINNED_V2_CONTRACT);
    contract.commonAttributes = contract.commonAttributes.filter(({ name }) => name !== removed);
    const result = validate(`<div ${removed}="Missing:visibility"></div>`, {
      contract,
      signals: new Set(),
      signalsAvailable: true,
    });
    assert(!result.issues.some(({ code }) => code === "UI_V2_EVENT_MISSING"));
    assert(result.issues.some(({ code }) => code === "UI_V2_RUNTIME_RULES_SKIPPED"));
    assert.equal(result.summary.incomplete, true);
    if (removed !== "visibility") {
      const retained = validate('<div visibility="Missing"></div>', {
        contract,
        signals: new Set(),
        signalsAvailable: true,
      });
      assert.equal(retained.issues.filter(({ code }) => code === "UI_V2_EVENT_MISSING").length, 1);
    }
  }
  const contract = structuredClone(PINNED_V2_CONTRACT);
  contract.packageVersion = "unknown";
  const unknown = validate('<div visibility="Missing"></div>', { contract, signals: new Set() });
  assert.equal(unknown.summary.incomplete, true);
  assert(unknown.issues.some(({ code }) => code === "UI_V2_RUNTIME_RULES_SKIPPED"));
  assert(!unknown.issues.some(({ code }) => code === "UI_V2_EVENT_MISSING"));
});

void test("signal placeholders shield internal colons and separators without hiding adjacent literal errors", () => {
  for (const value of [
    "${condition ? first : second}:visibility",
    "{{condition ? first : second}}:visibility",
    "${select(first, second)}:visibility",
    "{{first; second}}:visibility",
    "${({ key: 'x;y,z', nested: { value: first } }).key}:visibility",
    "${'first};Missing:visibility'}:visibility",
    "{{'first}};Missing:visibility'}}:visibility",
  ]) {
    for (const tag of ["div", "nodel-button", "nodel-row"]) {
      const result = validate(`<${tag} signals="${value};Bad..path:visibility;Missing:visibility"></${tag}>`, {
        signals: new Set(),
        signalsAvailable: true,
      });
      assert.equal(result.summary.schemaChecksSkipped, 1, `${tag}: ${value}`);
      assert.equal(result.summary.incomplete, true);
      assert.equal(result.issues.filter(({ code }) => code === "UI_V2_SIGNAL_BINDING_INVALID").length, 1);
      assert.equal(result.issues.filter(({ code }) => code === "UI_V2_EVENT_MISSING").length, 1);
      assert(result.issues.some(({ code, message }) => code === "UI_V2_EVENT_MISSING" && message.includes("Missing")));
    }
  }
});

void test("uncertain placeholder boundaries skip the whole attribute, not independent literal checks", () => {
  const values = [
    "${condition /* } */ ? 'ignored;Fake:visibility;' : 'safe'}",
    "${/}/.test(value) ? 'ignored;Fake:visibility;' : 'safe'}",
    "${condition // } ;Fake:visibility;\n ? first : second}",
    "${first\n;Fake:visibility;second}",
    "${`text ${nested};Fake:visibility;`}",
    "${({ nested: { value: /}/ } });Fake:visibility;}",
    "${'unterminated};Fake:visibility;",
    "{{unclosed;Fake:visibility;",
    // Stay below the HTML parser's independent 64 KiB tag budget.
    "${" + "{".repeat(30_000) + "}".repeat(30_000) + "/};Fake:visibility;",
  ];
  for (const [index, value] of values.entries()) {
    for (const tag of ["div", "nodel-button", "nodel-row"]) {
      const result = validate(
        `<${tag} signals="Before:visibility;${value}:visibility;After:visibility" visibility="Separate..path;SeparateMissing"></${tag}>`,
        { signals: new Set(), signalsAvailable: true },
      );
      assert.equal(result.summary.incomplete, true, `${tag}: case ${index}`);
      assert(result.summary.schemaChecksSkipped > 0);
      assert(result.issues.some(({ code }) => code === "UI_V2_SCHEMA_CHECK_SKIPPED"));
      assert(!result.issues.some(({ severity, attribute }) => severity === "error" && attribute === "signals"));
      const missing = result.issues.filter(({ code }) => code === "UI_V2_EVENT_MISSING");
      assert.equal(missing.length, 1);
      assert.match(missing[0]!.message, /SeparateMissing/u);
      assert.equal(result.issues.filter(({ code }) => code === "UI_V2_SIGNAL_BINDING_INVALID").length, 1);
    }
  }
});

void test("placeholder boundary preflight handles a 2 MiB attribute with constant stack space", () => {
  const definition = PINNED_V2_CONTRACT.elements.find(({ name }) => name === "nodel-button")!;
  for (const ending of ["/};Fake:visibility;", "", "}:visibility;Missing:visibility"]) {
    const raw =
      "${" +
      "{".repeat(500_000) +
      "a".repeat(2 * 1024 * 1024 - 1_000_002 - ending.length) +
      "}".repeat(500_000) +
      ending;
    assert.equal(raw.length, 2 * 1024 * 1024);
    const work = { remaining: 4096, truncated: false, schemaSkipped: 0 };
    const issues = validateV2Bindings(
      { nodeName: "nodel-button", tagName: "nodel-button", attrs: [{ name: "signals", value: raw }] },
      definition,
      undefined,
      new Set(),
      undefined,
      work,
    );
    assert.equal(work.schemaSkipped, 1);
    assert.equal(work.truncated, false);
    const missing = issues.filter(({ code }) => code === "UI_V2_EVENT_MISSING");
    assert.equal(missing.length, ending.startsWith("}") ? 1 : 0);
    assert(!issues.some(({ message }) => message.includes("Fake")));
  }
});

void test("native SVG visibility is ambiguous, not a definite missing Nodel alias", () => {
  for (const value of [
    "hidden",
    "visible",
    "collapse",
    "inherit",
    "initial",
    "unset",
    "revert",
    "revert-layer",
    "HIDDEN",
    "InHeRiT",
    "var(--native-visibility)",
    "env(native-visibility)",
    "Missing:visibility",
  ]) {
    const result = validate(`<svg><path visibility="${value}"></path></svg>`, {
      signals: new Set(),
      signalsAvailable: true,
    });
    assert(!result.issues.some(({ code }) => code === "UI_V2_EVENT_MISSING"));
    assert.equal(result.summary.incomplete, true);
    assert(
      result.issues.some(
        ({ code, message, severity }) =>
          code === "UI_V2_FOREIGN_VISIBILITY_AMBIGUOUS" &&
          severity === "warning" &&
          message.includes("Use CSS visibility"),
      ),
    );
  }
  const explicit = validate('<svg><path visibility="hidden" signals="Missing:visibility(ANY)"></path></svg>', {
    signals: new Set(),
    signalsAvailable: true,
  });
  assert.equal(explicit.issues.filter(({ code }) => code === "UI_V2_EVENT_MISSING").length, 1);
  assert(explicit.issues.some(({ code, message }) => code === "UI_V2_EVENT_MISSING" && message.includes("Missing")));
  const html = validate('<svg><foreignObject><div visibility="hidden"></div></foreignObject></svg>', {
    signals: new Set(),
    signalsAvailable: true,
  });
  assert.equal(html.issues.filter(({ code }) => code === "UI_V2_EVENT_MISSING").length, 1);
  assert(!html.issues.some(({ code }) => code === "UI_V2_FOREIGN_VISIBILITY_AMBIGUOUS"));
});

void test("unavailable signal discovery gates global references and component supplements do not duplicate checks", () => {
  const content = '<div visibility="Missing" signals="Other:visibility(ANY)"></div>';
  const unavailable = validate(content, {
    signals: new Set(),
    signalDefinitions: [{ name: "Missing" }],
    signalsAvailable: false,
  });
  assert(!unavailable.issues.some(({ code }) => code === "UI_V2_EVENT_MISSING"));
  assert(unavailable.issues.some(({ code }) => code === "UI_V2_SIGNAL_CHECK_SKIPPED"));
  assert.equal(unavailable.summary.incomplete, true);
  const available = validate(content, { signals: new Set(), signalsAvailable: true });
  assert.equal(available.issues.filter(({ code }) => code === "UI_V2_EVENT_MISSING").length, 2);
  for (const tag of ["nodel-button", "nodel-row"]) {
    const result = validate(`<${tag} signals="First:visibility(ANY);Second:visibility(LaSt)"></${tag}>`, {
      signals: new Set(),
      signalsAvailable: true,
    });
    assert.equal(result.issues.filter(({ code }) => code === "UI_V2_EVENT_MISSING").length, 2);
  }
});

void test("shared service avoids network for unrecognized input and exact-hashes explicit candidate bytes", async () => {
  let requests = 0;
  const client = {
    resolveNode: async () => {
      requests++;
      throw new Error("must not resolve");
    },
    getNodeFileContents: async () => {
      requests++;
      throw new Error("must not read");
    },
  } as unknown as NodelClient;
  const notUi = await analyzeUiCandidate(client, "node", "content/plain.html", "<main>plain</main>");
  assert.equal(notUi.uiFeedback.validation.status, "not_run");
  assert.equal(requests, 0);
  const explicit = await analyzeUiCandidate(
    client,
    "node",
    "content/draft.html",
    Buffer.from("<nodel-app></nodel-app>"),
    { selection: "v2" },
  );
  const feedback = explicit.uiFeedback as UiAdvisoryEnvelope;
  assert.equal(feedback.sha256, createHash("sha256").update("<nodel-app></nodel-app>").digest("hex"));
  assert.equal(feedback.selectedFormat, "v2");
  assert.ok(requests > 0, "explicit validation may attempt independent capability/live context probes");
});

void test("v1 enrichment availability gates missing-point claims without changing complete defaults", () => {
  const content =
    '<?xml-stylesheet type="text/xsl" href="v1/index.xsl"?><pages><button action="MissingAction" event="MissingEvent"/></pages>';
  const partial = validateV1Ui({
    path: "content/index.xml",
    content,
    source: "provided",
    actions: [],
    signals: [],
    actionsAvailable: false,
    signalsAvailable: true,
    filePaths: [],
  });
  assert.equal(
    partial.issues.some(({ code }) => code === "UI_ACTION_MISSING"),
    false,
  );
  assert.equal(
    partial.issues.some(({ code }) => code === "UI_EVENT_MISSING"),
    true,
  );
  assert.equal(
    partial.issues.some(({ code }) => code === "UI_ACTION_CHECK_SKIPPED"),
    true,
  );
  const legacyDefault = validateV1Ui({
    path: "content/index.xml",
    content,
    source: "provided",
    actions: [],
    signals: [],
    filePaths: [],
  });
  assert.equal(
    legacyDefault.issues.some(({ code }) => code === "UI_ACTION_MISSING"),
    true,
  );
  assert.equal(
    legacyDefault.issues.some(({ code }) => code === "UI_EVENT_MISSING"),
    true,
  );
});
