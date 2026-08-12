import { stableJsonHash } from "../../shared/canonicalJson.js";
import { publicError } from "../../shared/publicErrors.js";

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function planConfigWrite(
  current: unknown,
  patch: unknown,
  mode: "merge" | "replace",
  expectedHash?: string,
  label = "Config",
  removePaths: string[][] = [],
) {
  const currentHash = stableJsonHash(current);
  if (expectedHash && expectedHash !== currentHash)
    throw publicError("CONFLICT", `${label} expectedHash mismatch. Current hash is ${currentHash}.`);
  const merged = mode === "replace" ? patch : deepMerge(current, patch);
  const deletion = applyRemovePaths(merged, removePaths);
  return {
    mode,
    currentHash,
    next: deletion.next,
    nextHash: stableJsonHash(deletion.next),
    removePaths: deletion.removePaths,
    missingRemovePaths: deletion.missingRemovePaths,
  };
}

export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const result: RecordValue = { ...base };
  for (const [key, value] of Object.entries(patch)) result[key] = deepMerge(result[key], value);
  return result;
}

function applyRemovePaths(value: unknown, removePaths: string[][]) {
  const next = cloneUnknown(value);
  const normalized = removePaths.map((path) => [...path]);
  const missingRemovePaths: string[][] = [];
  for (const path of normalized) if (!removePath(next, path)) missingRemovePaths.push(path);
  return { next, removePaths: normalized, missingRemovePaths };
}

function removePath(value: unknown, path: string[]) {
  if (path.length === 0 || !isRecord(value)) return false;
  let current: unknown = value;
  for (const segment of path.slice(0, -1)) {
    if (!isRecord(current) || !isRecord(current[segment])) return false;
    current = current[segment];
  }
  if (!isRecord(current)) return false;
  const last = path[path.length - 1];
  if (!Object.prototype.hasOwnProperty.call(current, last)) return false;
  delete current[last];
  return true;
}

function cloneUnknown(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
