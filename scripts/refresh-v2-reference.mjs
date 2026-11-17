#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const MAX_CATALOGUE_BYTES = 4 * 1024 * 1024;
const MAX_CATALOGUE_NODES = 100_000;
const MAX_CATALOGUE_DEPTH = 512;
const [mode, ...args] = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  if (!args[index]?.startsWith("--") || !args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error(`Invalid argument near ${args[index] ?? "end"}`);
  options[args[index].slice(2)] = args[index + 1];
}
if (options.starter && options.catalogue) throw new Error("Use exactly one of --starter or --catalogue");
if (!options.starter && !options.catalogue) throw new Error("Provide exactly one of --starter or --catalogue");
const required = ["artifact", "repository", "revision", "package-version", "schema-version", "license"];
for (const key of required) if (!options[key]) throw new Error(`Missing --${key}`);
if (!/^[0-9a-f]{40}$/iu.test(options.revision))
  throw new Error("--revision must be an immutable 40-character Git commit SHA");
if (options["schema-version"] !== "1") throw new Error("Only schema version 1 is supported by this refresh script");
const artifactPath = resolve(options.artifact);
const raw = await readFile(artifactPath);
let starterText;
if (options.starter) {
  const starter = await readFile(resolve(options.starter));
  starterText = new TextDecoder("utf-8", { fatal: true }).decode(starter);
} else {
  const cataloguePath = resolve(options.catalogue);
  const catalogueInfo = await stat(cataloguePath);
  if (catalogueInfo.size > MAX_CATALOGUE_BYTES)
    throw new Error(`Catalogue exceeds the ${MAX_CATALOGUE_BYTES}-byte limit`);
  const catalogueBytes = await readFile(cataloguePath);
  if (catalogueBytes.byteLength > MAX_CATALOGUE_BYTES)
    throw new Error(`Catalogue exceeds the ${MAX_CATALOGUE_BYTES}-byte limit`);
  const catalogue = new TextDecoder("utf-8", { fatal: true }).decode(catalogueBytes);
  // Maintainer source workflow only: reuse the production tokenizer/tree-work
  // budgets rather than parsing unboundedly and checking the resulting tree.
  let html;
  try {
    html = await import("../dist/domain/ui/html.js");
    if (typeof html.parseHtml !== "function" || typeof html.walkHtml !== "function")
      throw new Error("Compiled HTML helper exports are unavailable");
  } catch (cause) {
    throw new Error("Catalogue mode requires the compiled bounded HTML helper; run npm run build first", { cause });
  }
  const parsed = html.parseHtml(catalogue, {
    maxBytes: MAX_CATALOGUE_BYTES,
    maxNodes: MAX_CATALOGUE_NODES,
    maxDepth: MAX_CATALOGUE_DEPTH,
    maxAttributesPerTag: 128,
    maxTagCharacters: 65_536,
    maxErrorEvents: 200,
    maxTreeOperations: 2_000_000,
  });
  if (!parsed.complete || parsed.truncated || !parsed.root)
    throw new Error(`Catalogue HTML parsing is incomplete: ${parsed.truncationReason ?? "parse_failed"}`);
  if (parsed.errorCount || parsed.errors.length)
    throw new Error(`Catalogue HTML has parse errors: ${parsed.errors[0]?.code ?? "unknown"}`);
  const nodes = [];
  const walked = html.walkHtml(parsed.root, (node) => nodes.push(node), MAX_CATALOGUE_NODES, MAX_CATALOGUE_DEPTH);
  if (walked.truncationReason) throw new Error(`Catalogue HTML traversal is incomplete: ${walked.truncationReason}`);
  const attr = (node, name) => node.attrs?.some((item) => item.name === name) ?? false;
  const pages = nodes.filter((node) => node.tagName === "nodel-page" && attr(node, "data-catalogue-quickstart"));
  const snippets = nodes.filter((node) => node.tagName === "pre" && attr(node, "data-catalogue-quickstart-code"));
  if (pages.length !== 1 || snippets.length !== 1)
    throw new Error("Catalogue must contain exactly one marked Quickstart page and code block");
  let ancestor = snippets[0].parentNode;
  while (ancestor && ancestor !== pages[0]) ancestor = ancestor.parentNode;
  if (ancestor !== pages[0]) throw new Error("Marked Quickstart code block is outside its Quickstart page");
  const codeElements = snippets[0].childNodes.filter((node) => node.tagName === "code");
  if (codeElements.length !== 1 || snippets[0].childNodes.some((node) => node.tagName && node.tagName !== "code"))
    throw new Error("Marked Quickstart block must contain exactly one code element");
  const code = codeElements[0];
  if (code.childNodes.some((node) => node.nodeName !== "#text"))
    throw new Error("Quickstart code must be text, not nested markup");
  const extracted = code.childNodes.map((node) => node.value).join("");
  // parse5 has already decoded HTML character references once. Keep all interior text,
  // normalize HTML line endings, and guarantee the single final newline in the pin.
  starterText = `${extracted.replace(/\r\n?/gu, "\n").replace(/\n+$/u, "")}\n`;
}
if (
  !starterText.includes("./v2/nodel-webui.css") ||
  !starterText.includes("./v2/nodel-webui.js") ||
  starterText.indexOf("./v2/nodel-webui.css") > starterText.indexOf("./v2/nodel-webui.js") ||
  !starterText.includes('theme="dark"') ||
  /\/src\/|data-nodel-runtime="memory"|catalogue/i.test(starterText)
)
  throw new Error(
    "Starter must use stable ordered ./v2 assets, fixed dark theme, and omit catalogue/memory references",
  );
const document = JSON.parse(raw.toString("utf8"));
if (document.schemaVersion !== 1 || document.packageVersion !== options["package-version"])
  throw new Error("Artifact schema/package version does not match explicit provenance");
const hash = createHash("sha256").update(raw).digest("hex");
const starterBytes = Buffer.from(starterText, "utf8");
const starterHash = createHash("sha256").update(starterBytes).digest("hex");
const contractPath = resolve(root, "src/nodel/v2/contract.json");
const provenancePath = resolve(root, "src/nodel/v2/provenance.json");
const starterPath = resolve(root, "src/nodel/v2/quickstart.json");
if (mode === "--check") {
  const [bundled, recorded, bundledStarter] = await Promise.all([
    readFile(contractPath),
    readFile(provenancePath, "utf8"),
    readFile(starterPath),
  ]);
  if (!bundled.equals(raw)) throw new Error("Bundled contract differs from supplied artifact; run refresh");
  if (!bundledStarter.equals(Buffer.from(`${JSON.stringify(starterText)}\n`)))
    throw new Error("Bundled Quickstart differs from supplied starter; run refresh");
  const provenance = JSON.parse(recorded);
  if (
    provenance.sha256 !== hash ||
    provenance.contentHash !== hash ||
    provenance.starterSha256 !== starterHash ||
    provenance.repository !== options.repository ||
    provenance.revision !== options.revision ||
    provenance.packageVersion !== options["package-version"] ||
    provenance.schemaVersion !== Number(options["schema-version"]) ||
    provenance.license !== options.license
  )
    throw new Error("Bundled provenance does not match explicit provenance or artifact hash");
  console.log(`v2 contract reference verified: sha256 ${hash}`);
} else if (mode === "--refresh") {
  const provenance = {
    repository: options.repository,
    revision: options.revision,
    packageVersion: options["package-version"],
    schemaVersion: Number(options["schema-version"]),
    license: options.license,
    sha256: hash,
    contentHash: hash,
    starterSha256: starterHash,
    sourceArtifact: options["source-artifact"] ?? "v2/nodel-components.json",
    attribution: "nodel-webui-v2; Mozilla Public License 2.0",
  };
  await mkdir(resolve(root, "src/nodel/v2"), { recursive: true });
  await writeFile(contractPath, raw);
  await writeFile(starterPath, `${JSON.stringify(starterText)}\n`);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`refreshed v2 contract reference: sha256 ${hash}`);
} else {
  throw new Error(
    "Usage: node scripts/refresh-v2-reference.mjs (--refresh|--check) --artifact PATH (--starter PATH | --catalogue PATH) --repository URL --revision 40-CHAR-SHA --package-version VERSION --schema-version 1 --license MPL-2.0 [--source-artifact PATH]",
  );
}
