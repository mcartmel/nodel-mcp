import { DEFAULT_RECIPE_IMPORT_POLICY, type RecipeImportPolicy } from "./recipeImportPolicy.js";

export type RecipeVerificationIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
  line: number;
  column?: number;
};

export type RecipeVerificationResult = {
  ok: boolean;
  checked: boolean;
  path: string;
  targetVersion: "Python 2.5/Jython 2.5";
  issues: RecipeVerificationIssue[];
  skippedReason?: string;
  analysis: "heuristic_static_analysis";
  limitations: string[];
};

type ScannerState = {
  tripleQuote?: "'''" | '"""';
};

type ScannedLine = {
  line: number;
  code: string;
};

type ImportedName = {
  importTarget: string;
  alias: string;
};

const targetVersion = "Python 2.5/Jython 2.5" as const;
const blockStarters = new Set([
  "class",
  "def",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "if",
  "try",
  "while",
  "with",
]);

export function verifyRecipeCompliance(path: string, content: string): RecipeVerificationResult {
  const issues: RecipeVerificationIssue[] = [];
  if (!isPythonRecipePath(path)) {
    return {
      ok: true,
      checked: false,
      path,
      targetVersion,
      issues,
      skippedReason: "Only Python recipe files are checked.",
      analysis: "heuristic_static_analysis",
      limitations: verificationLimitations(),
    };
  }

  const scanned = scanPythonLines(content, issues);
  const hasWithFuture = hasValidWithStatementFuture(scanned, issues);

  scanned.forEach(({ code, line }) => {
    checkLine(code, line, hasWithFuture, issues);
  });
  checkImportPolicy(scanned, issues, DEFAULT_RECIPE_IMPORT_POLICY);

  const scopedIssues = issues.map((issue) => ({ ...issue, path: issue.path ?? path }));

  return {
    ok: !scopedIssues.some((issue) => issue.severity === "error"),
    checked: true,
    path,
    targetVersion,
    issues: scopedIssues,
    analysis: "heuristic_static_analysis",
    limitations: verificationLimitations(),
  };
}

function verificationLimitations() {
  return [
    "This is heuristic static analysis, not a complete Python 2.5/Jython parser.",
    "It may report false positives and may miss syntax, import, runtime, or Nodel integration failures.",
    "Runtime verification in Nodel is required before treating a recipe as operational.",
  ];
}

export function summarizeRecipeVerification(result: RecipeVerificationResult) {
  if (result.ok) {
    return "Recipe compliance check passed.";
  }

  return result.issues
    .filter((issue) => issue.severity === "error")
    .slice(0, 8)
    .map(
      (issue) =>
        `${issue.path ?? result.path}:line ${issue.line}${issue.column ? `:${issue.column}` : ""} ${issue.code}: ${issue.message}`,
    )
    .join("; ");
}

function isPythonRecipePath(path: string) {
  return path === "script.py" || path.endsWith(".py");
}

function scanPythonLines(content: string, issues: RecipeVerificationIssue[]): ScannedLine[] {
  const state: ScannerState = {};
  return content.split(/\r?\n/u).map((line, index) => ({
    line: index + 1,
    code: sanitizePythonLine(line, index + 1, state, issues),
  }));
}

function hasValidWithStatementFuture(scanned: ScannedLine[], issues: RecipeVerificationIssue[]) {
  let seenRuntimeCode = false;
  let hasWithFuture = false;

  for (const { code, line } of scanned) {
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const futureImport = /^\s*from\s+__future__\s+import\s+(.+)$/u.exec(code);
    if (futureImport) {
      if (seenRuntimeCode) {
        addIssue(issues, "PY25_FUTURE_IMPORT_ORDER", "__future__ imports must appear before other recipe code.", line);
      } else if (/\bwith_statement\b/u.test(futureImport[1] ?? "")) {
        hasWithFuture = true;
      }
      continue;
    }

    seenRuntimeCode = true;
  }

  return hasWithFuture;
}

function sanitizePythonLine(line: string, lineNumber: number, state: ScannerState, issues: RecipeVerificationIssue[]) {
  const chars = [...line];
  let index = 0;
  let code = "";

  while (index < chars.length) {
    if (state.tripleQuote) {
      const closeIndex = line.indexOf(state.tripleQuote, index);
      if (closeIndex < 0) {
        return code.padEnd(chars.length, " ");
      }
      code = code.padEnd(closeIndex + state.tripleQuote.length, " ");
      index = closeIndex + state.tripleQuote.length;
      state.tripleQuote = undefined;
      continue;
    }

    const char = chars[index];
    if (char === "#") {
      return code.padEnd(chars.length, " ");
    }

    if (char === "'" || char === '"') {
      const quote = char;
      const prefix = readStringPrefix(line, index);
      if (/[fF]/u.test(prefix)) {
        addIssue(
          issues,
          "PY25_F_STRING",
          "f-string literals are not valid Python 2.5 syntax. Use percent formatting instead.",
          lineNumber,
          index - prefix.length + 1,
        );
      }
      if (/[bB]/u.test(prefix)) {
        addIssue(
          issues,
          "PY25_BYTES_LITERAL",
          "bytes literal prefixes are not valid Python 2.5 syntax. Use plain string literals.",
          lineNumber,
          index - prefix.length + 1,
        );
      }

      const triple = line.slice(index, index + 3) === quote.repeat(3);
      const closeIndex = triple ? line.indexOf(quote.repeat(3), index + 3) : findStringEnd(line, index + 1, quote);
      const start = index - prefix.length;
      const end = closeIndex < 0 ? chars.length : closeIndex + (triple ? 3 : 1);
      code = code.padEnd(Math.max(start, 0), " ");
      code = code.padEnd(end, " ");
      index = end;
      if (triple && closeIndex < 0) {
        state.tripleQuote = quote.repeat(3) as ScannerState["tripleQuote"];
      }
      continue;
    }

    code += char;
    index += 1;
  }

  return code;
}

function readStringPrefix(line: string, quoteIndex: number) {
  let start = quoteIndex;
  while (start > 0 && /[A-Za-z]/u.test(line[start - 1] ?? "")) {
    start -= 1;
  }

  const prefix = line.slice(start, quoteIndex);
  return /^[rRuUbBfF]*$/u.test(prefix) ? prefix : "";
}

function findStringEnd(line: string, start: number, quote: string) {
  let escaped = false;
  for (let index = start; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === quote) {
      return index;
    }
  }
  return -1;
}

function checkLine(code: string, line: number, hasWithFuture: boolean, issues: RecipeVerificationIssue[]) {
  if (/^\s*async\s+(def|for|with)\b/u.test(code)) {
    addIssue(issues, "PY25_ASYNC", "async syntax is not valid Python 2.5 syntax.", line);
  }
  if (/(^|[^\w])await\s+/u.test(code)) {
    addIssue(issues, "PY25_AWAIT", "await syntax is not valid Python 2.5 syntax.", line);
  }
  if (/(^|[^\w])nonlocal\s+/u.test(code)) {
    addIssue(issues, "PY25_NONLOCAL", "nonlocal is not valid Python 2.5 syntax.", line);
  }
  if (/^\s*except\b[^:]*\bas\b[^:]*:/u.test(code)) {
    addIssue(
      issues,
      "PY25_EXCEPT_AS",
      "Use Python 2 exception binding syntax, for example: except ValueError, e:.",
      line,
    );
  }
  if (/\braise\b.+\bfrom\b/u.test(code)) {
    addIssue(issues, "PY25_RAISE_FROM", "Exception chaining with raise ... from is not valid Python 2.5 syntax.", line);
  }
  if (/\byield\s+from\b/u.test(code)) {
    addIssue(issues, "PY25_YIELD_FROM", "yield from is not valid Python 2.5 syntax.", line);
  }
  if (/^\s*with\b/u.test(code) && !hasWithFuture) {
    addIssue(
      issues,
      "PY25_WITH_FUTURE",
      "Python 2.5 requires 'from __future__ import with_statement' before using with statements.",
      line,
    );
  }
  if (/\{[^[\]{}\n]*\bfor\b[^[\]{}\n]*\bin\b[^[\]{}\n]*\}/u.test(code)) {
    addIssue(
      issues,
      "PY25_DICT_SET_COMPREHENSION",
      "Dict and set comprehensions are not valid Python 2.5 syntax.",
      line,
    );
  }
  if (/\bdef\s+\w+\s*\([^)]*\)\s*->/u.test(code) || functionParameterAnnotation(code)) {
    addIssue(issues, "PY25_FUNCTION_ANNOTATION", "Function annotations are not valid Python 2.5 syntax.", line);
  }
  if (variableAnnotation(code)) {
    addIssue(issues, "PY25_VARIABLE_ANNOTATION", "Variable annotations are not valid Python 2.5 syntax.", line);
  }
  if (/\bdef\s+\w+\s*\([^)]*\*\s*,/u.test(code)) {
    addIssue(issues, "PY25_KEYWORD_ONLY", "Keyword-only parameters are not valid Python 2.5 syntax.", line);
  }
}

function checkImportPolicy(scanned: ScannedLine[], issues: RecipeVerificationIssue[], policy: RecipeImportPolicy) {
  const aliases = new Map<string, string>();
  const issuedImports = new Set<string>();

  scanned.forEach(({ code, line }) => {
    const imported = readImportedNames(code);
    imported.forEach(({ importTarget, alias }) => {
      classifyImport(importTarget, line, issues, policy, issuedImports);
      aliases.set(alias, importTarget);
    });
  });

  scanned.forEach(({ code, line }) => {
    checkBlockedCalls(code, line, aliases, issues, policy);
  });
}

function readImportedNames(code: string): ImportedName[] {
  const trimmed = code.trim();
  const importMatch = /^import\s+(.+)$/u.exec(trimmed);
  if (importMatch) {
    return readImportParts(importMatch[1] ?? "").map(({ name, alias }) => ({
      importTarget: name,
      alias: alias ?? rootName(name),
    }));
  }

  const fromMatch = /^from\s+([.\w]+)\s+import\s+(.+)$/u.exec(trimmed);
  if (!fromMatch) {
    return [];
  }

  const moduleName = fromMatch[1] ?? "";
  if (moduleName === "__future__") {
    return [];
  }

  const moduleImport = { importTarget: moduleName, alias: rootName(moduleName) };
  const names = readImportParts(fromMatch[2] ?? "")
    .filter(({ name }) => name !== "*")
    .map(({ name, alias }) => ({
      importTarget: `${moduleName}.${name}`,
      alias: alias ?? name,
    }));

  return [moduleImport, ...names];
}

function readImportParts(value: string) {
  return value
    .replace(/[()\\]/gu, "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const aliasMatch = /^([.\w]+)\s+as\s+(\w+)$/u.exec(part);
      if (aliasMatch) {
        return { name: aliasMatch[1] ?? "", alias: aliasMatch[2] };
      }
      return { name: part };
    })
    .filter(({ name }) => name.length > 0);
}

function classifyImport(
  importTarget: string,
  line: number,
  issues: RecipeVerificationIssue[],
  policy: RecipeImportPolicy,
  issuedImports: Set<string>,
) {
  if (importTarget === "__future__" || issuedImports.has(importTarget)) {
    return;
  }

  const blockedMatch = findPolicyMatch(importTarget, policy.blockedImports);
  if (blockedMatch && (blockedMatch === importTarget || !issuedImports.has(blockedMatch))) {
    issuedImports.add(importTarget);
    addIssue(issues, "RECIPE_IMPORT_BLOCKED", importMessage("Blocked import", importTarget, policy), line);
    return;
  }

  const discouragedMatch = findPolicyMatch(importTarget, policy.discouragedImports);
  if (discouragedMatch && (discouragedMatch === importTarget || !issuedImports.has(discouragedMatch))) {
    issuedImports.add(importTarget);
    addPolicyIssue(
      policy.discouragedImportSeverity,
      issues,
      "RECIPE_IMPORT_DISCOURAGED",
      importMessage("Discouraged import", importTarget, policy),
      line,
    );
    return;
  }

  issuedImports.add(importTarget);
  if (isAllowedImport(importTarget, policy)) {
    return;
  }

  if (hasKnownImportedParent(importTarget, issuedImports)) {
    return;
  }

  addPolicyIssue(
    policy.unknownImportSeverity,
    issues,
    "RECIPE_IMPORT_UNKNOWN",
    importMessage("Unknown import", importTarget, policy),
    line,
  );
}

function checkBlockedCalls(
  code: string,
  line: number,
  aliases: Map<string, string>,
  issues: RecipeVerificationIssue[],
  policy: RecipeImportPolicy,
) {
  const callPattern = /(^|[^\w.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/gu;
  let match: RegExpExecArray | null;

  while ((match = callPattern.exec(code)) !== null) {
    const rawCall = match[2] ?? "";
    const resolvedCall = resolveCall(rawCall, aliases);
    const blockedCall = policy.blockedCalls.find((entry) => entry === rawCall || entry === resolvedCall);
    if (!blockedCall) {
      continue;
    }
    addIssue(
      issues,
      "RECIPE_CALL_BLOCKED",
      callMessage(blockedCall, rawCall, policy),
      line,
      (match.index ?? 0) + (match[1]?.length ?? 0) + 1,
    );
  }
}

function resolveCall(rawCall: string, aliases: Map<string, string>) {
  const [head, ...tail] = rawCall.split(".");
  if (!head) {
    return rawCall;
  }
  const aliasTarget = aliases.get(head);
  return aliasTarget ? [aliasTarget, ...tail].join(".") : rawCall;
}

function isAllowedImport(importTarget: string, policy: RecipeImportPolicy) {
  return (
    matchesAny(importTarget, policy.allowedImports) ||
    policy.allowedJavaPrefixes.some((prefix) => importTarget === prefix || importTarget.startsWith(`${prefix}.`))
  );
}

function matchesAny(importTarget: string, entries: string[]) {
  return Boolean(findPolicyMatch(importTarget, entries));
}

function findPolicyMatch(importTarget: string, entries: string[]) {
  return entries.find((entry) => importTarget === entry || importTarget.startsWith(`${entry}.`));
}

function hasKnownImportedParent(importTarget: string, issuedImports: Set<string>) {
  const parts = importTarget.split(".");
  for (let count = parts.length - 1; count > 0; count -= 1) {
    if (issuedImports.has(parts.slice(0, count).join("."))) {
      return true;
    }
  }
  return false;
}

function rootName(importTarget: string) {
  return importTarget.split(".")[0] ?? importTarget;
}

function importMessage(prefix: string, importTarget: string, policy: RecipeImportPolicy) {
  const alternative = preferredAlternative(importTarget, policy);
  return alternative ? `${prefix}: ${importTarget}. ${alternative}` : `${prefix}: ${importTarget}.`;
}

function callMessage(blockedCall: string, rawCall: string, policy: RecipeImportPolicy) {
  const alternative = preferredAlternative(blockedCall, policy);
  const callName = blockedCall === rawCall ? blockedCall : `${rawCall} resolves to ${blockedCall}`;
  return alternative ? `Blocked call: ${callName}. ${alternative}` : `Blocked call: ${callName}.`;
}

function preferredAlternative(name: string, policy: RecipeImportPolicy) {
  const candidates = [
    name,
    ...name
      .split(".")
      .map((_, index, parts) => parts.slice(0, parts.length - index - 1).join("."))
      .filter(Boolean),
  ];
  return candidates
    .map((candidate) => policy.preferredAlternatives[candidate])
    .find((alternative): alternative is string => Boolean(alternative));
}

function addPolicyIssue(
  severity: "warning" | "error" | "ignore",
  issues: RecipeVerificationIssue[],
  code: string,
  message: string,
  line: number,
) {
  if (severity === "ignore") {
    return;
  }
  addIssue(issues, code, message, line, undefined, severity);
}

function functionParameterAnnotation(code: string) {
  const match = /\bdef\s+\w+\s*\((.*)\)\s*:/u.exec(code);
  return Boolean(match?.[1] && /(^|,)\s*\w+\s*:/u.test(match[1]));
}

function variableAnnotation(code: string) {
  const trimmed = code.trim();
  const firstWord = /^([A-Za-z_]\w*)/u.exec(trimmed)?.[1];
  if (!firstWord || blockStarters.has(firstWord)) {
    return false;
  }
  return /^[A-Za-z_]\w*\s*:\s*[A-Za-z_][\w.[\], "'|]*(?:\s*=.*)?$/u.test(trimmed);
}

function addIssue(
  issues: RecipeVerificationIssue[],
  code: string,
  message: string,
  line: number,
  column?: number,
  severity: RecipeVerificationIssue["severity"] = "error",
) {
  issues.push({ severity, code, message, line, column });
}
