// SPDX-License-Identifier: MPL-2.0
// Derived from https://github.com/museumsvictoria/nodel at revision 19756071383d696682688ab436c77c0a1f80c783.
import {
  actionAttrs,
  actionEventJoinPointRule,
  attr,
  confirmAttrs,
  eventPointRule,
  ignoredClass,
  meterShowPointRule,
  partialClass,
  propagatesClass,
  sourceRef,
  showAttrs,
  statusShowPointRule,
  unsupportedClass,
  V1_NODEL_BUILTIN_TYPES,
  type V1UiComponent,
} from "./shared.js";

export const V1_BUILTIN_COMPONENTS = [
  {
    name: "nodel",
    category: "builtin",
    summary: "Built-in Nodel UI panels and navbar helpers selected by type.",
    attributes: [
      attr("type", "built-in type", {
        required: true,
        values: V1_NODEL_BUILTIN_TYPES,
      }),
    ],
    allowedChildren: { allowed: [] },
    variants: V1_NODEL_BUILTIN_TYPES.map((type) => ({
      name: type,
      when: `type='${type}'`,
      markup:
        type === "hosticon" || type === "edit" || type === "nav"
          ? ["Handled directly by index.xsl when used in header."]
          : [`Generates built-in nodel-${type} panel markup or placeholder.`],
    })),
    markup: {
      outerTag: "div or navbar fragment",
      outerClasses: ["nodel-*", "base", "panel", "navbar-nav"],
      dataAttributes: ["data-nodel"],
      significantDescendants: [
        "built-in action/signal forms",
        "logs",
        "console",
        "params",
        "remote bindings",
        "node lists",
        "editor/toolkit/add-node UI",
      ],
      notes: ["Most built-ins render a placeholder div that nodel.js populates from REST endpoints."],
    },
    classPropagation: unsupportedClass,
    pointRules: [],
    valueBehavior: [
      "Built-ins read live REST resources and activity; they are administrative/dashboard widgets, not local recipe controls.",
    ],
    css: ["Uses built-in nodel-* classes and Bootstrap panels/forms."],
    sourceRefs: [
      sourceRef("templates.xsl", "1671-1832"),
      sourceRef("index.xsl", "92-94"),
      sourceRef("index.xsl", "157-220"),
      sourceRef("nodel.js", "806-964"),
    ],
  },
] as const satisfies readonly V1UiComponent[];
