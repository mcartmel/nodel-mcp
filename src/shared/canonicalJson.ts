import { createHash } from "node:crypto";

/**
 * Canonical JSON used for persisted plans, hashes, and backups. Values follow
 * JSON.stringify semantics for undefined/non-finite values, while unsupported
 * values such as bigint, functions, symbols, and cycles fail explicitly.
 */
export function stableStringify(value: unknown): string {
  return stringify(value, false, new Set<object>()) ?? "null";
}

export function stableJsonHash(value: unknown) {
  return sha256(stableStringify(value));
}

export function sha256(value: string | Uint8Array) {
  const hash = createHash("sha256");
  if (typeof value === "string") hash.update(value, "utf8");
  else hash.update(value);
  return hash.digest("hex");
}

function stringify(value: unknown, inArray: boolean, ancestors: Set<object>): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (value === undefined) return inArray ? "null" : undefined;
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("Canonical JSON does not support bigint, functions, or symbols.");
  }
  if (typeof value !== "object") throw new TypeError("Canonical JSON received an unsupported value.");
  if (ancestors.has(value)) throw new TypeError("Canonical JSON does not support cyclic values.");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => stringify(entry, true, ancestors) ?? "null").join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .flatMap((key) => {
        const serialized = stringify(record[key], false, ancestors);
        return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
      });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
