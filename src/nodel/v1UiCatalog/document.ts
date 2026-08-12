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

export const V1_DOCUMENT_COMPONENTS = [
  {
    name: "pages",
    category: "document",
    summary: "Root XML element for a v1 dashboard; controls title, theme, root assets, logo, and core mode.",
    attributes: [
      attr("title", "text", {
        notes: ["Shown in the navbar brand and updated at runtime by local Title events."],
      }),
      attr("css", "browser path", {
        notes: ["Loads a custom stylesheet unless core is set; path is relative to content/ at runtime."],
      }),
      attr("js", "browser path", {
        notes: ["Loads a custom script unless core is set; path is relative to content/ at runtime."],
      }),
      attr("theme", "theme name", {
        notes: ["Selects v1/css/components.<theme>.css and navbar/footer navbar-<theme> classes."],
      }),
      attr("logo", "browser path", {
        notes: ["Overrides v1/img/logo.png in the navbar brand."],
      }),
      attr("core", "presence flag", {
        notes: ["Suppresses custom css/js and adds body class core."],
      }),
    ],
    allowedChildren: {
      allowed: ["header", "page", "pagegroup", "footer"],
      required: ["page or pagegroup"],
    },
    variants: [
      {
        name: "themed",
        when: "theme is present",
        markup: ["Loads v1/css/components.<theme>.css and uses navbar-<theme>."],
      },
      {
        name: "core",
        when: "core is present",
        markup: ["Adds body class core and suppresses pages css/js assets."],
      },
    ],
    markup: {
      outerTag: "html/body shell",
      outerClasses: ["navbar", "container-fluid", "page"],
      dataAttributes: [],
      significantDescendants: [
        "fixed top navbar",
        "offline modal",
        "confirm modal",
        "alert",
        "page containers",
        "optional footer",
        "dynamic templates",
      ],
      notes: ["The root itself is not emitted as a DOM element; index.xsl builds a complete HTML document."],
    },
    classPropagation: unsupportedClass,
    pointRules: [],
    valueBehavior: ["Title can be replaced by a local event named Title; Clock can update the navbar clock."],
    css: ["theme selects the built-in CSS bundle; css loads one custom stylesheet after the component bundle."],
    sourceRefs: [sourceRef("index.xsl", "6-43"), sourceRef("index.xsl", "322-331")],
  },
  {
    name: "page",
    category: "document",
    summary: "Top-level dashboard page that receives a navbar entry and a generated content section.",
    attributes: [
      attr("title", "text", {
        required: true,
        notes: ["Sanitized to a data-nav/data-section id by removing non-alphanumeric characters."],
      }),
      attr("action", "point name", {
        notes: ["Generated on the navbar entry and called when the page nav item is clicked."],
      }),
      attr("class", "CSS classes", {
        notes: ["Ignored by the current transform; page containers stay container-fluid page."],
      }),
    ],
    allowedChildren: {
      allowed: ["row", "special_*"],
      required: ["row"],
      notes: ["pagegroup contains page children for navigation grouping."],
    },
    variants: [],
    markup: {
      outerTag: "div",
      outerClasses: ["container-fluid", "page"],
      dataAttributes: ["data-section"],
      significantDescendants: ["row children", "navbar li/a with data-nav"],
      notes: ["All //page elements generate body sections, including pages nested inside pagegroup."],
    },
    classPropagation: ignoredClass("generated .container-fluid.page section"),
    pointRules: [
      {
        xmlAttributes: ["action"],
        generatedDataAttributes: ["data-action"],
        references: ["action", "navigation"],
        notes: ["Action is attached to the navbar link, not the page body section."],
      },
    ],
    valueBehavior: [
      "Navigation shows the matching data-section and hides other sections; action is optional side effect.",
    ],
    css: ["Generated page sections use Bootstrap container-fluid plus page."],
    sourceRefs: [sourceRef("index.xsl", "101-132"), sourceRef("index.xsl", "292-298")],
  },
  {
    name: "pagegroup",
    category: "document",
    summary: "Navbar dropdown grouping for page entries; it does not create a content section by itself.",
    attributes: [
      attr("title", "text", { required: true }),
      attr("class", "CSS classes", {
        notes: ["Ignored; no pagegroup DOM section is emitted."],
      }),
    ],
    allowedChildren: { allowed: ["page"], required: ["page"] },
    variants: [],
    markup: {
      outerTag: "li/ul in navbar",
      outerClasses: ["dropdown", "dropdown-menu"],
      dataAttributes: ["data-nav"],
      significantDescendants: ["dropdown toggle", "page links"],
      notes: ["Nested pages still generate normal body page containers."],
    },
    classPropagation: unsupportedClass,
    pointRules: [],
    valueBehavior: ["Only affects navigation grouping."],
    css: ["Uses Bootstrap dropdown navbar styles."],
    sourceRefs: [sourceRef("index.xsl", "101-120")],
  },
  {
    name: "header",
    category: "document",
    summary: "Optional navbar right-side authoring area and brand link destination.",
    attributes: [
      attr("destination", "URL", {
        notes: ["Applied to the brand logo link."],
      }),
    ],
    allowedChildren: {
      allowed: ["button", "switch", "nodel"],
      notes: [
        "The shell also contains a legacy special case for header input type='checkbox'; input is not part of the public catalog list.",
      ],
    },
    variants: [
      {
        name: "hosticon",
        when: "contains nodel type='hosticon'",
        markup: ["Adds span.nodel-icon in the navbar brand."],
      },
      {
        name: "edit/nav",
        when: "contains nodel type='edit' or type='nav'",
        markup: ["Adds built-in navbar menus for node edit functions or node/UI navigation."],
      },
    ],
    markup: {
      outerTag: "navbar fragments",
      outerClasses: ["navbar-brand", "navbar-right", "navbar-form"],
      dataAttributes: [],
      significantDescendants: ["brand link", "optional navbar-form controls", "built-in nodel menus"],
      notes: ["header itself is not emitted as a standalone DOM element."],
    },
    classPropagation: unsupportedClass,
    pointRules: [],
    valueBehavior: ["Header controls behave like their normal button/switch templates inside a navbar form."],
    css: ["Uses Bootstrap navbar layout."],
    sourceRefs: [sourceRef("index.xsl", "76-95"), sourceRef("index.xsl", "138-220")],
  },
  {
    name: "footer",
    category: "document",
    summary: "Optional fixed bottom footer containing row layout.",
    attributes: [
      attr("class", "CSS classes", {
        notes: ["Ignored; footer class is generated from theme/default."],
      }),
    ],
    allowedChildren: { allowed: ["row"], required: ["row"] },
    variants: [
      {
        name: "themed",
        when: "pages theme is present",
        markup: ["footer class navbar navbar-fixed-bottom navbar-<theme>."],
      },
    ],
    markup: {
      outerTag: "footer",
      outerClasses: ["navbar", "navbar-fixed-bottom", "navbar-inverse"],
      dataAttributes: [],
      significantDescendants: ["div.container-fluid", "row children"],
      notes: ["Any footer adds body class hasfooter so padding-bottom is adjusted."],
    },
    classPropagation: unsupportedClass,
    pointRules: [],
    valueBehavior: ["Footer rows can contain normal controls and displays."],
    css: ["Fixed bottom navbar; body padding is updated by nodel.js."],
    sourceRefs: [sourceRef("index.xsl", "45-52"), sourceRef("index.xsl", "300-320"), sourceRef("nodel.js", "263-266")],
  },
] as const satisfies readonly V1UiComponent[];
