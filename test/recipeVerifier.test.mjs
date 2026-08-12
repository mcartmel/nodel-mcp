import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRecipeVerification, verifyRecipeCompliance } from "../dist/nodel/recipeVerifier.js";

test("verifyRecipeCompliance accepts Python 2.5 style recipe code", () => {
  const result = verifyRecipeCompliance(
    "script.py",
    [
      "from __future__ import with_statement",
      "import json, math",
      "from java.util import Date",
      "",
      "def main():",
      "    try:",
      "        console.info('started %s' % NAME)",
      "    except ValueError, e:",
      "        console.warn('bad value: %s' % e)",
      "",
    ].join("\n"),
  );

  assert.equal(result.ok, true);
  assert.equal(result.checked, true);
  assert.deepEqual(result.issues, []);
});

test("verifyRecipeCompliance warns for discouraged and unknown imports", () => {
  const result = verifyRecipeCompliance(
    "script.py",
    [
      "import time",
      "import socket as raw_socket",
      "from local_helpers import parse_value",
      "",
      "def main():",
      "    return time.time()",
      "",
    ].join("\n"),
  );

  assert.equal(result.ok, true);
  assert.ok(result.issues.every((issue) => issue.severity === "warning"));
  assert.ok(result.issues.some((issue) => issue.code === "RECIPE_IMPORT_DISCOURAGED" && /time/u.test(issue.message)));
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.code === "RECIPE_IMPORT_DISCOURAGED" && /Use Nodel TCP\(\) or UDP\(\) helpers/u.test(issue.message),
    ),
  );
  assert.ok(
    result.issues.some((issue) => issue.code === "RECIPE_IMPORT_UNKNOWN" && /local_helpers/u.test(issue.message)),
  );
});

test("verifyRecipeCompliance rejects blocked imports", () => {
  const result = verifyRecipeCompliance(
    "script.py",
    [
      "import asyncio",
      "from concurrent import futures",
      "from pathlib import Path",
      "",
      "def main():",
      "    return None",
      "",
    ].join("\n"),
  );

  const blocked = result.issues.filter((issue) => issue.code === "RECIPE_IMPORT_BLOCKED");
  assert.equal(result.ok, false);
  assert.equal(blocked.length, 3);
});

test("verifyRecipeCompliance rejects blocked calls through aliases", () => {
  const result = verifyRecipeCompliance(
    "script.py",
    [
      "import time as clock",
      "import subprocess as sp",
      "from time import sleep",
      "from java.lang import Runtime",
      "from java.util import Timer",
      "",
      "def main():",
      "    clock.sleep(1)",
      "    sleep(1)",
      "    sp.Popen(['echo', 'x'])",
      "    Runtime.getRuntime()",
      "    Timer()",
      "",
    ].join("\n"),
  );

  const blockedCalls = result.issues.filter((issue) => issue.code === "RECIPE_CALL_BLOCKED");
  assert.equal(result.ok, false);
  assert.equal(blockedCalls.length, 5);
  assert.ok(blockedCalls.some((issue) => /clock\.sleep resolves to time\.sleep/u.test(issue.message)));
  assert.ok(blockedCalls.some((issue) => /Use Nodel quick_process\(\) for short-lived commands/u.test(issue.message)));
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "RECIPE_IMPORT_DISCOURAGED" && /java\.util\.Timer/u.test(issue.message),
    ),
  );
});

test("verifyRecipeCompliance rejects common Python 3 syntax", () => {
  const result = verifyRecipeCompliance(
    "script.py",
    [
      "def greet(name: str) -> str:",
      "    return f'hello {name}'",
      "",
      "async def poll():",
      "    await fetch()",
      "",
      "try:",
      "    raise ValueError('bad') from None",
      "except ValueError as error:",
      "    print(error)",
      "",
      "values = {item for item in items}",
      "count: int = 0",
      "",
    ].join("\n"),
  );

  const codes = result.issues.map((issue) => issue.code);
  assert.equal(result.ok, false);
  assert.match(summarizeRecipeVerification(result), /PY25_FUNCTION_ANNOTATION/u);
  assert.ok(codes.includes("PY25_F_STRING"));
  assert.ok(codes.includes("PY25_ASYNC"));
  assert.ok(codes.includes("PY25_AWAIT"));
  assert.ok(codes.includes("PY25_RAISE_FROM"));
  assert.ok(codes.includes("PY25_EXCEPT_AS"));
  assert.ok(codes.includes("PY25_DICT_SET_COMPREHENSION"));
  assert.ok(codes.includes("PY25_VARIABLE_ANNOTATION"));
});

test("verifyRecipeCompliance does not confuse Python 2 dictionaries or lambdas with annotations", () => {
  const result = verifyRecipeCompliance(
    "script.py",
    [
      "CONFIG = { ADAM_6060: { 'coils':",
      "                         [ {'startAddr': 0, 'count': 6} ],",
      "                       'registers': []",
      "                     }}",
      "queue.request(lambda: udp.send('?V\\r'),",
      "              lambda resp: local_event_FirmwareVersion.emit(resp))",
      "",
    ].join("\n"),
  );

  assert.equal(result.ok, true);
  assert.equal(
    result.issues.some((issue) => issue.code === "PY25_VARIABLE_ANNOTATION"),
    false,
  );
});

test("verifyRecipeCompliance allows Python 2.5 list comprehensions inside dict literals", () => {
  const result = verifyRecipeCompliance(
    "script.py",
    [
      "INPUTSEL_LOOKUP = [('0', 'Analog'), ('1', 'Digital')]",
      "INPUTSEL_SCHEMA = {'type': 'string', 'enum': [y for x, y in INPUTSEL_LOOKUP]}",
      "",
    ].join("\n"),
  );

  assert.equal(result.ok, true);
  assert.equal(
    result.issues.some((issue) => issue.code === "PY25_DICT_SET_COMPREHENSION"),
    false,
  );
});

test("verifyRecipeCompliance requires with_statement future import for with statements", () => {
  const withoutFuture = verifyRecipeCompliance(
    "script.py",
    "def main():\n    with open('x') as handle:\n        return handle.read()\n",
  );
  const withFuture = verifyRecipeCompliance(
    "script.py",
    "from __future__ import with_statement\n\ndef main():\n    with open('x') as handle:\n        return handle.read()\n",
  );
  const misplacedFuture = verifyRecipeCompliance(
    "script.py",
    "NAME = 'demo'\nfrom __future__ import with_statement\n\ndef main():\n    with open('x') as handle:\n        return handle.read()\n",
  );

  assert.equal(withoutFuture.ok, false);
  assert.ok(withoutFuture.issues.some((issue) => issue.code === "PY25_WITH_FUTURE"));
  assert.equal(withFuture.ok, true);
  assert.equal(misplacedFuture.ok, false);
  assert.ok(misplacedFuture.issues.some((issue) => issue.code === "PY25_FUTURE_IMPORT_ORDER"));
});

test("verifyRecipeCompliance skips non-Python files", () => {
  const result = verifyRecipeCompliance("config.json", '{"ok": true}\n');

  assert.equal(result.ok, true);
  assert.equal(result.checked, false);
  assert.equal(result.issues.length, 0);
});
