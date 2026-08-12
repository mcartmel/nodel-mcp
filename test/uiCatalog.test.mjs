import assert from "node:assert/strict";
import test from "node:test";
import {
  V1_UI_COMPONENT_NAMES,
  decodeV1DataAttribute,
  getV1UiComponent,
  suggestV1UiComponents,
} from "../dist/nodel/v1UiCatalog.js";

const expectedComponents = [
  "pages",
  "page",
  "pagegroup",
  "header",
  "footer",
  "row",
  "column",
  "group",
  "grid",
  "cell",
  "gap",
  "title",
  "subtitle",
  "text",
  "icon",
  "image",
  "link",
  "button",
  "buttongroup",
  "switch",
  "partialswitch",
  "pills",
  "pill",
  "select",
  "item",
  "dynamicselect",
  "dynamicbuttongroup",
  "range",
  "lighting",
  "status",
  "statussleep",
  "badge",
  "partialbadge",
  "panel",
  "field",
  "qrcode",
  "meter",
  "signal",
  "nodel",
];

test("v1 UI catalog covers all planned public elements", () => {
  assert.deepEqual([...V1_UI_COMPONENT_NAMES].sort(), [...expectedComponents].sort());
});

test("v1 UI catalog records meter DOM and horizontal CSS defaults", () => {
  const meter = getV1UiComponent("meter");

  assert.equal(meter.markup.outerTag, "div");
  assert.ok(meter.markup.significantDescendants.some((entry) => /p/u.test(entry)));
  assert.ok(
    meter.variants.some(
      (variant) => variant.name === "horizontal" && variant.css.some((entry) => /margin-right:40px/u.test(entry)),
    ),
  );
  assert.ok(
    meter.variants.some(
      (variant) => variant.name === "horizontal" && variant.css.some((entry) => /right:-35px/u.test(entry)),
    ),
  );
  assert.equal(meter.classPropagation.status, "ignored");
});

test("v1 UI catalog distinguishes class propagation", () => {
  assert.equal(getV1UiComponent("row").classPropagation.status, "propagates");
  assert.equal(getV1UiComponent("page").classPropagation.status, "ignored");
  assert.equal(getV1UiComponent("column").classPropagation.status, "ignored");
  assert.equal(getV1UiComponent("group").classPropagation.status, "ignored");
  assert.equal(getV1UiComponent("button").classPropagation.status, "propagates");
});

test("decodeV1DataAttribute reproduces jQuery coercion", () => {
  assert.equal(decodeV1DataAttribute("5"), 5);
  assert.equal(decodeV1DataAttribute("true"), true);
  assert.equal(decodeV1DataAttribute("false"), false);
  assert.equal(decodeV1DataAttribute("null"), null);
  assert.deepEqual(decodeV1DataAttribute("[1,2]"), [1, 2]);
  assert.deepEqual(decodeV1DataAttribute('{"x":1}'), { x: 1 });
  assert.equal(decodeV1DataAttribute("05"), "05");
  assert.equal(decodeV1DataAttribute("1.0"), "1.0");
});

test("component suggestions handle near misses", () => {
  assert.ok(suggestV1UiComponents("metre").includes("meter"));
});
