import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, parse, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// CI-only: the validator is deliberately never copied into a release archive.
export const CADDY_VERSION = "2.11.3";
export const CADDY_ASSET = `caddy_${CADDY_VERSION}_linux_amd64.tar.gz`;
export const CADDY_SHA512 =
  "ee886eceda0ff9f30610d3be9b5b594026591e19add6b3961a341c72abe468e5eac9d7c2c2450bbb8420db1f827b954521f9336be4872f81090b8618adf8815a";
export const CADDY_DOWNLOAD_URL = `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/${CADDY_ASSET}`;
export const CADDY_CHECKSUM_URL = `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_checksums.txt`;
const EXPECTED_ARCHIVE_MEMBERS = new Set(["caddy", "LICENSE", "README.md"]);
const TRUSTED_REDIRECT_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const MAX_REDIRECTS = 3;

function trustedHttpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !TRUSTED_REDIRECT_HOSTS.has(url.hostname))
    throw new Error("Caddy source must use HTTPS without credentials on a trusted GitHub release host");
  return url;
}

export async function fetchBytes(value, fetchImpl = /** @type {any} */ (fetch), maxRedirects = MAX_REDIRECTS) {
  let url = trustedHttpsUrl(value);
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await fetchImpl(url, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      if (redirects === maxRedirects) throw new Error("Caddy download exceeded redirect limit");
      const location = response.headers?.get("location");
      if (!location) throw new Error("Caddy redirect did not provide a location");
      url = trustedHttpsUrl(new URL(location, url));
      continue;
    }
    if (!response.ok) throw new Error(`Caddy download failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error("Caddy download redirect handling failed");
}

function safeArchiveName(name) {
  if (
    typeof name !== "string" ||
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    [...name].some((character) => character.codePointAt(0) < 0x20 || character.codePointAt(0) === 0x7f) ||
    name.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    return false;
  return true;
}

export function validateArchiveMembers(members) {
  if (!Array.isArray(members) || !members.length) throw new Error("Caddy archive must contain members");
  const normalized = members.map((member) => (typeof member === "string" ? { name: member, type: "-" } : member));
  const names = new Set();
  let binaryCount = 0;
  for (const member of normalized) {
    if (!member || member.type !== "-" || !safeArchiveName(member.name))
      throw new Error("Caddy archive contains an unsafe, non-regular, or special member");
    if (names.has(member.name)) throw new Error("Caddy archive contains a duplicate member");
    names.add(member.name);
    if (!EXPECTED_ARCHIVE_MEMBERS.has(member.name)) throw new Error("Caddy archive contains an unexpected member");
    if (member.name === "caddy") binaryCount += 1;
  }
  if (binaryCount !== 1) throw new Error("Caddy archive must contain exactly one caddy binary");
  return normalized;
}

function listArchiveMembers(archivePath) {
  const listing = execFileSync("tar", ["--list", "--verbose", "--quoting-style=escape", "--file", archivePath], {
    encoding: "utf8",
  });
  return listing
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const match = /^(.)(?:[rwx-]{9})\s+\S+\s+\d+\s+\S+\s+\S+\s+(.+)$/u.exec(line);
      if (!match) throw new Error("Unable to parse Caddy archive member");
      return { type: match[1], name: match[2].replace(/^'(.*)'$/u, "$1") };
    });
}

export function validateOutputPath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    [...value].some((character) => character.codePointAt(0) < 0x20 || character.codePointAt(0) === 0x7f)
  )
    throw new Error("CADDY_BIN output must be a non-empty path without control characters");
  const rawComponents = value.split(/[\\/]/u).filter(Boolean);
  if (rawComponents.includes(".") || rawComponents.includes(".."))
    throw new Error("CADDY_BIN output contains traversal");
  const output = resolve(value);
  const components = output.slice(parse(output).root.length).split("/").filter(Boolean);
  if (components.includes(".") || components.includes("..")) throw new Error("CADDY_BIN output contains traversal");
  return output;
}

async function validateNewOutput(value) {
  const output = validateOutputPath(value);
  try {
    const existing = await lstat(output);
    throw new Error(existing.isFile() ? "CADDY_BIN output already exists" : "CADDY_BIN output is not a regular file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const parent = dirname(output);
  let current = parse(parent).root;
  for (const component of parent.slice(current.length).split("/").filter(Boolean)) {
    current = `${current}${current.endsWith("/") ? "" : "/"}${component}`;
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("CADDY_BIN output parent must be nonsymlink directories");
  }
  return output;
}

export function environmentLines(output) {
  const safeOutput = validateOutputPath(output);
  return `CADDY_BIN=${safeOutput}\nCADDY_REQUIRED=true\n`;
}

async function assertNoSymlinkComponents(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split("/").filter(Boolean)) {
    current = `${current}${current.endsWith("/") ? "" : "/"}${component}`;
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("GITHUB_ENV path must not contain symlinks");
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
}

export async function appendEnvironment(envPath, output) {
  if (!envPath) return;
  const safeEnv = validateOutputPath(envPath);
  await assertNoSymlinkComponents(dirname(safeEnv));
  try {
    const info = await lstat(safeEnv);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("GITHUB_ENV must be a regular nonsymlink file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const handle = await open(
    safeEnv,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(environmentLines(output), "utf8");
  } finally {
    await handle.close();
  }
}

export function parseFetcherArgs(args) {
  if (args.length !== 2 || args[0] !== "--output" || !args[1])
    throw new Error("Usage: fetch-caddy-validation.mjs --output PATH");
  return { output: validateOutputPath(args[1]) };
}

export async function installCaddy(output, fetchImpl = fetch) {
  const target = await validateNewOutput(output);
  const temporary = await mkdtemp(`${tmpdir()}/nodel-caddy-fetch-`);
  try {
    const published = (await fetchBytes(CADDY_CHECKSUM_URL, fetchImpl)).toString("utf8");
    const line = published.split(/\r?\n/u).find((entry) => entry.trimEnd().endsWith(`  ${CADDY_ASSET}`));
    if (!line || !new RegExp(`^${CADDY_SHA512}\\s+${CADDY_ASSET}$`, "u").test(line.trim()))
      throw new Error("Published Caddy checksum does not match the pinned v2.11.3 checksum");
    const archive = await fetchBytes(CADDY_DOWNLOAD_URL, fetchImpl);
    if (createHash("sha512").update(archive).digest("hex") !== CADDY_SHA512)
      throw new Error("Caddy archive checksum mismatch");
    const archivePath = `${temporary}/${CADDY_ASSET}`;
    await writeFile(archivePath, archive, { mode: 0o600 });
    validateArchiveMembers(listArchiveMembers(archivePath));
    execFileSync(
      "tar",
      [
        "--extract",
        "--gzip",
        "--file",
        archivePath,
        "--directory",
        temporary,
        "--no-same-owner",
        "--no-same-permissions",
        "--no-overwrite-dir",
        "caddy",
      ],
      { stdio: "inherit" },
    );
    const binary = `${temporary}/caddy`;
    const info = await lstat(binary);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Extracted Caddy member is not a regular file");
    const data = await readFile(binary);
    const version = execFileSync(binary, ["version"], { encoding: "utf8" });
    if (!new RegExp(`(?:^|\\D)v?${CADDY_VERSION.replaceAll(".", "\\.")}(?:\\D|$)`, "u").test(version))
      throw new Error("Downloaded Caddy binary did not report v2.11.3");
    await writeFile(target, data, { flag: "wx", mode: 0o700 });
    await chmod(target, 0o755);
    await appendEnvironment(process.env.GITHUB_ENV, target);
    return target;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { output } = parseFetcherArgs(process.argv.slice(2));
    console.log(`CADDY_BIN=${await installCaddy(output)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
