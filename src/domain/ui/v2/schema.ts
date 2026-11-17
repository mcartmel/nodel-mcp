const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
type PreparedSchema = { schema: Record<string, unknown>; types: string[] } | null;
export type StaticSchemaCache = Map<unknown, PreparedSchema>;

/** A deliberately small, non-executing JSON Schema subset. No regex, refs,
 * recursive schemas, coercion, or guessed dynamic control payloads. */
function prepare(schema: unknown): PreparedSchema {
  if (!record(schema)) return null;
  const supported = new Set([
    "type",
    "enum",
    "minimum",
    "maximum",
    "min",
    "max",
    "multipleOf",
    "minLength",
    "maxLength",
    "title",
    "description",
    "default",
    "$schema",
  ]);
  const keys = Object.keys(schema);
  if (keys.length > supported.size || keys.some((key) => !supported.has(key))) return null;
  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
  const knownTypes = new Set(["string", "number", "integer", "boolean", "null", "object", "array"]);
  if (types.length > 7 || types.some((type) => typeof type !== "string" || !knownTypes.has(type))) return null;
  if (schema.type !== undefined && types.length === 0) return null;
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) ||
      schema.enum.length > 256 ||
      schema.enum.some((entry) => typeof entry === "object" && entry !== null))
  )
    return null;
  for (const key of ["minimum", "maximum", "min", "max", "multipleOf", "minLength", "maxLength"])
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) return null;
  for (const key of ["minLength", "maxLength"])
    if (typeof schema[key] === "number" && (!Number.isInteger(schema[key]) || schema[key] < 0)) return null;
  if (typeof schema.multipleOf === "number" && schema.multipleOf <= 0) return null;
  return { schema, types: types as string[] };
}

export function checkStaticArg(
  rawSchema: unknown,
  value: unknown,
  cache: StaticSchemaCache = new Map(),
  stringLength?: number,
): "accepted" | "rejected" | "unknown" {
  let prepared = cache.get(rawSchema);
  if (prepared === undefined) {
    prepared = prepare(rawSchema);
    cache.set(rawSchema, prepared);
  }
  if (!prepared) return "unknown";
  const { schema, types } = prepared;
  const accepts = (type: unknown) =>
    type === "null"
      ? value === null
      : type === "array"
        ? Array.isArray(value)
        : type === "object"
          ? record(value)
          : type === "integer"
            ? typeof value === "number" && Number.isInteger(value)
            : type === "number"
              ? typeof value === "number" && Number.isFinite(value)
              : typeof value === type;
  if (types.length && !types.some(accepts)) return "rejected";
  if (schema.enum !== undefined) {
    if (!(schema.enum as unknown[]).some((entry) => value === entry)) return "rejected";
  }
  if (typeof value === "number") {
    const min = schema.minimum ?? schema.min,
      max = schema.maximum ?? schema.max;
    if ((typeof min === "number" && value < min) || (typeof max === "number" && value > max)) return "rejected";
    if (typeof schema.multipleOf === "number") {
      if (schema.multipleOf <= 0) return "unknown";
      const ratio = value / schema.multipleOf;
      if (!Number.isFinite(ratio)) return "unknown";
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) return "rejected";
    }
  }
  if (typeof value === "string" && (schema.minLength !== undefined || schema.maxLength !== undefined)) {
    const length = stringLength ?? Array.from(value).length;
    if (
      (typeof schema.minLength === "number" && length < schema.minLength) ||
      (typeof schema.maxLength === "number" && length > schema.maxLength)
    )
      return "rejected";
  }
  return types.length || schema.enum !== undefined ? "accepted" : "unknown";
}

export function decodeStaticArg(raw: string, type: string): { ok: true; value: unknown } | { ok: false } {
  if (type === "string") return { ok: true, value: raw };
  if (type === "number")
    return raw.trim() && Number.isFinite(Number(raw)) ? { ok: true, value: Number(raw) } : { ok: false };
  if (type === "boolean")
    return {
      ok: true,
      value: ["true", "1", "on", "yes", "active", "present", "available", "signal", "disabled"].includes(
        raw.trim().toLowerCase(),
      ),
    };
  if (type === "json") {
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch {
      return { ok: false };
    }
  }
  return { ok: false };
}
