import assert from "node:assert/strict";
import test from "node:test";
import { deriveRecipeLoadOrder, verifyComposedRecipe } from "../dist/nodel/recipeComposition.js";

test("deriveRecipeLoadOrder falls back to script.py then sorted ingredient and custom files", () => {
  const result = deriveRecipeLoadOrder(
    ["custom_b.py", "ingredient_b.py", "script.py", "ingredient_a.py", "custom_a.py"],
    { candidatePath: "ingredient_0.py" },
  );

  assert.equal(result.source, "script.py");
  assert.deepEqual(result.loadOrder, [
    "script.py",
    "ingredient_0.py",
    "ingredient_a.py",
    "ingredient_b.py",
    "custom_a.py",
    "custom_b.py",
  ]);
  assert.deepEqual(result.missingFiles, []);
  assert.deepEqual(result.candidateOverride, { path: "ingredient_0.py", loaded: true });
});

test("deriveRecipeLoadOrder uses nodeConfig.json dependencies before ingredient and custom files", () => {
  const result = deriveRecipeLoadOrder(["nodeConfig.json", "script.py", "ingredient_b.py", "custom_a.py"], {
    nodeConfigJson: JSON.stringify({ dependencies: ["base.py", "script.py"] }),
  });

  assert.equal(result.source, "nodeConfig.json dependencies");
  assert.deepEqual(result.loadOrder, ["base.py", "script.py", "ingredient_b.py", "custom_a.py"]);
  assert.deepEqual(result.missingFiles, ["base.py"]);
  assert.ok(result.issues.some((issue) => issue.code === "RECIPE_LOAD_MISSING" && issue.path === "base.py"));
});

test("deriveRecipeLoadOrder respects an explicitly empty dependency list", () => {
  const result = deriveRecipeLoadOrder(["nodeConfig.json", "script.py", "custom_a.py"], {
    nodeConfigJson: JSON.stringify({ dependencies: [] }),
  });

  assert.equal(result.source, "nodeConfig.json dependencies");
  assert.deepEqual(result.loadOrder, ["custom_a.py"]);
  assert.deepEqual(result.notLoadedPythonFiles, ["script.py"]);
});

test("verifyComposedRecipe applies one candidate override as loaded recipe content", () => {
  const result = verifyComposedRecipe([{ path: "script.py", content: "NAME = 'demo'\n" }], {
    candidate: { path: "ingredient_new.py", content: "def bad(value: str):\n    return value\n" },
  });

  const candidateFile = result.perFile.find((file) => file.path === "ingredient_new.py");
  assert.equal(result.staticAnalysisOnly, true);
  assert.match(result.message, /no Jython execution/u);
  assert.deepEqual(result.loadOrder.loadOrder, ["script.py", "ingredient_new.py"]);
  assert.equal(candidateFile?.source, "candidate");
  assert.ok(
    result.issues.some((issue) => issue.code === "PY25_FUNCTION_ANNOTATION" && issue.path === "ingredient_new.py"),
  );
});

test("verifyComposedRecipe reports missing, duplicate, not-loaded, and public declaration duplicates", () => {
  const result = verifyComposedRecipe([
    { path: "nodeConfig.json", content: JSON.stringify({ dependencies: ["base.py", "base.py", "missing.py"] }) },
    { path: "base.py", content: "local_event_Status = LocalEvent({'title': 'Status'})\n" },
    {
      path: "ingredient_bad.py",
      content: "local_event_Status = LocalEvent({'title': 'Status'})\ndef bad(value: str):\n    return value\n",
    },
    { path: "helper.py", content: "def helper():\n    return 1\n" },
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.missingFiles, ["missing.py"]);
  assert.deepEqual(result.notLoadedPythonFiles, ["helper.py"]);
  assert.deepEqual(result.duplicateLoadEntries, [{ path: "base.py", occurrences: 2, loadIndexes: [0, 1] }]);
  assert.ok(result.publicDeclarationDuplicates.some((duplicate) => duplicate.name === "local_event_Status"));
  assert.ok(result.issues.some((issue) => issue.code === "RECIPE_FILE_NOT_LOADED" && issue.path === "helper.py"));
  assert.ok(
    result.issues.some((issue) => issue.code === "RECIPE_PUBLIC_DECLARATION_DUPLICATE" && issue.path === "base.py"),
  );
  assert.ok(
    result.issues.some((issue) => issue.code === "PY25_FUNCTION_ANNOTATION" && issue.path === "ingredient_bad.py"),
  );
});

test("verifyComposedRecipe reports duplicate decorated local actions across files", () => {
  const result = verifyComposedRecipe([
    { path: "script.py", content: "@local_action({'title': 'Run'})\ndef Run(arg):\n    pass\n" },
    { path: "custom.py", content: "@local_action({'title': 'Run custom'})\ndef Run(arg):\n    pass\n" },
  ]);

  assert.ok(result.publicDeclarationDuplicates.some((duplicate) => duplicate.name === "@local_action:Run"));
  assert.ok(result.issues.some((issue) => issue.code === "RECIPE_PUBLIC_DECLARATION_DUPLICATE"));
});

test("verifyComposedRecipe reports cross-style and later decorated action overwrites", () => {
  const result = verifyComposedRecipe([
    { path: "script.py", content: "@local_action({'title': 'Run'})\ndef Run(arg):\n    pass\n" },
    { path: "custom.py", content: "def local_action_Run(arg):\n    pass\n\ndef Run(arg):\n    return arg\n" },
  ]);

  const duplicate = result.publicDeclarationDuplicates.find((entry) => entry.name === "@local_action:Run");
  assert.ok(duplicate);
  assert.ok(duplicate.declarations.some((entry) => entry.name === "local_action_Run"));
  assert.ok(duplicate.declarations.some((entry) => entry.name === "@global:Run" && entry.path === "custom.py"));
});
