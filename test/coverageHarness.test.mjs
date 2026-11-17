import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fileMetrics, reportMetrics } from "../scripts/coverage-metrics.mjs";
import { assertCanonicalCoverage, load, resolve } from "../scripts/coverage-loader.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const c8 = path.join(root, "node_modules/c8/bin/c8.js");
const loader = path.join(root, "scripts/coverage-register.mjs");
const nodeArgs = ["--import", loader];
const source = path.join(root, "src/nodel/client.ts");
const environment = { ...process.env };
// Nested sentinel runs must not pollute the outer suite's raw coverage.
delete environment.NODE_V8_COVERAGE;

test("mixed JS/TS coverage does not credit import-only methods or response branches", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "nodel-coverage-"));
  try {
    await writeFile(path.join(temporary, "package.json"), '{"type":"module"}\n');
    const compiled = pathToFileURL(path.join(root, "dist/nodel/client.js")).href;
    const typed = pathToFileURL(source).href;
    const sourceLines = (await readFile(source, "utf8")).split("\n");
    const responseLines = ["text", "bytes", "empty"].map((mode) => {
      const line = sourceLines.findIndex((text) => text.includes(`if (options.responseMode === "${mode}")`)) + 1;
      assert.ok(line > 0, `${mode} response branch must exist in the source`);
      return line;
    });
    const config = pathToFileURL(path.join(root, "dist/config.js")).href;
    const probe = path.join(temporary, "json.mjs");
    const importOnly = path.join(temporary, "import-only.ts");
    await writeFile(
      probe,
      `import { NodelClient } from ${JSON.stringify(compiled)};
import { createTestConfig } from ${JSON.stringify(config)};
globalThis.fetch = async () => new Response('{"ok":true}');
await new NodelClient(createTestConfig()).runtimeRequest('sentinel');\n`,
    );
    await writeFile(importOnly, `import ${JSON.stringify(typed)};\n`);
    const reportDir = path.join(temporary, "report");
    const args = [
      c8,
      "--reporter=json",
      "--all",
      "--include=src/**",
      "--exclude-after-remap",
      "--exclude=dist/**",
      `--reports-dir=${reportDir}`,
      `--temp-directory=${path.join(temporary, "raw")}`,
    ];
    const run = (extra) =>
      execFileSync(process.execPath, [...args, ...extra], { cwd: root, env: environment, stdio: "pipe" });
    run([process.execPath, ...nodeArgs, probe]);
    const baseline = JSON.parse(await readFile(path.join(reportDir, "coverage-final.json"), "utf8"))[source];
    run(["--clean=false", process.execPath, ...nodeArgs, importOnly]);
    const mixed = JSON.parse(await readFile(path.join(reportDir, "coverage-final.json"), "utf8"))[source];
    const rawScripts = (
      await Promise.all(
        (await readdir(path.join(temporary, "raw")))
          .filter((file) => file.endsWith(".json"))
          .map(async (file) => {
            const raw = JSON.parse(await readFile(path.join(temporary, "raw", file), "utf8"));
            assertCanonicalCoverage(raw.result);
            return raw.result.filter((entry) => entry.url.includes("/nodel/client.")).map((entry) => entry.url);
          }),
      )
    ).flat();
    assert.deepEqual([...new Set(rawScripts)], [compiled], "both workers must execute the same compiled URL");
    const branchesAt = (entry, line) =>
      Object.entries(entry.branchMap)
        .filter(([, branch]) => branch.loc.start.line === line)
        .flatMap(([id]) => entry.b[id]);
    for (const line of responseLines) {
      assert.deepEqual(branchesAt(baseline, line), [0], `JSON-only baseline at source line ${line}`);
      assert.deepEqual(branchesAt(mixed, line), [0], `import-only TS must not cover source line ${line}`);
    }
    const functionHits = (entry, name) => {
      const id = Object.keys(entry.fnMap).find((key) => entry.fnMap[key].name === name);
      assert.notEqual(id, undefined, `${name} must be measured`);
      return entry.f[id];
    };
    assert.equal(functionHits(baseline, "getToolkit"), 0);
    assert.equal(functionHits(mixed, "getToolkit"), 0);
    assert.equal(functionHits(mixed, "runtimeRequest"), 1, "importing must not increment method hits");

    const typedCalls = path.join(temporary, "typed-calls.ts");
    await writeFile(
      typedCalls,
      `import assert from 'node:assert/strict';
import { NodelClient } from ${JSON.stringify(typed)};
import { NodelClient as BuiltClient } from ${JSON.stringify(compiled)};
import { createTestConfig } from ${JSON.stringify(config)};
assert.equal(NodelClient, BuiltClient);
const client: NodelClient = new NodelClient(createTestConfig());
globalThis.fetch = async () => new Response('hello');
assert.equal(await client.runtimeRequest('text', { responseMode: 'text' }), 'hello');
assert.deepEqual(await client.runtimeRequest('bytes', { responseMode: 'bytes' }), new TextEncoder().encode('hello'));
assert.equal(await client.runtimeRequest('empty', { responseMode: 'empty' }), undefined);\n`,
    );
    run(["--clean=false", process.execPath, ...nodeArgs, typedCalls]);
    const jsCalls = path.join(temporary, "js-calls.mjs");
    await writeFile(
      jsCalls,
      `import assert from 'node:assert/strict';
import { NodelClient } from ${JSON.stringify(compiled)};
import { createTestConfig } from ${JSON.stringify(config)};
globalThis.fetch = async () => new Response('from JS');
assert.equal(await new NodelClient(createTestConfig()).runtimeRequest('text', { responseMode: 'text' }), 'from JS');\n`,
    );
    run(["--clean=false", process.execPath, ...nodeArgs, jsCalls]);
    const called = JSON.parse(await readFile(path.join(reportDir, "coverage-final.json"), "utf8"));
    for (const line of responseLines) {
      assert.ok(
        branchesAt(called[source], line).some((hits) => hits > 0),
        `real call covers source line ${line}`,
      );
    }
    assert.equal(functionHits(called[source], "runtimeRequest"), 5, "real JS and TS method calls accumulate");
    assert.equal(functionHits(called[source], "getToolkit"), 0, "uncalled methods remain uncovered");
    const uncovered = called[path.join(root, "src/index.ts")];
    assert.ok(uncovered, "--all must retain unimported production sources");
    assert.ok(Object.values(uncovered.s).length > 0);
    assert.ok(Object.values(uncovered.s).every((hits) => hits === 0));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

function coverageEntry(hits = [1, 1], branches = [1, 1]) {
  return {
    statementMap: Object.fromEntries(
      hits.map((_, id) => [id, { start: { line: id + 1, column: 0 }, end: { line: id + 1, column: 10 } }]),
    ),
    s: Object.fromEntries(hits.map((hit, id) => [id, hit])),
    b: /** @type {Record<string, number[]>} */ ({ 0: branches }),
    f: /** @type {Record<string, number>} */ ({ 0: 1 }),
  };
}

test("Istanbul metrics flatten branch arms and derive unique lines from statement locations", () => {
  const entry = coverageEntry([0, 1, 0], [1, 0, 1]);
  entry.statementMap[1].start.line = 1;
  assert.deepEqual(fileMetrics(entry), {
    lines: { covered: 1, total: 2 },
    statements: { covered: 1, total: 3 },
    branches: { covered: 2, total: 3 },
    functions: { covered: 1, total: 1 },
  });
  assert.deepEqual(reportMetrics({ a: entry, b: coverageEntry() }).branches, { covered: 4, total: 5 });
  assert.throws(() => fileMetrics({ s: {}, b: {}, f: {} }), /Incomplete/u);
  assert.throws(() => fileMetrics(coverageEntry([Number.NaN])), /Invalid/u);
});

test("coverage loader maps only in-repository source imports and fails closed on gaps", async () => {
  const context = { parentURL: pathToFileURL(path.join(root, "test/example.test.ts")).href };
  const compiled = pathToFileURL(path.join(root, "dist/nodel/client.js")).href;
  const next = async (url) => ({ url });
  for (const specifier of ["../src/nodel/client.js", "../src/nodel/client.ts", pathToFileURL(source).href]) {
    assert.deepEqual(await resolve(specifier, context, next), { url: compiled });
  }
  assert.deepEqual(await resolve("./fixtures/config.js", context, next), { url: "./fixtures/config.js" });
  assert.deepEqual(await resolve("node:fs", context, next), { url: "node:fs" });
  await assert.rejects(() => resolve("../src/nodel/client.ts?other", context, next), /canonical/u);
  await assert.rejects(() => resolve("../src/nodel/types.d.ts", context, next), /declaration/u);
  await assert.rejects(() => load(pathToFileURL(source).href, {}, next), /cannot execute/u);
  await assert.rejects(
    () =>
      resolve("../src/missing.ts", context, async () => {
        throw new Error("Compiled module missing");
      }),
    /Compiled module missing/u,
  );
  assert.throws(() => assertCanonicalCoverage([{ url: pathToFileURL(source).href }]), /Noncanonical/u);
  assert.throws(() => assertCanonicalCoverage([{ url: `${compiled}?duplicate` }]), /Noncanonical/u);
  assert.doesNotThrow(() => assertCanonicalCoverage([{ url: compiled }, { url: "node:fs" }]));
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          ...nodeArgs,
          "--input-type=module",
          "--eval",
          `await import(${JSON.stringify(new URL("../src/__coverage_missing__.ts", context.parentURL).href)})`,
        ],
        { cwd: root, env: environment, stdio: "pipe" },
      ),
    (error) => /** @type {{ stderr: Buffer }} */ (error).stderr.toString().includes("dist/__coverage_missing__.js"),
    "a missing compiled target must fail, not fall back to source",
  );
});

test("coverage gates reject real line/branch deficits and unmeasured reports", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "nodel-coverage-metrics-"));
  try {
    const targets = [
      "src/config.ts",
      "src/nodel/client.ts",
      "src/nodel/resolution/resolver.ts",
      "src/state/approvals.ts",
      "src/state/store.ts",
      "src/domain/config/writes.ts",
      "src/domain/bindings/writes.ts",
      "src/domain/recipes/service.ts",
      "src/nodel/pathPolicy.ts",
      "src/mcp/server.ts",
    ];
    const reportPath = path.join(temporary, "coverage.json");
    const run = async (report) => {
      await writeFile(reportPath, JSON.stringify(report));
      try {
        execFileSync(process.execPath, [path.join(root, "scripts/check-coverage.mjs"), reportPath], {
          env: environment,
          stdio: "pipe",
        });
        return { status: 0, stderr: "" };
      } catch (error) {
        return { status: error.status, stderr: error.stderr.toString() };
      }
    };
    const report = Object.fromEntries(targets.map((file) => [file, coverageEntry()]));
    assert.equal((await run(report)).status, 0, "fully covered multi-arm branches pass");
    report[targets[0]].b = { 0: [1, 0], 1: [0, 0] };
    let result = await run(report);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /src\/config.ts: 25.0% branches, required 80%/u);
    for (const file of targets) report[file] = coverageEntry([1, 1, 1, 1, 0, 0], [1, 1]);
    result = await run(report);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /global lines: 66.7%, required 80%/u);
    assert.match(result.stderr, /global statements: 66.7%, required 80%/u);
    for (const file of targets) report[file] = coverageEntry([1], [1, 0]);
    result = await run(report);
    assert.match(result.stderr, /global branches: 50.0%, required 78%/u);
    for (const file of targets) {
      report[file] = coverageEntry();
      report[file].f = { 0: 0 };
    }
    result = await run(report);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /global functions: 0.0%, required 85%/u);
    for (const file of targets) report[file] = { statementMap: {}, s: {}, b: {}, f: {} };
    result = await run(report);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /global lines: not measured/u);
    assert.match(result.stderr, /global branches: not measured/u);
    assert.equal((await run({})).status, 1, "an empty report must not auto-pass");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
