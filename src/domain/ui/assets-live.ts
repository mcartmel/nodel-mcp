import type { UiElement } from "./parser.js";
import type { UiAssetReference, UiValidationIssue } from "./types.js";
import { canonicalPointName } from "./points-schema.js";
import { addIssue, isRecord, jsonType, walkElements } from "./utils.js";
import { sanitizeSensitiveMessage } from "../../shared/publicErrors.js";

const frontendParserFingerprints = ["loadIndexFile", "schemaMap", "schemaMap.get(eType)", "e.get('join')"];

export function normalizeUiAssetPath(value: string) {
  const stripped = value.split(/[?#]/u, 1)[0]?.replace(/^\/+/, "") ?? "";
  return stripped.startsWith("content/") ? stripped : `content/${stripped}`;
}

export function isExternalUiAsset(value: string) {
  return /^(?:https?:)?\/\//iu.test(value) || /^(?:data:|#)/iu.test(value);
}

export function collectAssets(
  element: UiElement,
  files: Set<string>,
  assets: UiAssetReference[],
  issues: UiValidationIssue[],
) {
  const candidates: Array<[string, string | undefined]> =
    element.name === "pages"
      ? [
          ["css", element.attributes.css],
          ["js", element.attributes.js],
          ["logo", element.attributes.logo],
        ]
      : element.name === "image"
        ? [["source", element.attributes.source]]
        : [];
  for (const [attribute, value] of candidates) {
    if (!value) continue;
    const external = isExternalUiAsset(value);
    const builtIn = /^\/?v1\//iu.test(value);
    const normalizedPath = external || builtIn ? undefined : normalizeUiAssetPath(value);
    const exists = normalizedPath ? files.has(normalizedPath) : undefined;
    assets.push({
      element: element.name,
      attribute,
      value,
      normalizedPath,
      external,
      builtIn,
      exists,
      line: element.line,
      column: element.column,
    });
    if (normalizedPath && !exists)
      addIssue(
        issues,
        element,
        "warning",
        "UI_ASSET_MISSING",
        `Referenced asset ${value} was not found as ${normalizedPath}.`,
        attribute,
      );
  }
}

export function validateLiveValues(
  root: UiElement | undefined,
  entries: unknown[],
  threshold: number,
  issues: UiValidationIssue[],
) {
  if (!root) return [];
  const latest = new Map<string, unknown>();
  for (const entry of entries)
    if (isRecord(entry) && typeof entry.alias === "string") latest.set(canonicalPointName(entry.alias), entry.arg);
  const summaries: Array<{
    point: string;
    type: string;
    optionCount?: number;
  }> = [];
  walkElements(root, (element) => {
    const point = element.attributes.data;
    if (!point || (element.name !== "dynamicselect" && element.name !== "dynamicbuttongroup")) return;
    const value = latest.get(canonicalPointName(point));
    if (value === undefined) return;
    const optionCount = Array.isArray(value) ? value.length : undefined;
    summaries.push({ point, type: jsonType(value), optionCount });
    if (!Array.isArray(value)) {
      addIssue(
        issues,
        element,
        "warning",
        "UI_DYNAMIC_VALUE_NOT_ARRAY",
        `Dynamic selector ${point} currently emits ${jsonType(value)}, not an array.`,
        "data",
      );
    } else {
      if (value.length > threshold)
        addIssue(
          issues,
          element,
          "warning",
          "UI_DYNAMIC_OPTIONS_LARGE",
          `Dynamic selector ${point} currently has ${value.length} options; v1 renders all options without virtualization.`,
          "data",
        );
      if (value.some((entry) => !isRecord(entry) || typeof entry.value !== "string"))
        addIssue(
          issues,
          element,
          "warning",
          "UI_DYNAMIC_OPTION_SHAPE_INVALID",
          `Dynamic selector ${point} expects each option to contain a string value and optional key.`,
          "data",
        );
    }
  });
  return summaries;
}

export function detectFrontendParser(files: Array<{ path: string; content: string }>) {
  const source = files.map((file) => file.content).join("\n");
  const matched = frontendParserFingerprints.filter((fingerprint) => source.includes(fingerprint));
  return { detected: matched.length >= 3, matched };
}

export function parseFrontendSchemas(content: string | undefined, issues: UiValidationIssue[]) {
  if (!content) return {};
  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed)) return parsed;
    issues.push({
      severity: "warning",
      code: "UI_SCHEMAS_INVALID",
      message: "content/schemas.json must contain a JSON object.",
      parserSpecific: true,
    });
  } catch (error) {
    issues.push({
      severity: "warning",
      code: "UI_SCHEMAS_PARSE_ERROR",
      message: `content/schemas.json could not be parsed: ${sanitizeSensitiveMessage(error)}`,
      parserSpecific: true,
    });
  }
  return {};
}
