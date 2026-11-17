import type { V2ContractElement } from "./contract.js";
import type { HtmlNode } from "../html.js";
import type { PointDefinition, UiValidationIssue } from "../types.js";
import { javaActionName, trimPointReference as trim } from "./action-names.js";
import { checkStaticArg, decodeStaticArg, type StaticSchemaCache } from "./schema.js";
import { diagnosticCollector } from "../diagnostics.js";
import { declares } from "./runtime-rules.js";

const templateValue = /\{\{[^}]*\}\}|\$\{[^}]*\}/u;
const get = (node: HtmlNode, name: string) => node.attrs?.find((attr) => attr.name === name)?.value;
export type BindingBudget = {
  remaining: number;
  truncated: boolean;
  schemaSkipped: number;
  numericSkipped?: number;
  templateSkipped?: number;
  runtimeSkipped?: number;
  schemaCache?: StaticSchemaCache;
  phaseCache?: WeakMap<V2ContractElement["actionBindings"][number], Set<string>>;
};
export type ActionIndex = Map<string, PointDefinition[]>;
export function indexV2Actions(points: PointDefinition[]): ActionIndex {
  const result: ActionIndex = new Map();
  for (const point of points) {
    const key = javaActionName(point.name),
      existing = result.get(key);
    if (existing) existing.push(point);
    else result.set(key, [point]);
  }
  return result;
}

/** Boundary recognition only, never JavaScript parsing/evaluation. Support
 * balanced braces and single/double quoted strings in a deliberately restricted
 * lexical subset. Slash (comments/regex), backticks, line breaks and unquoted
 * escapes are uncertain: do not attempt to recover a boundary from their text.
 * Iterative and linear, including deeply nested or unclosed placeholders. */
function placeholderEnd(value: string, start: number): number {
  let braces = value[start] === "$" ? 1 : 2;
  let quote: string | undefined;
  let escaped = false;
  for (let index = start + 2; index < value.length; index++) {
    const ch = value[index];
    if (ch === "/" || ch === "`" || ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029") return -1;
    if (escaped) escaped = false;
    else if (quote && ch === "\\") escaped = true;
    else if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === "\\") return -1;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") braces++;
    else if (ch === "}" && --braces === 0) return index + 1;
  }
  return -1;
}

/** Streaming split: a long list never allocates tens of thousands of tokens or
 * diagnostic objects. Counts are lower bounds if this work budget is exhausted. */
function* parts(value: string, budget: BindingBudget, literal = false, protectTemplates = false): Generator<string> {
  // Preflight the WHOLE attribute before yielding any literal diagnostics. An
  // uncertain later placeholder invalidates even earlier apparent list entries.
  // Two linear passes, constant space; no token array or backtracking regex.
  if (protectTemplates) {
    for (let index = 0; index < value.length; index++) {
      if (!value.startsWith("{{", index) && !value.startsWith("${", index)) continue;
      const end = placeholderEnd(value, index);
      if (end < 0) {
        budget.schemaSkipped++;
        return;
      }
      index = end - 1;
    }
  }
  let start = 0;
  for (let index = 0; index <= value.length; index++) {
    // Preflight proved these restricted boundaries; skip their separators.
    if (protectTemplates && index < value.length) {
      if (value.startsWith("{{", index) || value.startsWith("${", index)) {
        index = placeholderEnd(value, index) - 1;
        continue;
      }
    }
    if (index !== value.length && (literal || (value[index] !== ";" && value[index] !== ","))) continue;
    if (budget.remaining-- <= 0) {
      budget.truncated = true;
      return;
    }
    yield trim(value.slice(start, index));
    start = index + 1;
  }
}

function expression(input: string): { alias: string; valid: boolean } {
  const value = trim(input),
    segments: string[] = [];
  let start = 0,
    slashes = 0;
  for (let index = 0; index < value.length; index++) {
    const ch = value[index];
    if (ch === "." && slashes % 2 === 0) {
      segments.push(value.slice(start, index));
      start = index + 1;
    }
    slashes = ch === "\\" ? slashes + 1 : 0;
  }
  segments.push(value.slice(start));
  const names = segments.map((segment) => trim(segment).replace(/\\\./gu, "."));
  return { alias: names[0] ?? "", valid: names.every(Boolean) };
}

function hasActionEntry(raw: string | undefined) {
  if (!raw) return false;
  let start = 0;
  for (let index = 0; index <= raw.length; index++) {
    if (index === raw.length || raw[index] === ";" || raw[index] === ",") {
      if (trim(raw.slice(start, index))) return true;
      start = index + 1;
    }
  }
  return false;
}

export function validateV2Bindings(
  node: HtmlNode,
  definition: V2ContractElement,
  actions?: Set<string>,
  signals?: Set<string>,
  sink?: UiValidationIssue[],
  work: BindingBudget = { remaining: 4096, truncated: false, schemaSkipped: 0 },
  actionIndex: ActionIndex | undefined = actions ? indexV2Actions([...actions].map((name) => ({ name }))) : undefined,
  signalDefinitions?: Map<string, PointDefinition>,
  rules: { known: boolean; common: Set<string>; visibilityOnly?: boolean } = { known: false, common: new Set() },
) {
  const issues = sink ?? diagnosticCollector().issues;
  const report = (severity: UiValidationIssue["severity"], code: string, message: string, attribute?: string) =>
    issues.push({
      severity,
      code,
      message,
      element: node.tagName,
      attribute,
      line: node.sourceCodeLocation?.startLine,
      column: node.sourceCodeLocation?.startCol,
      provenance: {
        rule: "v2-bindings",
        source: "nodel-webui-v2/src/data/{action-bindings,signal-bindings}.ts; Java SimpleName",
      },
    });
  const attr = (name: string) => get(node, name);
  const templated = (value: string) => templateValue.test(value);
  const rawArg = attr("arg"),
    argType = attr("arg-type") ?? "string";
  // Only these controls use the literal arg via buildActionPayload unchanged.
  const staticPayload =
    rules.known &&
    declares(definition, "arg", "arg-type") &&
    ["nodel-button", "nodel-shortcut"].includes(node.tagName ?? "") &&
    rawArg !== undefined &&
    !templated(rawArg);
  const decoded = staticPayload ? decodeStaticArg(rawArg!, argType) : undefined;
  const stringLength = decoded?.ok && typeof decoded.value === "string" ? Array.from(decoded.value).length : undefined;
  work.schemaCache ??= new Map();
  work.phaseCache ??= new WeakMap();
  if (decoded && !decoded.ok) report("error", "UI_V2_ARG_INVALID", `arg is not a valid ${argType} argument.`, "arg");
  const checkAction = (name: string, attribute: string) => {
    if (!actionIndex) {
      // Catalogue absence prevents every schema check, including generated pad,
      // palette/select/slider payloads with no literal `arg` attribute.
      work.schemaSkipped++;
      return;
    }
    const matches = actionIndex.get(javaActionName(name));
    if (!matches) {
      report(
        "error",
        "UI_V2_ACTION_MISSING",
        `Action ${name} is not registered on the node (Java SimpleName matching).`,
        attribute,
      );
      return;
    }
    if (matches.length !== 1) {
      report(
        "warning",
        "UI_V2_ACTION_AMBIGUOUS",
        `Action ${name} matches multiple normalized names; schema selection is unknown.`,
        attribute,
      );
      work.schemaSkipped++;
      return;
    }
    if (decoded?.ok) {
      const checked = checkStaticArg(matches[0]!.schema, decoded.value, work.schemaCache, stringLength);
      if (checked === "rejected")
        report(
          "error",
          "UI_V2_ARG_SCHEMA_MISMATCH",
          `Typed ${argType} arg is not accepted by action ${matches[0]!.name}'s schema.`,
          "arg",
        );
      else if (checked === "unknown") work.schemaSkipped++;
    } else if (!rules.known || rawArg !== undefined || !["nodel-button", "nodel-shortcut"].includes(node.tagName ?? ""))
      work.schemaSkipped++;
  };
  const padDirections = ["up", "down", "left", "right", "center"];
  const padOverridesKnown =
    rules.known &&
    node.tagName === "nodel-pad" &&
    padDirections.every(
      (direction) =>
        declares(definition, `${direction}-action`, `${direction}-actions`) &&
        definition.actionBindings.some((binding) => binding.attribute === `${direction}-action`) &&
        definition.actionBindings.some((binding) => binding.attribute === `${direction}-actions`),
    );
  const possibleDirections = padDirections.filter(
    (direction) =>
      direction !== "center" || !declares(definition, "center") || attr("center")?.trim().toLowerCase() !== "hide",
  );
  const allPadDirectionsOverride =
    padOverridesKnown &&
    possibleDirections.every(
      (direction) => hasActionEntry(attr(`${direction}-action`)) || hasActionEntry(attr(`${direction}-actions`)),
    );
  const padOverrideDynamic =
    allPadDirectionsOverride &&
    possibleDirections.some(
      (direction) => templated(attr(`${direction}-action`) ?? "") || templated(attr(`${direction}-actions`) ?? ""),
    );
  let explicitActions = false;
  for (const binding of definition.actionBindings) {
    if (binding.attribute === "join") continue;
    const raw = attr(binding.attribute);
    if (raw === undefined) continue;
    if (["action", "actions"].includes(binding.attribute) && allPadDirectionsOverride) {
      if (padOverrideDynamic) work.schemaSkipped++;
      continue; // Runtime bindings(direction) returns specific bindings first.
    }
    const alias = binding.attribute === "action-on" || binding.attribute === "action-off";
    if (alias && (!rules.known || !declares(definition, binding.attribute))) {
      work.schemaSkipped++;
      continue;
    }
    const literal = alias;
    const shortcutBinding =
      rules.known &&
      node.tagName === "nodel-shortcut" &&
      declares(definition, binding.attribute) &&
      binding.phases.includes("trigger");
    let phases = work.phaseCache.get(binding);
    if (!phases) {
      phases = new Set(binding.phases);
      work.phaseCache.set(binding, phases);
    }
    for (const part of parts(raw, work, literal)) {
      if (!part) {
        if (shortcutBinding)
          report(
            "error",
            "UI_V2_SHORTCUT_ACTION_GRAMMAR",
            "Shortcut action lists cannot contain empty entries or trailing separators.",
            binding.attribute,
          );
        continue;
      }
      explicitActions = true;
      if (templated(part)) {
        work.schemaSkipped++;
        continue;
      }
      const colon = literal ? -1 : part.lastIndexOf(":");
      const action = colon > 0 ? trim(part.slice(0, colon)) : part;
      const explicitPhase = colon > 0 && colon < part.length - 1 ? part.slice(colon + 1).trim() : undefined;
      const derivedDefault =
        rules.known &&
        ((node.tagName === "nodel-pad" && ["click", "press", "release"].every((phase) => phases.has(phase))) ||
          (node.tagName === "nodel-palette" && ["change", "live"].every((phase) => phases.has(phase))));
      const phase = explicitPhase ?? binding.defaultPhase;
      if (shortcutBinding && (colon === 0 || colon === part.length - 1))
        report(
          "error",
          "UI_V2_SHORTCUT_ACTION_GRAMMAR",
          "Shortcut bindings require a nonempty action and trigger phase.",
          binding.attribute,
        );
      else if (!action || (phase && !phases.has(phase)))
        report(
          "error",
          "UI_V2_ACTION_BINDING_INVALID",
          `Action binding ${part} has an unsupported phase; allowed: ${binding.phases
            .slice(0, 12)
            .map((value) => value.slice(0, 80))
            .join(", ")}${binding.phases.length > 12 ? ", ..." : ""}.`,
          binding.attribute,
        );
      else {
        if (!phase && !derivedDefault) {
          work.schemaSkipped++;
          report(
            "info",
            "UI_V2_ACTION_PHASE_UNKNOWN",
            "The selected contract does not specify a default phase and this component's runtime default is unknown.",
            binding.attribute,
          );
        }
        checkAction(action, binding.attribute);
      }
    }
    if (work.truncated) break;
  }
  const join = trim(attr("join") ?? "");
  if (
    join &&
    !explicitActions &&
    !templated(join) &&
    definition.actionBindings.some((binding) => binding.attribute === "join")
  )
    checkAction(join, "join");

  const checkSignalList = (
    name: string,
    raw: string,
    defaultTarget: string | undefined,
    targets: Array<{ name: string; aggregations: string[] }>,
  ) => {
    for (const part of parts(raw, work, false, true)) {
      if (!part) continue;
      // Detect placeholders before interpreting ANY colon, including ternaries
      // and object syntax inside the placeholder. Their expansion is unknown;
      // even an uncertain/unclosed expression must not prove a missing alias.
      if (part.includes("{{") || part.includes("${")) {
        work.schemaSkipped++;
        continue;
      }
      const colon = part.indexOf(":"),
        ref = trim(colon < 0 ? part : part.slice(0, colon));
      const spec = colon < 0 ? defaultTarget : part.slice(colon + 1).trim();
      // Same target parser as the runtime: aggregation is case-insensitive,
      // target names are exact. Global visibility selects AFTER parsing; other
      // ordinary-HTML targets and signal(s) without a default are not consumed.
      const match = spec && /^(.+)\((last|any|all)\)$/iu.exec(spec);
      const target = (match ? match[1] : spec)?.trim(),
        mode = match?.[2]?.toLowerCase() ?? "last";
      if (rules.visibilityOnly && target !== "visibility") continue;
      const parsed = expression(ref);
      if (!parsed.valid) {
        report("error", "UI_V2_SIGNAL_BINDING_INVALID", `Signal expression ${ref} is malformed.`, name);
        continue;
      }
      const allowed = targets.find((candidate) => candidate.name === target);
      if (spec === undefined && !rules.known) {
        work.schemaSkipped++;
        report(
          "info",
          "UI_V2_SIGNAL_DEFAULT_UNKNOWN",
          "The selected contract omits a default signal target and this runtime version is not covered by source-backed supplements.",
          name,
        );
      } else if (!allowed || (mode !== "last" && !allowed.aggregations.includes(mode)))
        report(
          "error",
          "UI_V2_SIGNAL_TARGET_INVALID",
          spec === undefined
            ? `Signal ${ref} needs an explicit target; ${node.tagName} has no default target.`
            : `Signal target ${spec} is unsupported for ${name}.`,
          name,
        );
      if (signals && !signals.has(parsed.alias))
        report(
          "error",
          "UI_V2_EVENT_MISSING",
          `Signal ${parsed.alias} is not registered on the node (exact alias matching).`,
          name,
        );
      else if (signals || signalDefinitions?.has(parsed.alias)) {
        // Existence is exact, but target handlers format/coerce/project live
        // values differently. Retain schema definitions and explicitly defer
        // these dynamic checks rather than treating name lookup as schema proof.
        work.schemaSkipped++;
      }
    }
  };
  for (const binding of definition.signalBindings) {
    const raw = attr(binding.attribute);
    const targets =
      rules.known &&
      rules.common.has("visibility") &&
      ["signal", "signals"].includes(binding.attribute) &&
      !binding.targets.some((target) => target.name === "visibility")
        ? [...binding.targets, { name: "visibility", aggregations: ["any", "all"] }]
        : binding.targets;
    const optionsDefault =
      rules.known &&
      ["nodel-select", "nodel-segmented"].includes(node.tagName ?? "") &&
      declares(definition, "options-signal") &&
      binding.attribute === "options-signal" &&
      binding.targets.some((target) => target.name === "options");
    if (raw !== undefined && !work.truncated)
      checkSignalList(
        binding.attribute,
        raw,
        binding.defaultTarget ?? (optionsDefault ? "options" : undefined),
        targets,
      );
  }
  // Common visibility consumes signal(s) only with an explicit visibility target.
  for (const name of ["signal", "signals", "visibility"]) {
    if (!rules.known || !rules.common.has("visibility") || !rules.common.has(name)) continue;
    if (definition.signalBindings.some((binding) => binding.attribute === name)) continue;
    const raw = attr(name);
    if (raw !== undefined && !work.truncated)
      checkSignalList(name, raw, name === "visibility" ? "visibility" : undefined, [
        { name: "visibility", aggregations: ["any", "all"] },
      ]);
  }
  const codeMode = attr("confirm-mode")?.trim().toLowerCase() === "code";
  const confirmCode = trim(attr("confirm-code-signal") ?? "") || (codeMode ? "ConfirmCode" : "");
  if (
    rules.known &&
    declares(definition, "confirm-mode", "confirm-code-signal") &&
    confirmCode &&
    !templated(confirmCode) &&
    signals &&
    !signals.has(confirmCode)
  )
    report(
      "error",
      "UI_V2_CONFIRM_SIGNAL_MISSING",
      `Confirmation signal ${confirmCode} is not registered (exact alias matching).`,
      "confirm-code-signal",
    );
  if (rules.known && node.tagName === "nodel-link" && declares(definition, "href", "node", "event-binding")) {
    const destinations = ["href", "node", "event-binding"].filter((name) => attr(name) !== undefined);
    if (destinations.length !== 1)
      report("error", "UI_V2_LINK_DESTINATION", "nodel-link requires exactly one of href, node, or event-binding.");
    else if (!attr(destinations[0]!)?.trim())
      report("error", "UI_V2_LINK_DESTINATION_EMPTY", "nodel-link destination must be nonempty.", destinations[0]);
  }
  return issues;
}
