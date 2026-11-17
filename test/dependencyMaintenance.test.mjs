import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import yaml from "js-yaml";

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
