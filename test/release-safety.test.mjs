import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertSafeArchiveMember,
  assertSafeRelative,
  collectRegularFiles,
  parseArchiveMembers,
} from "../scripts/release-safety.mjs";

test("release safety rejects unsafe relative paths", () => {
  assert.equal(assertSafeRelative("dist/index.js"), "dist/index.js");
  assert.throws(() => {
    assertSafeRelative("../etc/passwd");
  }, /Unsafe path/);
  assert.throws(() => {
    assertSafeRelative("dist/../index.js");
  }, /Unsafe path/);
  assert.throws(() => {
    assertSafeRelative("/tmp/build");
  }, /Unsafe path/);
  assert.throws(() => {
    assertSafeRelative("C:/tmp/build");
  }, /Unsafe path/);
});

test("release archive members reject absolute, traversal, and forbidden entries", () => {
  assert.deepEqual(parseArchiveMembers("app/index.js\nreports/sbom.json\n"), ["app/index.js", "reports/sbom.json"]);
  assert.throws(() => {
    parseArchiveMembers("../etc/passwd\n");
  }, /Unsafe archive member/);
  assert.throws(() => {
    parseArchiveMembers("/etc/passwd\n");
  }, /Unsafe archive member/);
  assert.throws(() => {
    parseArchiveMembers("src/main.js\n");
  }, /Forbidden archive member/);
  assert.throws(() => {
    parseArchiveMembers("a/../../b\n");
  }, /Unsafe archive member/);
  assert.throws(() => {
    assertSafeArchiveMember("test/../a");
  }, /Unsafe archive member/);
});

test("release safety rejects symlink staging members", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodel-release-safety-"));
  try {
    const safeDir = join(root, "safe");
    await mkdir(safeDir);
    await writeFile(join(safeDir, "ok.txt"), "ready\n");
    await symlink(join(root, "target.txt"), join(safeDir, "bad-link"));
    await assert.rejects(
      () => collectRegularFiles(root),
      (error) => {
        assert.match(String(error), /Symlink is not allowed in staging:\s*safe\/bad-link/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release staging traversal uses UTF-8 byte ordering", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodel-release-order-"));
  try {
    await writeFile(join(root, "z"), "z\n");
    await writeFile(join(root, "a"), "a\n");
    await writeFile(join(root, "Z"), "Z\n");
    await writeFile(join(root, "ä"), "umlaut\n");
    assert.deepEqual(await collectRegularFiles(root), ["Z", "a", "z", "ä"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
