/**
 * Conservative lexical evidence for bounded JS/CSS samples, not a parser or a
 * build fingerprint. A MIME label and prose/error text alone are not evidence
 * of an entry asset. Inconclusive prefixes remain unknown; nothing is executed.
 */
export function hasStaticEntryEvidence(artifact: "script" | "stylesheet", text: string, complete: boolean): boolean {
  const source = text.trim();
  const code = maskLiteralsAndComments(source, artifact === "script").trim();
  const visible = skipLeadingComments(source, artifact === "script");
  if (!visible || obviousError.test(visible)) return false;
  const tokens = artifact === "script" ? tokenize(code) : [];
  if (artifact === "script" && isAuthenticationResponse(source, tokens)) return false;
  // JSON error envelopes can carry JS/CSS MIME too. Complete JSON data is not
  // entry code. This is bounded to the 4KiB sample; contract parsing stays domain-owned.
  if (complete) {
    try {
      JSON.parse(source);
      return false;
    } catch {
      /* Inspect syntax evidence, not JSON validity. */
    }
  }
  return artifact === "stylesheet" ? cssEvidence(code) : jsEvidence(tokens);
}

const obviousError =
  /^(?:(?:http(?:\/\d(?:\.\d)?)?\s+)?[45]\d{2}\b|(?:not\s+found|unauthori[sz]ed|forbidden|access\s+denied|permission\s+denied|(?:authentication|authorization|login)\s+required|please\s+(?:log|sign)\s+in|bad\s+request|internal\s+server\s+error|bad\s+gateway|service\s+unavailable|gateway\s+timeout|cannot\s+(?:get|find|load)|failed\s+to\s+(?:load|fetch)|error)(?:\s|[.:!]|$))/iu;

const navigationKeys = new Set(["location", "href", "replace", "assign"]);
const authMessage =
  /(?:\b(?:login|log[\s_-]*in|sign[\s_-]*in|unauthori[sz]ed|forbidden|authentication)\b|access\s+denied|session\s+expired|type\s*=\s*["']password)/iu;

// Simple token alternatives: each character is consumed once, without
// searching/retrying suffixes. This is intentionally not a JavaScript parser.
function tokenize(code: string): string[] {
  return code.match(/[$_\p{ID_Start}][\p{ID_Continue}$]*|=>|==|[^\s]/gu) ?? [];
}

function identifier(token: string | undefined): boolean {
  return token !== undefined && /^[$_\p{ID_Start}][\p{ID_Continue}$]*$/u.test(token);
}

function closingTokens(tokens: string[]): Map<number, number> {
  const stack: number[] = [];
  const pairs = new Map<number, number>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (["(", "[", "{"].includes(token)) stack.push(i);
    else if ([")", "]", "}"].includes(token)) {
      const start = stack.pop();
      if (start === undefined || "([{".indexOf(tokens[start]!) !== ")]}".indexOf(token)) return pairs;
      pairs.set(start, i);
    }
  }
  return pairs;
}

/** Only inspect the leading statement (possibly inside a bounded immediate
 * wrapper/guard), never login references in ordinary functions or strings.
 * Navigation-led ambiguous tails remain unknown, rather than parsing arbitrary
 * destination expressions. All passes are O(n); wrapper depth is capped at four.
 */
function isAuthenticationResponse(source: string, tokens: string[]): boolean {
  const pairs = closingTokens(tokens);
  let start = 0;
  let end = tokens.length;
  for (let depth = 0; depth < 4; depth++) {
    while (tokens[start] === ";" || (tokens[start] === "__literal__" && tokens[start + 1] === ";")) {
      start += tokens[start] === ";" ? 1 : 2;
    }
    while (tokens[end - 1] === ";") end--;
    let i = start;
    const members: string[] = [tokens[i++] ?? ""];
    while (i < end) {
      if (tokens[i] === "." && identifier(tokens[i + 1])) {
        members.push(tokens[i + 1]!);
        i += 2;
      } else if (tokens[i] === "[" && tokens[i + 2] === "]") {
        members.push((tokens[i + 1] ?? "").replace(/^__navigation_(\w+)__$/u, "$1"));
        i += 3;
      } else break;
    }
    const root = members[0];
    const location = members.indexOf("location");
    const globals = ["window", "self", "top", "parent", "globalThis", "document"];
    const browser = location === 0 || (location > 0 && members.slice(0, location).every((m) => globals.includes(m)));
    const suffix = members.slice(location + 1).join(".");
    if (
      browser &&
      ((["", "href"].includes(suffix) && tokens[i] === "=") ||
        (["replace", "assign"].includes(suffix) && tokens[i] === "("))
    )
      return true;
    const display = members.join(".");
    if (
      authMessage.test(source) &&
      ((["alert", "window.alert", "document.write", "document.writeln"].includes(display) &&
        tokens[i] === "(" &&
        tokens[i + 1] === "__literal__") ||
        ([
          "document.body.innerHTML",
          "document.body.outerHTML",
          "document.documentElement.innerHTML",
          "document.documentElement.outerHTML",
        ].includes(display) &&
          tokens[i] === "=" &&
          tokens[i + 1] === "__literal__"))
    )
      return true;
    if (root === "if" && tokens[start + 1] === "(" && pairs.has(start + 1)) {
      start = pairs.get(start + 1)! + 1;
    } else {
      // Require an immediate invocation enclosing the entire remaining body.
      if (tokens[end - 2] !== "(" || tokens[end - 1] !== ")") return false;
      end -= 2;
      if (["!", "+", "~", "-"].includes(tokens[start]!)) start++;
      if (tokens[start] === "(" && pairs.get(start) === end - 1) {
        start++;
        end--;
      }
      if (tokens[start] === "function") {
        start++;
        if (identifier(tokens[start])) start++;
        if (tokens[start] !== "(" || tokens[start + 1] !== ")" || tokens[start + 2] !== "{") return false;
        start += 2;
      } else if (tokens[start] === "(" && tokens[start + 1] === ")" && tokens[start + 2] === "=>") start += 3;
      else return false;
    }
    if (tokens[start] === "{" && pairs.get(start) === end - 1) {
      start++;
      end--;
    }
  }
  // More wrapper/guard layers than this small recognizer supports: unknown.
  return true;
}

function jsEvidence(tokens: string[]): boolean {
  const pairs = closingTokens(tokens);
  const hasAssignment = tokens.includes("=") || tokens.includes(";");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (["var", "let", "const"].includes(token!) && (identifier(next) || next === "[" || next === "{") && hasAssignment)
      return true;
    if (token === "=>") return true;
    if (token === "function") {
      let j = i + 1;
      if (tokens[j] === "*") j++;
      if (identifier(tokens[j])) j++;
      const end = pairs.get(j);
      if (tokens[j] === "(" && end !== undefined && tokens[end + 1] === "{") return true;
    }
    if (token === "class" && (next === "{" || (identifier(next) && ["{", "extends"].includes(tokens[i + 2]!))))
      return true;
    if (
      token === "import" &&
      (["__literal__", "{", "*", "(", "."].includes(next!) ||
        (identifier(next) && [",", "from"].includes(tokens[i + 2]!)))
    )
      return true;
    if (
      token === "export" &&
      ["{", "*", "default", "const", "let", "var", "function", "class", "async"].includes(next!)
    )
      return true;
  }
  let i = 0;
  while (tokens[i] === "__literal__" && tokens[i + 1] === ";") i += 2;
  while ([";", "(", "!", "+", "~", "-"].includes(tokens[i]!)) i++;
  if (!identifier(tokens[i++])) return false;
  while (i < tokens.length) {
    if (tokens[i] === "." && identifier(tokens[i + 1])) i += 2;
    else if (tokens[i] === "[" && pairs.has(i)) i = pairs.get(i)! + 1;
    else break;
  }
  return tokens[i] === "(" || tokens[i] === "=";
}

function cssEvidence(code: string): boolean {
  // A rule/at-rule boundary outside strings/comments is positive syntax
  // evidence. Selectors/properties/at-rule names are deliberately not allowlisted.
  let brackets = 0;
  let parentheses = 0;
  let assignment = false;
  let invalidSelectorSyntax = false;
  for (let i = 0; i < code.length; i++) {
    const character = code[i];
    if (character === "\\") {
      i++;
      continue;
    }
    if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (character === "(") parentheses++;
    else if (character === ")") parentheses--;
    else if (character === "=" && !brackets && !parentheses) assignment = true;
    else if ((character === "/" || character === "<") && !brackets && !parentheses) invalidSelectorSyntax = true;
    if (brackets < 0 || parentheses < 0) return false;
    if (!brackets && !parentheses && (character === "{" || character === ";")) {
      const prelude = code.slice(0, i).trim();
      if (!prelude || /[{}]/u.test(prelude)) return false;
      if (prelude.startsWith("@")) return /^@[-\p{ID_Start}][\p{ID_Continue}-]*/u.test(prelude);
      return character === "{" && !assignment && !invalidSelectorSyntax && !prelude.startsWith("__literal__");
    }
  }
  return false;
}

function skipLeadingComments(source: string, javascript: boolean): string {
  let offset = 0;
  while (offset < source.length) {
    while (/\s/u.test(source[offset] ?? "")) offset++;
    if (source.startsWith("/*", offset)) {
      const end = source.indexOf("*/", offset + 2);
      if (end < 0) return "";
      offset = end + 2;
    } else if (javascript && source.startsWith("//", offset)) {
      const end = source.indexOf("\n", offset + 2);
      if (end < 0) return "";
      offset = end + 1;
    } else return source.slice(offset);
  }
  return "";
}

function maskLiteralsAndComments(source: string, javascript: boolean): string {
  const parts: string[] = [];
  for (let i = 0; i < source.length; ) {
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      parts.push(" ");
      if (end < 0) break;
      i = end + 2;
    } else if (javascript && source.startsWith("//", i)) {
      const end = source.indexOf("\n", i + 2);
      parts.push(" ");
      if (end < 0) break;
      i = end + 1;
    } else if (source[i] === '"' || source[i] === "'" || (javascript && source[i] === "`")) {
      const start = i;
      const quote = source[i++];
      while (i < source.length) {
        if (source[i] === "\\") i += 2;
        else if (source[i++] === quote) break;
      }
      let before = start - 1;
      let after = i;
      while (before >= 0 && /\s/u.test(source[before]!)) before--;
      while (after < source.length && /\s/u.test(source[after]!)) after++;
      const key = source.slice(start + 1, i - 1);
      // Preserve only plain browser-navigation member keys. All other literal
      // contents remain masked, so examples/login strings cannot become code evidence.
      parts.push(
        javascript && source[before] === "[" && source[after] === "]" && navigationKeys.has(key)
          ? ` __navigation_${key}__ `
          : " __literal__ ",
      );
    } else parts.push(source[i++]!);
  }
  return parts.join("");
}
