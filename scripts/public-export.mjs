import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, posix } from "node:path";
import { compareUtf8, validatePublicCandidateEntries } from "./public-candidate-policy.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const TAR_BLOCK = 512;
export const PUBLIC_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
const GIT_TEXT_MAX_BYTES = 1 * 1024 * 1024;
const defaultGit = (cwd, args) => {
  const archive = args.includes("archive");
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "buffer",
      maxBuffer: archive ? PUBLIC_ARCHIVE_MAX_BYTES : GIT_TEXT_MAX_BYTES,
    });
  } catch (error) {
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      fail(archive ? "git archive exceeds configured maximum" : "git command output exceeds configured maximum");
    throw error;
  }
};

/** @typedef {{ cwd?: string, sourceSha?: string, runGit?: (cwd: string, args: string[], options?: { encoding?: string }) => string | Buffer }} PublicTreeOptions */
/** @typedef {PublicTreeOptions & { output?: string, manifestPath?: string }} PublicExportOptions */

function fail(message) {
  throw new Error(message);
}

function parseTarNumber(header, start, end, name) {
  const value = header.subarray(start, end).toString("ascii").replace(/\0.*$/u, "").trim();
  if (!value || !/^[0-7]+$/u.test(value)) fail(`invalid tar numeric field: ${name}`);
  return Number.parseInt(value, 8);
}

function assertTarChecksum(header) {
  const expected = parseTarNumber(header, 148, 156, "checksum");
  let actual = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) actual += index >= 148 && index < 156 ? 0x20 : header[index];
  if (actual !== expected) fail("invalid tar header checksum");
}

function field(header, start, end) {
  return header.subarray(start, end).toString("utf8").replace(/\0.*$/u, "");
}

export function parsePublicArchive(buffer, { maxBytes = PUBLIC_ARCHIVE_MAX_BYTES } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length > maxBytes) fail("public archive exceeds configured maximum");
  const entries = [];
  let terminated = false;
  for (let offset = 0; offset + TAR_BLOCK <= buffer.length; ) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) {
      if (
        offset + TAR_BLOCK * 2 > buffer.length ||
        !buffer.subarray(offset + TAR_BLOCK, offset + TAR_BLOCK * 2).every((byte) => byte === 0)
      )
        fail("invalid tar end marker");
      if (
        offset + TAR_BLOCK * 2 !== buffer.length &&
        !buffer.subarray(offset + TAR_BLOCK * 2).every((byte) => byte === 0)
      )
        fail("trailing tar data");
      terminated = true;
      break;
    }
    assertTarChecksum(header);
    if (
      header.subarray(257, 263).toString("ascii") !== "ustar\0" ||
      header.subarray(263, 265).toString("ascii") !== "00"
    )
      fail("unsupported tar header format");
    const typeFlag = String.fromCharCode(header[156]);
    if (!["0", "2", "5"].includes(typeFlag)) fail("unsupported tar extension/type flag");
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 500);
    const path = prefix ? `${prefix}/${name}` : name;
    const mode = parseTarNumber(header, 100, 108, "mode");
    const size = parseTarNumber(header, 124, 136, "size");
    const dataStart = offset + TAR_BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) fail("truncated tar member");
    entries.push({
      path: path.replace(/\/$/u, ""),
      mode: typeFlag === "2" ? 0o120000 : mode,
      type: typeFlag === "0" ? "file" : typeFlag === "5" ? "directory" : "symlink",
      linkname: field(header, 157, 257),
      data: buffer.subarray(dataStart, dataEnd),
    });
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  if (!terminated) fail("missing tar end marker");
  return validatePublicCandidateEntries(entries);
}

function git(cwd, args, runGit) {
  const result = (runGit ?? defaultGit)(cwd, args, {
    encoding: "buffer",
    maxBuffer: args.includes("archive") ? PUBLIC_ARCHIVE_MAX_BYTES : GIT_TEXT_MAX_BYTES,
  });
  if (!Buffer.isBuffer(result)) return Buffer.from(result);
  if (args.includes("archive") && result.length > PUBLIC_ARCHIVE_MAX_BYTES)
    fail("public archive exceeds configured maximum");
  return result;
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function assertSafeExistingPath(path, label, allowMissingLeaf = false) {
  const absolute = resolve(path);
  const components = [];
  for (let current = absolute; ; current = dirname(current)) {
    components.push(current);
    if (current === dirname(current)) break;
  }
  let missing = false;
  for (const current of components.reverse()) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        if (current === absolute && allowMissingLeaf && stat.isFile()) fail(`${label} already exists`);
        fail(`${label} has unsafe existing component: ${current}`);
      }
      if (missing) fail(`${label} has a non-directory parent: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing = true;
    }
  }
}

async function assertNewDirectory(path, label) {
  await assertSafeExistingPath(dirname(path), label);
  try {
    await lstat(path);
    fail(`${label} already exists`);
  } catch (error) {
    if (error.message?.includes("already exists")) throw error;
    if (error.code !== "ENOENT") throw error;
  }
}

async function assertNewManifest(path) {
  await assertSafeExistingPath(dirname(path), "manifest path");
  try {
    await lstat(path);
    fail("manifest already exists");
  } catch (error) {
    if (error.message?.includes("manifest already exists")) throw error;
    if (error.code !== "ENOENT") throw error;
  }
}

function statusEntries(cwd, runGit) {
  return git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], runGit)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) }));
}

function archiveEntries(root, sourceSha, runGit) {
  return validatePublicCandidateEntries(
    parsePublicArchive(git(root, ["archive", "--format=tar", `${sourceSha}^{tree}`], runGit)),
  );
}

/** @param {PublicTreeOptions} options */
export function checkPublicTree({ cwd = process.cwd(), sourceSha, runGit } = {}) {
  if (!SHA.test(sourceSha ?? "")) fail("--source-sha requires an exact 40-character SHA");
  const root = resolve(git(cwd, ["rev-parse", "--show-toplevel"], runGit).toString().trim());
  const head = git(root, ["rev-parse", "HEAD"], runGit).toString().trim();
  if (head !== sourceSha) fail(`source SHA must equal HEAD (${head})`);
  const status = statusEntries(root, runGit);
  if (status.length) fail(`working tree is not clean: ${status.map(({ code, path }) => `${code} ${path}`).join(", ")}`);
  return manifestFor(archiveEntries(root, sourceSha, runGit), sourceSha);
}

function manifestFor(entries, sourceSha) {
  return {
    sourceSha,
    paths: entries
      .filter((entry) => entry.type !== "directory")
      .sort((left, right) => compareUtf8(left.path, right.path))
      .map((entry) => ({
        path: entry.path,
        sha256: createHash("sha256")
          .update(entry.type === "symlink" ? entry.linkname : entry.data)
          .digest("hex"),
        mode: entry.mode.toString(8),
        type: entry.type,
      })),
  };
}

/** @param {PublicExportOptions} options */
export async function exportPublicTree({ cwd = process.cwd(), sourceSha, output, manifestPath, runGit } = {}) {
  const manifest = checkPublicTree({ cwd, sourceSha, runGit });
  if (!output) fail("--output requires a destination directory");
  const root = resolve(git(cwd, ["rev-parse", "--show-toplevel"], runGit).toString().trim());
  const destination = resolve(output);
  const manifestFile = resolve(manifestPath ?? `${destination}.manifest.json`);
  if (isWithin(root, destination) || isWithin(root, manifestFile))
    fail("output and manifest must be outside source repository");
  if (isWithin(destination, manifestFile)) fail("manifest must be outside exported tree");
  await assertNewDirectory(destination, "output directory");
  await assertNewManifest(manifestFile);
  const entries = archiveEntries(root, sourceSha, runGit);
  await mkdir(destination, { recursive: false, mode: 0o755 });
  for (const entry of entries.filter((item) => item.type === "directory"))
    await mkdir(resolve(destination, entry.path), { recursive: false, mode: entry.mode & 0o777 });
  for (const entry of entries.filter((item) => item.type !== "directory")) {
    const target = resolve(destination, entry.path);
    if (!isWithin(destination, target)) fail(`archive extraction escaped output: ${entry.path}`);
    if (entry.type === "symlink") await symlink(entry.linkname, target);
    else {
      await writeFile(target, entry.data, { flag: "wx", mode: entry.mode & 0o777 });
      await chmod(target, entry.mode & 0o777);
    }
  }
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(manifestFile, 0o600);
  return { destination, manifestPath: manifestFile, manifest };
}

export function parseCliArgs(argv) {
  let mode;
  let sourceSha;
  let output;
  let manifestPath;
  const valueFlags = new Set(["--source-sha", "--output", "--manifest"]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--check") {
      if (seen.has(flag) || mode) fail("duplicate or conflicting CLI mode");
      seen.add(flag);
      mode = "check";
    } else if (flag === "--output") {
      if (seen.has(flag) || mode) fail("duplicate or conflicting CLI mode");
      seen.add(flag);
      mode = "output";
      output = argv[++index];
      if (!output || output.startsWith("--")) fail("--output requires a value");
    } else if (valueFlags.has(flag)) {
      if (seen.has(flag)) fail(`duplicate CLI flag: ${flag}`);
      seen.add(flag);
      const value = argv[++index];
      if (!value || value.startsWith("--")) fail(`${flag} requires a value`);
      if (flag === "--source-sha") sourceSha = value;
      else manifestPath = value;
    } else fail(`unknown CLI argument: ${flag}`);
  }
  if (!mode) fail("use exactly one of --check or --output");
  if (!SHA.test(sourceSha ?? "")) fail("--source-sha requires an exact 40-character SHA");
  if (mode === "check" && manifestPath) fail("--manifest requires --output");
  return { mode, sourceSha, output, manifestPath };
}

async function main(argv) {
  const { mode, sourceSha, output, manifestPath } = parseCliArgs(argv);
  const result =
    mode === "output" ? await exportPublicTree({ sourceSha, output, manifestPath }) : checkPublicTree({ sourceSha });
  console.log(
    output
      ? `Public export written to ${result.destination}\nManifest: ${result.manifestPath}`
      : `Public tree eligible (${result.paths.length} files).`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`)
  main(process.argv.slice(2)).catch((error) => {
    console.error(`public-export: ${error.message}`);
    process.exitCode = 1;
  });
