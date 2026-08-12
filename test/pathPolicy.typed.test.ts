import assert from "node:assert/strict";
import test from "node:test";
import { assertSafePublicRecipePath, assertSafeRecipePath, contentAssetPathWarning } from "../src/nodel/pathPolicy.js";

void test("assertSafeRecipePath accepts relative POSIX recipe paths", () => {
  assert.equal(assertSafeRecipePath("script.py"), "script.py");
  assert.equal(assertSafeRecipePath("config/settings.json"), "config/settings.json");
  assert.equal(assertSafeRecipePath("assets/page.html"), "assets/page.html");
});

void test("assertSafeRecipePath rejects traversal and non-relative paths", () => {
  for (const path of [
    "",
    " script.py",
    "script.py ",
    "/script.py",
    "../script.py",
    "config/../script.py",
    "config//x.json",
    "./script.py",
    "C:/temp/script.py",
    "config\\x.json",
    "script.py?x=1",
    "script.py#hash",
    "bad\u0000path.py",
  ]) {
    assert.throws(() => assertSafeRecipePath(path), /Recipe path/u, path);
  }
});

void test("assertSafePublicRecipePath trims outer slashes before validation", () => {
  assert.equal(assertSafeRecipePath("content/index.xml"), "content/index.xml");
  assert.equal(assertSafePublicRecipePath("/Example/script.py/"), "Example/script.py");
  assert.equal(assertSafePublicRecipePath("/Example Recipe/script.py/"), "Example Recipe/script.py");
  assert.throws(() => assertSafePublicRecipePath("/../script.py"), /Recipe path/u);
});

void test("contentAssetPathWarning warns for UI assets outside content", () => {
  assert.match(contentAssetPathWarning("index.html") ?? "", /outside content\//u);
  assert.match(contentAssetPathWarning("assets/app.css") ?? "", /content\/assets\/app\.css/u);
  assert.match(contentAssetPathWarning("assets/logo.png") ?? "", /content\/assets\/logo\.png/u);
});

void test("contentAssetPathWarning skips content and non-UI paths", () => {
  assert.equal(contentAssetPathWarning("content/index.html"), undefined);
  assert.equal(contentAssetPathWarning("script.py"), undefined);
  assert.equal(contentAssetPathWarning("config/settings.json"), undefined);
});
