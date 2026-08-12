import type { NodelDefinition } from "../../nodel/types.js";
import safeRegex from "safe-regex2";
import { isRecord, readString } from "./common.js";
import { publicError, sanitizeSensitiveMessage } from "../../shared/publicErrors.js";

export type PointFilterOptions = {
  names?: string[];
  filter?: string;
  caseSensitive?: boolean;
};

type NormalizedDefinitionEntry = {
  name: string;
  definition: NodelDefinition;
  raw: unknown;
};

type BindingKind = "actions" | "events";

type BindingPoint = {
  key: string;
  kind: BindingKind;
  name: string;
  title?: string;
  hasSchema: boolean;
  schema?: unknown;
  hasConfig: boolean;
  config?: unknown;
  statuses: unknown[];
};

type FilterCandidate = {
  name: string;
  aliases?: string[];
};

const bindingKinds = ["actions", "events"] as const;
const maxFilterPatternLength = 256;

export function hasPointFilters(options: PointFilterOptions) {
  return (options.names?.length ?? 0) > 0 || (typeof options.filter === "string" && options.filter.length > 0);
}

export function filterDefinitions(value: unknown, options: PointFilterOptions) {
  const entries = normalizeDefinitions(value);
  const matched = filterCandidates(entries, options, definitionCandidate);
  return {
    value: rebuildDefinitions(value, matched),
    totalCount: entries.length,
    matchedCount: matched.length,
    summaries: summarizeDefinitionEntries(matched),
  };
}

export function summarizeDefinitions(value: unknown) {
  return summarizeDefinitionEntries(normalizeDefinitions(value));
}

export function filterBindings(
  schema: unknown,
  bindings: unknown,
  bindingStatus: unknown[] | undefined,
  options: PointFilterOptions,
) {
  const points = normalizeBindingPoints(schema, bindings, bindingStatus);
  const matched = filterCandidates(points, options, bindingCandidate);
  const matchedKeys = new Set(matched.map((point) => point.key));

  return {
    schema: filterBindingSchema(schema, matchedKeys),
    bindings: filterBindingConfig(bindings, matchedKeys),
    bindingStatus: bindingStatus ? filterBindingStatus(bindingStatus, matchedKeys) : undefined,
    totalCount: points.length,
    matchedCount: matched.length,
    summaries: summarizeBindingPoints(matched),
  };
}

export function compileSafeFilterRegex(pattern: string | undefined, caseSensitive = false) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return undefined;
  }
  assertSafeRegexPattern(pattern);
  try {
    return new RegExp(pattern, caseSensitive ? "u" : "iu");
  } catch (error) {
    throw publicError("VALIDATION", `filter must be a valid regular expression: ${sanitizeSensitiveMessage(error)}`);
  }
}

function normalizeDefinitions(value: unknown): NormalizedDefinitionEntry[] {
  if (Array.isArray(value)) {
    return value.map((definition, index) => ({
      name:
        readString(isRecord(definition) ? definition.name : undefined) ??
        readString(isRecord(definition) ? definition.title : undefined) ??
        String(index),
      definition: isRecord(definition) ? definition : { value: definition },
      raw: definition,
    }));
  }

  if (isRecord(value)) {
    return Object.entries(value).map(([name, definition]) => ({
      name,
      definition: isRecord(definition) ? definition : { value: definition },
      raw: definition,
    }));
  }

  return [];
}

function summarizeDefinitionEntries(entries: NormalizedDefinitionEntry[]) {
  return entries.map(({ name, definition }) => ({
    name,
    title: readString(definition.title) ?? readString(definition.label),
    group: readString(definition.group),
    order: typeof definition.order === "number" ? definition.order : undefined,
    schema: definition.schema ?? definition.params ?? definition.arguments,
  }));
}

function rebuildDefinitions(source: unknown, entries: NormalizedDefinitionEntry[]) {
  if (Array.isArray(source)) {
    return entries.map((entry) => entry.raw);
  }
  if (isRecord(source)) {
    return Object.fromEntries(entries.map((entry) => [entry.name, entry.raw]));
  }
  return source;
}

function filterCandidates<T>(entries: T[], options: PointFilterOptions, toCandidate: (entry: T) => FilterCandidate) {
  const predicate = buildPointPredicate(options);
  return entries.filter((entry) => predicate(toCandidate(entry)));
}

function buildPointPredicate(options: PointFilterOptions) {
  if ((options.names?.length ?? 0) > 0 && typeof options.filter === "string" && options.filter.length > 0) {
    throw publicError("VALIDATION", "names and filter are mutually exclusive; provide one point selector.");
  }
  const caseSensitive = options.caseSensitive === true;
  const names = new Set((options.names ?? []).map((name) => normalizeMatchText(name, caseSensitive)));
  const regex = compileSafeFilterRegex(options.filter, caseSensitive);

  return (candidate: FilterCandidate) => {
    if (names.size > 0) {
      const candidateNames = [candidate.name, ...(candidate.aliases ?? [])].map((name) =>
        normalizeMatchText(name, caseSensitive),
      );
      if (!candidateNames.some((name) => names.has(name))) {
        return false;
      }
    }

    if (regex) {
      const candidateNames = [candidate.name, ...(candidate.aliases ?? [])];
      if (!candidateNames.some((name) => regex.test(name))) {
        return false;
      }
    }

    return true;
  };
}

function definitionCandidate(entry: NormalizedDefinitionEntry): FilterCandidate {
  return {
    name: entry.name,
    aliases: [
      readString(entry.definition.name),
      readString(entry.definition.title),
      readString(entry.definition.label),
    ].filter((value): value is string => Boolean(value)),
  };
}

function normalizeBindingPoints(schema: unknown, bindings: unknown, bindingStatus: unknown[] | undefined) {
  const points = new Map<string, BindingPoint>();

  for (const entry of extractSchemaBindingEntries(schema)) {
    const point = ensureBindingPoint(points, entry.kind, entry.name);
    point.hasSchema = true;
    point.schema = entry.schema;
    point.title = entry.title ?? point.title;
  }

  for (const entry of extractConfigBindingEntries(bindings)) {
    const point = ensureBindingPoint(points, entry.kind, entry.name);
    point.hasConfig = true;
    point.config = entry.config;
  }

  for (const entry of bindingStatus ?? []) {
    const status = normalizeBindingStatusEntry(entry);
    if (!status) {
      continue;
    }
    ensureBindingPoint(points, status.kind, status.name).statuses.push(entry);
  }

  return [...points.values()];
}

function extractSchemaBindingEntries(
  schema: unknown,
): Array<{ kind: BindingKind; name: string; title?: string; schema: unknown }> {
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  const entries: Array<{ kind: BindingKind; name: string; title?: string; schema: unknown }> = [];

  for (const kind of bindingKinds) {
    const group = isRecord(properties[kind]) ? properties[kind] : {};
    const groupProperties = isRecord(group.properties) ? group.properties : {};
    for (const [name, definition] of Object.entries(groupProperties)) {
      entries.push({
        kind,
        name,
        title: readString(isRecord(definition) ? definition.title : undefined),
        schema: definition,
      });
    }
  }

  return entries;
}

function extractConfigBindingEntries(bindings: unknown): Array<{ kind: BindingKind; name: string; config: unknown }> {
  if (!isRecord(bindings)) {
    return [];
  }

  const entries: Array<{ kind: BindingKind; name: string; config: unknown }> = [];
  for (const kind of bindingKinds) {
    const group = isRecord(bindings[kind]) ? bindings[kind] : {};
    for (const [name, config] of Object.entries(group)) {
      entries.push({ kind, name, config });
    }
  }
  return entries;
}

function ensureBindingPoint(points: Map<string, BindingPoint>, kind: BindingKind, name: string) {
  const key = bindingKey(kind, name);
  let point = points.get(key);
  if (!point) {
    point = { key, kind, name, hasSchema: false, hasConfig: false, statuses: [] };
    points.set(key, point);
  }
  return point;
}

function bindingCandidate(point: BindingPoint): FilterCandidate {
  return {
    name: point.name,
    aliases: bindingNameAliases(point.kind, point.name),
  };
}

function summarizeBindingPoints(points: BindingPoint[]) {
  return points.map((point) => ({
    kind: point.kind,
    name: point.name,
    title: point.title,
    inSchema: point.hasSchema,
    configured: point.hasConfig,
    statusCount: point.statuses.length,
    schema: summarizeBindingSchema(point.schema),
    config: summarizeBindingConfig(point.config, point.kind),
    status: point.statuses.length > 0 ? point.statuses.map(summarizeBindingStatus) : undefined,
  }));
}

function summarizeBindingSchema(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return value;
  }

  const summary: Record<string, unknown> = {};
  for (const key of ["title", "description", "type", "required", "default", "enum"]) {
    if (value[key] !== undefined) {
      summary[key] = value[key];
    }
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function summarizeBindingConfig(value: unknown, kind: BindingKind) {
  if (value === undefined || !isRecord(value)) {
    return value;
  }

  const preferredKeys =
    kind === "actions"
      ? ["node", "action", "args", "arguments", "enabled"]
      : ["node", "event", "signal", "args", "arguments", "enabled"];
  const summary = pickKeys(value, preferredKeys);
  return Object.keys(summary).length > 0 ? summary : value;
}

function summarizeBindingStatus(value: unknown) {
  if (!isRecord(value)) {
    return value;
  }

  const summary = pickKeys(value, [
    "source",
    "type",
    "name",
    "binding",
    "bindingName",
    "node",
    "action",
    "event",
    "signal",
    "status",
    "state",
    "connected",
    "error",
    "message",
    "comment",
  ]);
  return Object.keys(summary).length > 0 ? summary : value;
}

function filterBindingSchema(schema: unknown, matchedKeys: Set<string>) {
  if (!isRecord(schema)) {
    return schema;
  }

  const next: Record<string, unknown> = { ...schema };
  if (!isRecord(schema.properties)) {
    return next;
  }

  const properties: Record<string, unknown> = { ...schema.properties };
  next.properties = properties;
  for (const kind of bindingKinds) {
    const group = properties[kind];
    if (!isRecord(group)) {
      continue;
    }
    const nextGroup: Record<string, unknown> = { ...group };
    properties[kind] = nextGroup;
    if (isRecord(group.properties)) {
      nextGroup.properties = Object.fromEntries(
        Object.entries(group.properties).filter(([name]) => matchedKeys.has(bindingKey(kind, name))),
      );
    }
  }

  return next;
}

function filterBindingConfig(bindings: unknown, matchedKeys: Set<string>) {
  if (!isRecord(bindings)) {
    return bindings;
  }

  const next: Record<string, unknown> = { ...bindings };
  for (const kind of bindingKinds) {
    const group = bindings[kind];
    if (isRecord(group)) {
      next[kind] = Object.fromEntries(
        Object.entries(group).filter(([name]) => matchedKeys.has(bindingKey(kind, name))),
      );
    }
  }

  return next;
}

function filterBindingStatus(bindingStatus: unknown[], matchedKeys: Set<string>) {
  return bindingStatus.filter((entry) => {
    const status = normalizeBindingStatusEntry(entry);
    return status ? matchedKeys.has(status.key) : false;
  });
}

function normalizeBindingStatusEntry(entry: unknown): { kind: BindingKind; name: string; key: string } | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }

  const kind = readBindingStatusKind(entry);
  if (!kind) {
    return undefined;
  }

  const name = readBindingStatusName(entry, kind);
  if (!name) {
    return undefined;
  }

  return { kind, name, key: bindingKey(kind, name) };
}

function readBindingStatusKind(entry: Record<string, unknown>): BindingKind | undefined {
  const type = readString(entry.type)?.toLocaleLowerCase();
  if (type?.includes("action")) {
    return "actions";
  }
  if (type?.includes("event") || type?.includes("signal")) {
    return "events";
  }

  const kind = readString(entry.kind)?.toLocaleLowerCase();
  if (kind === "action" || kind === "actions") {
    return "actions";
  }
  if (kind === "event" || kind === "events" || kind === "signal" || kind === "signals") {
    return "events";
  }

  return undefined;
}

function readBindingStatusName(entry: Record<string, unknown>, kind: BindingKind) {
  const generic = readFirstString(entry, ["bindingName", "binding", "name"]);
  if (generic) {
    return generic;
  }

  return kind === "actions"
    ? readFirstString(entry, ["action", "actionName", "localAction", "sourceAction"])
    : readFirstString(entry, ["event", "eventName", "signal", "signalName", "localEvent", "sourceEvent"]);
}

function bindingKey(kind: BindingKind, name: string) {
  return `${kind}:${name}`;
}

function bindingNameAliases(kind: BindingKind, name: string) {
  const singular = kind === "actions" ? "action" : "event";
  return [`${kind}:${name}`, `${kind}.${name}`, `${singular}:${name}`, `${singular}.${name}`];
}

function normalizeMatchText(value: string, caseSensitive: boolean) {
  return caseSensitive ? value : value.toLocaleLowerCase();
}

function assertSafeRegexPattern(pattern: string) {
  if (pattern.length > maxFilterPatternLength) {
    throw publicError(
      "VALIDATION",
      `filter regular expression is too long; maximum length is ${maxFilterPatternLength} characters.`,
    );
  }
  if (/\\(?:[1-9]|k<)/u.test(pattern)) {
    throw publicError("VALIDATION", "filter regular expression cannot use backreferences.");
  }
  if (hasQuantifiedGroup(pattern)) {
    throw publicError("VALIDATION", "filter regular expression cannot use quantified groups.");
  }
  if (!safeRegex(pattern)) {
    throw publicError("VALIDATION", "filter regular expression is potentially unsafe.");
  }
}

function hasQuantifiedGroup(pattern: string) {
  let escaped = false;
  let inCharacterClass = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      continue;
    }
    if (char === "]") {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass || char !== ")") {
      continue;
    }
    if (isQuantifierAt(pattern, index + 1)) {
      return true;
    }
  }

  return false;
}

function isQuantifierAt(pattern: string, index: number) {
  const char = pattern[index];
  if (char === "*" || char === "+" || char === "?") {
    return true;
  }
  if (char !== "{") {
    return false;
  }
  const end = pattern.indexOf("}", index + 1);
  if (end < 0) {
    return false;
  }
  return /^\{\d+(?:,\d*)?\}$/u.test(pattern.slice(index, end + 1));
}

function readFirstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function pickKeys(record: Record<string, unknown>, keys: string[]) {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (record[key] !== undefined) {
      result[key] = record[key];
    }
  }
  return result;
}
