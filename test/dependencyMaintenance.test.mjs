import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import yaml from "js-yaml";

const require = createRequire(import.meta.url);

test("production dependency pins match the lock and license evidence", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  const report = JSON.parse(await readFile("reports/dependency-licenses.json", "utf8"));
  const lockedRoot = lock.packages[""];

  for (const name of ["@modelcontextprotocol/sdk", "express", "zod"]) {
    assert.equal(lockedRoot.dependencies[name], packageJson.dependencies[name], `${name} lock pin`);
    assert.equal(
      lock.packages[`node_modules/${name}`].version,
      packageJson.dependencies[name],
      `${name} resolved version`,
    );
  }

  assert.equal(
    report.lockfileSha256,
    createHash("sha256")
      .update(await readFile("package-lock.json"))
      .digest("hex"),
    "license report must be regenerated from the exact lockfile",
  );
});

test("tooling pins and compatible coverage overrides match the lock", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  const lockedRoot = lock.packages[""];

  for (const [name, version] of Object.entries({
    "@eslint/js": "10.0.1",
    "@types/node": "22.20.5",
    c8: "12.0.0",
    eslint: "10.15.0",
    tsx: "4.23.15",
  })) {
    assert.equal(packageJson.devDependencies[name], version, `${name} package pin`);
    assert.equal(lockedRoot.devDependencies[name], version, `${name} lock pin`);
    assert.equal(lock.packages[`node_modules/${name}`].version, version, `${name} resolved version`);
  }

  assert.deepEqual(packageJson.overrides, {
    "test-exclude": { glob: "14.0.6", minimatch: "11.0.9" },
  });
  assert.equal(lock.packages["node_modules/test-exclude/node_modules/glob"].version, "14.0.6");
  assert.equal(lock.packages["node_modules/test-exclude/node_modules/minimatch"].version, "11.0.9");
});

test("c8 test-exclude globs keep include, exclude, and node_modules behavior", () => {
  const TestExclude = require("test-exclude");
  const exclude = new TestExclude({
    cwd: process.cwd(),
    include: ["src/**/*.ts"],
    exclude: ["src/**/*.d.ts", "src/nodel/v1UiCatalog/**"],
    extension: [".ts"],
    excludeNodeModules: true,
  });

  assert.equal(exclude.shouldInstrument("src/index.ts"), true);
  assert.equal(exclude.shouldInstrument("src/nodel/v1UiCatalog/index.ts"), false);
  assert.equal(exclude.shouldInstrument("src/index.d.ts"), false);
  assert.equal(exclude.shouldInstrument("node_modules/example/index.ts"), false);
  const files = exclude.globSync();
  assert.ok(files.includes("src/index.ts"));
  assert.ok(files.every((file) => !file.startsWith("src/nodel/v1UiCatalog/")));
  assert.ok(files.every((file) => !file.endsWith(".d.ts")));
});

async function dependabotConfig(overrides = {}) {
  const source = await readFile(".github/dependabot.yml", "utf8");
  const config = yaml.load(source);
  const npm = config.updates.find((entry) => entry["package-ecosystem"] === "npm");
  const actions = config.updates.find((entry) => entry["package-ecosystem"] === "github-actions");

  Object.assign(npm.groups["production-security-updates"], overrides.securityGroup);
  Object.assign(npm.groups["eslint-toolchain"], overrides.eslintGroup);
  if (overrides.actionsGroup) Object.assign(actions.groups["github-actions"], overrides.actionsGroup);
  if (overrides.ignore) npm.ignore = overrides.ignore;

  return { npm, actions };
}

function assertDependabotGroups({ npm, actions }) {
  assert.deepEqual(npm.groups["production-security-updates"], {
    "applies-to": "security-updates",
    "dependency-type": "production",
    patterns: ["*"],
  });
  assert.deepEqual(npm.groups["eslint-toolchain"], {
    "applies-to": "version-updates",
    patterns: ["@eslint/js", "@typescript-eslint/*", "eslint", "typescript-eslint"],
  });
  assert.deepEqual(actions.groups["github-actions"], {
    "applies-to": "version-updates",
    patterns: ["*"],
  });
  assert.deepEqual(npm.ignore, [
    {
      "dependency-name": "typescript",
      versions: ["7.x"],
      "update-types": ["version-update:semver-major"],
    },
  ]);
}

test("Dependabot groups security updates without unpairing toolchains", async () => {
  assertDependabotGroups(await dependabotConfig());
});

test("Dependabot assertions reject a fabricated package pattern", async () => {
  const config = await dependabotConfig({
    securityGroup: { patterns: ["not-a-real-package"] },
  });

  assert.throws(() => assertDependabotGroups(config), assert.AssertionError);
});

test("Dependabot assertions reject an incomplete ESLint family", async () => {
  const config = await dependabotConfig({
    eslintGroup: { patterns: ["@typescript-eslint/*", "eslint", "typescript-eslint"] },
  });

  assert.throws(() => assertDependabotGroups(config), assert.AssertionError);
});

test("Dependabot assertions reject blanket ignores", async () => {
  const config = await dependabotConfig({
    ignore: [{ "dependency-name": "*", versions: [">=0"] }],
  });

  assert.throws(() => assertDependabotGroups(config), assert.AssertionError);
});

test("workflow actions use the approved immutable action commits", async () => {
  const expected = new Map([
    ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
    ["actions/setup-node", "949feb2413d6458794dcd2491c4babbbce0c15c1"],
    ["actions/setup-java", "d1374f8ac74474200d16ef8ecee22c7ae7a51880"],
    ["gitleaks/gitleaks-action", "e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e"],
    ["github/codeql-action/init", "33d7b85da1a04171e211befe2c739303b9a4c066"],
    ["github/codeql-action/analyze", "33d7b85da1a04171e211befe2c739303b9a4c066"],
    ["actions/upload-artifact", "ea165f8d65b6e75b540449e92b4886f43607fa02"],
    ["actions/attest-build-provenance", "e8998f949152b193b063cb0ec769d69d929409be"],
  ]);
  const workflowPaths = [
    ".github/workflows/ci.yml",
    ".github/workflows/compatibility.yml",
    ".github/workflows/release.yml",
    ".github/workflows/secret-scan.yml",
    ".github/workflows/codeql.yml",
  ];
  const actionsByWorkflow = new Map();

  for (const path of workflowPaths) {
    const workflow = yaml.load(await readFile(path, "utf8"));
    const actions = [];
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses) {
          const separator = step.uses.lastIndexOf("@");
          const name = step.uses.slice(0, separator);
          const pin = step.uses.slice(separator + 1);
          assert.match(pin, /^[0-9a-f]{40}$/u, `${path}: ${step.uses} must use an immutable commit`);
          assert.equal(pin, expected.get(name), `${path}: unexpected action pin for ${name}`);
          actions.push(name);
        }
      }
    }
    actionsByWorkflow.set(path, actions);
  }

  assert.deepEqual(actionsByWorkflow.get(".github/workflows/codeql.yml"), [
    "actions/checkout",
    "github/codeql-action/init",
    "github/codeql-action/analyze",
  ]);
  assert.equal(expected.get("github/codeql-action/init"), expected.get("github/codeql-action/analyze"));
});
