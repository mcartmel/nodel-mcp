import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderUnit } from "../scripts/systemd-render.mjs";
import { cyclonedxComponents, packageNameFromLockPath } from "../scripts/sbom.mjs";
import { validateProductionLicenses } from "../scripts/license-policy.mjs";
import { releaseMode } from "../scripts/release-modes.mjs";
import { assertCaddyReleaseMembers } from "../scripts/caddy-release-safety.mjs";
import { compareUtf8 } from "../scripts/public-candidate-policy.mjs";
import { markFailure } from "../scripts/check-shell-systemd.mjs";

test("systemd renderer preserves shell-special path characters", () => {
  const rendered = renderUnit("WorkingDirectory=__INSTALL_DIR__\n", { INSTALL_DIR: '/tmp/space dir/#&%\\path;"' });
  assert.equal(rendered, "WorkingDirectory=/tmp/space\\x20dir/\\x23\\x26%%\\x5cpath\\x3b\\x22\n");
});

test("systemd stop timeout exceeds the default bounded shutdown", async () => {
  const [user, system] = await Promise.all([
    readFile(new URL("../systemd/nodel-ai.service", import.meta.url), "utf8"),
    readFile(new URL("../systemd/nodel-ai.system.service.in", import.meta.url), "utf8"),
  ]);
  for (const unit of [user, system]) assert.match(unit, /TimeoutStopSec=15s/u);
});

test("SBOM resolves final nested package names and deduplicates purls", () => {
  assert.equal(packageNameFromLockPath("node_modules/outer/node_modules/inner"), "inner");
  assert.equal(packageNameFromLockPath("node_modules/a/node_modules/@scope/pkg"), "@scope/pkg");
  const components = cyclonedxComponents({
    "node_modules/outer/node_modules/inner": { version: "1.0.0" },
    "node_modules/another/node_modules/inner": { version: "1.0.0" },
    "node_modules/a/node_modules/@scope/pkg": { version: "2.0.0", license: "MIT" },
  });
  assert.deepEqual(
    components.map(({ purl }) => purl),
    ["pkg:npm/%40scope/pkg@2.0.0", "pkg:npm/inner@1.0.0"],
  );
  assert.ok(components.every((component) => component.type === "library" && component.version && component.purl));
});

test("production license policy rejects unknown licenses without complete review", () => {
  assert.throws(() => validateProductionLicenses({ "bad@1.0.0": { licenses: "UNKNOWN" } }), /bad@1.0.0/u);
  assert.doesNotThrow(() =>
    validateProductionLicenses({ "reviewed@1.0.0": { licenses: "UNKNOWN" } }, [
      {
        package: "reviewed@1.0.0",
        advisory: "LEGAL-1",
        rationale: "Reviewed",
        owner: "legal",
        expiry: "2099-01-01",
      },
    ]),
  );
});

test("release modes are stable across umasks", () => {
  assert.equal(releaseMode("docs", true), 0o755);
  assert.equal(releaseMode("docs/readme.txt", false), 0o644);
  assert.equal(releaseMode("scripts/install-systemd-user.sh", false), 0o755);
  assert.equal(releaseMode("scripts/install-systemd-system.sh", false), 0o755);
  assert.equal(releaseMode("scripts/caddy-render.mjs", false), 0o755);
  assert.equal(releaseMode("scripts/caddy-check.mjs", false), 0o755);
  assert.equal(releaseMode("deploy/caddy/nodel-mcp.Caddyfile.in", false), 0o644);
});

test("release packaging retains Caddy commands without packaging a validator", async () => {
  const [packageScript, packageSource, helper, smoke, releasing] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/release-package.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/fetch-caddy-validation.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/release-smoke.mjs", import.meta.url), "utf8"),
    readFile(new URL("../docs/releasing.md", import.meta.url), "utf8"),
  ]);
  const pkg = JSON.parse(packageScript);
  assert.equal(pkg.scripts["caddy:render"], "node scripts/caddy-render.mjs");
  assert.equal(pkg.scripts["caddy:check"], "node scripts/caddy-check.mjs");
  assert.match(packageSource, /"deploy\/caddy\/nodel-mcp\.Caddyfile\.in"/u);
  assert.match(packageSource, /"scripts\/caddy-render\.mjs"/u);
  assert.match(packageSource, /"scripts\/caddy-check\.mjs"/u);
  assert.doesNotMatch(packageSource, /fetch-caddy-validation/u);
  assert.match(smoke, /scripts\/caddy-render\.mjs/u);
  assert.match(smoke, /scripts\/caddy-check\.mjs/u);
  assert.match(smoke, /CADDY_REQUIRED/u);
  assert.match(helper, /releases\/download\/v\$\{CADDY_VERSION\}/u);
  assert.match(helper, /CADDY_REQUIRED=true/u);
  assert.match(releasing, /CADDY_BIN=.*CADDY_REQUIRED=true npm run release:check/u);
});

test("Caddy release allowlist rejects every generated or secret-bearing artifact", () => {
  assert.doesNotThrow(() => assertCaddyReleaseMembers(["deploy/caddy/nodel-mcp.Caddyfile.in"]));
  assert.doesNotThrow(() => assertCaddyReleaseMembers(["scripts/caddy-render.mjs", "scripts/caddy-check.mjs"]));
  for (const member of [
    "deploy/caddy/extra.conf",
    "caddy",
    "bin/caddy",
    "bin/caddy.exe",
    "tools/caddy-linux-amd64",
    "tools/caddy_validator",
    "tools/caddy-helper.sh",
    "caddy_2.11.3_linux_amd64.tar.gz",
    "archives/caddy.zip",
    "archives/caddy.rpm",
    "deploy/caddy/generated.caddy",
    "deploy/caddy/Caddyfile",
    "caddyfile",
    "Caddyfile.bak",
    "caddyfile.temp",
    "Caddyfile.save",
    "Caddyfile.TEMP",
    "Caddyfile.bak.tmp",
    "custom.CADDY",
    "cert.pem",
    "cert.key",
    "cert.crt",
    "cert.cer",
    "cert.der",
    "cert.p12",
    "cert.pfx",
    "cert.p7b",
    "keys/private-key.pem",
    "keys/id_rsa",
  ])
    assert.throws(() => assertCaddyReleaseMembers([member]));
});

test("release manifest sorting distinguishes UTF-8 non-ASCII order", () => {
  const files = ["Z", "a", "z", "\uFF5D", "\u{104B6}"];
  const defaultOrder = [...files].sort();
  const utf8Order = [...files].sort(compareUtf8);
  assert.notDeepEqual(defaultOrder, utf8Order);
  assert.deepEqual(utf8Order, ["Z", "a", "z", "\uFF5D", "\u{104B6}"]);
});

test("split catalog files carry MPL provenance notices", async () => {
  for (const file of ["document", "layout", "content", "control", "state", "builtin", "cssRecipes", "shared"])
    assert.match(
      await readFile(new URL(`../src/nodel/v1UiCatalog/${file}.ts`, import.meta.url), "utf8"),
      /SPDX-License-Identifier: MPL-2\.0[\s\S]*Derived from https:\/\/github\.com\/museumsvictoria\/nodel[\s\S]*19756071383d696682688ab436c77c0a1f80c783/u,
    );
});

test("systemd installers invoke the selected Node binary", async () => {
  const [user, system] = await Promise.all([
    readFile(fileURLToPath(new URL("../scripts/install-systemd-user.sh", import.meta.url)), "utf8"),
    readFile(fileURLToPath(new URL("../scripts/install-systemd-system.sh", import.meta.url)), "utf8"),
  ]);
  assert.match(user, /"\$NODE_BIN"\s+.*systemd-render\.mjs/su);
  assert.match(system, /"\$SELECTED_NODE_BIN"\s+.*systemd-render\.mjs/su);
});

test("systemd checker binds rendered units to active executable path", async () => {
  const checkSource = await readFile(
    fileURLToPath(new URL("../scripts/check-shell-systemd.mjs", import.meta.url)),
    "utf8",
  );
  assert.match(checkSource, /process\.execPath/u);
  assert.match(checkSource, /realpathSync\(process\.execPath\)/u);
  assert.match(checkSource, /activeNodePath/);
  assert.doesNotMatch(checkSource, /NODE_BIN:\s+"\/usr\/bin\/node"/u);
  assert.doesNotMatch(checkSource, /"\/usr\/bin\/node"/u);
});

test("check-shell-systemd preserves earliest nonzero failure", () => {
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    markFailure(13, null);
    assert.equal(process.exitCode, 13);
    markFailure(7, null);
    assert.equal(process.exitCode, 13);
    markFailure(null, "SIGKILL");
    assert.equal(process.exitCode, 13);
  } finally {
    process.exitCode = previous;
  }
});

test("installers keep root resolution via script directory", async () => {
  const [user, system] = await Promise.all([
    readFile(fileURLToPath(new URL("../scripts/install-systemd-user.sh", import.meta.url)), "utf8"),
    readFile(fileURLToPath(new URL("../scripts/install-systemd-system.sh", import.meta.url)), "utf8"),
  ]);
  assert.equal(user.includes('ROOT_DIR="$(CDPATH="" cd -- "$(dirname -- "$0")/.." && pwd)"'), true);
  assert.equal(system.includes('ROOT_DIR="$(CDPATH="" cd -- "$(dirname -- "$0")/.." && pwd)"'), true);
});

test("release workflow is SHA pinned and never publishes npm or containers", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  for (const action of workflow.matchAll(/uses:\s*([^\s@]+)@([^\s]+)/gu)) assert.match(action[2], /^[0-9a-f]{40}$/u);
  assert.doesNotMatch(workflow, /npm\s+publish|docker\s+push|build-push-action/iu);
  assert.match(workflow, /--draft/u);
  assert.match(workflow, /release:compatibility-check/u);
  assert.match(workflow, /contents:\s*write/u);
  assert.match(workflow, /shellcheck/u);
  assert.match(workflow, /release:determinism/u);
  assert.match(workflow, /fetch-caddy-validation\.mjs/u);
  for (const asset of ["SHA256SUMS", "SBOM.cdx.json", "dependency-licenses.json", "ARTIFACT-MANIFEST.json"])
    assert.match(workflow, new RegExp(asset.replaceAll(".", "\\."), "u"));
});

test("CI fetches the pinned Caddy validator and requires validation", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /fetch-caddy-validation\.mjs/u);
  assert.match(workflow, /Caddy validation/u);
  const helper = await readFile(new URL("../scripts/fetch-caddy-validation.mjs", import.meta.url), "utf8");
  assert.match(helper, /CADDY_VERSION = "2\.11\.3"/u);
  assert.match(helper, /createHash\("sha512"\)/u);
  assert.match(helper, /CADDY_BIN=/u);
  assert.match(helper, /CADDY_REQUIRED=true/u);
});

test(
  "release package can be rebuilt with the same hash",
  { skip: !process.env.RUN_RELEASE_PACKAGE_TESTS, timeout: 120_000 },
  async () => {
    const first = spawnSync("npm", ["run", "release:package"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);
    const archive = fileURLToPath(new URL("../artifacts/nodel-ai-v0.1.0.tar.gz", import.meta.url));
    const hash = async () =>
      createHash("sha256")
        .update(await readFile(archive))
        .digest("hex");
    const firstHash = await hash();
    const second = spawnSync("npm", ["run", "release:package"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await hash(), firstHash);
  },
);
