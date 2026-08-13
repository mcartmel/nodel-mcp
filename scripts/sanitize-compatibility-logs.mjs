import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const source = process.env.NODEL_COMPAT_LOG_DIR ?? process.argv[2];
const destination = process.env.NODEL_COMPAT_SANITIZED_DIR ?? process.argv[3];
if (!source || !destination) throw new Error("usage: sanitize-compatibility-logs.mjs SOURCE DESTINATION");
await mkdir(destination, { recursive: true });

const MAX_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_LINES = 256;
const sensitive =
  /(bearer\s+|"?(?:auth|token|password|secret|api[_-]?key|private[_-]?key)"?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/giu;
const urlCredentials = /(https?:\/\/)([^/@\s]+):([^/@\s]+)@/giu;
const sensitiveKey = /auth|token|password|secret|api[_-]?key|private[_-]?key/iu;
const MAX_REDACTION_DEPTH = 8;
const MAX_REDACTION_ENTRIES = 64;

function sanitizePlainText(value) {
  return value.replaceAll(urlCredentials, "$1[redacted]@").replaceAll(sensitive, "$1[redacted]").slice(0, MAX_BYTES);
}

function redactValue(value, depth = 0) {
  if (typeof value === "string") {
    if (depth < MAX_REDACTION_DEPTH) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object")
          return sanitizePlainText(JSON.stringify(redactValue(parsed, depth + 1)));
      } catch {
        // Plain text remains covered by the bounded regex sanitizer below.
      }
    }
    return sanitizePlainText(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_REDACTION_DEPTH) return "[withheld]";
  if (Array.isArray(value)) return value.slice(0, MAX_REDACTION_ENTRIES).map((entry) => redactValue(entry, depth + 1));

  const safe = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_REDACTION_ENTRIES)) {
    safe[key] = sensitiveKey.test(key) ? "[redacted]" : redactValue(entry, depth + 1);
  }
  return safe;
}

const sidecarLog = join(source, "sidecar.log");
const raw = (await readFile(sidecarLog).catch(() => Buffer.alloc(0))).subarray(0, MAX_INPUT_BYTES).toString("utf8");
const safeLines = [];
for (const line of raw.split(/\r?\n/u).slice(0, MAX_LINES)) {
  if (!line.trim()) continue;
  try {
    const value = JSON.parse(line);
    const redacted = redactValue(value);
    const safe = {};
    for (const field of ["level", "message", "time", "requestId"]) {
      if (typeof redacted[field] === "string") safe[field] = redacted[field];
    }
    safeLines.push(JSON.stringify(safe));
  } catch {
    safeLines.push(JSON.stringify({ level: "info", message: "non-JSON sidecar log line withheld" }));
  }
}
await writeFile(join(destination, "sidecar-sanitized.jsonl"), `${safeLines.join("\n")}\n`);
const startupStatuses = [];
const validComponents = new Set(["fifo-holder", "nodel", "sidecar", "supervisor"]);
const validPhases = new Set(["setup", "launch", "readiness", "cleanup"]);
const validOutcomes = new Set(["started", "ready", "failed", "stopped"]);
const validExitClassifications = new Set([
  "running",
  "ready",
  "not_started",
  "exited",
  "timeout",
  "stopped",
  "cleanup_failed",
]);
const rawStatus = (await readFile(join(source, "startup-status.jsonl")).catch(() => Buffer.alloc(0)))
  .subarray(0, MAX_INPUT_BYTES)
  .toString("utf8");
for (const line of rawStatus.split(/\r?\n/u).slice(0, MAX_LINES)) {
  try {
    const value = JSON.parse(line);
    if (
      validComponents.has(value.component) &&
      validPhases.has(value.phase) &&
      validOutcomes.has(value.outcome) &&
      validExitClassifications.has(value.exitClassification)
    ) {
      startupStatuses.push(
        JSON.stringify({
          component: value.component,
          phase: value.phase,
          outcome: value.outcome,
          exitClassification: value.exitClassification,
        }),
      );
    }
  } catch {
    // Status input is untrusted; malformed lines are intentionally withheld.
  }
}
await writeFile(join(destination, "startup-status.jsonl"), `${startupStatuses.join("\n")}\n`);
await writeFile(
  join(destination, "nodel-log-note.txt"),
  "Raw Nodel logs are intentionally withheld from compatibility artifacts.\n",
);
await writeFile(join(destination, "README.txt"), `Sanitized compatibility diagnostics from ${basename(source)}.\n`);
