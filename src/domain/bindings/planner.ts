import { stableJsonHash } from "../../shared/canonicalJson.js";

export type BindingKind = "actions" | "events";
export type BindingTarget = { name: string; definition: unknown };
export type BindingMatch = BindingTarget & { score: number };

export function normalizeText(value: string) {
  return value.trim().toLocaleLowerCase();
}
export function simpleText(value: string) {
  return value.replace(/[^a-z0-9]+/giu, "");
}
export function tokenizeSimpleText(value: string) {
  return value
    .split(/[^a-z0-9]+/iu)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function bindingScore(binding: { name: string; title?: string }, targetName: string) {
  const names = [binding.name, binding.title ?? ""].map(normalizeText).filter(Boolean);
  const target = normalizeText(targetName);
  const simpleNames = names.map(simpleText);
  const simpleTarget = simpleText(target);
  if (names.includes(target) || simpleNames.includes(simpleTarget)) return 100;
  if (simpleNames.some((name) => name.endsWith(simpleTarget) || simpleTarget.endsWith(name))) return 85;
  if (simpleNames.some((name) => name.includes(simpleTarget) || simpleTarget.includes(name))) return 70;
  const overlap = tokenizeSimpleText(simpleTarget).filter((token) =>
    new Set(simpleNames.flatMap(tokenizeSimpleText)).has(token),
  ).length;
  return overlap === 0
    ? 0
    : Math.min(65, 30 + Math.round((35 * overlap) / Math.max(tokenizeSimpleText(simpleTarget).length, 1)));
}

export function bestBindingTarget(
  binding: { name: string; title?: string },
  targets: BindingTarget[],
): BindingMatch | undefined {
  return targets
    .map((target) => ({ ...target, score: bindingScore(binding, target.name) }))
    .sort((left, right) => right.score - left.score)[0];
}

export function bindingPlanHashes(current: unknown, next: unknown) {
  return { currentHash: stableJsonHash(current), nextHash: stableJsonHash(next) };
}
