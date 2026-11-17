import { readFile } from "node:fs/promises";

const sourceRoot = new URL("../src/", import.meta.url);
const compiledRoot = new URL("../dist/", import.meta.url);

function compiledURL(url) {
  if (!url.startsWith(sourceRoot.href)) return undefined;
  const source = new URL(url);
  if (source.search || source.hash) throw new Error(`Coverage requires a canonical production URL: ${url}`);
  const relative = source.href.slice(sourceRoot.href.length);
  if (relative.endsWith(".d.ts")) throw new Error(`Cannot execute a declaration file: ${url}`);
  return new URL(relative.replace(/\.ts$/u, ".js"), compiledRoot).href;
}

export async function resolve(specifier, context, nextResolve) {
  // Map before tsx resolves .js -> .ts. This also supports explicit .ts imports
  // and file URLs, without redirecting dependencies or test helpers outside src.
  let requested;
  if (specifier.startsWith(".") || specifier.startsWith("file:")) {
    requested = compiledURL(new URL(specifier, context.parentURL).href);
  }
  const result = await nextResolve(requested ?? specifier, context);
  // Catch any source aliases resolved by another hook as well. Missing compiled
  // modules fail resolution; never silently fall back to a second representation.
  const mapped = compiledURL(result.url);
  return mapped ? nextResolve(mapped, context) : result;
}

export async function load(url, context, nextLoad) {
  if (compiledURL(url)) throw new Error(`Coverage cannot execute production TypeScript directly: ${url}`);
  if (url.startsWith(compiledRoot.href)) {
    assertCanonicalCoverage([{ url }]);
    if (new URL(url).pathname.endsWith(".js")) {
      // Do not pass production JS through tsx either: all workers must execute
      // the exact tsc bytes, including its original sourceMappingURL comment.
      return { format: "module", source: await readFile(new URL(url), "utf8"), shortCircuit: true };
    }
  }
  return nextLoad(url, context);
}

export function assertCanonicalCoverage(scripts) {
  for (const { url } of scripts) {
    // Async ESM hooks do not intercept CommonJS require(). Fail the coverage
    // run if a future test bypasses this loader, rather than ignoring that file
    // or merging its incompatible offsets into the compiled representation.
    if (url.startsWith(sourceRoot.href)) throw new Error(`Noncanonical production coverage: ${url}`);
    if (url.startsWith(compiledRoot.href) && (new URL(url).search || new URL(url).hash)) {
      throw new Error(`Noncanonical compiled coverage URL: ${url}`);
    }
  }
}
