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

export const V1_LAYOUT_COMPONENTS = [
  {
    name: "row",
    category: "layout",
    summary: "Bootstrap row container for columns and the most reliable custom CSS scoping hook.",
    attributes: [attr("class", "CSS classes"), ...showAttrs],
    allowedChildren: {
      allowed: ["column", "cell"],
      required: ["column"],
      notes: ["Normal page rows contain column children; rows under grid contain cell children."],
    },
    variants: [],
    markup: {
      outerTag: "div",
      outerClasses: ["row", "sect"],
      dataAttributes: ["data-showevent", "data-showarg", "data-showeventarg"],
      significantDescendants: ["column children"],
      notes: ["showevent adds class sect in addition to row and any XML class."],
    },
    classPropagation: propagatesClass("outer div.row", ["XML class is appended after row and before optional sect."]),
    pointRules: [statusShowPointRule],
    valueBehavior: ["Visibility follows showevent/showvalue behavior; row has no direct action value behavior."],
    css: [
      "Use row class for page/section-level custom styling because page, column, group, and meter ignore XML class.",
    ],
    sourceRefs: [sourceRef("templates.xsl", "5-34")],
  },
  {
    name: "column",
    category: "layout",
    summary: "Bootstrap grid column; width attributes generate col-*-N classes.",
    attributes: [
      attr("xs", "1-12"),
      attr("sm", "1-12", { default: "12 when no width is supplied" }),
      attr("md", "1-12"),
      attr("lg", "1-12"),
      attr("push", "number", {
        notes: ["Generates col-sm-push-<value> regardless of breakpoint attributes."],
      }),
      attr("pull", "number", {
        notes: ["Generates col-sm-pull-<value> regardless of breakpoint attributes."],
      }),
      attr("event", "point name", {
        notes: ["Used as a visibility source on columns, not as a data-event updater."],
      }),
      attr("value", "jQuery-decoded scalar", {
        notes: ["Alias for showvalue on column visibility."],
      }),
      attr("class", "CSS classes", {
        notes: ["Ignored by the current transform."],
      }),
      ...showAttrs,
    ],
    allowedChildren: {
      allowed: ["any catalog non-document child"],
      notes: ["Column applies templates to all non-document component children."],
    },
    variants: [
      {
        name: "default-width",
        when: "no xs/sm/md/lg attributes",
        markup: ["class col-sm-12 plus optional push/pull and sect."],
      },
      {
        name: "explicit-width",
        when: "any xs/sm/md/lg attribute",
        markup: ["class col-xs-N col-sm-N col-md-N col-lg-N for supplied widths."],
      },
    ],
    markup: {
      outerTag: "div",
      outerClasses: ["col-sm-12", "col-xs-*", "col-sm-*", "col-md-*", "col-lg-*", "sect"],
      dataAttributes: ["data-showevent", "data-showarg"],
      significantDescendants: ["all child templates"],
      notes: [
        "event/showevent add visibility data attributes; they do not create a normal data-event subscription for column contents.",
      ],
    },
    classPropagation: ignoredClass("outer column div"),
    pointRules: [
      {
        xmlAttributes: ["event", "showevent", "value", "showvalue"],
        generatedDataAttributes: ["data-showevent", "data-showarg"],
        references: ["showevent"],
        notes: ["event is treated as a showevent source for columns."],
      },
    ],
    valueBehavior: ["Visibility only; child controls handle their own events/actions."],
    css: ["Bootstrap 12-column grid. push/pull always use col-sm-push/pull classes."],
    sourceRefs: [sourceRef("templates.xsl", "37-183")],
  },
  {
    name: "group",
    category: "layout",
    summary: "Visual well grouping around arbitrary child controls/content.",
    attributes: [
      attr("class", "CSS classes", {
        notes: ["Ignored by the current transform."],
      }),
      ...showAttrs,
    ],
    allowedChildren: {
      allowed: ["any catalog non-document child"],
      notes: ["Applies templates to all non-document component children."],
    },
    variants: [],
    markup: {
      outerTag: "div",
      outerClasses: ["well", "sect"],
      dataAttributes: ["data-showevent", "data-showarg", "data-showeventarg"],
      significantDescendants: ["child templates"],
      notes: ["The generated class is well plus optional sect only."],
    },
    classPropagation: ignoredClass("outer div.well"),
    pointRules: [statusShowPointRule],
    valueBehavior: ["Visibility only; child controls handle their own events/actions."],
    css: ["Bootstrap well styling."],
    sourceRefs: [sourceRef("templates.xsl", "1643-1668")],
  },
  {
    name: "grid",
    category: "layout",
    summary: "Dense table layout for button/control cells.",
    attributes: [
      attr("class", "CSS classes", {
        notes: ["Ignored on grid itself; row class under grid is copied to tr."],
      }),
    ],
    allowedChildren: {
      allowed: ["row"],
      required: ["row"],
      notes: ["grid row children contain cell children rather than column children."],
    },
    variants: [],
    markup: {
      outerTag: "table",
      outerClasses: ["btn-grid"],
      dataAttributes: [],
      significantDescendants: ["tr for each row", "td for each cell"],
      notes: ["row showevent/class under grid are applied to tr."],
    },
    classPropagation: unsupportedClass,
    pointRules: [],
    valueBehavior: ["No direct values; child cell controls carry behavior."],
    css: ["btn-grid table styling from the built-in component CSS."],
    sourceRefs: [sourceRef("templates.xsl", "524-560")],
  },
  {
    name: "cell",
    category: "layout",
    summary: "Cell inside a grid row; emits a table cell around child templates.",
    attributes: [
      attr("class", "CSS classes", {
        notes: ["Ignored by the grid transform."],
      }),
    ],
    allowedChildren: {
      allowed: ["any catalog non-document child"],
      notes: ["Only meaningful as grid/row/cell; child templates are applied normally."],
    },
    variants: [],
    markup: {
      outerTag: "td",
      outerClasses: [],
      dataAttributes: [],
      significantDescendants: ["child templates"],
      notes: ["cell is processed by the grid template's for-each loop, not its own template."],
    },
    classPropagation: unsupportedClass,
    pointRules: [],
    valueBehavior: ["No direct values."],
    css: ["Inherits btn-grid table layout."],
    sourceRefs: [sourceRef("templates.xsl", "552-555")],
  },
  {
    name: "gap",
    category: "layout",
    summary: "Vertical spacer with a generated min-height style.",
    attributes: [attr("value", "pixels", { default: "20" })],
    allowedChildren: { allowed: [] },
    variants: [],
    markup: {
      outerTag: "div",
      outerClasses: [],
      dataAttributes: [],
      significantDescendants: [],
      notes: ["Generates inline style min-height:<value>px."],
    },
    classPropagation: unsupportedClass,
    pointRules: [],
    valueBehavior: ["Static spacer only."],
    css: ["Inline min-height defaults to 20px."],
    sourceRefs: [sourceRef("templates.xsl", "1631-1640")],
  },
] as const satisfies readonly V1UiComponent[];
