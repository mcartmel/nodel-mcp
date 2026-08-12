// SPDX-License-Identifier: MPL-2.0
// Derived from https://github.com/museumsvictoria/nodel at revision 19756071383d696682688ab436c77c0a1f80c783.
export const V1_UI_SOURCE_REVISION = "19756071383d696682688ab436c77c0a1f80c783";

// Derived from museumsvictoria/nodel, licensed under MPL-2.0. See THIRD_PARTY_NOTICES.md.

export const SOURCE_BASE_URL = `https://github.com/museumsvictoria/nodel/blob/${V1_UI_SOURCE_REVISION}/nodel-webui-js/src`;

export type V1UiComponentCategory = "document" | "layout" | "content" | "control" | "state" | "builtin";

export type V1UiClassPropagationStatus = "propagates" | "partial" | "ignored" | "unsupported";

export interface V1UiSourceRef {
  readonly file: "index.xsl" | "templates.xsl" | "nodel.js" | "theme.less" | "index.xml";
  readonly lineRange: string;
  readonly url: string;
  readonly notes?: string;
}

export interface V1UiAttribute {
  readonly name: string;
  readonly type?: string;
  readonly values?: readonly string[];
  readonly required?: boolean;
  readonly default?: string;
  readonly notes?: readonly string[];
}

export interface V1UiChildrenRule {
  readonly allowed: readonly string[];
  readonly required?: readonly string[];
  readonly notes?: readonly string[];
}

export interface V1UiMarkupFact {
  readonly outerTag: string;
  readonly outerClasses: readonly string[];
  readonly dataAttributes: readonly string[];
  readonly significantDescendants: readonly string[];
  readonly notes?: readonly string[];
}

export interface V1UiClassPropagationFact {
  readonly status: V1UiClassPropagationStatus;
  readonly target?: string;
  readonly notes: readonly string[];
}

export interface V1UiPointRule {
  readonly xmlAttributes: readonly string[];
  readonly generatedDataAttributes: readonly string[];
  readonly references: readonly ("action" | "event" | "showevent" | "data" | "status" | "navigation" | "remote")[];
  readonly derivedNames?: readonly string[];
  readonly notes: readonly string[];
}

export interface V1UiVariant {
  readonly name: string;
  readonly when: string;
  readonly markup?: readonly string[];
  readonly pointRules?: readonly string[];
  readonly valueBehavior?: readonly string[];
  readonly css?: readonly string[];
}

export interface V1UiComponent {
  readonly name: string;
  readonly category: V1UiComponentCategory;
  readonly summary: string;
  readonly attributes: readonly V1UiAttribute[];
  readonly allowedChildren: V1UiChildrenRule;
  readonly variants: readonly V1UiVariant[];
  readonly markup: V1UiMarkupFact;
  readonly classPropagation: V1UiClassPropagationFact;
  readonly pointRules: readonly V1UiPointRule[];
  readonly valueBehavior: readonly string[];
  readonly css: readonly string[];
  readonly sourceRefs: readonly V1UiSourceRef[];
}

export interface V1UiComponentIndexEntry {
  readonly name: string;
  readonly category: V1UiComponentCategory;
  readonly summary: string;
  readonly variants: readonly string[];
  readonly classPropagation: V1UiClassPropagationStatus;
}

export interface V1UiCssRecipe {
  readonly name: string;
  readonly title: string;
  readonly components: readonly string[];
  readonly description: string;
  readonly css?: string;
  readonly markup?: string;
  readonly notes: readonly string[];
}

const lineAnchor = (lineRange: string) => {
  const [start, end] = lineRange.split("-");
  if (!start || Number.isNaN(Number(start))) return "";
  if (!end || Number.isNaN(Number(end))) return `#L${start}`;
  return `#L${start}-L${end}`;
};

export const sourceRef = (file: V1UiSourceRef["file"], lineRange: string, notes?: string): V1UiSourceRef => ({
  file,
  lineRange,
  url: `${SOURCE_BASE_URL}/${file}${lineAnchor(lineRange)}`,
  ...(notes ? { notes } : {}),
});

export const attr = (name: string, type?: string, options?: Omit<V1UiAttribute, "name" | "type">): V1UiAttribute => ({
  name,
  ...(type ? { type } : {}),
  ...options,
});

export const showAttrs = [
  attr("showevent", "point name", {
    notes: ["Generates data-showevent and hides the section until matching local activity arrives."],
  }),
  attr("showvalue", "jQuery-decoded scalar or JSON array", {
    notes: ["Generates data-showarg. Matching is strict after jQuery data decoding."],
  }),
  attr("showeventarg", "object path", {
    notes: ["Generates data-showeventarg and extracts a nested property before showvalue comparison."],
  }),
] as const;

export const actionAttrs = [
  attr("action", "point name or JSON array string", {
    notes: ["Generates data-action or data-arg-action, depending on the component."],
  }),
  attr("event", "point name", {
    notes: ["Generates data-event for normal state updates."],
  }),
  attr("join", "point name", {
    notes: ["When supported, overrides separate action/event and uses the same base point for both directions."],
  }),
] as const;

export const confirmAttrs = [
  attr("confirm", "boolean-like string", {
    notes: ["Generates data-confirm; confirmtext alone implies true."],
  }),
  attr("confirmtitle", "text", { notes: ["Confirmation dialog title."] }),
  attr("confirmtext", "text", { notes: ["Confirmation dialog body text."] }),
] as const;

export const statusShowPointRule: V1UiPointRule = {
  xmlAttributes: ["showevent", "showvalue", "showeventarg"],
  generatedDataAttributes: ["data-showevent", "data-showarg", "data-showeventarg"],
  references: ["showevent"],
  notes: [
    "Visibility uses local event activity, hides generated sections initially, and compares decoded values strictly.",
  ],
};

export const meterShowPointRule: V1UiPointRule = {
  xmlAttributes: ["showevent", "showvalue"],
  generatedDataAttributes: ["data-showevent", "data-showarg"],
  references: ["showevent"],
  notes: ["Meter visibility supports showevent/showvalue; the current meter template does not emit data-showeventarg."],
};

export const eventPointRule: V1UiPointRule = {
  xmlAttributes: ["event"],
  generatedDataAttributes: ["data-event"],
  references: ["event"],
  notes: ["Subscribes generated markup to local event activity for value updates."],
};

export const actionEventJoinPointRule = (
  generatedDataAttributes: readonly string[] = ["data-action", "data-event"],
): V1UiPointRule => ({
  xmlAttributes: ["action", "event", "join"],
  generatedDataAttributes,
  references: ["action", "event"],
  notes: ["join takes precedence where present and creates both action and event references from the same point name."],
});

export const unsupportedClass: V1UiClassPropagationFact = {
  status: "unsupported",
  notes: ["The current transform does not read an XML class attribute for this element."],
};

export const ignoredClass = (target: string): V1UiClassPropagationFact => ({
  status: "ignored",
  target,
  notes: ["An XML class attribute may look plausible here, but the current XSLT does not copy it to generated markup."],
});

export const propagatesClass = (target: string, notes?: readonly string[]): V1UiClassPropagationFact => ({
  status: "propagates",
  target,
  notes: notes ?? [`XML class is appended to ${target}.`],
});

export const partialClass = (target: string, notes: readonly string[]): V1UiClassPropagationFact => ({
  status: "partial",
  target,
  notes,
});

export const V1_UI_CATALOG_METADATA = {
  format: "v1_xml_xslt",
  scope: "legacy Nodel v1 XML dashboard authoring and browser behavior",
  sourceRevision: V1_UI_SOURCE_REVISION,
  sourceBaseUrl: SOURCE_BASE_URL,
  driftCaveat:
    "This catalog is pinned to the named upstream source revision. Installed Nodel runtimes or copied recipe assets can drift; verify live rendering when behavior matters.",
  provenance:
    "Derived from museumsvictoria/nodel under MPL-2.0; this project is independent and is not affiliated with or endorsed by the upstream project.",
  runtimeDependency: "none; this module does not read the sibling Nodel source checkout at runtime",
} as const;

export const V1_NODEL_BUILTIN_TYPES = [
  "description",
  "actsig",
  "log",
  "serverlog",
  "charts",
  "console",
  "params",
  "remote",
  "list",
  "locals",
  "diagnostics",
  "add",
  "editor",
  "toolkit",
  "hosticon",
  "edit",
  "nav",
] as const;

export const V1_UI_AUTHORITATIVE_SOURCES = [
  {
    name: "index.xml",
    role: "Canonical v1 XML authoring sample and processing instruction.",
    sourcePath: "nodel-webui-js/src/index.xml",
    upstreamUrl: `${SOURCE_BASE_URL}/index.xml`,
  },
  {
    name: "index.xsl",
    role: "V1 page shell, asset loading, navigation, dynamic selector templates, and import of templates.xsl.",
    sourcePath: "nodel-webui-js/src/index.xsl",
    upstreamUrl: `${SOURCE_BASE_URL}/index.xsl`,
  },
  {
    name: "templates.xsl",
    role: "Authoritative XML element and attribute transformation rules.",
    sourcePath: "nodel-webui-js/src/templates.xsl",
    upstreamUrl: `${SOURCE_BASE_URL}/templates.xsl`,
  },
  {
    name: "nodel.js",
    role: "Runtime action dispatch, jQuery data decoding consumers, event/activity processing, visibility, and control state behavior.",
    sourcePath: "nodel-webui-js/src/nodel.js",
    upstreamUrl: `${SOURCE_BASE_URL}/nodel.js`,
  },
  {
    name: "theme.less",
    role: "Built-in v1 dashboard CSS, including meter and range orientation rules.",
    sourcePath: "nodel-webui-js/src/theme.less",
    upstreamUrl: `${SOURCE_BASE_URL}/theme.less`,
  },
  {
    name: "Dashboard Snippets wiki",
    role: "Community-authored examples and practical snippets that may lag current source behavior.",
    upstreamUrl: "https://github.com/museumsvictoria/nodel/wiki/Dashboard-Snippets",
  },
] as const;
