import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function run(script) {
  try {
    execFileSync(process.execPath, [script], { encoding: "utf8", stdio: "pipe" });
    return { status: 0, output: "" };
  } catch (error) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test("candidate scanners include untracked files and honor git ignored paths", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const secretPath = `candidate-secret-${suffix}.txt`;
  const ignoredPath = join("node_modules", `candidate-secret-${suffix}.txt`);
  const documentPath = join("docs", `candidate-link-${suffix}.md`);
  try {
    mkdirSync("node_modules", { recursive: true });
    writeFileSync(ignoredPath, `AKIA${"A".repeat(16)}\n`, "utf8");
    assert.equal(run("scripts/secret-check.mjs").status, 0);

    writeFileSync(secretPath, `AKIA${"A".repeat(16)}\n`, "utf8");
    const secret = run("scripts/secret-check.mjs");
    assert.equal(secret.status, 1);
    assert.match(secret.output, new RegExp(secretPath, "u"));
    rmSync(secretPath, { force: true });

    writeFileSync(documentPath, "[broken](missing-candidate-target.md)\n", "utf8");
    const docs = run("scripts/check-docs-links.mjs");
    assert.equal(docs.status, 1);
    assert.match(docs.output, new RegExp(documentPath, "u"));
  } finally {
    rmSync(secretPath, { force: true });
    rmSync(ignoredPath, { force: true });
    rmSync(documentPath, { force: true });
  }
});

test("candidate scanner commands retain standard git ignore filtering", () => {
  for (const script of ["scripts/secret-check.mjs", "scripts/check-docs-links.mjs"]) {
    const source = readFileSync(script, "utf8");
    assert.match(source, /git", \["ls-files", "--cached", "--others", "--exclude-standard", "-z"\]/u);
  }
});
