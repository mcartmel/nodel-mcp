import type { NodelClient } from "../../nodel/client.js";
import { stableJsonHash } from "../../shared/canonicalJson.js";
import { bindingScore, normalizeText, simpleText, tokenizeSimpleText, type BindingKind } from "./planner.js";
import {
  bindingsPatchFromProposals,
  extractRemoteBindingNames,
  normalizeBindings,
  normalizeDefinitions,
  type BindingDefinition,
  type BindingProposal,
} from "./directPlanner.js";

export type ContextCandidate = {
  name: string;
  node: unknown;
  source: "explicit" | "local" | "network";
  contextScore: number;
  reasons: string[];
  roles: Array<{ role: string; score: number; reasons: string[] }>;
  actions: Array<{ name: string; definition: unknown }>;
  events: Array<{ name: string; definition: unknown }>;
  error?: string;
};
export type ContextPlanInput = {
  sourceNode: unknown;
  context: string;
  targetHint?: string;
  schema: unknown;
  currentBindings: unknown;
  candidates: ContextCandidate[];
  kinds: "actions" | "events" | "both";
  bindingNames?: string[];
  overwrite: boolean;
  minScore: number;
  ambiguityMargin: number;
};

export async function discoverContextCandidates(
  nodelClient: NodelClient,
  options: {
    sourceNodeName: string;
    context: string;
    targetHint?: string;
    candidateNodes?: string[];
    excludeNodes?: string[];
    maxCandidates: number;
  },
): Promise<ContextCandidate[]> {
  const excluded = new Set([options.sourceNodeName, ...(options.excludeNodes ?? [])].map(normalizeText));
  const names = new Map<
    string,
    { name: string; source: ContextCandidate["source"]; contextScore: number; reasons: string[] }
  >();
  if (options.candidateNodes && options.candidateNodes.length > 0) {
    for (const name of options.candidateNodes)
      names.set(normalizeText(name), { name, source: "explicit", contextScore: 100, reasons: ["explicit candidate"] });
  } else {
    const localNodes = await nodelClient.listLocalNodes(false);
    for (const node of localNodes)
      names.set(normalizeText(node.name), {
        name: node.name,
        source: "local",
        ...scoreCandidateName(node.name, options.context, options.targetHint),
      });
    try {
      const networkNodes = normalizeNetworkNodeNames(
        await nodelClient.listNetworkNodeUrls(options.context || options.targetHint || ""),
      );
      for (const node of networkNodes) {
        const key = normalizeText(node.name);
        if (!names.has(key))
          names.set(key, {
            name: node.name,
            source: "network",
            ...scoreCandidateName(node.name, options.context, options.targetHint),
          });
      }
    } catch {
      // Network discovery is useful enrichment; local candidates still yield a valid plan.
    }
  }
  const ranked = [...names.values()]
    .filter((entry) => !excluded.has(normalizeText(entry.name)))
    .sort((left, right) => right.contextScore - left.contextScore)
    .slice(0, options.maxCandidates);
  return Promise.all(
    ranked.map(async (entry): Promise<ContextCandidate> => {
      try {
        const [actions, events] = await Promise.all([
          nodelClient.getNodeActions(entry.name),
          nodelClient.getNodeSignals(entry.name),
        ]);
        const actionEntries = normalizeDefinitions(actions.actions);
        const eventEntries = normalizeDefinitions(events.signals);
        return {
          name: actions.node.name,
          node: actions.node,
          source: entry.source,
          contextScore: entry.contextScore,
          reasons: entry.reasons,
          roles: classifyCandidate(actions.node.name, actionEntries, eventEntries),
          actions: actionEntries,
          events: eventEntries,
        };
      } catch (error) {
        return {
          name: entry.name,
          node: { name: entry.name },
          source: entry.source,
          contextScore: entry.contextScore,
          reasons: entry.reasons,
          roles: [],
          actions: [],
          events: [],
          error: sanitizeSensitiveMessage(error),
        };
      }
    }),
  );
}

export function buildContextBindingPlan(input: ContextPlanInput) {
  const currentBindings = normalizeBindings(input.currentBindings);
  const requestedKinds = input.kinds === "both" ? (["actions", "events"] as const) : ([input.kinds] as const);
  const requestedNames = new Set((input.bindingNames ?? []).map(normalizeText));
  const actionBindings = extractRemoteBindingNames(input.schema, "actions");
  const eventBindings = extractRemoteBindingNames(input.schema, "events");
  const nextBindings = JSON.parse(JSON.stringify(currentBindings)) as Record<string, unknown>;
  const proposals: BindingProposal[] = [];
  const skipped: unknown[] = [];
  const unresolved: unknown[] = [];
  const ambiguous: unknown[] = [];
  for (const kind of requestedKinds) {
    const bindings = kind === "actions" ? actionBindings : eventBindings;
    const targetField = kind === "actions" ? "action" : "event";
    for (const binding of bindings) {
      if (requestedNames.size > 0 && !requestedNames.has(normalizeText(binding.name))) continue;
      const existing = readBinding(currentBindings, kind, binding.name);
      if (existing && !input.overwrite) {
        skipped.push({ kind, bindingName: binding.name, reason: "already_bound", existing });
        continue;
      }
      const matches = rankContextMatches(binding, kind, input.candidates).filter(
        (match) => match.score >= input.minScore,
      );
      if (matches.length === 0) {
        unresolved.push({ kind, bindingName: binding.name, reason: "no_confident_match" });
        continue;
      }
      const [best, second] = matches;
      if (second && best.score - second.score <= input.ambiguityMargin) {
        ambiguous.push({
          kind,
          bindingName: binding.name,
          reason: "close_matches",
          options: matches.slice(0, 5).map(summarizeContextMatch),
        });
        continue;
      }
      const value = { node: best.candidate.name, [targetField]: best.target.name };
      ensureRecord(nextBindings, kind)[binding.name] = value;
      proposals.push({
        kind,
        bindingName: binding.name,
        targetNode: best.candidate.name,
        targetName: best.target.name,
        targetField,
        score: best.score,
        reason: best.reason,
        existing,
      } as BindingProposal);
    }
  }
  const currentHash = stableJsonHash(currentBindings);
  const nextHash = stableJsonHash(nextBindings);
  return {
    operation: "propose_context_bindings",
    sourceNode: input.sourceNode,
    context: input.context,
    targetHint: input.targetHint,
    currentHash,
    nextHash,
    changed: currentHash !== nextHash,
    candidateNodes: input.candidates.map((candidate) => ({
      node: candidate.node,
      name: candidate.name,
      source: candidate.source,
      contextScore: candidate.contextScore,
      reasons: candidate.reasons,
      roles: candidate.roles,
      actions: candidate.actions.map((entry) => entry.name),
      events: candidate.events.map((entry) => entry.name),
      error: candidate.error,
    })),
    schemaSummary: {
      actionBindings: actionBindings.map((entry) => entry.name),
      eventBindings: eventBindings.map((entry) => entry.name),
    },
    proposals,
    skipped,
    ambiguous,
    unresolved,
    bindingPatch: bindingsPatchFromProposals(proposals),
    nextBindings,
    message:
      "Review proposals, ambiguous matches, and unresolved bindings before applying bindingPatch with nodel.set_node_bindings.",
  };
}

function rankContextMatches(binding: BindingDefinition, kind: BindingKind, candidates: ContextCandidate[]) {
  const matches: Array<{
    candidate: ContextCandidate;
    target: { name: string; definition: unknown };
    score: number;
    reason: string;
  }> = [];
  for (const candidate of candidates)
    for (const target of kind === "actions" ? candidate.actions : candidate.events) {
      const nameScore = bindingScore(binding, target.name);
      if (nameScore === 0) continue;
      const role = roleAffinity(binding, candidate);
      const score = clampScore(Math.round(nameScore * 0.68 + candidate.contextScore * 0.2 + role.score));
      matches.push({
        candidate,
        target,
        score,
        reason: [
          `name score ${nameScore}`,
          `context score ${candidate.contextScore}`,
          ...role.reasons,
          ...candidate.reasons,
        ].join("; "),
      });
    }
  return matches.sort((left, right) => right.score - left.score);
}
function summarizeContextMatch(match: ReturnType<typeof rankContextMatches>[number]) {
  return { targetNode: match.candidate.name, targetName: match.target.name, score: match.score, reason: match.reason };
}
function roleAffinity(binding: BindingDefinition, candidate: ContextCandidate) {
  const text = simpleText(`${binding.name} ${binding.title ?? ""}`);
  const roleNames = new Set(candidate.roles.map((role) => role.role));
  const reasons: string[] = [];
  let score = 0;
  const add = (role: string, amount: number, reason: string) => {
    if (roleNames.has(role)) {
      score += amount;
      reasons.push(reason);
    }
  };
  if (/(stream|play|pause|stop|media|track|clip|playlist)/u.test(text))
    add("media_player", 14, "media-like binding matched media player role");
  if (/(status|state|playing|paused|stopped)/u.test(text))
    add("media_player", 8, "status-like binding matched media player role");
  if (/(tv|display|screen|projector|input|power)/u.test(text))
    add("display", 12, "display-like binding matched display role");
  if (/(volume|mute|audio|amp|speaker)/u.test(text)) add("audio", 12, "audio-like binding matched audio role");
  if (/(light|lighting|scene|preset)/u.test(text)) add("lighting", 12, "lighting-like binding matched lighting role");
  return { score: Math.min(score, 20), reasons };
}
function classifyCandidate(name: string, actions: Array<{ name: string }>, events: Array<{ name: string }>) {
  const text = normalizeText(
    `${name} ${actions.map((entry) => entry.name).join(" ")} ${events.map((entry) => entry.name).join(" ")}`,
  );
  return [
    roleScore("media_player", text, ["media", "player", "stream", "play", "pause", "stop", "playlist", "clip"]),
    roleScore("display", text, ["display", "tv", "monitor", "projector", "screen", "input", "hdmi"]),
    roleScore("audio", text, ["audio", "amp", "amplifier", "volume", "mute", "speaker", "dsp"]),
    roleScore("lighting", text, ["light", "lighting", "dynet", "scene", "preset"]),
    roleScore("frontend", text, ["frontend", "dashboard", "control", "group"]),
  ]
    .filter((role) => role.score > 0)
    .sort((left, right) => right.score - left.score);
}
function roleScore(role: string, text: string, tokens: string[]) {
  const matches = tokens.filter((token) => text.includes(token));
  return { role, score: Math.min(100, matches.length * 18), reasons: matches.map((token) => `matched ${token}`) };
}
function scoreCandidateName(name: string, context: string, targetHint?: string) {
  const reasons: string[] = [];
  let score = 0;
  const simpleName = simpleText(normalizeText(name));
  const contextTokens = tokenizeSimpleText(normalizeText(context));
  const hintTokens = tokenizeSimpleText(normalizeText(targetHint ?? ""));
  const contextMatches = contextTokens.filter((token) => simpleName.includes(token));
  const hintMatches = hintTokens.filter((token) => simpleName.includes(token));
  if (contextTokens.length > 0) {
    score += Math.round((70 * contextMatches.length) / contextTokens.length);
    if (contextMatches.length > 0) reasons.push(`matched context tokens: ${contextMatches.join(", ")}`);
  }
  if (hintTokens.length > 0) {
    score += Math.round((25 * hintMatches.length) / hintTokens.length);
    if (hintMatches.length > 0) reasons.push(`matched hint tokens: ${hintMatches.join(", ")}`);
  }
  return { contextScore: clampScore(score), reasons };
}
function normalizeNetworkNodeNames(response: unknown) {
  const entries = Array.isArray(response) ? response : Object.values(isRecord(response) ? response : {});
  return entries.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const name = readString(entry.node) ?? readString(entry.name) ?? readString(entry.key);
    return name ? [{ name }] : [];
  });
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
function clampScore(value: number) {
  return Math.max(0, Math.min(100, value));
}
function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
import { sanitizeSensitiveMessage } from "../../shared/publicErrors.js";
