import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import {
  assertToolReferences,
  collectToolSpecs,
  toolIsAvailable,
  toolPolicies,
} from "../dist/mcp/registry/toolRegistry.js";
import { WORKFLOWS } from "../dist/mcp/registry/metadata.js";
import { createTestConfig } from "../dist/config.js";
import { validateReleaseVersions } from "../scripts/release-version-check.mjs";

const registryConfig = createTestConfig({
  writesEnabled: true,
  nodeLifecycleEnabled: true,
  deletesEnabled: true,
});
const specs = /** @type {import("../dist/mcp/registry/toolRegistry.js").ToolSpec[]} */ (
  collectToolSpecs(registryConfig)
);

test("canonical tool registry has unique names and valid metadata", () => {
  const names = specs.map((spec) => spec.name);
  assert.equal(new Set(names).size, names.length);
  for (const spec of specs) {
    assert.ok(spec.title && spec.description && spec.registration);
    assert.ok(["read", "proposal", "write", "lifecycle", "delete"].includes(spec.capability));
    assert.ok(["preview", "experimental"].includes(spec.stability));
    assert.ok(["always", "writes", "lifecycle", "deletes"].includes(spec.gate));
  }
});

test("full-gate policy names exactly match captured definitions", () => {
  assert.deepEqual(specs.map((spec) => spec.name).sort(), Object.keys(toolPolicies()).sort());
  for (const spec of specs) {
    const definition = /** @type {Record<string, unknown>} */ (spec.definition);
    assert.equal(definition.inputSchema, spec.inputSchema);
    assert.equal(definition.annotations, spec.annotations);
    assert.equal(typeof spec.handler, "function");
    assert.ok(spec.jsonInputSchema && typeof spec.jsonInputSchema === "object");
  }
});

test("registry gate derivation matches safety policy", () => {
  const readOnly = {
    writesEnabled: false,
    nodeLifecycleEnabled: false,
    deletesEnabled: false,
  };
  assert.ok(specs.filter((spec) => spec.gate === "always").every((spec) => toolIsAvailable(spec, readOnly)));
  assert.ok(specs.filter((spec) => spec.gate !== "always").every((spec) => !toolIsAvailable(spec, readOnly)));
  const allWrites = {
    writesEnabled: true,
    nodeLifecycleEnabled: true,
    deletesEnabled: true,
  };
  assert.ok(specs.every((spec) => toolIsAvailable(spec, allWrites)));
});

test("runtime registration follows every gate combination", () => {
  for (const gate of [
    {
      writesEnabled: false,
      nodeLifecycleEnabled: false,
      deletesEnabled: false,
    },
    { writesEnabled: true, nodeLifecycleEnabled: false, deletesEnabled: false },
    { writesEnabled: true, nodeLifecycleEnabled: true, deletesEnabled: false },
    { writesEnabled: true, nodeLifecycleEnabled: true, deletesEnabled: true },
  ]) {
    const config = createTestConfig(gate);
    const actual = collectToolSpecs(config);
    assert.equal(new Set(actual.map((spec) => spec.name)).size, actual.length);
    assert.ok(actual.every((spec) => spec.title && spec.description && spec.handler));
    assert.ok(actual.filter((spec) => spec.capability === "proposal").every((spec) => spec.gate === "always"));
    assert.ok(actual.filter((spec) => spec.gate !== "always").every((spec) => toolIsAvailable(spec, config)));
  }
});

test("guidance references only registered tools", async () => {
  const guidance = await readFile(new URL("../src/mcp/tools/guidance.ts", import.meta.url), "utf8");
  const references = [...guidance.matchAll(/nodel\.[a-z0-9_]+/gu)].map((match) => match[0]);
  assert.doesNotThrow(() => assertToolReferences([...new Set(references)]));
});

test("generated public tool reference is current", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["scripts/generate-tool-reference.mjs", "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("package, lockfile, MCP source, and release tag versions align", async () => {
  await validateReleaseVersions({
    packageJsonPath: new URL("../package.json", import.meta.url),
    packageLockPath: new URL("../package-lock.json", import.meta.url),
    mcpServerPath: new URL("../src/mcp/server.ts", import.meta.url),
  });
});

test("release-version-check supports matching tag refs", async () => {
  await validateReleaseVersions({
    packageJsonPath: new URL("../package.json", import.meta.url),
    packageLockPath: new URL("../package-lock.json", import.meta.url),
    mcpServerPath: new URL("../src/mcp/server.ts", import.meta.url),
    releaseTag: "v0.1.0",
  });
});

test("release-version-check rejects mismatching tag refs", async () => {
  await assert.rejects(
    () =>
      validateReleaseVersions({
        packageJsonPath: new URL("../package.json", import.meta.url),
        packageLockPath: new URL("../package-lock.json", import.meta.url),
        mcpServerPath: new URL("../src/mcp/server.ts", import.meta.url),
        releaseTag: "v9.9.9",
      }),
    /does not match package.json version/u,
  );
});

test("release-version-check accepts synthetic Git tag refs", async () => {
  await validateReleaseVersions({
    packageJsonPath: new URL("../package.json", import.meta.url),
    packageLockPath: new URL("../package-lock.json", import.meta.url),
    mcpServerPath: new URL("../src/mcp/server.ts", import.meta.url),
    releaseTag: "refs/tags/v0.1.0",
  });
});

test("safety layers do not import MCP adapters", async () => {
  assert.deepEqual(await findMcpAdapterReferences(new URL("../", import.meta.url)), []);
});

test("safety-layer scanner detects a prohibited temporary import without rg", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nodel-architecture-test-"));
  try {
    for (const safetyDirectory of safetyDirectories) await mkdir(join(directory, safetyDirectory), { recursive: true });
    await mkdirSourceFixture(directory, "src/domain/temporary.ts", 'import "../../mcp/tools/example.js";\n');
    assert.deepEqual(await findMcpAdapterReferences(new URL(`file://${directory}/`)), ["src/domain/temporary.ts"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safety-layer scanner parses multiline imports, exports, dynamic imports, and require", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nodel-architecture-ast-"));
  try {
    for (const safetyDirectory of safetyDirectories) await mkdir(join(directory, safetyDirectory), { recursive: true });
    await mkdirSourceFixture(
      directory,
      "src/domain/multiline.ts",
      [
        'import { value } from "../../',
        'mcp/tools/imported.js";\n',
        'export { value } from "../../mcp/tools/exported.js";\n',
        'const load = import(\n  "../../mcp/tools/dynamic.js"\n);\n',
        'const required = require(\n  "../../mcp/tools/required.js"\n);\n',
      ].join(""),
    );
    assert.deepEqual(await findMcpAdapterReferences(new URL(`file://${directory}/`)), ["src/domain/multiline.ts"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safety-layer scanner rejects symlinks in protected source trees", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nodel-architecture-symlink-"));
  try {
    for (const safetyDirectory of safetyDirectories) await mkdir(join(directory, safetyDirectory), { recursive: true });
    await symlink(join(directory, "src/domain"), join(directory, "src/shared/link"));
    await assert.rejects(() => findMcpAdapterReferences(new URL(`file://${directory}/`)), /symlink/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function mkdirSourceFixture(root, relativePath, content) {
  const parts = relativePath.split("/");
  parts.pop();
  let directory = root;
  for (const part of parts) {
    directory = join(directory, part);
    await mkdir(directory, { recursive: true });
  }
  await writeFile(join(root, relativePath), content);
}

const safetyDirectories = ["src/shared", "src/state", "src/nodel", "src/domain"];
const ignoredSourceDirectories = new Set(["vendor", "generated", "node_modules"]);

async function findMcpAdapterReferences(rootUrl) {
  const root = new URL(rootUrl);
  const references = [];
  async function scan(relativeDirectory) {
    const directory = new URL(relativeDirectory, root);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = `${relativeDirectory}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Protected source tree contains symlink: ${relativePath}`);
      if (ignoredSourceDirectories.has(entry.name)) continue;
      if (entry.isDirectory()) {
        await scan(`${relativePath}/`);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const content = await readFile(new URL(relativePath, root), "utf8");
        const sourceFile = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const specifiers = [];
        function visit(node) {
          if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
              specifiers.push(node.moduleSpecifier.text);
          } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            if (ts.isStringLiteral(node.moduleReference.expression))
              specifiers.push(node.moduleReference.expression.text);
          } else if (
            ts.isCallExpression(node) &&
            node.arguments.length === 1 &&
            ts.isStringLiteral(node.arguments[0])
          ) {
            const expression = node.expression;
            if (
              expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(expression) && expression.text === "require")
            )
              specifiers.push(node.arguments[0].text);
          }
          ts.forEachChild(node, visit);
        }
        visit(sourceFile);
        if (specifiers.some((specifier) => /(?:^|\/)mcp(?:\/|$)/u.test(specifier))) references.push(relativePath);
      }
    }
  }
  for (const directory of safetyDirectories) await scan(`${directory}/`);
  return references.sort();
}

test("recipe MCP adapter delegates orchestration to domain services", async () => {
  const adapter = await readFile(new URL("../src/mcp/tools/recipeWrites.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/domain/recipes/service.ts", import.meta.url), "utf8");

  for (const name of [
    "proposeRecipeScript",
    "proposeRecipeScriptEdit",
    "proposeNodeFile",
    "proposeNodeFileEdit",
    "saveRecipeScript",
    "applyRecipeScriptEdit",
    "saveNodeFile",
    "applyNodeFileEdit",
    "restartNode",
    "createNode",
    "deleteNode",
  ]) {
    assert.match(adapter, new RegExp(`\\b${name}\\(`, "u"));
    assert.doesNotMatch(adapter, new RegExp(`(?:async )?function ${name}\\b`, "u"));
    assert.match(service, new RegExp(`export async function ${name}\\b`, "u"));
  }
});

test("UI validator orchestrates domain validation modules", async () => {
  const [validator, catalog, points, assets] = await Promise.all([
    readFile(new URL("../src/domain/ui/validator.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/domain/ui/catalog.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/domain/ui/points-schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/domain/ui/assets-live.ts", import.meta.url), "utf8"),
  ]);

  assert.match(catalog, /export function validateElementCatalog/u);
  assert.match(points, /export function collectPointReferences/u);
  assert.match(points, /export function validateElementValues/u);
  assert.match(assets, /export function collectAssets/u);
  assert.match(assets, /export function validateLiveValues/u);
  assert.doesNotMatch(validator, /function validateElementCatalog/u);
  assert.doesNotMatch(validator, /function collectPointReferences/u);
  assert.doesNotMatch(validator, /function collectAssets/u);
});

test("node write adapter delegates mutations to domain services", async () => {
  const adapter = await readFile(new URL("../src/mcp/tools/nodeWrites.ts", import.meta.url), "utf8");
  for (const forbidden of ["auditedMutation", "backupBindingState", "backupParameterState", "withWriteLock"]) {
    assert.doesNotMatch(adapter, new RegExp(`\\b${forbidden}\\b`, "u"));
  }
  assert.doesNotMatch(adapter, /nodeRequest\([^)]*save/u);
});

test("workflow metadata covers every declared guidance task without registry cycles", async () => {
  for (const task of [
    "recipe_script",
    "recipe_script_edit",
    "node_file",
    "node_file_edit",
    "parameters",
    "bindings",
    "action",
    "restart",
    "create_node",
    "delete_node",
    "diagnose",
    "general",
  ]) {
    assert.ok(WORKFLOWS[task], `Missing workflow metadata for ${task}`);
  }
  const [guidance, metadata] = await Promise.all([
    readFile(new URL("../src/mcp/tools/guidance.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/mcp/registry/metadata.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(guidance, /toolRegistry\.js/u);
  assert.doesNotMatch(metadata, /\.\.\/tools\//u);
});

test("v1 UI catalog facade composes category modules", async () => {
  const facade = await readFile(new URL("../src/nodel/v1UiCatalog.ts", import.meta.url), "utf8");
  for (const category of ["document", "layout", "content", "control", "state", "builtin"]) {
    assert.match(facade, new RegExp(`v1UiCatalog/${category}\\.js`, "u"));
  }
  assert.ok(facade.split("\n").length < 250);
});

test("v1 UI catalog category modules own bounded declarative literals", async () => {
  const categories = [
    ["document", "document"],
    ["layout", "layout"],
    ["content", "content"],
    ["control", "control"],
    ["state", "state"],
    ["builtin", "builtin"],
  ];
  for (const [file, category] of categories) {
    const content = await readFile(new URL(`../src/nodel/v1UiCatalog/${file}.ts`, import.meta.url), "utf8");
    assert.ok(content.split("\n").length < 1_000, `${file} catalog module is too large`);
    assert.match(content, new RegExp(`category: "${category}"`, "u"));
    assert.doesNotMatch(content, /V1_UI_COMPONENTS\.filter|from "\.\/data\.js"/u);
  }
  await assert.rejects(readFile(new URL("../src/nodel/v1UiCatalog/data.ts", import.meta.url), "utf8"));
});
