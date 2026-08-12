import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

export const PRIVATE_LINK = /(?:github\.com[/:]mcartmel\/nodel-ai|git@github\.com:mcartmel\/nodel-ai)/iu;
const SECRET = /(AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA|EC|OPENSSH|DSA|PRIVATE) KEY-----|gh[pousr]_[A-Za-z0-9_]{20,})/u;
const DENIED_PART = /^(?:\.state|\.kilo|artifacts?|coverage|node_modules|logs?|backups?|backup)$/iu;
const DENIED_TOP_LEVEL = /^(?:plans|private|downloads|\.downloads|tmp)$/iu;
const PRIVATE_MARKER = /(?:^|\/)(?:private-export|internal-release)(?:$|[._-])/iu;
const DENIED_FILE =
  /(?:^|\/)(?:\.env(?!\.example$)|.*\.(?:pem|key|crt|cer|p12|pfx|jks|keystore)|caddy(?:[-.]generated)?\.(?:json|yaml|yml|conf)|.*generated.*\.(?:json|yaml|yml|conf)|.*\.bak(?:kup)?|.*\.backup)$/iu;
const HOST_PATH = /(?:\/home\/nodel(?:\/|$)|\/etc\/caddy(?:\/|$))/u;
const IPV4_LITERAL = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/gu;

function containsRfc1918Address(value) {
  return [...value.matchAll(IPV4_LITERAL)].some(([address]) => {
    if (!isIPv4(address)) return false;
    const [first, second] = address.split(".").map(Number);
    return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
  });
}

export function compareUtf8(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

export function assertPublicCandidatePath(path, { allowBuildOutput = false } = {}) {
  if (!path || path.includes("\\") || path.includes("\0") || isAbsolute(path))
    throw new Error(`unsafe candidate path: ${path}`);
  const normalized = posix.normalize(path);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized !== path.replace(/\/$/u, "")
  )
    throw new Error(`unsafe candidate path: ${path}`);
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /^\.git(?:$|\.)/u.test(part)))
    throw new Error(`unsafe candidate path: ${path}`);
  if (
    parts.some((part) => DENIED_PART.test(part)) ||
    DENIED_TOP_LEVEL.test(parts[0]) ||
    PRIVATE_MARKER.test(normalized) ||
    (!allowBuildOutput && parts.includes("dist")) ||
    (DENIED_FILE.test(normalized) && normalized !== ".env.example")
  )
    throw new Error(`denied public path: ${path}`);
  return normalized;
}

function assertEntryMode(entry) {
  const permissions = entry.mode & 0o777;
  const kind = entry.mode & 0o170000;
  if (entry.type === "file" && kind && kind !== 0o100000) throw new Error(`special candidate mode: ${entry.path}`);
  if (entry.type === "directory" && kind && kind !== 0o040000) throw new Error(`special candidate mode: ${entry.path}`);
  if (entry.type === "file" && ![0o644, 0o664, 0o755, 0o775].includes(permissions))
    throw new Error(`unsafe file mode: ${entry.path}`);
  if (entry.type === "directory" && ![0o755, 0o775].includes(permissions))
    throw new Error(`unsafe directory mode: ${entry.path}`);
  if (entry.type === "symlink" && entry.mode !== 0o120000) throw new Error(`unsafe symlink mode: ${entry.path}`);
}

function assertContent(entry) {
  if (entry.type === "file") {
    if (entry.data.subarray(0, 128).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1"))
      throw new Error(`Git LFS pointer: ${entry.path}`);
    const content = entry.data.toString("utf8");
    if (
      SECRET.test(content) ||
      PRIVATE_LINK.test(content) ||
      HOST_PATH.test(content) ||
      (entry.path !== "docs/operations.md" && containsRfc1918Address(content))
    )
      throw new Error(`private or secret content: ${entry.path}`);
  }
  if (
    entry.type === "symlink" &&
    (PRIVATE_LINK.test(entry.linkname) ||
      HOST_PATH.test(entry.linkname) ||
      (entry.path !== "docs/operations.md" && containsRfc1918Address(entry.linkname)))
  )
    throw new Error(`private symlink: ${entry.path}`);
}

export function validatePublicCandidateEntries(entries, options = {}) {
  const byPath = new Map();
  for (const entry of entries) {
    entry.path = assertPublicCandidatePath(entry.path, options);
    if (byPath.has(entry.path)) throw new Error(`duplicate candidate member: ${entry.path}`);
    if (!entry.data) entry.data = Buffer.alloc(0);
    if (!entry.type || !["file", "directory", "symlink"].includes(entry.type))
      throw new Error(`unsupported candidate member: ${entry.path}`);
    assertEntryMode(entry);
    assertContent(entry);
    byPath.set(entry.path, entry);
  }
  for (const entry of byPath.values()) {
    if (entry.type !== "symlink") continue;
    if (!entry.linkname || isAbsolute(entry.linkname)) throw new Error(`unsafe symlink: ${entry.path}`);
    const target = posix.normalize(posix.join(posix.dirname(entry.path), entry.linkname));
    if (target === "." || target.startsWith("../") || target.includes("/../"))
      throw new Error(`unsafe symlink: ${entry.path}`);
    const targetEntry = byPath.get(target);
    if (!targetEntry) throw new Error(`symlink target is not in candidate: ${entry.path}`);
    if (targetEntry.type === "symlink") throw new Error(`symlink chains are not allowed: ${entry.path}`);
    const ancestors = target.split("/").slice(0, -1);
    if (ancestors.some((_, index) => byPath.get(ancestors.slice(0, index + 1).join("/"))?.type === "symlink"))
      throw new Error(`symlink parent is not safe: ${entry.path}`);
  }
  return [...byPath.values()];
}

export async function collectPublicCandidateTree(root) {
  const absoluteRoot = resolve(root);
  const entries = [];
  async function walk(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareUtf8(left.name, right.name));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const path = relative(absoluteRoot, absolute).split(sep).join("/");
      const stat = await lstat(absolute);
      if (stat.isFile()) entries.push({ path, mode: stat.mode, type: "file", data: await readFile(absolute) });
      else if (stat.isDirectory()) {
        entries.push({ path, mode: stat.mode, type: "directory", data: Buffer.alloc(0) });
        await walk(absolute);
      } else if (stat.isSymbolicLink())
        entries.push({ path, mode: 0o120000, type: "symlink", linkname: await readlink(absolute) });
      else throw new Error(`unsupported candidate filesystem member: ${path}`);
    }
  }
  await walk(absoluteRoot);
  return entries;
}

export async function validatePublicCandidateTree(root, options = {}) {
  return validatePublicCandidateEntries(await collectPublicCandidateTree(root), options);
}
