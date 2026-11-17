import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const pinNames = ["contract.json", "quickstart.json", "provenance.json"];
const maxBytes = 4 * 1024 * 1024;

async function fixture(t, compiled = true) {
  const directory = await mkdtemp(join(tmpdir(), "nodel-refresh-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "scripts"));
  await mkdir(join(directory, "src/nodel/v2"), { recursive: true });
  await copyFile(join(root, "scripts/refresh-v2-reference.mjs"), join(directory, "scripts/refresh-v2-reference.mjs"));
  await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
  for (const name of pinNames) await copyFile(join(root, "src/nodel/v2", name), join(directory, "src/nodel/v2", name));
  if (compiled) {
    await mkdir(join(directory, "dist/domain/ui"), { recursive: true });
    for (const name of ["html.js", "limits.js"]) {
      const source = join(root, "dist/domain/ui", name);
      await assert.doesNotReject(readFile(source), "Refresh tests require compiled helpers; run npm run build first");
      await copyFile(source, join(directory, "dist/domain/ui", name));
    }
    await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  }
  const starter = JSON.parse(await readFile(join(directory, "src/nodel/v2/quickstart.json"), "utf8"));
  const escaped = starter.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const marked = `<nodel-page data-catalogue-quickstart><pre data-catalogue-quickstart-code><code>${escaped}</code></pre></nodel-page>`;
  await writeFile(join(directory, "starter.html"), starter);
  const catalogue = (tail = "") => `<!doctype html><html><head></head><body>${marked}${tail}</body></html>`;
  const pins = () => Promise.all(pinNames.map((name) => readFile(join(directory, "src/nodel/v2", name))));
  const run = (mode = "--check", input = "--catalogue", revision = "b4f9f03dd40ac4670d48efa749ae8d5ad96c2980") =>
    spawnSync(
      process.execPath,
      [
        "scripts/refresh-v2-reference.mjs",
        mode,
        "--artifact",
        "src/nodel/v2/contract.json",
        input,
        input === "--catalogue" ? "components.html" : "starter.html",
        "--repository",
        "https://github.com/mcartmel/nodel-webui-v2",
        "--revision",
        revision,
        "--package-version",
        "0.2.0",
        "--schema-version",
        "1",
        "--license",
        "MPL-2.0",
      ],
      { cwd: directory, encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 },
    );
  return { directory, catalogue, pins, run };
}

function exited(result) {
  assert.ifError(result.error); // In particular, fail on the hard subprocess timeout.
  assert.equal(result.signal, null);
}

test("catalogue refresh uses compiled bounds and accepts a valid catalogue above the default 2 MiB", async (t) => {
  const f = await fixture(t);
  const original = await f.pins();
  for (const tail of ["", "x".repeat(2 * 1024 * 1024)]) {
    await writeFile(join(f.directory, "components.html"), f.catalogue(tail));
    const result = f.run();
    exited(result);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /verified: sha256 47ca302aea65ed7a47002b6c312f978471aa681f923c10878bc7b2782210d2a8/u);
  }
  assert.deepEqual(await f.pins(), original);
});

test("catalogue refresh rejects adversarial input within a hard timeout without writing pins", async (t) => {
  const f = await fixture(t);
  const original = await f.pins();
  const attributes = (count) => Array.from({ length: count }, (_, index) => ` a${index}="x"`).join("");
  /** @type {[string, string | Buffer, RegExp][]} */
  const cases = [
    ["40k attributes", f.catalogue(`<div${attributes(40_000)}></div>`), /incomplete: attributes_per_tag/u],
    [
      "80k attributes after comment recovery",
      f.catalogue(`<!--><div${attributes(80_000)}></div>`),
      /incomplete: attributes_per_tag/u,
    ],
    ["deep tree", f.catalogue("<div>".repeat(600)), /incomplete: depth/u],
    ["wide tree", f.catalogue("<i></i>".repeat(100_001)), /incomplete: node_count/u],
    ["tree work", f.catalogue(`${"<div>".repeat(400)}${"<i></i>".repeat(6_000)}`), /incomplete: tree_work/u],
    ["diagnostics", f.catalogue('<p a="1" a="2"></p>'.repeat(40_000)), /incomplete: parser_errors/u],
    ["token size", f.catalogue(`<div a="${"x".repeat(65_536)}"></div>`), /incomplete: tag_size/u],
    ["parse error", f.catalogue('<p a="1" a="2"></p>'), /parse errors: HTML_DUPLICATE_ATTRIBUTE/u],
    ["bytes", Buffer.alloc(maxBytes + 1, 0xff), /exceeds the 4194304-byte limit/u],
    ["strict UTF-8", Buffer.from([0xff]), /encoded data was not valid/u],
  ];
  for (const [name, content, error] of cases) {
    await t.test(name, async () => {
      await writeFile(join(f.directory, "components.html"), content);
      const result = f.run("--refresh");
      exited(result);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, error);
      assert.ok(result.stderr.length < 16_384, "diagnostic output must remain bounded");
      assert.deepEqual(await f.pins(), original, "rejected input must not change any pin");
    });
  }
});

test("catalogue mode fails actionably before build while standalone starter needs no compiled helper", async (t) => {
  const f = await fixture(t, false);
  const original = await f.pins();
  await writeFile(join(f.directory, "components.html"), f.catalogue());
  const catalogue = f.run("--refresh");
  exited(catalogue);
  assert.notEqual(catalogue.status, 0);
  assert.match(catalogue.stderr, /compiled bounded HTML helper; run npm run build first/u);
  assert.deepEqual(await f.pins(), original);
  const starter = f.run("--check", "--starter");
  exited(starter);
  assert.equal(starter.status, 0, starter.stderr);

  // Absent input files and helper must not mask mutable-revision rejection.
  await rm(join(f.directory, "src/nodel/v2/contract.json"));
  await rm(join(f.directory, "components.html"));
  for (const mode of ["--check", "--refresh"]) {
    const invalid = f.run(mode, "--catalogue", "main");
    exited(invalid);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /immutable 40-character Git commit SHA/u);
    assert.doesNotMatch(invalid.stderr, /ENOENT|run npm run build/u);
  }
});
