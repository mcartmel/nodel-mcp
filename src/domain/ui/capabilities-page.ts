import { assertSafeRecipePath } from "../../nodel/pathPolicy.js";
import { NODEL_STATIC_ASSET_PATHS } from "../../nodel/http/staticAssets.js";
import { parseHtml, type HtmlNode } from "./html.js";
import { UI_ADVISORY_LIMITS } from "./limits.js";
import type { UiPageRuntimeContext, UiRuntimeReference } from "./capabilities-types.js";

/** Pure browser URL analysis. None of the resulting URLs are fetched. */
export function resolveUiPageRuntimeContext(
  nodeBaseUrl: string | undefined,
  path = "content/index.html",
  content?: string,
): UiPageRuntimeContext {
  assertSafeRecipePath(path);
  if (path.length > 4096) throw new TypeError("Page path exceeds the supported length.");
  const result: UiPageRuntimeContext = {
    storagePath: path,
    state: "not_inspected",
    apiResolution: "unchecked",
    references: [],
    limitations: [],
  };
  if (!path.startsWith("content/")) {
    result.state = "unchecked";
    result.limitations.push(
      "Page storage is outside content/; its browser-facing URL is not assumed. Prefer content/index.html or verify the custom serving layout manually.",
    );
    return result;
  }
  if (!nodeBaseUrl) {
    result.state = "unchecked";
    result.limitations.push("The node could not be resolved, so page-relative runtime/API URLs are unchecked.");
    return result;
  }
  const root = new URL(nodeBaseUrl.endsWith("/") ? nodeBaseUrl : `${nodeBaseUrl}/`);
  const page = new URL(path.slice("content/".length).split("/").map(encodeURIComponent).join("/"), root);
  result.browserUrl = page.toString();
  let base = page;
  if (content === undefined) {
    result.baseUrl = page.toString();
    result.apiResolution = apiResolution(page, root);
    result.limitations.push(
      "Page contents were not inspected; node-root assets do not verify the page's actual references or any <base> element.",
    );
    if (result.apiResolution !== "node_root") result.limitations.push(nestedAdvice);
    return result;
  }
  const parsed = parseHtml(content);
  const elements: HtmlNode[] = [];
  // Template content is inert until instantiated. Do not treat its runtime links
  // as references of the active page. Comments and raw script text are not elements.
  const stack = parsed.root ? [parsed.root] : [];
  while (stack.length && elements.length < UI_ADVISORY_LIMITS.maxVisitedNodes) {
    const element = stack.pop()!;
    elements.push(element);
    for (let i = (element.childNodes?.length ?? 0) - 1; i >= 0; i--) stack.push(element.childNodes![i]!);
  }
  const bases = elements.filter((element) => element.tagName === "base" && attribute(element, "href") !== undefined);
  let unsupportedBase = false;
  if (bases.length) {
    const value = attribute(bases[0]!, "href")!;
    try {
      base = new URL(value, page);
      if (!safeBrowserUrl(base) || value.includes("\\") || /\p{C}/u.test(value)) unsupportedBase = true;
    } catch {
      unsupportedBase = true;
    }
    if (bases.length > 1)
      result.limitations.push(
        "Only the first <base href> affects browser URL resolution; later base elements are ignored.",
      );
  }
  if (safeBrowserUrl(base)) result.baseUrl = displayUrl(base);
  result.apiResolution = unsupportedBase ? "unchecked" : apiResolution(base, root);
  let customAssets = false;
  let truncatedReferences = false;
  for (const element of elements) {
    const tag = element.tagName;
    const value =
      tag === "script"
        ? attribute(element, "src")
        : tag === "link" && /(?:^|\s)stylesheet(?:\s|$)/iu.test(attribute(element, "rel") ?? "")
          ? attribute(element, "href")
          : undefined;
    if (value === undefined) continue;
    const artifact = tag === "script" ? "script" : "stylesheet";
    const known = new RegExp(`(?:^|/)nodel-webui\\.${artifact === "script" ? "js" : "css"}(?:[?#]|$)`, "u").test(value);
    if (!known) {
      customAssets = true;
      continue;
    }
    if (result.references.length >= UI_ADVISORY_LIMITS.maxRuntimeReferences) {
      truncatedReferences = true;
      break;
    }
    const reference: UiRuntimeReference = { artifact, reference: displayReference(value), state: "unchecked" };
    result.references.push(reference);
    try {
      const url = new URL(value, base);
      if (!safeBrowserUrl(url) || value.includes("\\") || /\p{C}/u.test(value) || unsupportedBase) {
        reference.reason = "Unsupported URL/base syntax; verify it manually. It was not fetched.";
      } else if (url.origin !== root.origin) {
        reference.reason =
          "External runtime reference is unchecked and was not fetched. Use the node-root v2 assets or verify the external deployment manually.";
      } else {
        reference.resolvedUrl = displayUrl(url);
        const expected = new URL(NODEL_STATIC_ASSET_PATHS[artifact], root);
        if (url.pathname === expected.pathname && !url.search && !url.hash) reference.state = "matches_node_root";
        else {
          reference.state = "different_path";
          reference.reason =
            "This reference does not resolve to the fixed probed node-root artifact. Correct the path or verify the custom layout manually; no authored URL was fetched.";
        }
      }
    } catch {
      reference.reason = "Runtime reference could not be resolved and was not fetched.";
    }
  }
  const has = (artifact: "script" | "stylesheet") =>
    result.references.some((reference) => reference.artifact === artifact && reference.state === "matches_node_root");
  if (!parsed.complete || stack.length || truncatedReferences) {
    result.state = "incomplete";
    result.limitations.push(
      "Page/reference analysis reached a parsing or resource limit; unvisited markup remains unchecked.",
    );
  } else if (
    unsupportedBase ||
    result.apiResolution === "external" ||
    result.references.some((reference) => reference.state === "unchecked")
  )
    result.state = "unchecked";
  else if (
    result.references.some((reference) => reference.state === "different_path") ||
    result.apiResolution !== "node_root"
  )
    result.state = "mismatched";
  else if (has("script") && has("stylesheet")) result.state = "matches_node_root";
  else {
    result.state = "unchecked";
    result.limitations.push(
      "Both stable v2 entry references were not observed. Custom/hashed runtime layouts are not inferred; verify the page manually or use the stable node-root JS/CSS links.",
    );
  }
  if (result.apiResolution !== "node_root") result.limitations.push(nestedAdvice);
  if (customAssets)
    result.limitations.push(
      "Additional/custom scripts and styles were not fetched, executed, or validated; their behavior remains unchecked.",
    );
  result.limitations.push(
    "Reference matching is static URL evidence only, not a browser test or proof that components upgrade.",
  );
  return result;
}

const nestedAdvice =
  "v2 uses relative REST/ requests: nested pages or <base> can change API resolution independently of asset links. Prefer a node-root starter or verify both REST/ and asset URLs manually.";
function attribute(node: HtmlNode, name: string) {
  return node.attrs?.find((entry) => entry.name === name)?.value;
}
function safeBrowserUrl(url: URL) {
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}
function apiResolution(base: URL, root: URL): UiPageRuntimeContext["apiResolution"] {
  if (!safeBrowserUrl(base)) return "unchecked";
  const api = new URL("REST/", base);
  if (api.origin !== root.origin) return "external";
  return api.toString() === new URL("REST/", root).toString() ? "node_root" : "different_path";
}
function displayUrl(url: URL) {
  return `${url.origin}${url.pathname}`.slice(0, 2048);
}
function displayReference(value: string) {
  // Never include query tokens or embedded credentials in page diagnostics.
  try {
    if (/^(?:https?:)?\/\//iu.test(value)) return displayUrl(new URL(value, "https://reference.invalid"));
  } catch {
    return "[invalid absolute URL]";
  }
  return value.split(/[?#]/u, 1)[0]!.replace(/\p{C}/gu, "").slice(0, 300);
}
