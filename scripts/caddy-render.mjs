import { lstat, open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isIP } from "node:net";
import { dirname, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultTemplate = fileURLToPath(new URL("../deploy/caddy/nodel-mcp.Caddyfile.in", import.meta.url));
const DEFAULT_UPSTREAM = "127.0.0.1:8765";
const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;
export const MIN_BODY_LIMIT_BYTES = 1024;
export const MAX_BODY_LIMIT_BYTES = 50 * 1024 * 1024;
const OPTION_NAMES = new Map([
  ["--hostname", "hostname"],
  ["--bind-address", "bindAddress"],
  ["--allow-cidr", "allowCidrs"],
  ["--upstream", "upstream"],
  ["--body-limit-bytes", "bodyLimitBytes"],
  ["--output", "output"],
]);

function fail(message) {
  throw new Error(message);
}

function parseIp(value) {
  if (
    typeof value !== "string" ||
    !value ||
    [...value].some((character) => character.codePointAt(0) < 0x21 || character.codePointAt(0) === 0x7f) ||
    isIP(value) === 0
  )
    fail("Invalid IP address");
  return value;
}

export function isValidCidr(value) {
  if (typeof value !== "string") return false;
  const slash = value.lastIndexOf("/");
  if (slash < 1 || slash === value.length - 1) return false;
  const ip = value.slice(0, slash);
  const prefix = Number(value.slice(slash + 1));
  const version = isIP(ip);
  return (
    (version === 4 || version === 6) && Number.isInteger(prefix) && prefix >= 0 && prefix <= (version === 4 ? 32 : 128)
  );
}

function parsePort(value) {
  const port = Number(value);
  if (!/^\d+$/u.test(String(value)) || !Number.isInteger(port) || port < 1 || port > 65535)
    fail("Invalid upstream port");
  return port;
}

export function parseUpstream(value) {
  if (typeof value !== "string") fail("Upstream is required");
  let host;
  let port;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0 || value[end + 1] !== ":" || value.indexOf("]", end + 1) !== -1) fail("Invalid upstream");
    host = value.slice(1, end);
    port = value.slice(end + 2);
  } else {
    const separator = value.lastIndexOf(":");
    if (separator < 1) fail("Invalid upstream");
    host = value.slice(0, separator);
    port = value.slice(separator + 1);
  }
  const ip = parseIp(host);
  const loopback = (isIP(ip) === 4 && ip.startsWith("127.")) || (isIP(ip) === 6 && ip === "::1");
  if (!loopback) fail("Upstream must be loopback");
  if (isIP(ip) === 6 && (!value.startsWith("[") || host !== "::1"))
    fail("IPv6 upstream must be bracketed and canonical");
  const parsedPort = parsePort(port);
  return isIP(ip) === 6 ? `[::1]:${parsedPort}` : `${ip}:${parsedPort}`;
}

export function parseBodyLimitBytes(value) {
  if (!/^\d+$/u.test(String(value))) fail("Body limit must be an integer between 1024 and 52428800");
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < MIN_BODY_LIMIT_BYTES || bytes > MAX_BODY_LIMIT_BYTES)
    fail("Body limit must be an integer between 1024 and 52428800");
  return bytes;
}

export function formatCaddyBytes(bytes) {
  const value = parseBodyLimitBytes(bytes);
  /** @type {Array<[string, number]>} */
  const units = [
    ["GiB", 2 ** 30],
    ["MiB", 2 ** 20],
    ["KiB", 2 ** 10],
  ];
  for (const [unit, size] of units) {
    if (value % size === 0) return `${value / size}${unit}`;
  }
  return `${value}B`;
}

export function validateOptions(input) {
  const options = { ...input };
  if (typeof options.hostname !== "string" || !options.hostname) fail("Hostname is required");
  if (
    !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u.test(
      options.hostname,
    ) ||
    /[{}$`\\\s/:*?]/u.test(options.hostname)
  )
    fail("Invalid hostname");
  options.bindAddress = parseIp(options.bindAddress);
  options.allowCidrs = Array.isArray(options.allowCidrs) ? options.allowCidrs : [];
  if (!options.allowCidrs.length || options.allowCidrs.some((cidr) => !isValidCidr(cidr)))
    fail("At least one valid CIDR is required");
  options.upstream = parseUpstream(options.upstream ?? DEFAULT_UPSTREAM);
  options.bodyLimitBytes = parseBodyLimitBytes(options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES);
  return options;
}

export function renderCaddyfile(template, input) {
  const options = validateOptions(input);
  const values = {
    HOSTNAME: options.hostname,
    BIND: options.bindAddress,
    CIDRS: options.allowCidrs.join(" "),
    UPSTREAM: options.upstream,
    BODY_LIMIT: formatCaddyBytes(options.bodyLimitBytes),
  };
  return template
    .replace(/__([A-Z_]+)__/gu, (placeholder, name) => {
      if (!(name in values)) fail(`Unknown template placeholder: ${placeholder}`);
      return values[name];
    })
    .replace(/\r\n?/gu, "\n")
    .replace(/\n*$/u, "\n");
}

async function ensureSafeOutput(path) {
  const rawComponents = String(path).split(/[\\/]/u).filter(Boolean);
  if (rawComponents.includes("..")) fail("Output path contains traversal components");
  const output = resolve(path);
  const components = output.slice(parse(output).root.length).split("/").filter(Boolean);
  if (components.includes("..")) fail("Output path contains traversal components");
  try {
    const stat = await lstat(output);
    fail(stat.isFile() ? "Refusing existing output" : "Output must be a new regular file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const parent = dirname(output);
  let parentStat;
  try {
    parentStat = await lstat(parent);
  } catch (error) {
    fail(`Invalid output directory: ${error.message}`);
  }
  if (parentStat.isSymbolicLink()) fail("Output path must not contain symlinks");
  if (!parentStat.isDirectory()) fail("Output parent is not a directory");
  let current = parse(parent).root;
  for (const component of parent.slice(current.length).split("/").filter(Boolean)) {
    current = `${current}${current.endsWith("/") ? "" : "/"}${component}`;
    if ((await lstat(current)).isSymbolicLink()) fail("Output path must not contain symlinks");
  }
}

export async function writeRenderedOutput(path, content) {
  await ensureSafeOutput(path);
  const handle = await open(resolve(path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  try {
    await handle.chmod(0o644);
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

export function parseCliArgs(args) {
  const result = { allowCidrs: [] };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const name = OPTION_NAMES.get(flag);
    if (!name) fail(`Unknown argument: ${flag}`);
    if (name !== "allowCidrs" && seen.has(name)) fail(`Duplicate argument: ${flag}`);
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    if (name === "allowCidrs") result.allowCidrs.push(value);
    else {
      seen.add(name);
      result[name] = value;
    }
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const content = renderCaddyfile(await readFile(defaultTemplate, "utf8"), options);
    if (options.output) await writeRenderedOutput(options.output, content);
    else process.stdout.write(content);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
