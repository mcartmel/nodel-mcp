import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const source = process.env.NODEL_COMPAT_LOG_DIR ?? process.argv[2];
const destination = process.env.NODEL_COMPAT_SANITIZED_DIR ?? process.argv[3];
if (!source || !destination) throw new Error("usage: sanitize-compatibility-logs.mjs SOURCE DESTINATION");
await mkdir(destination, { recursive: true });

const MAX_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_LINES = 256;
const sensitive = /(bearer\s+|(?:auth|token|password|secret|api[_-]?key|private[_-]?key)\s*[=:]\s*)[^\s,;"'}]+/giu;
const urlCredentials = /(https?:\/\/)([^/@\s]+):([^/@\s]+)@/giu;
function sanitize(value) {
  return value.replaceAll(urlCredentials, "$1[redacted]@").replaceAll(sensitive, "$1[redacted]").slice(0, MAX_BYTES);
}

const sidecarLog = join(source, "sidecar.log");
const raw = (await readFile(sidecarLog).catch(() => Buffer.alloc(0))).subarray(0, MAX_INPUT_BYTES).toString("utf8");
const safeLines = [];
for (const line of raw.split(/\r?\n/u).slice(0, MAX_LINES)) {
  if (!line.trim()) continue;
  try {
    const value = JSON.parse(line);
    const safe = {};
    for (const field of ["level", "message", "time", "requestId"]) {
      if (typeof value[field] === "string") safe[field] = sanitize(value[field]);
    }
    safeLines.push(JSON.stringify(safe));
  } catch {
    safeLines.push(JSON.stringify({ level: "info", message: "non-JSON sidecar log line withheld" }));
  }
}
await writeFile(join(destination, "sidecar-sanitized.jsonl"), `${safeLines.join("\n")}\n`);
await writeFile(
  join(destination, "nodel-log-note.txt"),
  "Raw Nodel logs are intentionally withheld from compatibility artifacts.\n",
);
await writeFile(join(destination, "README.txt"), `Sanitized compatibility diagnostics from ${basename(source)}.\n`);
