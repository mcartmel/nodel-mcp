import assert from "node:assert/strict";
import test from "node:test";
import { v1XmlUiGuidance } from "../dist/nodel/uiGuidelines.js";

test("v1XmlUiGuidance identifies the legacy v1 XML format", () => {
  const guidance = v1XmlUiGuidance();

  assert.equal(guidance.format, "v1_xml_xslt");
  assert.equal(guidance.scope, "legacy_compatibility");
  assert.match(guidance.guidelines, /legacy v1 XML\/XSLT dashboard format/u);
});

test("v1XmlUiGuidance documents required storage and stylesheet contract", () => {
  const { guidelines } = v1XmlUiGuidance();

  assert.match(guidelines, /content\/index\.xml/u);
  assert.ok(guidelines.includes('<?xml-stylesheet type="text/xsl" href="v1/index.xsl"?>'));
});

test("v1XmlUiGuidance explains action event join and generated data attributes", () => {
  const { guidelines } = v1XmlUiGuidance();

  assert.match(guidelines, /action="Name"/u);
  assert.match(guidelines, /event="Name"/u);
  assert.match(guidelines, /join="Name"/u);
  assert.match(guidelines, /data-action/u);
  assert.match(guidelines, /data-event/u);
  assert.match(guidelines, /Do not hand-author data-action, data-event/u);
});

test("v1XmlUiGuidance includes inspection and supporting-file verification guidance", () => {
  const { guidelines } = v1XmlUiGuidance();

  assert.match(guidelines, /nodel\.get_node_actions/u);
  assert.match(guidelines, /nodel\.get_node_signals/u);
  assert.match(guidelines, /Use supporting-file tools for XML/u);
  assert.match(guidelines, /Do not restart the node just because an XML file changed/u);
});

test("v1XmlUiGuidance warns that index xsd is not authoritative", () => {
  const guidance = v1XmlUiGuidance();

  assert.match(guidance.guidelines, /Do not rely on index\.xsd as a complete schema/u);
  assert.ok(guidance.caveats.some((caveat) => /index\.xsd is incomplete/u.test(caveat)));
});

test("v1XmlUiGuidance exposes authoritative source references", () => {
  const { authoritativeSources } = v1XmlUiGuidance();
  const names = authoritativeSources.map((source) => source.name);

  assert.ok(names.includes("index.xml"));
  assert.ok(names.includes("index.xsl"));
  assert.ok(names.includes("templates.xsl"));
  assert.ok(names.includes("nodel.js"));
});
