import { decodeV1DataAttribute, getV1UiComponent } from "../../nodel/v1UiCatalog.js";
import type { UiElement } from "./parser.js";
import type { FrontendSchemaOverride, PointDefinition, UiPointReference, UiValidationIssue } from "./types.js";
import {
  addIssue,
  approximatelyInteger,
  isRecord,
  jsonEqual,
  jsonType,
  numberAttribute,
  stringValue,
} from "./utils.js";

export type UiPointKind = "action" | "event";

export function canonicalPointName(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

export function schemaTypes(schema: unknown) {
  if (!isRecord(schema)) return [];
  const type = schema.type;
  return typeof type === "string"
    ? [type]
    : Array.isArray(type)
      ? type.filter((entry): entry is string => typeof entry === "string")
      : [];
}

export function normalizePointDefinitions(value: unknown): PointDefinition[] {
  if (Array.isArray(value)) {
    return value.flatMap((definition, index) => {
      if (!isRecord(definition)) return [];
      return [
        {
          name: stringValue(definition.name) ?? stringValue(definition.title) ?? String(index),
          schema: definition.schema ?? definition.params ?? definition.arguments,
        },
      ];
    });
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([name, definition]) => ({
    name,
    schema: isRecord(definition) ? (definition.schema ?? definition.params ?? definition.arguments) : undefined,
  }));
}

export function pointMap(definitions: PointDefinition[]) {
  return new Map(definitions.map((definition) => [canonicalPointName(definition.name), definition]));
}

export function collectPointReferences(
  element: UiElement,
  references: UiPointReference[],
  issues: UiValidationIssue[],
) {
  const attrs = element.attributes;
  const component = getV1UiComponent(element.name);
  if (!component) return;
  const supported = new Set(component.attributes.map((attribute) => attribute.name));
  const momentary = element.name === "button" && attrs.type === "momentary";
  const join = attrs.join;
  if (!momentary && supported.has("join") && join) {
    addPointReference(references, element, "action", join, "join", false);
    addPointReference(references, element, "event", join, "join", false);
  } else if (!momentary) {
    if (supported.has("action"))
      for (const action of parseActionNames(attrs.action, element, issues))
        addPointReference(references, element, "action", action, "action", false);
    if (supported.has("event") && attrs.event)
      addPointReference(references, element, "event", attrs.event, "event", false);
  }
  if (supported.has("action-on") && attrs["action-on"])
    addPointReference(references, element, "action", attrs["action-on"], "action-on", false);
  if (supported.has("action-off") && attrs["action-off"])
    addPointReference(references, element, "action", attrs["action-off"], "action-off", false);
  if (supported.has("showevent") && attrs.showevent)
    addPointReference(references, element, "event", attrs.showevent, "showevent", false);
  if (supported.has("data") && attrs.data) addPointReference(references, element, "event", attrs.data, "data", false);
  if (element.name === "range" && attrs.type === "mute") {
    const actionBase = join ?? attrs.action;
    const eventBase = join ?? attrs.event;
    if (actionBase) addPointReference(references, element, "action", `${actionBase}Muting`, "type=mute", true);
    if (eventBase) addPointReference(references, element, "event", `${eventBase}Muting`, "type=mute", true);
  }
}

export function validatePointReferences(
  references: UiPointReference[],
  actionMap: Map<string, PointDefinition>,
  signalMap: Map<string, PointDefinition>,
  issues: UiValidationIssue[],
  parserDetected: boolean,
) {
  for (const reference of references) {
    const definitions = reference.kind === "action" ? actionMap : signalMap;
    if (definitions.has(canonicalPointName(reference.name))) continue;
    issues.push({
      severity: "error",
      code: reference.derived
        ? "UI_MUTING_POINT_MISSING"
        : parserDetected && (reference.attribute === "data" || reference.attribute === "showevent")
          ? "UI_FRONTEND_AUX_POINT_MISSING"
          : reference.kind === "action"
            ? "UI_ACTION_MISSING"
            : "UI_EVENT_MISSING",
      message: `${reference.kind === "action" ? "Action" : "Signal/event"} ${reference.name} referenced by ${reference.element}@${reference.attribute} is not registered on the node.${reference.derived && parserDetected ? " The standard Frontend parser does not create Muting companions automatically." : parserDetected && (reference.attribute === "data" || reference.attribute === "showevent") ? ` The standard Frontend parser does not register ${reference.attribute} points automatically.` : ""}`,
      element: reference.element,
      attribute: reference.attribute,
      line: reference.line,
      column: reference.column,
      parserSpecific:
        parserDetected && (reference.derived || reference.attribute === "data" || reference.attribute === "showevent"),
    });
  }
}

export function validateElementValues(
  element: UiElement,
  parent: UiElement | undefined,
  actions: Map<string, PointDefinition>,
  signals: Map<string, PointDefinition>,
  issues: UiValidationIssue[],
  parserDetected: boolean,
  frontendSchemas: Record<string, unknown>,
  findings: Map<string, FrontendSchemaOverride>,
) {
  const expectedType = expectedElementValueType(element);
  const actionNames = decodeActionNames(element.attributes.join ?? element.attributes.action) ?? [];
  const eventName = element.attributes.join ?? element.attributes.event;
  if (expectedType) {
    for (const actionName of actionNames)
      compareSchemaType(element, "action", actionName, actions, expectedType, issues);
    compareSchemaType(element, "event", eventName, signals, expectedType, issues);
  }
  if (element.name === "button") {
    for (const attribute of ["arg", "arg-on", "arg-off"] as const) {
      const source = element.attributes[attribute];
      if (source === undefined) continue;
      const value = decodeV1DataAttribute(source);
      for (const actionName of actionNames)
        compareSchemaValue(element, "action", actionName, actions, value, issues, attribute);
      const eventDefinition = eventName ? signals.get(canonicalPointName(eventName)) : undefined;
      if (eventDefinition?.schema && !schemaAcceptsValue(eventDefinition.schema, value))
        addIssue(
          issues,
          element,
          "warning",
          "UI_BUTTON_EVENT_TYPE_MISMATCH",
          `Button ${attribute} decodes as ${jsonType(value)}, but event ${eventName} schema does not accept that value; strict active-state matching may fail.`,
          attribute,
        );
    }
  }
  if ((element.name === "pill" || element.name === "item") && element.attributes.value !== undefined && parent) {
    const parentActions = decodeActionNames(parent.attributes.join ?? parent.attributes.action) ?? [];
    const parentEvent = parent.attributes.join ?? parent.attributes.event;
    const value = decodeV1DataAttribute(element.attributes.value);
    for (const actionName of parentActions)
      compareSchemaValue(element, "action", actionName, actions, value, issues, "value");
    const eventSchema = parentEvent ? signals.get(canonicalPointName(parentEvent))?.schema : undefined;
    if (eventSchema && !schemaAcceptsValue(eventSchema, value))
      addIssue(
        issues,
        element,
        "warning",
        "UI_SELECTION_EVENT_TYPE_MISMATCH",
        `${element.name} value decodes as ${jsonType(value)}, but event ${parentEvent} schema does not accept that value; strict active-state matching may fail.`,
        "value",
      );
  }
  if (element.attributes.showevent && element.attributes.showvalue !== undefined) {
    const values = Array.isArray(decodeV1DataAttribute(element.attributes.showvalue))
      ? (decodeV1DataAttribute(element.attributes.showvalue) as unknown[])
      : [decodeV1DataAttribute(element.attributes.showvalue)];
    const schema = signals.get(canonicalPointName(element.attributes.showevent))?.schema;
    if (schema && values.some((value) => !schemaAcceptsValue(schema, value)))
      addIssue(
        issues,
        element,
        "warning",
        "UI_SHOWVALUE_TYPE_MISMATCH",
        `One or more showvalue entries are not accepted by showevent ${element.attributes.showevent} schema; strict visibility matching may fail.`,
        "showvalue",
      );
  }
  if (parserDetected) {
    for (const actionName of actionNames)
      collectFrontendSchemaOverride(
        element,
        actionName,
        actions,
        frontendSchemas[`${element.name}_action`] ?? frontendSchemas[element.name],
        "action",
        findings,
      );
    collectFrontendSchemaOverride(
      element,
      eventName,
      signals,
      frontendSchemas[`${element.name}_signal`] ?? frontendSchemas[element.name],
      "event",
      findings,
    );
  }
  if (element.name === "range")
    validateRange(element, actionNames, eventName, actions, signals, issues, parserDetected, frontendSchemas);
}

export function emitFrontendSchemaOverrides(
  findings: Map<string, FrontendSchemaOverride>,
  issues: UiValidationIssue[],
) {
  for (const finding of findings.values()) {
    issues.push({
      severity: "info",
      code: "UI_FRONTEND_CUSTOM_SCHEMA_OVERRIDE",
      message: `Live registered schema for ${finding.name} differs from the Frontend parser's element schema (${[...finding.differences].join("; ")}). The parser skips existing points, so the live ${[...finding.roles].join("/")} schema is authoritative. Referenced by ${finding.origins.size} XML control${finding.origins.size === 1 ? "" : "s"}.`,
      element: finding.element,
      line: finding.line,
      column: finding.column,
      parserSpecific: true,
    });
  }
}

export function summarizePointReferences(references: UiPointReference[]) {
  const grouped = new Map<
    string,
    {
      kind: "action" | "event";
      name: string;
      derived: boolean;
      origins: Array<{ element: string; attribute: string; line: number }>;
    }
  >();
  for (const reference of references) {
    const key = `${reference.kind}:${canonicalPointName(reference.name)}`;
    const existing = grouped.get(key) ?? {
      kind: reference.kind,
      name: reference.name,
      derived: reference.derived,
      origins: [],
    };
    existing.derived ||= reference.derived;
    existing.origins.push({
      element: reference.element,
      attribute: reference.attribute,
      line: reference.line,
    });
    grouped.set(key, existing);
  }
  return [...grouped.values()];
}

function validateRange(
  element: UiElement,
  actionNames: string[],
  eventName: string | undefined,
  actions: Map<string, PointDefinition>,
  signals: Map<string, PointDefinition>,
  issues: UiValidationIssue[],
  parserDetected: boolean,
  frontendSchemas: Record<string, unknown>,
) {
  for (const actionName of actionNames) compareRangeSchema(element, actionName, actions, "action", issues);
  compareRangeSchema(element, eventName, signals, "event", issues);
  if (!parserDetected) return;
  const schema = frontendSchemas.range;
  const type = schemaTypes(schema).join("|");
  const liveSchemas = [
    ...actionNames.map((name) => actions.get(canonicalPointName(name))?.schema),
    eventName ? signals.get(canonicalPointName(eventName))?.schema : undefined,
  ];
  const liveSchemasDescribeRange =
    liveSchemas.length > 0 &&
    liveSchemas.every((registered) => registered !== undefined && rangeSchemaDescribesUi(element, registered));
  if (schema && !liveSchemasDescribeRange && !rangeSchemaDescribesUi(element, schema))
    addIssue(
      issues,
      element,
      "info",
      "UI_FRONTEND_RANGE_BOUNDS_NOT_DERIVED",
      `Standard Frontend parser selects the range schema by element type${type ? ` (${type})` : ""}; XML min/max/step do not add schema bounds.`,
      undefined,
      true,
    );
}

function compareRangeSchema(
  element: UiElement,
  pointName: string | undefined,
  definitions: Map<string, PointDefinition>,
  kind: "action" | "event",
  issues: UiValidationIssue[],
) {
  if (!pointName) return;
  const schema = definitions.get(canonicalPointName(pointName))?.schema;
  if (!schema) return;
  const uiMin = numberAttribute(element.attributes.min);
  const uiMax = numberAttribute(element.attributes.max);
  const uiStep = numberAttribute(element.attributes.step ?? "1");
  const minimum = schemaMinimum(schema);
  const maximum = schemaMaximum(schema);
  const multipleOf = schemaNumber(schema, "multipleOf");
  if (uiMin !== undefined && minimum !== undefined && uiMin < minimum)
    addIssue(
      issues,
      element,
      "warning",
      "UI_RANGE_SCHEMA_MIN_MISMATCH",
      `Range min ${uiMin} can send below ${kind} ${pointName} schema minimum ${minimum}.`,
      "min",
    );
  if (uiMax !== undefined && maximum !== undefined && uiMax > maximum)
    addIssue(
      issues,
      element,
      "warning",
      "UI_RANGE_SCHEMA_MAX_MISMATCH",
      `Range max ${uiMax} can send above ${kind} ${pointName} schema maximum ${maximum}.`,
      "max",
    );
  if (uiStep !== undefined && multipleOf !== undefined && !approximatelyInteger(uiStep / multipleOf))
    addIssue(
      issues,
      element,
      "warning",
      "UI_RANGE_SCHEMA_STEP_MISMATCH",
      `Range step ${uiStep} is incompatible with ${kind} ${pointName} schema multipleOf ${multipleOf}.`,
      "step",
    );
  const missing: string[] = [];
  if (uiMin !== undefined && minimum === undefined) missing.push("min");
  if (uiMax !== undefined && maximum === undefined) missing.push("max");
  if (uiStep !== undefined && !schemaStepIsImplicit(schema, uiStep) && multipleOf === undefined) missing.push("step");
  if (missing.length > 0)
    addIssue(
      issues,
      element,
      "info",
      "UI_RANGE_SCHEMA_BOUNDS_INCOMPLETE",
      `${kind} ${pointName} schema does not describe XML ${missing.join("/")}.`,
    );
}

function collectFrontendSchemaOverride(
  element: UiElement,
  pointName: string | undefined,
  definitions: Map<string, PointDefinition>,
  selectedSchema: unknown,
  kind: "action" | "event",
  findings: Map<string, FrontendSchemaOverride>,
) {
  if (!pointName || !isRecord(selectedSchema)) return;
  const registered = definitions.get(canonicalPointName(pointName))?.schema;
  if (!isRecord(registered)) return;
  const differences: string[] = [];
  for (const key of ["type", "multipleOf", "enum"] as const)
    if (selectedSchema[key] !== undefined && !jsonEqual(registered[key], selectedSchema[key]))
      differences.push(
        `${kind}.${key}: parser=${formatSchemaValue(selectedSchema[key])}, live=${formatSchemaValue(registered[key])}`,
      );
  const selectedMinimum = schemaMinimum(selectedSchema);
  const selectedMaximum = schemaMaximum(selectedSchema);
  if (selectedMinimum !== undefined && schemaMinimum(registered) !== selectedMinimum)
    differences.push(`${kind}.min: parser=${selectedMinimum}, live=${formatSchemaValue(schemaMinimum(registered))}`);
  if (selectedMaximum !== undefined && schemaMaximum(registered) !== selectedMaximum)
    differences.push(`${kind}.max: parser=${selectedMaximum}, live=${formatSchemaValue(schemaMaximum(registered))}`);
  if (differences.length === 0) return;
  const canonicalName = canonicalPointName(pointName);
  const finding = findings.get(canonicalName) ?? {
    name: pointName,
    roles: new Set<"action" | "event">(),
    differences: new Set<string>(),
    origins: new Set<string>(),
    element: element.name,
    line: element.line,
    column: element.column,
  };
  finding.roles.add(kind);
  for (const difference of differences) finding.differences.add(difference);
  finding.origins.add(`${element.name}:${element.line}:${element.column}`);
  findings.set(canonicalName, finding);
}

function addPointReference(
  references: UiPointReference[],
  element: UiElement,
  kind: UiPointKind,
  name: string,
  attribute: string,
  derived: boolean,
) {
  if (name.trim())
    references.push({
      kind,
      name,
      attribute,
      element: element.name,
      line: element.line,
      column: element.column,
      derived,
    });
}
function parseActionNames(value: string | undefined, element: UiElement, issues: UiValidationIssue[]) {
  const decoded = decodeActionNames(value);
  if (decoded) return decoded;
  addIssue(
    issues,
    element,
    "error",
    "UI_ACTION_ARRAY_INVALID",
    "action JSON arrays must contain only non-empty action name strings.",
    "action",
  );
  return [];
}
function decodeActionNames(value: string | undefined) {
  if (!value) return [];
  if (!value.trim().startsWith("[")) return [value];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string" && entry.length > 0)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
function compareSchemaType(
  element: UiElement,
  kind: UiPointKind,
  pointName: string | undefined,
  definitions: Map<string, PointDefinition>,
  expectedType: string,
  issues: UiValidationIssue[],
  attribute?: string,
) {
  if (!pointName) return;
  const actual = schemaTypes(definitions.get(canonicalPointName(pointName))?.schema);
  if (actual.length > 0 && !actual.some((type) => schemaTypeAcceptsExpected(type, expectedType)))
    addIssue(
      issues,
      element,
      "warning",
      "UI_POINT_SCHEMA_TYPE_MISMATCH",
      `${kind} ${pointName} schema type is ${actual.join("|")}, but this control sends/displays ${expectedType}.`,
      attribute,
    );
}
function compareSchemaValue(
  element: UiElement,
  kind: UiPointKind,
  pointName: string | undefined,
  definitions: Map<string, PointDefinition>,
  value: unknown,
  issues: UiValidationIssue[],
  attribute?: string,
) {
  if (!pointName) return;
  const schema = definitions.get(canonicalPointName(pointName))?.schema;
  if (schema && !schemaAcceptsValue(schema, value))
    addIssue(
      issues,
      element,
      "warning",
      "UI_POINT_SCHEMA_VALUE_MISMATCH",
      `${kind} ${pointName} schema does not accept ${attribute ?? "control"} value ${JSON.stringify(value)} (${jsonType(value)}).`,
      attribute,
    );
}
function expectedElementValueType(element: UiElement) {
  return element.name === "switch"
    ? "boolean"
    : element.name === "partialswitch"
      ? "string"
      : element.name === "range" || element.name === "meter" || element.name === "signal"
        ? "number"
        : undefined;
}
function schemaTypeAcceptsExpected(schemaType: string, expectedType: string) {
  return schemaType === expectedType || (expectedType === "number" && schemaType === "integer");
}
function schemaAcceptsValue(schema: unknown, value: unknown) {
  if (!isRecord(schema)) return true;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(candidate, value))) return false;
  const types = schemaTypes(schema);
  if (types.length === 0) return true;
  return types.some((type) =>
    type === "null"
      ? value === null
      : type === "array"
        ? Array.isArray(value)
        : type === "object"
          ? isRecord(value)
          : type === "integer"
            ? typeof value === "number" && Number.isInteger(value)
            : type === "number"
              ? typeof value === "number" && Number.isFinite(value)
              : typeof value === type,
  );
}
function schemaNumber(schema: unknown, key: string) {
  return isRecord(schema) && typeof schema[key] === "number" ? schema[key] : undefined;
}
function schemaMinimum(schema: unknown) {
  return schemaNumber(schema, "minimum") ?? schemaNumber(schema, "min");
}
function schemaMaximum(schema: unknown) {
  return schemaNumber(schema, "maximum") ?? schemaNumber(schema, "max");
}
function rangeSchemaDescribesUi(element: UiElement, schema: unknown) {
  if (!isRecord(schema)) return false;
  const uiMin = numberAttribute(element.attributes.min);
  const uiMax = numberAttribute(element.attributes.max);
  const uiStep = numberAttribute(element.attributes.step ?? "1");
  return (
    !(uiMin !== undefined && schemaMinimum(schema) === undefined) &&
    !(uiMax !== undefined && schemaMaximum(schema) === undefined) &&
    !(uiStep !== undefined && !schemaStepIsImplicit(schema, uiStep) && schemaNumber(schema, "multipleOf") === undefined)
  );
}
function schemaStepIsImplicit(schema: unknown, uiStep: number) {
  return uiStep === 1 && schemaTypes(schema).includes("integer");
}
function formatSchemaValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}
