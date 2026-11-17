import { createHash } from "node:crypto";
import { parseHtml, walkHtml, type HtmlNode } from "../html.js";
import { UI_ADVISORY_LIMITS } from "../limits.js";
import type { PointDefinition, UiValidationIssue } from "../types.js";
import { diagnosticCollector } from "../diagnostics.js";
import type { UiCapabilities } from "../capabilities-types.js";
import { validateV2Assets } from "./assets.js";
import { indexV2Actions, validateV2Bindings, type BindingBudget, type ActionIndex } from "./bindings.js";
import type { V2Contract, V2ContractElement, V2Attribute } from "./contract.js";
import { knownRuntimeRules, declares } from "./runtime-rules.js";

const standard = new Set(
  "id class style slot part title role tabindex lang dir hidden accesskey contenteditable draggable spellcheck translate inert nonce autocapitalize autofocus enterkeyhint inputmode name value type href target rel src alt width height min max step checked disabled readonly required multiple selected placeholder for action formaction method enctype download loading decoding referrerpolicy crossorigin integrity media sizes as defer async xmlns is itemid itemprop itemref itemscope itemtype exportparts xmlns:xlink xmlns:svg xmlns:html".split(
    " ",
  ),
);
const standardEvents = new Set(
  "onabort onauxclick onbeforeinput onbeforematch onbeforetoggle onblur oncancel onchange onclick onclose oncontextmenu oncopy oncut ondblclick ondrag ondragend ondragenter ondragleave ondragover ondragstart ondrop onerror onfocus onformdata oninput oninvalid onkeydown onkeypress onkeyup onload onmousedown onmouseenter onmouseleave onmousemove onmouseout onmouseover onmouseup onpaste onpointercancel onpointerdown onpointerenter onpointerleave onpointermove onpointerout onpointerover onpointerup onreset onscroll onscrollend onselect onslotchange onsubmit ontoggle onwheel".split(
    " ",
  ),
);
const placeholder = /\{\{[^}]*\}\}|\$\{[^}]*\}/u;
const get = (node: HtmlNode, name: string) => node.attrs?.find((attr) => attr.name === name)?.value;
const has = (node: HtmlNode, name: string) => node.attrs?.some((attr) => attr.name === name) ?? false;
const attrIssue = (
  severity: UiValidationIssue["severity"],
  code: string,
  message: string,
  node: HtmlNode,
  name?: string,
): UiValidationIssue => ({
  severity,
  code,
  message,
  element: node.tagName,
  attribute: name,
  line: node.sourceCodeLocation?.startLine,
  column: node.sourceCodeLocation?.startCol,
  location: node.sourceCodeLocation
    ? {
        line: node.sourceCodeLocation.startLine,
        column: node.sourceCodeLocation.startCol,
        startOffset: node.sourceCodeLocation.startOffset,
        endOffset: node.sourceCodeLocation.endOffset,
      }
    : undefined,
  provenance: { rule: "v2-contract", source: "schema-1 component contract" },
});
const directElements = (node: HtmlNode) => (node.childNodes ?? []).filter((child) => !!child.tagName);
const hasPlaceholder = (value: string) => placeholder.test(value);
type ChildContext = { nodes: HtmlNode[]; tags: Set<string>; definitelyVisible: number };

function numericIssue(
  def: V2Attribute,
  value: string,
  node: HtmlNode,
  issues: UiValidationIssue[],
  work: BindingBudget,
  runtimeKnown: boolean,
) {
  if (!def.numeric) return;
  const numericText = value.trim();
  // Only metadata explicitly documenting integer-prefixed text uses parseInt.
  // normalizesToInteger by itself does NOT specify the string-to-number parser.
  const prefix = def.syntax === "integer-prefixed text" ? /^[-+]?\d+/u.exec(numericText)?.[0] : undefined;
  const templateNumber =
    runtimeKnown && node.tagName === "nodel-template" && ["repeat", "start", "step"].includes(def.name);
  const parsed = Number(prefix ?? numericText);
  if (def.syntax === "integer-prefixed text" && prefix === undefined) {
    issues.push(
      attrIssue(
        "warning",
        "UI_V2_NUMBER_FALLBACK",
        `${def.name} has no integer prefix and uses its component-specific runtime fallback.`,
        node,
        def.name,
      ),
    );
    return;
  }
  if (templateNumber && !Number.isFinite(parsed)) {
    issues.push(
      attrIssue(
        "warning",
        "UI_V2_NUMBER_FALLBACK",
        `${def.name} uses its runtime fallback of 1 because Number(value) is not finite.`,
        node,
        def.name,
      ),
    );
    return;
  }
  if (def.numeric.normalizesToInteger && !templateNumber && !prefix && (!numericText || !Number.isFinite(parsed))) {
    work.numericSkipped = (work.numericSkipped ?? 0) + 1;
    issues.push(
      attrIssue(
        "info",
        "UI_V2_NUMBER_CHECK_SKIPPED",
        `${def.name} conversion/fallback is not specified by normalizesToInteger; check the component runtime.`,
        node,
        def.name,
      ),
    );
    return;
  }
  if ((!templateNumber && !numericText && !prefix) || !Number.isFinite(parsed)) {
    issues.push(
      attrIssue("error", "UI_V2_NUMBER_INVALID", `Expected a finite number for ${def.name}.`, node, def.name),
    );
    return;
  }
  const normalized =
    def.numeric.normalizesToInteger && ((prefix !== undefined && prefix !== numericText) || !Number.isInteger(parsed));
  if (
    (def.valueType === "integer" || def.numeric.integer) &&
    !Number.isInteger(parsed) &&
    !def.numeric.normalizesToInteger
  ) {
    issues.push(attrIssue("error", "UI_V2_INTEGER_INVALID", `${def.name} must be an integer.`, node, def.name));
    return;
  }
  const below =
    def.numeric.min !== undefined && (def.numeric.exclusiveMin ? parsed <= def.numeric.min : parsed < def.numeric.min);
  const above = def.numeric.max !== undefined && parsed > def.numeric.max;
  if (normalized || below || above)
    issues.push(
      attrIssue(
        "warning",
        "UI_V2_NUMBER_NORMALIZED",
        `${def.name} is normalized${below || above ? " and clamped to its supported range" : ""} at runtime.`,
        node,
        def.name,
      ),
    );
}

function validateComponent(
  node: HtmlNode,
  parent: HtmlNode | undefined,
  contract: V2Contract,
  definitions: Map<string, V2ContractElement>,
  issues: UiValidationIssue[],
  actions?: Set<string>,
  signals?: Set<string>,
  work: BindingBudget = { remaining: 4096, truncated: false, schemaSkipped: 0 },
  actionIndex?: ActionIndex,
  parentUnknown = false,
  childrenOf: (node: HtmlNode) => ChildContext = (node) => {
    const nodes = directElements(node);
    return {
      nodes,
      tags: new Set(nodes.map((child) => child.tagName!)),
      definitelyVisible: nodes.filter((child) => !has(child, "hidden") && !has(child, "visibility")).length,
    };
  },
  signalDefinitions?: Map<string, PointDefinition>,
  enumCache = new Map<V2Attribute, Set<string>>(),
  treeComplete = true,
) {
  const element = definitions.get(node.tagName!);
  if (!element) {
    if (node.tagName!.startsWith("nodel-"))
      issues.push(
        attrIssue(
          "warning",
          "UI_V2_COMPONENT_UNKNOWN",
          `Component ${node.tagName} is not in the selected contract.`,
          node,
        ),
      );
    return;
  }
  if (element.registration === "auto-host")
    issues.push(
      attrIssue(
        "warning",
        "UI_V2_INTERNAL_AUTO_HOST",
        "This internal auto-host component is normally supplied by the runtime; avoid authoring it directly.",
        node,
      ),
    );
  const attrs = new Map<string, V2Attribute>();
  for (const definition of [...contract.commonAttributes, ...element.attributes])
    attrs.set(definition.name, definition);
  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (const attribute of node.attrs ?? []) {
    const name = attribute.name,
      value = attribute.value;
    if (seen.has(name))
      issues.push(attrIssue("error", "UI_V2_DUPLICATE_ATTRIBUTE", `Duplicate attribute ${name}.`, node, name));
    seen.add(name);
    values.set(name, value);
    const definition =
      attrs.get(name) ?? (name.startsWith("data-") && attrs.has("data-*") ? attrs.get("data-*") : undefined);
    if (
      !definition &&
      !standard.has(name) &&
      !standardEvents.has(name) &&
      !name.startsWith("aria-") &&
      !name.startsWith("data-") &&
      !name.startsWith("xmlns:")
    ) {
      issues.push(
        attrIssue(
          "warning",
          "UI_V2_ATTRIBUTE_UNKNOWN",
          `Attribute ${name} is not declared for ${node.tagName}.`,
          node,
          name,
        ),
      );
      continue;
    }
    if (!definition) continue;
    if (definition.legacy)
      issues.push(
        attrIssue("warning", "UI_V2_ATTRIBUTE_LEGACY", `${name} is legacy: ${definition.legacy}`, node, name),
      );
    if (definition.completion === "hidden")
      issues.push(
        attrIssue("warning", "UI_V2_ATTRIBUTE_HIDDEN", `${name} is an internal/hidden attribute.`, node, name),
      );
    if (hasPlaceholder(value)) continue;
    if (definition.valueType === "boolean" && value !== "")
      issues.push(
        attrIssue(
          "warning",
          "UI_V2_BOOLEAN_PRESENCE",
          `${name} is boolean by attribute presence; a string value such as "false" still enables it.`,
          node,
          name,
        ),
      );
    if (definition.valueType === "enum" && definition.values) {
      let allowed = enumCache.get(definition);
      if (!allowed) {
        allowed = new Set(definition.values);
        enumCache.set(definition, allowed);
      }
      if (!allowed.has(value))
        issues.push(
          attrIssue(
            "error",
            "UI_V2_ENUM_INVALID",
            `${name} must be one of: ${definition.values
              .slice(0, 12)
              .map((entry) => entry.slice(0, 80))
              .join(", ")}${definition.values.length > 12 ? ", ..." : ""}.`,
            node,
            name,
          ),
        );
    }
    numericIssue(definition, value, node, issues, work, knownRuntimeRules(contract));
  }
  validateV2Bindings(node, element, actions, signals, issues, work, actionIndex, signalDefinitions, {
    known: knownRuntimeRules(contract),
    common: new Set(contract.commonAttributes.map((attribute) => attribute.name)),
  });
  if (element.composition?.requiredParent && parentUnknown) {
    work.templateSkipped = (work.templateSkipped ?? 0) + 1;
    issues.push(
      attrIssue(
        "info",
        "UI_V2_TEMPLATE_PARENT_UNKNOWN",
        "Template clone parent is unknown; required-parent validation was skipped.",
        node,
      ),
    );
  } else if (element.composition?.requiredParent && parent?.tagName !== element.composition.requiredParent)
    issues.push(
      attrIssue(
        "error",
        "UI_V2_PARENT_REQUIRED",
        `${node.tagName} must be a direct child of ${element.composition.requiredParent}.`,
        node,
      ),
    );
  const childContext = childrenOf(node);
  const children = childContext.tags;
  for (const required of treeComplete ? (element.composition?.requiredDirectChildren ?? []) : []) {
    if (!children.has(required) && (children.has("template") || children.has("nodel-template"))) {
      work.templateSkipped = (work.templateSkipped ?? 0) + 1;
      issues.push(
        attrIssue(
          "info",
          "UI_V2_TEMPLATE_CHILDREN_UNKNOWN",
          `Rendered template children may supply ${required}; required-child validation was skipped.`,
          node,
        ),
      );
    } else if (!children.has(required))
      issues.push(
        attrIssue("error", "UI_V2_CHILD_REQUIRED", `${node.tagName} requires direct child ${required}.`, node),
      );
  }
  for (const advisory of treeComplete ? (element.composition?.advisoryDirectChildren ?? []) : [])
    if (!children.has(advisory))
      issues.push(
        attrIssue(
          "warning",
          "UI_V2_CHILD_RECOMMENDED",
          `${node.tagName} is normally composed with a direct ${advisory} child.`,
          node,
        ),
      );
  if (
    knownRuntimeRules(contract) &&
    declares(element, "min-height") &&
    node.tagName === "nodel-page" &&
    values.get("min-height") === "viewport" &&
    children.has("nodel-page")
  )
    issues.push(
      attrIssue(
        "warning",
        "UI_V2_PAGE_VIEWPORT_GROUP",
        "min-height=viewport only applies to a leaf page, not a navigation group.",
        node,
        "min-height",
      ),
    );
  if (
    knownRuntimeRules(contract) &&
    declares(element, "fill") &&
    (node.tagName === "nodel-group" || node.tagName === "nodel-control-grid") &&
    values.has("fill")
  ) {
    if (parentUnknown) {
      work.templateSkipped = (work.templateSkipped ?? 0) + 1;
      issues.push(
        attrIssue(
          "info",
          "UI_V2_TEMPLATE_PARENT_UNKNOWN",
          "Template clone parent is unknown; fill placement was skipped.",
          node,
        ),
      );
    } else if (parent?.tagName !== "nodel-column" && parent?.tagName !== "nodel-page")
      issues.push(
        attrIssue(
          "warning",
          "UI_V2_FILL_PLACEMENT",
          "fill only applies to a sole visible child of nodel-column or direct child of a viewport leaf nodel-page.",
          node,
          "fill",
        ),
      );
    else if (
      (parent.tagName === "nodel-page" && !declares(definitions.get("nodel-page"), "min-height")) ||
      (parent.tagName === "nodel-column" && !definitions.has("nodel-column"))
    )
      work.runtimeSkipped = (work.runtimeSkipped ?? 0) + 1;
    else if (
      parent.tagName === "nodel-page" &&
      (get(parent, "min-height") !== "viewport" || childrenOf(parent).tags.has("nodel-page"))
    )
      issues.push(
        attrIssue(
          "warning",
          "UI_V2_FILL_PAGE",
          "Page-level fill requires min-height=viewport on a leaf nodel-page.",
          node,
          "fill",
        ),
      );
    else if (
      parent.tagName === "nodel-column" &&
      childrenOf(parent).definitelyVisible > (!has(node, "hidden") && !has(node, "visibility") ? 1 : 0)
    )
      issues.push(
        attrIssue(
          "warning",
          "UI_V2_FILL_COMPETING_CHILD",
          "Fill is inactive while the column has another definitely visible direct child.",
          node,
          "fill",
        ),
      );
  }
}

export type V2ValidationOptions = {
  path: string;
  content: string;
  contract: V2Contract;
  capabilities?: UiCapabilities;
  actions?: Set<string>;
  signals?: Set<string>;
  actionsAvailable?: boolean;
  signalsAvailable?: boolean;
  maxIssues?: number;
  actionDefinitions?: PointDefinition[];
  signalDefinitions?: PointDefinition[];
  filePaths?: string[];
};
export function validateV2Ui(options: V2ValidationOptions) {
  const parsed = parseHtml(options.content);
  const diagnostics = diagnosticCollector(options.maxIssues);
  const { issues } = diagnostics;
  for (const error of parsed.errors)
    issues.push({
      severity: "warning",
      code: error.code,
      message: error.message,
      line: error.line,
      column: error.column,
      location: { line: error.line, column: error.column, startOffset: error.startOffset, endOffset: error.endOffset },
      provenance: { rule: "html5-parser", source: "parse5 7.3.0" },
    });
  const definitions = new Map(options.contract.elements.map((entry) => [entry.name, entry]));
  const elements: Array<{ node: HtmlNode; parent?: HtmlNode }> = [];
  const root = parsed.root;
  if (root)
    walkHtml(root, (node) => {
      if (node.tagName) elements.push({ node, parent: node.parentNode?.tagName ? node.parentNode : undefined });
    });
  const templateOwners = new Map<HtmlNode, HtmlNode>();
  for (const { node } of elements) if (node.content) templateOwners.set(node.content, node);
  const renderedParent = (node: HtmlNode): { parent?: HtmlNode; unknown: boolean } => {
    let parent = node.parentNode ?? undefined;
    for (let depth = 0; parent?.nodeName === "#document-fragment"; depth++) {
      if (depth >= UI_ADVISORY_LIMITS.maxDepth) return { unknown: true };
      const template = templateOwners.get(parent),
        host = template?.parentNode;
      if (
        !knownRuntimeRules(options.contract) ||
        host?.tagName !== "nodel-template" ||
        !declares(definitions.get(host.tagName), "template") ||
        get(host, "template")?.trim()
      )
        return { unknown: true };
      // Each clone is inserted as a sibling of its nodel-template host. Resolve
      // outer ownership too, rather than mistaking a nested fragment for a grid.
      parent = host.parentNode ?? undefined;
    }
    return { parent, unknown: false };
  };
  const work: BindingBudget = { remaining: 4096, truncated: false, schemaSkipped: 0 };
  const enumCache = new Map<V2Attribute, Set<string>>();
  const childrenCache = new WeakMap<HtmlNode, ChildContext>();
  const childrenOf = (node: HtmlNode): ChildContext => {
    let context = childrenCache.get(node);
    if (!context) {
      const nodes = directElements(node);
      context = {
        nodes,
        tags: new Set(nodes.map((child) => child.tagName!)),
        definitelyVisible: nodes.filter((child) => !has(child, "hidden") && !has(child, "visibility")).length,
      };
      childrenCache.set(node, context);
    }
    return context;
  };
  let ruleWork = 2_000_000;
  let ruleWorkTruncated = false;
  const actionIndex =
    options.actionsAvailable === false ||
    (!options.actionDefinitions && !options.actions && options.actionsAvailable !== true)
      ? undefined
      : indexV2Actions(options.actionDefinitions ?? [...(options.actions ?? [])].map((name) => ({ name })));
  const signalIndex = options.signalDefinitions
    ? new Map(options.signalDefinitions.map((point) => [point.name, point]))
    : undefined;
  const signals = options.signals ?? (signalIndex ? new Set(signalIndex.keys()) : undefined);
  const custom = elements.filter(({ node }) => node.tagName?.startsWith("nodel-"));
  const contractCustom = custom.filter(({ node }) => definitions.has(node.tagName!));
  const fullDocument =
    !!root &&
    ((root.childNodes ?? []).some((node) => node.nodeName === "#documentType") ||
      elements.some(({ node }) => node.tagName === "html" && !!node.sourceCodeLocation?.startTag));
  if (
    parsed.complete &&
    knownRuntimeRules(options.contract) &&
    definitions.has("nodel-app") &&
    fullDocument &&
    contractCustom.length &&
    !custom.some(({ node }) => node.tagName === "nodel-app")
  )
    issues.push({
      severity: "error",
      code: "UI_V2_APP_SHELL_MISSING",
      message:
        "A full v2 application document should contain a nodel-app shell. HTML fragments are not required to contain one.",
    });
  const shortcutChords = new Set<string>();
  for (const { node } of elements) {
    const definition = definitions.get(node.tagName!);
    if (definition && !knownRuntimeRules(options.contract)) work.runtimeSkipped = (work.runtimeSkipped ?? 0) + 1;
    const cost =
      1 +
      (1 + (node.attrs?.length ?? 0)) *
        (options.contract.commonAttributes.length +
          (definition?.attributes.length ?? 0) +
          (definition?.actionBindings.length ?? 0) +
          (definition?.signalBindings.length ?? 0));
    if (cost > ruleWork) {
      ruleWorkTruncated = true;
      break;
    }
    ruleWork -= cost;
    const { parent: effectiveParent, unknown: parentUnknown } = renderedParent(node);
    // Visibility is installed by the runtime on ordinary HTML as well as
    // registered custom elements. Keep this supplement contract/version-gated;
    // it must not make bundled runtime behavior authoritative for older contracts.
    if (!definition && (node.attrs ?? []).some(({ name }) => ["visibility", "signal", "signals"].includes(name)))
      validateGlobalVisibilityBindings(
        node,
        options.contract,
        options.signalsAvailable === false ? undefined : signals,
        work,
        issues,
      );
    validateComponent(
      node,
      effectiveParent,
      options.contract,
      definitions,
      issues,
      options.actionsAvailable === false ? undefined : options.actions,
      options.signalsAvailable === false ? undefined : signals,
      work,
      actionIndex,
      parentUnknown,
      childrenOf,
      signalIndex,
      enumCache,
      parsed.complete,
    );
    const source = node.sourceCodeLocation?.startTag;
    if (
      node.tagName?.startsWith("nodel-") &&
      source &&
      options.content.slice(source.startOffset, source.endOffset).trimEnd().endsWith("/>") &&
      !(node.tagName === "nodel-control-space" && definition && knownRuntimeRules(options.contract))
    )
      issues.push(
        attrIssue(
          "warning",
          "UI_V2_CUSTOM_SELF_CLOSING",
          `Custom element ${node.tagName} should use an explicit closing tag; HTML ignores XML-style self-closing syntax for custom elements.`,
          node,
        ),
      );
    if (node.tagName === "nodel-shortcut" && definition && knownRuntimeRules(options.contract)) {
      const actionFeature = definition.actionBindings.some(
        (binding) =>
          ["action", "actions"].includes(binding.attribute) &&
          declares(definition, binding.attribute) &&
          binding.phases.includes("trigger"),
      );
      const key = get(node, "key");
      const action = get(node, "action");
      const actions = get(node, "actions");
      if (declares(definition, "key") && (key === undefined || key.length === 0))
        issues.push(
          attrIssue("error", "UI_V2_SHORTCUT_KEY_REQUIRED", "nodel-shortcut requires a nonempty key.", node, "key"),
        );
      if (actionFeature && !action && !actions)
        issues.push(
          attrIssue("error", "UI_V2_SHORTCUT_ACTION_REQUIRED", "nodel-shortcut requires action or actions.", node),
        );
      if (
        definitions.has("nodel-app") &&
        definition.composition?.requiredParent === "nodel-app" &&
        !parentUnknown &&
        effectiveParent?.tagName !== "nodel-app"
      )
        issues.push(
          attrIssue(
            "warning",
            "UI_V2_SHORTCUT_PARENT",
            "nodel-shortcut is intended as a direct child of nodel-app.",
            node,
          ),
        );
      if (
        declares(definition, "key", "ctrl", "alt", "shift", "meta") &&
        actionFeature &&
        key &&
        !hasPlaceholder(key) &&
        !has(node, "disabled") &&
        !has(node, "hidden") &&
        (action || actions) &&
        !hasPlaceholder(action ?? "") &&
        !hasPlaceholder(actions ?? "")
      ) {
        const chord = [
          key,
          ...["ctrl", "alt", "shift", "meta"].map((name) => (get(node, name) === undefined ? "0" : "1")),
        ].join("\u0000");
        if (shortcutChords.has(chord))
          issues.push(
            attrIssue("error", "UI_V2_SHORTCUT_DUPLICATE", "Duplicate nodel-shortcut key/modifier chord.", node, "key"),
          );
        shortcutChords.add(chord);
      }
    }
  }
  if (fullDocument && !contractCustom.length)
    issues.push({
      severity: "warning",
      code: "UI_V2_NO_COMPONENTS",
      message: "No contract components were found in this full HTML document.",
    });
  if (options.actionsAvailable === false)
    issues.push({
      severity: "info",
      code: "UI_V2_ACTION_CHECK_SKIPPED",
      message: "Action existence checks were skipped because action discovery was unavailable.",
    });
  if (options.signalsAvailable === false)
    issues.push({
      severity: "info",
      code: "UI_V2_SIGNAL_CHECK_SKIPPED",
      message: "Signal existence checks were skipped because event discovery was unavailable.",
    });
  if (
    elements.some(
      ({ node }) =>
        node.tagName === "script" && get(node, "type") === "module" && /(?:^|\/)src\//u.test(get(node, "src") ?? ""),
    )
  )
    issues.push({
      severity: "warning",
      code: "UI_V2_MODULE_SOURCE_IMPORT",
      message: "Development source-module imports are not a stable deployed starter reference.",
    });
  if (elements.some(({ node }) => node.tagName === "template"))
    issues.push({
      severity: "info",
      code: "UI_V2_TEMPLATE_STATIC_LIMITATION",
      message:
        "Literal template structure is checked, but rendered clones and interpolated values cannot be fully validated statically.",
    });
  const assetResult = validateV2Assets(
    options.path,
    options.content,
    options.capabilities,
    options.filePaths,
    parsed,
    issues,
    {
      known: knownRuntimeRules(options.contract),
    },
  );
  if (work.truncated)
    issues.push({
      severity: "info",
      code: "UI_V2_BINDING_WORK_TRUNCATED",
      message: "Binding token budget exhausted; remaining bindings were not checked and counts are lower bounds.",
    });
  if (ruleWorkTruncated)
    issues.push({
      severity: "info",
      code: "UI_V2_RULE_WORK_TRUNCATED",
      message:
        "Component rule work budget exhausted; remaining components were not checked and counts are lower bounds.",
    });
  if (work.schemaSkipped)
    issues.push({
      severity: "info",
      code: "UI_V2_SCHEMA_CHECK_SKIPPED",
      message: `${work.schemaSkipped} point payload/schema checks were unknown, dynamic, unavailable, or outside the supported safe subset. Signal-target/live-value schema compatibility is not inferred from names.`,
    });
  if (work.runtimeSkipped)
    issues.push({
      severity: "info",
      code: "UI_V2_RUNTIME_RULES_SKIPPED",
      message:
        "Some source-backed supplements lack a known selected-contract version, declared features, or established foreign-element semantics; unsupported behavior was not inferred.",
    });
  const bounded = issues;
  const errors = diagnostics.counts.error;
  const warnings = diagnostics.counts.warning + parsed.omittedErrors;
  const info = diagnostics.counts.info;
  const incomplete =
    !parsed.complete ||
    options.actionsAvailable === false ||
    options.signalsAvailable === false ||
    ruleWorkTruncated ||
    work.truncated ||
    !!work.schemaSkipped ||
    !!work.numericSkipped ||
    !!work.templateSkipped ||
    !!work.runtimeSkipped ||
    assetResult.incomplete ||
    diagnostics.truncated ||
    !!parsed.omittedErrors ||
    elements.length >= UI_ADVISORY_LIMITS.maxVisitedNodes ||
    ["unchecked", "incomplete", "mismatched", "not_inspected"].includes(assetResult.page.state);
  return {
    ok: errors === 0,
    format: "v2_html" as const,
    path: options.path,
    sha256: createHash("sha256").update(options.content, "utf8").digest("hex"),
    summary: {
      elementCount: elements.length,
      errorCount: errors,
      warningCount: warnings,
      infoCount: info,
      returnedIssueCount: bounded.length,
      truncatedIssues: diagnostics.truncated || !!parsed.omittedErrors,
      bindingWorkTruncated: work.truncated,
      ruleWorkTruncated,
      schemaChecksSkipped: work.schemaSkipped,
      numericChecksSkipped: work.numericSkipped ?? 0,
      templateChecksSkipped: work.templateSkipped ?? 0,
      runtimeChecksSkipped: work.runtimeSkipped ?? 0,
      countsAreLowerBounds: work.truncated || ruleWorkTruncated || !parsed.complete,
      incomplete,
      visitedNodes: parsed.visitedNodes,
      inputBytes: parsed.inputBytes,
    },
    issues: bounded,
    page: assetResult.page,
    limitations: [
      ...assetResult.limitations,
      "Custom JavaScript, CSS, dynamic templates, runtime rendering, and live values are not browser-tested.",
    ],
    parse: {
      complete: parsed.complete,
      errorCount: parsed.errorCount,
      omittedErrors: parsed.omittedErrors,
      truncationReason: parsed.truncationReason,
    },
  };
}

function validateGlobalVisibilityBindings(
  node: HtmlNode,
  contract: V2Contract,
  signals: Set<string> | undefined,
  work: BindingBudget,
  issues: UiValidationIssue[],
) {
  const common = new Set(contract.commonAttributes.map((attribute) => attribute.name));
  const known = knownRuntimeRules(contract) && common.has("visibility");
  // parse5 retains namespaceURI on elements. Keep this local structural check
  // rather than inferring SVG from tag names (foreignObject re-enters HTML).
  const namespace = "namespaceURI" in node ? node.namespaceURI : undefined;
  const foreign = !!namespace && namespace !== "http://www.w3.org/1999/xhtml";
  // Foreign presentation attributes accept CSS syntax (including CSS-wide
  // keywords and var()/env()), not just the three basic SVG visibility values.
  // No such attribute by itself proves authored Nodel binding intent.
  const nativeVisibility = foreign && has(node, "visibility");
  if (foreign && known) {
    work.runtimeSkipped = (work.runtimeSkipped ?? 0) + 1;
    issues.push({
      ...attrIssue(
        "warning",
        "UI_V2_FOREIGN_VISIBILITY_AMBIGUOUS",
        nativeVisibility
          ? "Foreign visibility presentation syntax collides with the runtime's broad initial binding selector; it is not a definite Nodel signal reference. Use CSS visibility for native styling. Foreign-element updates and HTML hidden behavior are not established."
          : "The runtime's initial visibility selector includes foreign elements, but later updates are HTMLElement-gated and HTML hidden behavior is not established. Explicit Nodel references are checked without claiming foreign-element rendering support.",
        node,
        nativeVisibility ? "visibility" : undefined,
      ),
      suggestion: nativeVisibility
        ? "Use CSS visibility for native foreign-element styling instead of the visibility attribute."
        : undefined,
      provenance: {
        rule: "v2-global-visibility",
        source: "nodel-webui-v2/src/data/signal-bindings.ts",
        version: "0.2.0",
      },
    });
  }
  const filtered = {
    ...node,
    attrs: (node.attrs ?? []).flatMap((attribute) => {
      if (!["visibility", "signal", "signals"].includes(attribute.name)) return [];
      if (!known || !common.has(attribute.name)) {
        work.runtimeSkipped = (work.runtimeSkipped ?? 0) + 1;
        return [];
      }
      if (nativeVisibility && attribute.name === "visibility") return [];
      return [attribute];
    }),
  };
  const definition: V2ContractElement = {
    name: node.tagName ?? "html-element",
    description: "Source-backed global visibility bindings.",
    attributes: [],
    audience: "core",
    registration: "global",
    completion: "hidden",
    actionBindings: [],
    signalBindings: [
      {
        attribute: "visibility",
        defaultTarget: "visibility",
        targets: [{ name: "visibility", aggregations: ["any", "all"] }],
      },
      { attribute: "signal", targets: [{ name: "visibility", aggregations: ["any", "all"] }] },
      { attribute: "signals", targets: [{ name: "visibility", aggregations: ["any", "all"] }] },
    ].filter((binding) => known && common.has(binding.attribute)),
    events: [],
  };
  validateV2Bindings(filtered, definition, undefined, signals, issues, work, undefined, undefined, {
    known,
    common,
    visibilityOnly: true,
  });
}
