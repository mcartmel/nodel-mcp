export function extractFileEntries(value: unknown): Array<{ path: string; size?: number; raw: unknown }> {
  const candidates = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  const entries: Array<{ path: string; size?: number; raw: unknown }> = [];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      entries.push({ path: candidate, raw: candidate });
      continue;
    }
    if (!isRecord(candidate)) continue;
    const path =
      readString(candidate.path) ??
      readString(candidate.name) ??
      readString(candidate.file) ??
      readString(candidate.filename);
    if (path) entries.push({ path, size: readNumber(candidate.size) ?? readNumber(candidate.length), raw: candidate });
  }
  return entries;
}

export function extractEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["entries", "activity", "console", "items", "logs"]) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  return Object.values(value).filter((entry) => isRecord(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
