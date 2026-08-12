import { assertSafeRecipePath } from "./pathPolicy.js";
import {
  verifyRecipeCompliance,
  type RecipeVerificationIssue,
  type RecipeVerificationResult,
} from "./recipeVerifier.js";
import { sanitizeSensitiveMessage } from "../shared/publicErrors.js";

const SCRIPT_PATH = "script.py";
const NODE_CONFIG_PATH = "nodeConfig.json";
const STATIC_ANALYSIS_NOTICE = "Static analysis only; no Jython execution or Nodel runtime import/load was performed.";

const publicDeclarationPrefixes = ["param_", "local_event_", "local_action_", "remote_action_", "remote_event_"];

export type RecipeCompositionInputFile = {
  path: string;
  content?: string;
};

export type RecipeCompositionCandidateOverride = {
  path: string;
  content: string;
};

export type RecipeCompositionIssue = Omit<RecipeVerificationIssue, "line"> & {
  line?: number;
};

export type RecipeLoadOrderFile = {
  path: string;
  loadIndex: number;
  source: "current" | "candidate" | "missing";
  missing: boolean;
};

export type DuplicateLoadEntry = {
  path: string;
  occurrences: number;
  loadIndexes: number[];
};

export type PublicDeclaration = {
  name: string;
  kind: string;
  path: string;
  line: number;
};

export type DuplicatePublicDeclaration = {
  name: string;
  declarations: PublicDeclaration[];
};

export type RecipeLoadOrder = {
  source: "nodeConfig.json dependencies" | "script.py";
  dependencies: string[];
  ingredientFiles: string[];
  customFiles: string[];
  loadOrder: string[];
  loadedFiles: RecipeLoadOrderFile[];
  missingFiles: string[];
  duplicateLoadEntries: DuplicateLoadEntry[];
  notLoadedPythonFiles: string[];
  candidateOverride?: {
    path: string;
    loaded: boolean;
  };
  issues: RecipeCompositionIssue[];
};

export type RecipeComposedFileVerification = {
  path: string;
  source: "current" | "candidate";
  loadIndexes: number[];
  byteLength: number;
  recipeVerification: RecipeVerificationResult;
};

export type RecipeComposedVerificationResult = {
  ok: boolean;
  checked: true;
  mode: "static_per_file";
  staticAnalysisOnly: true;
  message: string;
  loadOrder: RecipeLoadOrder;
  perFile: RecipeComposedFileVerification[];
  missingFiles: string[];
  duplicateLoadEntries: DuplicateLoadEntry[];
  notLoadedPythonFiles: string[];
  publicDeclarationDuplicates: DuplicatePublicDeclaration[];
  issues: RecipeCompositionIssue[];
};

export function deriveRecipeLoadOrder(
  filePaths: string[],
  options: { nodeConfigJson?: string; candidatePath?: string } = {},
): RecipeLoadOrder {
  const issues: RecipeCompositionIssue[] = [];
  const availablePaths = normalizePathSet(filePaths, options.candidatePath);
  const nodeConfig = readNodeConfigDependencies(options.nodeConfigJson);
  issues.push(...nodeConfig.issues);

  const hasDependencies = nodeConfig.configured;
  const dependencies = hasDependencies ? nodeConfig.dependencies : [SCRIPT_PATH];
  const ingredientFiles = sortedRecipeFiles(availablePaths, /^ingredient.*\.py$/u);
  const customFiles = sortedRecipeFiles(availablePaths, /^custom.*\.py$/u);
  const loadOrder = [...dependencies, ...ingredientFiles, ...customFiles];
  const duplicateLoadEntries = findDuplicateLoadEntries(loadOrder);
  const missingFiles = unique(loadOrder.filter((path) => !availablePaths.has(path)));
  const loadedFiles = loadOrder.map(
    (path, loadIndex) =>
      ({
        path,
        loadIndex,
        source: !availablePaths.has(path) ? "missing" : path === options.candidatePath ? "candidate" : "current",
        missing: !availablePaths.has(path),
      }) satisfies RecipeLoadOrderFile,
  );
  const loadedPathSet = new Set(loadOrder);
  const notLoadedPythonFiles = [...availablePaths]
    .filter((path) => isPythonRecipeFile(path) && !loadedPathSet.has(path))
    .sort();

  for (const path of missingFiles) {
    issues.push({
      severity: "error",
      code: "RECIPE_LOAD_MISSING",
      message: `Nodel load order references missing recipe file: ${path}.`,
      path,
    });
  }

  for (const duplicate of duplicateLoadEntries) {
    issues.push({
      severity: "warning",
      code: "RECIPE_LOAD_DUPLICATE",
      message: `Nodel load order includes ${duplicate.path} ${duplicate.occurrences} times.`,
      path: duplicate.path,
    });
  }

  for (const path of notLoadedPythonFiles) {
    issues.push({
      severity: "warning",
      code: "RECIPE_FILE_NOT_LOADED",
      message: `Python recipe file is present but is not loaded by nodeConfig.json dependencies, script.py, ingredient*.py, or custom*.py: ${path}.`,
      path,
    });
  }

  return {
    source: hasDependencies ? "nodeConfig.json dependencies" : "script.py",
    dependencies,
    ingredientFiles,
    customFiles,
    loadOrder,
    loadedFiles,
    missingFiles,
    duplicateLoadEntries,
    notLoadedPythonFiles,
    candidateOverride: options.candidatePath
      ? { path: options.candidatePath, loaded: loadedPathSet.has(options.candidatePath) }
      : undefined,
    issues,
  };
}

export function verifyComposedRecipe(
  files: RecipeCompositionInputFile[],
  options: { candidate?: RecipeCompositionCandidateOverride } = {},
): RecipeComposedVerificationResult {
  const fileMap = normalizeFileMap(files, options.candidate);
  const nodeConfigJson = fileMap.get(NODE_CONFIG_PATH)?.content;
  const loadOrder = deriveRecipeLoadOrder([...fileMap.keys()], {
    nodeConfigJson,
    candidatePath: options.candidate?.path,
  });
  const loadIndexes = indexLoadOrder(loadOrder.loadOrder);
  const uniqueLoadedPythonPaths = unique(loadOrder.loadOrder).filter(
    (path) => isPythonRecipeFile(path) && fileMap.has(path),
  );
  const perFile = uniqueLoadedPythonPaths.map((path) => {
    const content = fileMap.get(path)?.content ?? "";
    return {
      path,
      source: path === options.candidate?.path ? "candidate" : "current",
      loadIndexes: loadIndexes.get(path) ?? [],
      byteLength: Buffer.byteLength(content, "utf8"),
      recipeVerification: verifyRecipeCompliance(path, content),
    } satisfies RecipeComposedFileVerification;
  });
  const publicDeclarationDuplicates = findDuplicatePublicDeclarations(
    perFile.map(({ path }) => ({ path, content: fileMap.get(path)?.content ?? "" })),
  );
  const issues: RecipeCompositionIssue[] = [
    ...loadOrder.issues,
    ...perFile.flatMap(({ recipeVerification }) => recipeVerification.issues),
    ...publicDeclarationDuplicates.map((duplicate) => ({
      severity: "warning" as const,
      code: "RECIPE_PUBLIC_DECLARATION_DUPLICATE",
      message: `Public declaration ${duplicate.name} appears in multiple loaded recipe files.`,
      path: duplicate.declarations[0]?.path,
      line: duplicate.declarations[0]?.line,
    })),
  ];

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    checked: true,
    mode: "static_per_file",
    staticAnalysisOnly: true,
    message: STATIC_ANALYSIS_NOTICE,
    loadOrder,
    perFile,
    missingFiles: loadOrder.missingFiles,
    duplicateLoadEntries: loadOrder.duplicateLoadEntries,
    notLoadedPythonFiles: loadOrder.notLoadedPythonFiles,
    publicDeclarationDuplicates,
    issues,
  };
}

function normalizeFileMap(
  files: RecipeCompositionInputFile[],
  candidate: RecipeCompositionCandidateOverride | undefined,
) {
  const map = new Map<string, RecipeCompositionInputFile>();
  for (const file of files) {
    const path = assertSafeRecipePath(file.path);
    map.set(path, { ...file, path });
  }
  if (candidate) {
    const path = assertSafeRecipePath(candidate.path);
    map.set(path, { path, content: candidate.content });
  }
  return map;
}

function normalizePathSet(filePaths: string[], candidatePath: string | undefined) {
  const paths = new Set<string>();
  for (const filePath of filePaths) {
    paths.add(assertSafeRecipePath(filePath));
  }
  if (candidatePath) {
    paths.add(assertSafeRecipePath(candidatePath));
  }
  return paths;
}

function readNodeConfigDependencies(content: string | undefined) {
  const issues: RecipeCompositionIssue[] = [];
  if (content === undefined) {
    return { dependencies: [] as string[], configured: false, issues };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      dependencies: [] as string[],
      configured: false,
      issues: [
        {
          severity: "error" as const,
          code: "RECIPE_NODE_CONFIG_PARSE_ERROR",
          message: `nodeConfig.json could not be parsed as JSON: ${sanitizeSensitiveMessage(error)}`,
          path: NODE_CONFIG_PATH,
        },
      ],
    };
  }

  if (!isRecord(parsed) || parsed.dependencies === undefined) {
    return { dependencies: [] as string[], configured: false, issues };
  }

  if (!Array.isArray(parsed.dependencies)) {
    issues.push({
      severity: "error",
      code: "RECIPE_NODE_CONFIG_DEPENDENCIES_INVALID",
      message: "nodeConfig.json dependencies must be an array of recipe file paths.",
      path: NODE_CONFIG_PATH,
    });
    return { dependencies: [] as string[], configured: true, issues };
  }

  const dependencies: string[] = [];
  parsed.dependencies.forEach((entry, index) => {
    const rawPath = readDependencyPath(entry);
    if (!rawPath) {
      issues.push({
        severity: "error",
        code: "RECIPE_NODE_CONFIG_DEPENDENCY_INVALID",
        message: `nodeConfig.json dependencies[${index}] must be a recipe file path string.`,
        path: NODE_CONFIG_PATH,
      });
      return;
    }

    try {
      dependencies.push(assertSafeRecipePath(rawPath));
    } catch (error) {
      issues.push({
        severity: "error",
        code: "RECIPE_NODE_CONFIG_DEPENDENCY_INVALID",
        message: `nodeConfig.json dependencies[${index}] is not a safe recipe path: ${sanitizeSensitiveMessage(error)}`,
        path: NODE_CONFIG_PATH,
      });
    }
  });

  return { dependencies, configured: true, issues };
}

function readDependencyPath(entry: unknown) {
  return typeof entry === "string" ? entry : undefined;
}

function sortedRecipeFiles(paths: Set<string>, pattern: RegExp) {
  return [...paths].filter((path) => !path.includes("/") && pattern.test(path)).sort();
}

function isPythonRecipeFile(path: string) {
  return path === SCRIPT_PATH || path.endsWith(".py");
}

function findDuplicateLoadEntries(paths: string[]) {
  const byPath = indexLoadOrder(paths);
  return [...byPath]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([path, loadIndexes]) => ({ path, occurrences: loadIndexes.length, loadIndexes }));
}

function indexLoadOrder(paths: string[]) {
  const byPath = new Map<string, number[]>();
  paths.forEach((path, index) => {
    const indexes = byPath.get(path) ?? [];
    indexes.push(index);
    byPath.set(path, indexes);
  });
  return byPath;
}

function findDuplicatePublicDeclarations(files: Array<{ path: string; content: string }>) {
  const declarations = files.flatMap(({ path, content }) => readPublicDeclarations(path, content));
  const byName = new Map<string, PublicDeclaration[]>();
  for (const declaration of declarations) {
    if (declaration.kind === "top_level_function") continue;
    const identity = declarationIdentity(declaration.name);
    const existing = byName.get(identity) ?? [];
    existing.push(declaration);
    byName.set(identity, existing);
  }
  const duplicates = [...byName]
    .filter(([, entries]) => entries.length > 1)
    .map(([name, declarations]) => ({ name, declarations }));

  declarations.forEach((declaration, index) => {
    if (!declaration.name.startsWith("@local_action:")) return;
    const functionName = declaration.name.slice("@local_action:".length);
    const overwrites = declarations
      .slice(index + 1)
      .filter(
        (candidate) =>
          candidate.name === `@global:${functionName}` &&
          (candidate.path !== declaration.path || candidate.line !== declaration.line),
      );
    if (overwrites.length === 0) return;
    const name = `@local_action:${functionName}`;
    const existing = duplicates.find((duplicate) => duplicate.name === name);
    if (existing) {
      existing.declarations.push(...overwrites.filter((entry) => !existing.declarations.includes(entry)));
    } else {
      duplicates.push({ name, declarations: [declaration, ...overwrites] });
    }
  });

  return duplicates;
}

function readPublicDeclarations(path: string, content: string): PublicDeclaration[] {
  const declarations: PublicDeclaration[] = [];
  let pendingLocalActionDecorator = false;
  content.split(/\r?\n/u).forEach((line, index) => {
    if (/^\s/u.test(line) || line.trim().length === 0 || line.trimStart().startsWith("#")) {
      return;
    }
    const code = stripLineComment(line);
    if (/^@local_action\b/u.test(code)) {
      pendingLocalActionDecorator = true;
      return;
    }
    const assignment = /^([A-Za-z_]\w*)\s*=/u.exec(code);
    const functionDef = /^def\s+([A-Za-z_]\w*)\s*\(/u.exec(code);
    const name = assignment?.[1] ?? functionDef?.[1];
    if (functionDef?.[1] && pendingLocalActionDecorator) {
      declarations.push({
        name: `@local_action:${functionDef[1]}`,
        kind: "decorated_local_action",
        path,
        line: index + 1,
      });
    }
    if (functionDef?.[1]) {
      declarations.push({ name: `@global:${functionDef[1]}`, kind: "top_level_function", path, line: index + 1 });
    }
    pendingLocalActionDecorator = false;
    const kind = name ? publicDeclarationKind(name) : undefined;
    if (!name || !kind) {
      return;
    }
    declarations.push({ name, kind, path, line: index + 1 });
  });
  return declarations;
}

function publicDeclarationKind(name: string) {
  const prefix = publicDeclarationPrefixes.find((entry) => name.startsWith(entry));
  return prefix ? prefix.slice(0, -1) : undefined;
}

function declarationIdentity(name: string) {
  if (name.startsWith("@local_action:")) return name;
  if (name.startsWith("local_action_")) return `@local_action:${name.slice("local_action_".length)}`;
  return name;
}

function stripLineComment(line: string) {
  const hashIndex = line.indexOf("#");
  return hashIndex < 0 ? line : line.slice(0, hashIndex);
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
