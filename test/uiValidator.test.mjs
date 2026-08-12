import assert from "node:assert/strict";
import test from "node:test";
import { validateV1Ui } from "../dist/nodel/uiValidator.js";

const stylesheet = '<?xml-stylesheet type="text/xsl" href="v1/index.xsl"?>';

test("UI validator reports malformed XML", () => {
  const result = validateV1Ui(baseInput(`${stylesheet}<pages><page title="Main"></pages>`));

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "UI_XML_NOT_WELL_FORMED"));
});

test("UI validator reports missing points, mute companions, ignored classes, and missing assets", () => {
  const xml = `${stylesheet}
<pages title="Room" css="css/custom.css?v=2" js="js/missing.js">
  <page title="Main" class="ignored">
    <row class="levels">
      <column sm="6" class="ignored">
        <range join="Level" type="mute" min="-100" max="12" step="1"/>
      </column>
    </row>
  </page>
</pages>`;
  const result = validateV1Ui(
    baseInput(xml, {
      actions: { Level: { schema: { type: "number" } } },
      signals: { Level: { schema: { type: "number" } } },
      filePaths: ["content/index.xml", "content/css/custom.css"],
      recipeFiles: [
        {
          path: "script.py",
          content:
            "schemaMap = {}\ndef loadIndexFile(path): pass\neType = 'range'\nschemaMap.get(eType)\njoin = e.get('join')\n",
        },
      ],
      schemasJson: JSON.stringify({ range: { type: "number" } }),
    }),
  );

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "UI_MUTING_POINT_MISSING" && issue.parserSpecific));
  assert.ok(result.issues.some((issue) => issue.code === "UI_CLASS_IGNORED"));
  assert.ok(result.issues.some((issue) => issue.code === "UI_ASSET_MISSING" && /missing\.js/u.test(issue.message)));
  assert.ok(result.issues.some((issue) => issue.code === "UI_RANGE_SCHEMA_BOUNDS_INCOMPLETE"));
  assert.ok(result.issues.some((issue) => issue.code === "UI_FRONTEND_RANGE_BOUNDS_NOT_DERIVED"));
  assert.equal(result.assets.find((asset) => asset.attribute === "css").exists, true);
  assert.ok(result.generatedPoints.some((point) => point.name === "LevelMuting" && point.derived));
});

test("UI validator checks browser argument types against strict event schemas", () => {
  const xml = `${stylesheet}<pages><page title="Main"><row><column><button action="Set" event="State" arg="1.0">One</button></column></row></page></pages>`;
  const result = validateV1Ui(
    baseInput(xml, {
      actions: { Set: { schema: { type: "number" } } },
      signals: { State: { schema: { type: "number" } } },
    }),
  );

  assert.ok(result.issues.some((issue) => issue.code === "UI_POINT_SCHEMA_VALUE_MISMATCH"));
  assert.ok(result.issues.some((issue) => issue.code === "UI_BUTTON_EVENT_TYPE_MISMATCH"));
});

test("UI validator optionally reports large and malformed dynamic selector values", () => {
  const xml = `${stylesheet}<pages><page title="Main"><row><column><dynamicselect action="Pick" event="Selected" data="Options"/></column></row></page></pages>`;
  const result = validateV1Ui(
    baseInput(xml, {
      actions: { Pick: {} },
      signals: { Selected: {}, Options: {} },
      liveEntries: [{ alias: "Options", arg: [{ value: "One" }, "bad", { value: "Three" }] }],
      dynamicOptionWarningThreshold: 2,
    }),
  );

  assert.ok(result.issues.some((issue) => issue.code === "UI_DYNAMIC_OPTIONS_LARGE"));
  assert.ok(result.issues.some((issue) => issue.code === "UI_DYNAMIC_OPTION_SHAPE_INVALID"));
  assert.equal(result.liveValues[0].optionCount, 3);
});

test("UI validator accepts proposed content metadata and query-suffixed existing assets", () => {
  const xml = `${stylesheet}<pages css="css/custom.css?v=7"><page title="Main"><row><column><text>Ready</text></column></row></page></pages>`;
  const result = validateV1Ui(baseInput(xml, { source: "provided", filePaths: ["content/css/custom.css"] }));

  assert.equal(result.source, "provided");
  assert.equal(result.ok, true);
  assert.equal(result.assets[0].normalizedPath, "content/css/custom.css");
  assert.equal(result.assets[0].exists, true);
});

test("UI validator requires the complete stylesheet processing instruction", () => {
  const result = validateV1Ui(
    baseInput('<?xml-stylesheet href="v1/index.xsl"?><pages><page title="Main"><row><column/></row></page></pages>'),
  );

  assert.ok(result.issues.some((issue) => issue.code === "UI_STYLESHEET_MISSING"));
});

test("UI validator accepts alternative required children and rejects enum values", () => {
  const valid = validateV1Ui(
    baseInput(
      `${stylesheet}<pages><pagegroup title="Grouped"><page title="One"><row><column><buttongroup><switch join="Power"/></buttongroup></column></row></page></pagegroup></pages>`,
      {
        actions: { Power: {} },
        signals: { Power: {} },
      },
    ),
  );
  const invalid = validateV1Ui(
    baseInput(
      `${stylesheet}<pages><page title="Main"><row><column><range type="sideways" join="Level"/></column></row></page></pages>`,
      {
        actions: { Level: {} },
        signals: { Level: {} },
      },
    ),
  );

  assert.equal(
    valid.issues.some((issue) => issue.code === "UI_CHILD_REQUIRED"),
    false,
  );
  assert.ok(invalid.issues.some((issue) => issue.code === "UI_ATTRIBUTE_VALUE_UNSUPPORTED"));
});

test("UI validator ignores point attributes that momentary button XSLT ignores", () => {
  const xml = `${stylesheet}<pages><page title="Main"><row><column><button type="momentary" action="Ignored" event="Ignored" action-on="Press" action-off="Release">Hold</button></column></row></page></pages>`;
  const result = validateV1Ui(baseInput(xml, { actions: { Press: {}, Release: {} } }));

  assert.ok(result.issues.some((issue) => issue.code === "UI_MOMENTARY_IGNORES_ACTION"));
  assert.equal(
    result.issues.some((issue) => issue.code === "UI_ACTION_MISSING" && /Ignored/u.test(issue.message)),
    false,
  );
  assert.equal(
    result.issues.some((issue) => issue.code === "UI_EVENT_MISSING" && /Ignored/u.test(issue.message)),
    false,
  );
});

test("UI validator labels data and showevent parser limitations", () => {
  const xml = `${stylesheet}<pages><page title="Main"><row showevent="Visible"><column><dynamicselect action="Pick" event="Selected" data="Options"/></column></row></page></pages>`;
  const result = validateV1Ui(
    baseInput(xml, {
      actions: { Pick: {} },
      signals: { Selected: {} },
      recipeFiles: [
        {
          path: "script.py",
          content:
            "schemaMap = {}\ndef loadIndexFile(path): pass\neType = 'x'\nschemaMap.get(eType)\njoin = e.get('join')\n",
        },
      ],
    }),
  );

  assert.ok(
    result.issues.some(
      (issue) =>
        issue.code === "UI_FRONTEND_AUX_POINT_MISSING" && issue.parserSpecific && /Options/u.test(issue.message),
    ),
  );
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.code === "UI_FRONTEND_AUX_POINT_MISSING" && issue.parserSpecific && /Visible/u.test(issue.message),
    ),
  );
});

test("UI validator allows state and builtin components under columns and groups", () => {
  const xml = `${stylesheet}<pages><page title="Main"><row><column><group><status event="Status">State</status><meter event="Level"/><nodel type="description"/></group></column></row></page></pages>`;
  const result = validateV1Ui(baseInput(xml, { signals: { Status: {}, Level: {} } }));

  assert.equal(
    result.issues.some((issue) => issue.code === "UI_CHILD_UNSUPPORTED"),
    false,
  );
});

test("UI validator applies coercion and enum checks to every multi-action target", () => {
  const xml = `${stylesheet}<pages><page title="Main"><row><column><button action='["SetA","SetB"]' event="State" arg="5">Five</button></column></row></page></pages>`;
  const result = validateV1Ui(
    baseInput(xml, {
      actions: {
        SetA: { schema: { type: "integer", enum: [5] } },
        SetB: { schema: { type: ["number", "null"], enum: [6] } },
      },
      signals: { State: { schema: { type: "integer", enum: [5] } } },
    }),
  );

  assert.equal(
    result.issues.some((issue) => /SetA/u.test(issue.message) && /MISMATCH/u.test(issue.code)),
    false,
  );
  assert.ok(
    result.issues.some((issue) => issue.code === "UI_POINT_SCHEMA_VALUE_MISMATCH" && /SetB/u.test(issue.message)),
  );
});

test("UI validator treats live custom schemas as authoritative and deduplicates parser differences", () => {
  const xml = `${stylesheet}<pages><page title="Main"><row><column><button action="Zone1playing" event="Zone1playing" arg="false">Stop</button><button action="Zone1playing" event="Zone1playing" arg="true">Play</button></column></row></page></pages>`;
  const result = validateV1Ui(
    baseInput(xml, {
      actions: { Zone1playing: { schema: { type: "boolean" } } },
      signals: { Zone1playing: { schema: { type: "boolean" } } },
      recipeFiles: [frontendParserRecipe()],
      schemasJson: JSON.stringify({ button: { type: "integer" } }),
    }),
  );

  const overrides = result.issues.filter((issue) => issue.code === "UI_FRONTEND_CUSTOM_SCHEMA_OVERRIDE");
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].severity, "info");
  assert.match(overrides[0].message, /live action\/event schema is authoritative/u);
  assert.match(overrides[0].message, /Referenced by 2 XML controls/u);
  assert.equal(
    result.issues.some((issue) => issue.code === "UI_FRONTEND_REGISTERED_SCHEMA_MISMATCH"),
    false,
  );
});

test("UI validator accepts integer schema bounds as complete for step one", () => {
  const xml = `${stylesheet}<pages><page title="Main"><row><column><range join="InputZone1" min="-100" max="12" step="1"/></column></row></page></pages>`;
  const schema = { type: "integer", minimum: -100, maximum: 12 };
  const result = validateV1Ui(
    baseInput(xml, {
      actions: { InputZone1: { schema } },
      signals: { InputZone1: { schema } },
      recipeFiles: [frontendParserRecipe()],
      schemasJson: JSON.stringify({ range: { type: "number" } }),
    }),
  );

  assert.equal(
    result.issues.some((issue) => issue.code === "UI_RANGE_SCHEMA_BOUNDS_INCOMPLETE"),
    false,
  );
  assert.equal(
    result.issues.some((issue) => issue.code === "UI_FRONTEND_RANGE_BOUNDS_NOT_DERIVED"),
    false,
  );
});

test("UI validator recognizes Nodel min and max schema aliases", () => {
  const xml = `${stylesheet}<pages><page title="Main"><row><column><range join="InputZone1" min="-100" max="12" step="1"/></column></row></page></pages>`;
  const schema = { type: "integer", min: -100, max: 12, format: "range" };
  const result = validateV1Ui(
    baseInput(xml, {
      actions: { InputZone1: { schema } },
      signals: { InputZone1: { schema } },
      recipeFiles: [frontendParserRecipe()],
      schemasJson: JSON.stringify({ range: { type: "integer" } }),
    }),
  );

  assert.equal(
    result.issues.some((issue) => issue.code === "UI_RANGE_SCHEMA_BOUNDS_INCOMPLETE"),
    false,
  );
  assert.equal(
    result.issues.some((issue) => issue.code === "UI_FRONTEND_RANGE_BOUNDS_NOT_DERIVED"),
    false,
  );
});

test("UI validator still notes an unconstrained non-unit integer range step", () => {
  const xml = `${stylesheet}<pages><page title="Main"><row><column><range join="EvenLevel" min="0" max="10" step="2"/></column></row></page></pages>`;
  const schema = { type: "integer", minimum: 0, maximum: 10 };
  const result = validateV1Ui(
    baseInput(xml, {
      actions: { EvenLevel: { schema } },
      signals: { EvenLevel: { schema } },
    }),
  );

  assert.ok(
    result.issues.some((issue) => issue.code === "UI_RANGE_SCHEMA_BOUNDS_INCOMPLETE" && /step/u.test(issue.message)),
  );
});

/** @param {string} content @param {Record<string, unknown>} overrides @returns {import("../dist/domain/ui/types.js").UiValidationInput} */
function baseInput(content, overrides = {}) {
  return {
    path: "content/index.xml",
    content,
    source: "saved",
    actions: {},
    signals: {},
    filePaths: ["content/index.xml"],
    maxIssues: 200,
    ...overrides,
  };
}

function frontendParserRecipe() {
  return {
    path: "script.py",
    content:
      "schemaMap = {}\ndef loadIndexFile(path): pass\neType = 'button'\nschemaMap.get(eType)\njoin = e.get('join')\n",
  };
}
