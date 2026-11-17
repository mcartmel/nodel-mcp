import type { UiValidationIssue } from "../types.js";
import { resolveUiPageRuntimeContext } from "../capabilities-page.js";
import type { UiCapabilities } from "../capabilities-types.js";
import { parseHtml, walkHtml, type HtmlParseResult, type HtmlNode } from "../html.js";
import { diagnosticCollector } from "../diagnostics.js";

/** Static reference assessment only. Authored URLs are never fetched here. */
export function validateV2Assets(
  path: string,
  content: string,
  capabilities?: UiCapabilities,
  filePaths?: string[],
  parsedInput?: HtmlParseResult,
  sink?: UiValidationIssue[],
  rules = { known: false },
) {
  const issues: UiValidationIssue[] = sink ?? diagnosticCollector().issues;
  const page = resolveUiPageRuntimeContext(capabilities?.target?.nodeBaseUrl, path, content);
  const parsed = parsedInput ?? parseHtml(content);
  const nodes: HtmlNode[] = [];
  // Runtime resources in inert templates are not active page entry assets.
  const inert = new WeakSet<HtmlNode>();
  walkHtml(parsed.root, (node) => {
    if (node.parentNode && inert.has(node.parentNode)) inert.add(node);
    if (node.content) inert.add(node.content);
    if (!inert.has(node)) nodes.push(node);
  });
  const refs = page.references;
  const get = (node: (typeof nodes)[number], name: string) => node.attrs?.find((attr) => attr.name === name)?.value;
  const located = (node: HtmlNode, attribute: string, fallbackAttribute?: string) => {
    const source =
      node.sourceCodeLocation?.attrs?.[attribute] ??
      (fallbackAttribute ? node.sourceCodeLocation?.attrs?.[fallbackAttribute] : undefined) ??
      node.sourceCodeLocation?.startTag;
    return {
      line: source?.startLine,
      column: source?.startCol,
      location: source
        ? {
            line: source.startLine,
            column: source.startCol,
            startOffset: source.startOffset,
            endOffset: source.endOffset,
          }
        : undefined,
    };
  };
  for (const node of nodes) {
    const src = get(node, "src");
    if (
      rules.known &&
      node.tagName === "script" &&
      src &&
      /(?:^|\/)nodel-webui\.js(?:[?#]|$)/u.test(src) &&
      get(node, "type")?.trim().toLowerCase() !== "module"
    )
      issues.push({
        severity: "error",
        code: "UI_V2_SCRIPT_MODULE_REQUIRED",
        message: 'The v2 entry script requires type="module".',
        element: "script",
        attribute: "type",
        ...located(node, "type", "src"),
        suggestion: 'Add type="module" to this script element, keeping its src unchanged.',
        provenance: { rule: "v2-module-entry", source: "nodel-webui-v2 stable ES module entry" },
      });
  }
  if (!rules.known)
    issues.push({
      severity: "info",
      code: "UI_V2_ENTRY_RULES_UNCHECKED",
      message:
        "Entry-module and runtime-mode supplements are unknown for the selected runtime version; its contract was not supplemented from the bundled reference.",
    });
  const supportUnknown = !!capabilities?.state && capabilities.state !== "available";
  if (supportUnknown)
    issues.push({
      severity: "warning",
      code: "UI_V2_RUNTIME_SUPPORT_UNCONFIRMED",
      message: `Deployment support is ${capabilities.state}; contract validation does not confirm that runtime entry assets are available.`,
    });
  const files = filePaths === undefined ? undefined : new Set(filePaths);
  if (!files)
    issues.push({
      severity: "info",
      code: "UI_V2_ASSET_CHECK_SKIPPED",
      message: "Recipe file listing was unavailable; local asset coverage is unknown.",
    });
  // Reuse the canonical storage-segment encoding and active-page <base> rules.
  // A synthetic root is ONLY for relative local arithmetic when the runtime is
  // unresolved; outside content/ there is intentionally no browser URL at all.
  const root = new URL(capabilities?.target?.nodeBaseUrl ?? "https://static.invalid/");
  if (!root.pathname.endsWith("/")) root.pathname += "/";
  const localPage = page.browserUrl ? page : resolveUiPageRuntimeContext(root.toString(), path, content);
  const base =
    localPage.browserUrl &&
    localPage.baseUrl &&
    localPage.baseUrl.length < 2048 &&
    localPage.apiResolution !== "unchecked"
      ? new URL(localPage.baseUrl)
      : undefined;
  if (!base)
    issues.push({
      severity: "info",
      code: "UI_V2_ASSET_PATH_UNCHECKED",
      message: "The page's browser-facing path/base is unknown; local asset resolution was skipped.",
      suggestion: "Use a content/ page or verify its custom serving layout manually.",
    });
  if (files && base)
    for (const node of nodes) {
      const candidates = node.tagName === "link" ? ["href"] : ["src", "poster"];
      for (const attribute of candidates) {
        const value = get(node, attribute);
        if (!value || /\{\{|\$\{|^(?:data:|blob:|#)/iu.test(value)) continue;
        try {
          const url = new URL(value, base);
          if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) continue;
          const local = decodeURIComponent(url.pathname.slice(root.pathname.length));
          if (/^(?:v1|v2)\//u.test(local)) continue; // shared runtime evidence is independent
          const storagePath = `content/${local}`;
          if (!files.has(storagePath))
            issues.push({
              severity: "warning",
              code: "UI_V2_ASSET_MISSING",
              message: `Local asset ${storagePath} was not found in the recipe listing; it may be served from shared content.`,
              element: node.tagName,
              attribute,
              ...located(node, attribute),
              suggestion: `Verify ${storagePath} exists or correct this ${attribute} URL; the asset may instead be served from shared content.`,
              provenance: {
                rule: "v2-local-assets",
                source: "capabilities-page canonical page/base URL and recipe file catalogue",
              },
            });
        } catch {
          /* Invalid/custom reference is not fetched or guessed. */
        }
      }
    }
  if (!refs.some((ref) => ref.artifact === "script" && ref.state === "matches_node_root"))
    issues.push({
      severity: "warning",
      code: "UI_V2_SCRIPT_REFERENCE",
      message: "Stable node-root v2 script reference was not confirmed; custom or hashed layouts remain unchecked.",
      provenance: { rule: "v2-stable-assets", source: "capabilities-page" },
    });
  if (!refs.some((ref) => ref.artifact === "stylesheet" && ref.state === "matches_node_root"))
    issues.push({
      severity: "warning",
      code: "UI_V2_STYLESHEET_REFERENCE",
      message: "Stable node-root v2 stylesheet reference was not confirmed; custom or hashed layouts remain unchecked.",
      provenance: { rule: "v2-stable-assets", source: "capabilities-page" },
    });
  if (page.state === "mismatched")
    issues.push({
      severity: "warning",
      code: "UI_V2_RUNTIME_REFERENCE_MISMATCH",
      message:
        "The page's stable runtime references or base path do not resolve to the probed node-root assets; no authored URL was fetched.",
    });
  if (page.apiResolution !== "node_root")
    issues.push({
      severity: "warning",
      code: "UI_V2_API_PATH_UNCHECKED",
      message: "Relative REST/ resolution is not node-root; nested pages and <base> can change API targeting.",
    });
  if (
    rules.known &&
    nodes.some((node) => node.attrs?.some((attr) => attr.name === "data-nodel-runtime" && attr.value === "memory"))
  )
    issues.push({
      severity: "warning",
      code: "UI_V2_MEMORY_RUNTIME",
      message: 'data-nodel-runtime="memory" is a catalogue/demo mode and must not be copied into a deployed page.',
    });
  if (
    nodes.some(
      (node) =>
        node.tagName === "script" &&
        node.attrs?.some((attr) => attr.name === "src" && /(?:^|\/)src\//u.test(attr.value)),
    )
  )
    issues.push({
      severity: "warning",
      code: "UI_V2_SOURCE_IMPORT",
      message: "A development /src/ script reference is not a stable deployed runtime asset.",
    });
  return {
    issues,
    incomplete: supportUnknown || !files || !base || !rules.known,
    page,
    limitations: [...page.limitations, "External assets and authored references are not fetched or executed."],
  };
}
