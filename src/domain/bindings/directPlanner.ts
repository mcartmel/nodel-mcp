import { stableJsonHash } from "../../shared/canonicalJson.js";
import { bestBindingTarget, normalizeText, type BindingKind } from "./planner.js";

export type BindingDefinition = { name: string; title: string; definition: unknown };
export type BindingPlanInput = {
  sourceNode: unknown;
  targetNode: unknown;
  schema: unknown;
  currentBindings: unknown;
  targetActions: unknown;
  targetSignals: unknown;
  kinds: "actions" | "events" | "both";
  bindingNames?: string[];
  overwrite: boolean;
  minScore: number;
};
export type BindingProposal = {
  kind: BindingKind;
  bindingName: string;
  targetNode: string;
  targetName: string;
  targetField: string;
  score: number;
  existing?: unknown;
};

export function buildDirectBindingPlan(input: BindingPlanInput) {
  const currentBindings = normalizeBindings(input.currentBindings);
  const requestedKinds = input.kinds === "both" ? (["actions", "events"] as const) : ([input.kinds] as const);
  const requestedNames = new Set((input.bindingNames ?? []).map(normalizeText));
  const actionBindings = extractRemoteBindingNames(input.schema, "actions");
  const eventBindings = extractRemoteBindingNames(input.schema, "events");
  const actionTargets = normalizeDefinitions(input.targetActions);
  const eventTargets = normalizeDefinitions(input.targetSignals);
  const nextBindings = cloneRecord(currentBindings);
  const proposals: BindingProposal[] = [];
  const skipped: unknown[] = [];
  const unresolved: Array<{ kind: BindingKind; bindingName: string; reason: string; bestCandidate?: unknown }> = [];

  for (const kind of requestedKinds) {
    const bindings = kind === "actions" ? actionBindings : eventBindings;
    const targets = kind === "actions" ? actionTargets : eventTargets;
    const targetField = kind === "actions" ? "action" : "event";
    for (const binding of bindings) {
      if (requestedNames.size > 0 && !requestedNames.has(normalizeText(binding.name))) continue;

      const existing = readBinding(currentBindings, kind, binding.name);
      if (existing && !input.overwrite) {
        skipped.push({ kind, bindingName: binding.name, reason: "already_bound", existing });
        continue;
      }

      const match = bestBindingTarget(binding, targets);
      if (!match || match.score < input.minScore) {
        unresolved.push({ kind, bindingName: binding.name, reason: "no_confident_match", bestCandidate: match });
        continue;
      }

      const value = {
        node: isRecord(input.targetNode) ? (readString(input.targetNode.name) ?? "") : "",
        [targetField]: match.name,
      };
      ensureRecord(nextBindings, kind)[binding.name] = value;
      proposals.push({
        kind,
        bindingName: binding.name,
        targetNode: value.node,
        targetName: match.name,
        targetField,
        score: match.score,
        existing,
      });
    }
  }

  const currentHash = stableJsonHash(currentBindings);
  const nextHash = stableJsonHash(nextBindings);
  return {
    operation: "propose_node_bindings",
    sourceNode: input.sourceNode,
    targetNode: input.targetNode,
    currentHash,
    nextHash,
    changed: currentHash !== nextHash,
    schemaSummary: {
      actionBindings: actionBindings.map((entry) => entry.name),
      eventBindings: eventBindings.map((entry) => entry.name),
    },
    targetSummary: {
      actions: actionTargets.map((entry) => entry.name),
      events: eventTargets.map((entry) => entry.name),
    },
    proposals,
    skipped,
    unresolved,
    bindingPatch: bindingsPatchFromProposals(proposals),
    nextBindings,
    message:
      "Review proposals, then pass expectedHash=currentHash to nodel.apply_node_binding_plan or apply bindingPatch with nodel.set_node_bindings after approval.",
  };
}

export function extractRemoteBindingNames(schema: unknown, kind: BindingKind): BindingDefinition[] {
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  const group = isRecord(properties[kind]) ? properties[kind] : {};
  const groupProperties = isRecord(group.properties) ? group.properties : {};
  return Object.entries(groupProperties).map(([name, definition]) => ({
    name,
    title: readString(isRecord(definition) ? definition.title : undefined) ?? name,
    definition,
  }));
}

export function normalizeDefinitions(value: unknown): Array<{ name: string; definition: unknown }> {
  if (Array.isArray(value))
    return value.map((definition, index) => ({
      name: readString(isRecord(definition) ? definition.name : undefined) ?? String(index),
      definition,
    }));
  if (isRecord(value)) return Object.entries(value).map(([name, definition]) => ({ name, definition }));
  return [];
}

export function bindingsPatchFromProposals(proposals: readonly BindingProposal[]) {
  const patch: Record<string, Record<string, unknown>> = {};
  for (const proposal of proposals) {
    patch[proposal.kind] = patch[proposal.kind] ?? {};
    patch[proposal.kind][proposal.bindingName] = {
      node: proposal.targetNode,
      [proposal.targetField]: proposal.targetName,
    };
  }
  return patch;
}

export function normalizeBindings(value: unknown) {
  const record = isRecord(value) ? cloneRecord(value) : {};
  record.actions = isRecord(record.actions) ? cloneRecord(record.actions) : {};
  record.events = isRecord(record.events) ? cloneRecord(record.events) : {};
  return record;
}

function readBinding(bindings: Record<string, unknown>, kind: BindingKind, name: string) {
  const group = isRecord(bindings[kind]) ? bindings[kind] : {};
  const value = group[name];
  if (!isRecord(value)) return undefined;
  const node = readString(value.node);
  const target = readString(kind === "actions" ? value.action : value.event);
  return node || target ? value : undefined;
}

function ensureRecord(record: Record<string, unknown>, key: string) {
  if (!isRecord(record[key])) record[key] = {};
  return record[key] as Record<string, unknown>;
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(isRecord(value) ? value : {})) as Record<string, unknown>;
}

function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
