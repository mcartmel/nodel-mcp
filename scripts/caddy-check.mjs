import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBodyLimitBytes, parseUpstream, renderCaddyfile, validateOptions } from "./caddy-render.mjs";

const templatePath = fileURLToPath(new URL("../deploy/caddy/nodel-mcp.Caddyfile.in", import.meta.url));
const canonicalTemplate = await readFile(templatePath, "utf8");
const fixture = {
  hostname: "nodel-check.example",
  bindAddress: "127.0.0.1",
  allowCidrs: ["198.51.100.0/24", "fd00::/8"],
  upstream: "127.0.0.1:8765",
  bodyLimitBytes: 1_048_576,
};

export function inspectCaddyfile(content) {
  const findings = [];
  let options;
  try {
    options = extractCanonicalOptions(content);
  } catch {
    findings.push("Caddyfile is not an exact rendering of the approved template");
  }
  if (options && normalizeCaddyfile(content) !== renderCaddyfile(canonicalTemplate, options))
    findings.push("Caddyfile differs from the approved template rendering");
  if (/^\s*header_up\b/imu.test(content)) findings.push("header_up modifications are not allowed");
  return { ok: findings.length === 0, findings, options };
}

function normalizeCaddyfile(content) {
  return content.replace(/\r\n?/gu, "\n").replace(/\n*$/u, "\n");
}

function parseCaddyBodyLimit(value) {
  const match = /^(\d+)(B|KiB|MiB|GiB)$/u.exec(value);
  if (!match) throw new Error("Invalid Caddy body limit");
  const unit = { B: 1, KiB: 2 ** 10, MiB: 2 ** 20, GiB: 2 ** 30 }[match[2]];
  return parseBodyLimitBytes(Number(match[1]) * unit);
}

export function extractCanonicalOptions(content) {
  const normalized = normalizeCaddyfile(content);
  const site = /^https:\/\/([^\s{]+) \{\n\tbind ([^\s{]+)\n/mu.exec(normalized);
  const cidrs = /\n\t\tnot remote_ip ([^\n]+)\n/mu.exec(normalized);
  const body = /\n\t\t\tmax_size ([^\s]+)\n/mu.exec(normalized);
  const upstreams = [...normalized.matchAll(/\n\t\treverse_proxy ([^\s{]+) \{/gu)].map((match) => match[1]);
  if (!site || !cidrs || !body || upstreams.length !== 3 || new Set(upstreams).size !== 1)
    throw new Error("Missing canonical Caddy values");
  return validateOptions({
    hostname: site[1],
    bindAddress: site[2],
    allowCidrs: cidrs[1].split(" "),
    upstream: parseUpstream(upstreams[0]),
    bodyLimitBytes: parseCaddyBodyLimit(body[1]),
  });
}

function listenerAddress(entry) {
  if (typeof entry !== "string") return String(entry?.address ?? entry?.localAddress ?? entry?.local ?? "");
  const columns = entry.trim().split(/\s+/u);
  return columns[0] === "LISTEN" ? (columns[3] ?? "") : (columns.at(-1) ?? "");
}

export function classifyListeners(listeners) {
  const entries = Array.isArray(listeners) ? listeners : String(listeners).split(/\r?\n/u).filter(Boolean);
  return entries.map((entry) => {
    const address = listenerAddress(entry);
    const match = address.match(/^\[([^\]]+)\]:(\d+)$/u) ?? address.match(/^(.+):(\d+)$/u);
    const host = match?.[1] ?? address;
    const port = Number(match?.[2]);
    const nonLoopback =
      host === "0.0.0.0" || host === "::" || host === "*" || (host && host !== "127.0.0.1" && host !== "::1");
    let severity = "info";
    let message = "Listener is not a monitored endpoint";
    if (port === 8765 && nonLoopback) {
      severity = "blocking";
      message = "MCP 8765 is exposed beyond loopback";
    } else if ((port === 8080 || port === 8085) && nonLoopback) {
      severity = "warning";
      message = `Nodel ${port} is exposed beyond loopback`;
    }
    return { address, port, severity, message };
  });
}

export function inspectLocalListeners(ssOutput, ssBin = process.env.SS_BIN || "ss") {
  const supplied = ssOutput !== undefined;
  const result = supplied ? null : spawnSync(ssBin, ["-H", "-ltn"], { encoding: "utf8" });
  const available = supplied || result?.status === 0;
  const listeners = classifyListeners(ssOutput ?? (available ? result?.stdout : ""));
  return {
    available,
    skipped: !available,
    message: !available ? "Listener diagnostics skipped: ss is unavailable" : undefined,
    listeners,
    blocking: listeners.filter((listener) => listener.severity === "blocking"),
    warnings: listeners.filter((listener) => listener.severity === "warning"),
  };
}

export function detectCaddyVersion(caddyBin = process.env.CADDY_BIN || "caddy") {
  const result = spawnSync(caddyBin, ["version"], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const match = output.match(/(?:v|Caddy\/)?(\d+)\.(\d+)/iu);
  return { available: !result.error, ok: result.status === 0 && match?.[1] === "2", version: match?.[0] ?? null };
}

export function validateWithCaddy(configPath, caddyBin = process.env.CADDY_BIN || "caddy", cwd) {
  const version = detectCaddyVersion(caddyBin);
  if (!version.available) {
    const required = process.env.CADDY_REQUIRED === "true";
    return {
      available: false,
      skipped: !required,
      ok: !required,
      message: required ? "Caddy 2 is required but unavailable" : "Caddy validation skipped: Caddy 2 is unavailable",
    };
  }
  if (!version.ok) return { available: true, ok: false, message: "Caddy 2 is required" };
  const result = spawnSync(caddyBin, ["validate", "--adapter", "caddyfile", "--config", configPath], {
    encoding: "utf8",
    cwd,
  });
  return {
    available: true,
    ok: result.status === 0,
    message: result.status === 0 ? "Caddy validation passed" : "Caddy rejected the Caddyfile",
  };
}

function quoteCaddyPath(path) {
  return JSON.stringify(resolve(path));
}

export async function validateComposedConfig(
  existingPath,
  candidatePath,
  caddyBin = process.env.CADDY_BIN || "caddy",
  { mkdtempImpl = mkdtemp, writeFileImpl = writeFile, removeImpl = rm, validateImpl = validateWithCaddy } = {},
) {
  const existingAbsolute = resolve(existingPath);
  const candidateAbsolute = resolve(candidatePath);
  const existingDirectory = dirname(existingAbsolute);
  const wrapperDirectory = await mkdtempImpl(join(tmpdir(), "nodel-caddy-compose-"));
  const wrapperPath = join(wrapperDirectory, `compose-${process.pid}.Caddyfile`);
  try {
    await writeFileImpl(
      wrapperPath,
      `import ${quoteCaddyPath(existingAbsolute)}\nimport ${quoteCaddyPath(candidateAbsolute)}\n`,
      {
        mode: 0o600,
      },
    );
    const result = await validateImpl(wrapperPath, caddyBin, existingDirectory);
    return result.ok || result.skipped ? result : { ...result, message: "Caddy rejected composed configuration" };
  } finally {
    await removeImpl(wrapperDirectory, { recursive: true, force: true });
  }
}

async function regularConfig(path) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new Error("Config is unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Config must be a regular nonsymlink file");
  return readFile(path, "utf8");
}

async function readHealthJson(response) {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 4096) return null;
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function liveCheck(liveUrl) {
  let url;
  try {
    url = new URL(liveUrl);
    if (
      !/^https?:$/u.test(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("unsafe URL");
  } catch {
    return { ok: false, message: "Live URL is unsafe or invalid" };
  }
  const checks = [
    ["mcp", 401],
    ["readyz", 401],
    ["healthz", 200],
  ];
  for (const [path, expected] of checks) {
    try {
      const expectedUrl = new URL(`/${path}`, url).href;
      const response = await fetch(expectedUrl, { redirect: "manual", signal: AbortSignal.timeout(3000) });
      if (response.url !== expectedUrl) return { ok: false, message: `Live ${path} response URL changed` };
      if (response.status >= 300 && response.status < 400)
        return { ok: false, message: `Live ${path} returned a redirect (${response.status})` };
      if (response.status !== expected) return { ok: false, message: `Live ${path} status was ${response.status}` };
      if (path === "healthz") {
        const health = await readHealthJson(response);
        if (!health || health.ok !== true || typeof health.version !== "string")
          return { ok: false, message: "Live health check was not the required JSON contract" };
      }
    } catch {
      return { ok: false, message: `Live ${path} check failed` };
    }
  }
  return { ok: true };
}

/** @param {{ configPath?: string, existingConfigPath?: string, caddyBin?: string, liveUrl?: string, ssOutput?: string, ssBin?: string }} [options] */
export async function diagnose({ configPath, existingConfigPath, caddyBin, liveUrl, ssOutput, ssBin } = {}) {
  const temporary = !configPath;
  const directory = temporary ? await mkdtemp(join(tmpdir(), "nodel-caddy-check-")) : null;
  const target = configPath ?? join(directory, "Caddyfile");
  try {
    const content = configPath
      ? await regularConfig(configPath)
      : renderCaddyfile(await readFile(templatePath, "utf8"), fixture);
    if (temporary) await writeFile(target, content, { mode: 0o600 });
    const inspection = inspectCaddyfile(content);
    const caddy = validateWithCaddy(target, caddyBin);
    let existing = { ok: true };
    if (existingConfigPath) {
      const existingPath = resolve(existingConfigPath);
      await regularConfig(existingPath);
      existing = await validateComposedConfig(existingPath, target, caddyBin);
    }
    const listeners = inspectLocalListeners(ssOutput, ssBin);
    const live = liveUrl ? await liveCheck(liveUrl) : { ok: true };
    return {
      ok: inspection.ok && caddy.ok && existing.ok && !listeners.blocking.length && live.ok,
      inspection,
      caddy,
      existing,
      listeners,
      live,
    };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export function parseCheckCliArgs(args) {
  const result = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--config", "--existing-config", "--live"].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    const name = flag === "--live" ? "liveUrl" : flag === "--config" ? "configPath" : "existingConfigPath";
    result[name] = value;
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await diagnose(parseCheckCliArgs(process.argv.slice(2)));
    for (const warning of result.listeners.warnings) console.error(`Warning: ${warning.message}`);
    if (result.listeners.skipped) console.error(`Warning: ${result.listeners.message}`);
    if (result.caddy.skipped) console.error(`Warning: ${result.caddy.message}`);
    if (result.existing.skipped) console.error(`Warning: ${result.existing.message}`);
    if (!result.ok) {
      for (const finding of result.inspection.findings) console.error(finding);
      if (!result.caddy.ok) console.error(result.caddy.message);
      if (!result.existing.ok) console.error(result.existing.message);
      if (!result.live.ok) console.error(result.live.message);
      if (result.listeners.blocking.length) console.error("Blocking listener exposure detected");
      process.exitCode = 1;
    } else console.log("Caddy inspection and validation passed");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
