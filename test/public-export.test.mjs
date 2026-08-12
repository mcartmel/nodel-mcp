import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compareUtf8, validatePublicCandidateEntries } from "../scripts/public-candidate-policy.mjs";
import {
  checkPublicTree,
  exportPublicTree,
  parseCliArgs,
  parsePublicArchive,
  PUBLIC_ARCHIVE_MAX_BYTES,
} from "../scripts/public-export.mjs";
import { validateReleaseStaging } from "../scripts/release-package-policy.mjs";

async function fixture(files = {}, links = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "nodel-public-export-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  for (const [path, content] of Object.entries(files)) {
    const target = join(cwd, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  for (const [path, target] of Object.entries(links)) {
    const link = join(cwd, path);
    await mkdir(join(link, ".."), { recursive: true });
    await symlink(target, link);
  }
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"],
    { cwd },
  );
  return { cwd, sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim() };
}

function tarEntry({ name = "file.txt", type = "0", mode = 0o644, data = Buffer.alloc(0), linkname = "" } = {}) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(mode.toString(8).padStart(7, "0") + "\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header.fill(0x20, 148, 156);
  header.write(type, 156);
  header.write(linkname, 157);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function tar(entries) {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

test("exports the exact committed tree with deterministic manifest bytes", async () => {
  const repo = await fixture({ "README.md": "public\n", ".env.example": "TOKEN=\n", "z.txt": "z\n", "a.txt": "a\n" });
  const base = join(repo.cwd, "..", `export-${process.pid}-${Date.now()}`);
  const first = await exportPublicTree({ cwd: repo.cwd, sourceSha: repo.sha, output: `${base}-a` });
  const second = await exportPublicTree({ cwd: repo.cwd, sourceSha: repo.sha, output: `${base}-b` });
  assert.deepEqual(first.manifest, checkPublicTree({ cwd: repo.cwd, sourceSha: repo.sha }));
  assert.deepEqual(await readFile(first.manifestPath), await readFile(second.manifestPath));
  assert.equal((await lstat(first.manifestPath)).mode & 0o777, 0o600);
  assert.deepEqual(
    first.manifest.paths.map(({ path }) => path),
    [".env.example", "README.md", "a.txt", "z.txt"],
  );
});

test("uses public repository metadata while retaining the nodel-ai runtime identity", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.name, "nodel-ai");
  assert.equal(packageJson.repository.url, "git+https://github.com/mcartmel/nodel-mcp.git");
  assert.equal(packageJson.bugs.url, "https://github.com/mcartmel/nodel-mcp/issues");
  assert.equal(packageJson.homepage, "https://github.com/mcartmel/nodel-mcp#readme");
});

test("documentation checker rejects spaced and plural private-build provenance wording", async () => {
  const checker = await readFile(new URL("../scripts/check-docs-links.mjs", import.meta.url), "utf8");
  const expression = checker.match(/const privateHistory\s*=\s*\n?\s*(\/.*\/[a-z]*);/u);
  assert.ok(expression);
  const lastSlash = expression[1].lastIndexOf("/");
  const pattern = expression[1].slice(1, lastSlash);
  const flags = expression[1].slice(lastSlash + 1);
  const privateHistory = new RegExp(pattern, flags);
  for (const value of ["private build", "private builds", "private-build", "private formats", "private history"])
    assert.match(value, privateHistory);
});

test("orders manifests by UTF-8 bytes rather than process locale", () => {
  const paths = ["z", "a", "Z", "ä"].sort(compareUtf8);
  assert.deepEqual(paths, ["Z", "a", "z", "ä"]);
});

test("CLI requires exact, non-duplicated flags and values", () => {
  assert.deepEqual(parseCliArgs(["--check", "--source-sha", "a".repeat(40)]), {
    mode: "check",
    sourceSha: "a".repeat(40),
    output: undefined,
    manifestPath: undefined,
  });
  assert.deepEqual(
    parseCliArgs(["--output", "/outside", "--manifest", "/audit.json", "--source-sha", "b".repeat(40)]),
    {
      mode: "output",
      sourceSha: "b".repeat(40),
      output: "/outside",
      manifestPath: "/audit.json",
    },
  );
  for (const args of [
    [],
    ["--check"],
    ["--check", "--source-sha", "a".repeat(40), "--check"],
    ["--check", "--source-sha", "a".repeat(40), "--output", "/outside"],
    ["--check", "--source-sha", "a".repeat(40), "--unknown"],
    ["--check", "--source-sha", "a".repeat(40), "--manifest", "/audit.json"],
    ["--output", "--source-sha", "a".repeat(40)],
    ["--check", "--source-sha", "a".repeat(40), "--source-sha", "b".repeat(40)],
  ])
    assert.throws(() => parseCliArgs(args));
});

test("real Git archive checks support source trees over one MiB", async () => {
  const repo = await fixture({ "large.txt": Buffer.alloc(2 * 1024 * 1024, 0x61) });
  const result = checkPublicTree({ cwd: repo.cwd, sourceSha: repo.sha });
  assert.equal(
    result.paths.find(({ path }) => path === "large.txt")?.sha256,
    "5256ec18f11624025905d057d6befb03d77b243511ac5f77ed5e0221ce6d84b5",
  );
  assert.ok(result.paths.length > 0);
  assert.ok(PUBLIC_ARCHIVE_MAX_BYTES > 2 * 1024 * 1024);
  const exported = await exportPublicTree({
    cwd: repo.cwd,
    sourceSha: repo.sha,
    output: join(repo.cwd, "..", `large-export-${process.pid}-${Date.now()}`),
  });
  assert.equal((await lstat(join(exported.destination, "large.txt"))).size, 2 * 1024 * 1024);
});

test("refuses dirty, untracked candidates, ignored local files, and source mismatches", async () => {
  const repo = await fixture({ "README.md": "public\n" });
  await writeFile(join(repo.cwd, "candidate.txt"), "candidate\n");
  assert.throws(() => checkPublicTree({ cwd: repo.cwd, sourceSha: repo.sha }), /working tree is not clean/u);
  execFileSync("git", ["clean", "-fdq"], { cwd: repo.cwd });
  await writeFile(join(repo.cwd, "ignored.env"), "secret\n");
  await writeFile(join(repo.cwd, ".git", "info", "exclude"), "ignored.env\n", { flag: "a" });
  assert.equal(
    checkPublicTree({ cwd: repo.cwd, sourceSha: repo.sha }).paths.some(({ path }) => path === "ignored.env"),
    false,
  );
  assert.throws(() => checkPublicTree({ cwd: repo.cwd, sourceSha: "0".repeat(40) }), /source SHA must equal HEAD/u);
});

test("rejects public candidate policy violations and symlink chains", async (t) => {
  const privateIp = ["192", "168", "1", "7"].join(".");
  const privateCidr = `${["10", "0", "0", "0"].join(".")}/8`;
  /** @type {[string, any[], RegExp][]} */
  const cases = [
    ["denylist", [{ path: ".env", mode: 0o644, type: "file", data: Buffer.from("x") }], /denied public path/u],
    [
      "private-link",
      [
        {
          path: "README.md",
          mode: 0o644,
          type: "file",
          data: Buffer.from(["https://github.com/mcartmel", "nodel-ai"].join("/")),
        },
      ],
      /private or secret content/u,
    ],
    [
      "host-path",
      [{ path: "README.md", mode: 0o644, type: "file", data: Buffer.from(["", "home", "nodel", "secret"].join("/")) }],
      /private or secret content/u,
    ],
    [
      "private-ip-url-and-cidr",
      [
        {
          path: "README.md",
          mode: 0o644,
          type: "file",
          data: Buffer.from(`http://${privateIp}:8080/allowed ${privateCidr}`),
        },
      ],
      /private or secret content/u,
    ],
    [
      "secret",
      [{ path: "README.md", mode: 0o644, type: "file", data: Buffer.from(`AKIA${"A".repeat(16)}`) }],
      /private or secret content/u,
    ],
    [
      "lfs",
      [
        {
          path: "large.bin",
          mode: 0o644,
          type: "file",
          data: Buffer.from("version https://git-lfs.github.com/spec/v1\n"),
        },
      ],
      /Git LFS pointer/u,
    ],
    ["gitlink", [{ path: "module", mode: 0o160000, type: "file", data: Buffer.alloc(0) }], /special candidate mode/u],
    ["mode", [{ path: "file", mode: 0o600, type: "file", data: Buffer.alloc(0) }], /unsafe file mode/u],
    [
      "chain",
      [
        { path: "file", mode: 0o644, type: "file", data: Buffer.alloc(0) },
        { path: "one", mode: 0o120000, type: "symlink", linkname: "file" },
        { path: "two", mode: 0o120000, type: "symlink", linkname: "one" },
      ],
      /symlink chains/u,
    ],
    [
      "cycle",
      [
        { path: "one", mode: 0o120000, type: "symlink", linkname: "two" },
        { path: "two", mode: 0o120000, type: "symlink", linkname: "one" },
      ],
      /symlink chains/u,
    ],
  ];
  for (const [name, entries, expected] of cases) {
    await t.test(name, () => assert.throws(() => validatePublicCandidateEntries(entries), expected));
  }
});

test("allows private IP content only in the local-only operations document", () => {
  const privateIp = ["172", "16", "0", "9"].join(".");
  const entry = (path) => ({ path, mode: 0o644, type: "file", data: Buffer.from(`http://${privateIp}:8080\n`) });
  assert.doesNotThrow(() => validatePublicCandidateEntries([entry("docs/operations.md")]));
  assert.throws(() => validatePublicCandidateEntries([entry("docs/other.md")]), /private or secret content/u);
  const secret = `AKIA${"A".repeat(16)}`;
  assert.throws(
    () =>
      validatePublicCandidateEntries([
        { path: "docs/operations.md", mode: 0o644, type: "file", data: Buffer.from(secret) },
      ]),
    /private or secret content/u,
  );
});

test("rejects private plan/download roots and private release markers without hiding public docs or workflows", () => {
  for (const path of [
    "plans/release.md",
    "private/notes.md",
    "downloads/source.tar",
    ".downloads/source.tar",
    "tmp/review.txt",
    "private-export.json",
    "docs/internal-release-notes.md",
    "scripts/private-export.mjs",
  ]) {
    assert.throws(
      () => validatePublicCandidateEntries([{ path, mode: 0o644, type: "file", data: Buffer.from("safe\n") }]),
      /denied public path/u,
      path,
    );
  }
  for (const path of ["docs/releasing.md", ".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    assert.doesNotThrow(() =>
      validatePublicCandidateEntries([{ path, mode: 0o644, type: "file", data: Buffer.from("public\n") }]),
    );
  }
});

test("validates tar checksums and rejects all unsupported extension types", () => {
  const good = tar([tarEntry({ name: "README.md", data: Buffer.from("ok\n") })]);
  assert.deepEqual(
    parsePublicArchive(good).map(({ path }) => path),
    ["README.md"],
  );
  const corrupt = Buffer.from(good);
  corrupt[0] ^= 1;
  assert.throws(() => parsePublicArchive(corrupt), /checksum/u);
  for (const type of ["1", "3", "4", "6", "7", "8", "g", "x", "L", "K", "S"]) {
    assert.throws(() => parsePublicArchive(tar([tarEntry({ type })])), /unsupported tar extension\/type flag/u, type);
  }
  assert.throws(() => parsePublicArchive(tar([tarEntry({ mode: 0o600 })])), /unsafe file mode/u);
  assert.throws(() => parsePublicArchive(Buffer.alloc(PUBLIC_ARCHIVE_MAX_BYTES + 1)), /exceeds configured maximum/u);
});

test("refuses unsafe output and manifest paths", async () => {
  const repo = await fixture({ "README.md": "public\n" });
  const parent = await mkdtemp(join(tmpdir(), "nodel-public-output-"));
  const linked = join(parent, "linked");
  await symlink(parent, linked);
  await assert.rejects(
    () => exportPublicTree({ cwd: repo.cwd, sourceSha: repo.sha, output: join(linked, "output") }),
    /unsafe existing component/u,
  );
  const output = join(parent, "output");
  const manifestParent = join(parent, "manifest-link");
  await symlink(parent, manifestParent);
  await assert.rejects(
    () =>
      exportPublicTree({
        cwd: repo.cwd,
        sourceSha: repo.sha,
        output,
        manifestPath: join(manifestParent, "manifest.json"),
      }),
    /unsafe existing component/u,
  );
  await assert.rejects(
    () =>
      exportPublicTree({
        cwd: repo.cwd,
        sourceSha: repo.sha,
        output: join(parent, "inside"),
        manifestPath: join(repo.cwd, "manifest.json"),
      }),
    /outside source repository/u,
  );
  await writeFile(join(parent, "manifest.json"), "existing\n");
  await assert.rejects(
    () =>
      exportPublicTree({
        cwd: repo.cwd,
        sourceSha: repo.sha,
        output: join(parent, "third"),
        manifestPath: join(parent, "manifest.json"),
      }),
    /manifest already exists/u,
  );
});

test("release staging uses the shared public candidate policy", async () => {
  const tree = await mkdtemp(join(tmpdir(), "nodel-release-policy-"));
  await writeFile(join(tree, "README.md"), "https://github.com/mcartmel/nodel-mcp\n");
  await mkdir(join(tree, "dist"));
  await writeFile(join(tree, "dist", "index.js"), "export {};\n");
  await assert.doesNotReject(() => validateReleaseStaging(tree));
  await writeFile(join(tree, "certificate.pem"), "not a certificate\n");
  await assert.rejects(() => validateReleaseStaging(tree), /denied public path/u);
  await writeFile(join(tree, "certificate.pem"), "safe\n");
  const privateIp = ["10", "1", "2", "3"].join(".");
  await mkdir(join(tree, "docs"));
  await writeFile(join(tree, "docs", "operations.md"), `http://${privateIp}:8080\n`);
  await rm(join(tree, "certificate.pem"));
  await assert.doesNotReject(() => validateReleaseStaging(tree));
  await writeFile(join(tree, "README.md"), `${["https://github.com/mcartmel", "nodel-ai"].join("/")}\n`);
  await assert.rejects(() => validateReleaseStaging(tree), /private or secret content/u);
});
