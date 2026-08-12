import { createHash } from "node:crypto";
import { collectAssets, detectFrontendParser, parseFrontendSchemas, validateLiveValues } from "./assets-live.js";
import { validateElementCatalog } from "./catalog.js";
import {
  collectPointReferences,
  emitFrontendSchemaOverrides,
  normalizePointDefinitions,
  pointMap,
  summarizePointReferences,
  validateElementValues,
  validatePointReferences,
} from "./points-schema.js";
import { parseV1Ui } from "./parser.js";
import type {
  FrontendSchemaOverride,
  UiAssetReference,
  UiPointReference,
  UiValidationInput,
  UiValidationIssue,
} from "./types.js";
import { addIssue, walkElements } from "./utils.js";

export type {
  UiAssetReference,
  UiIssueSeverity,
  UiPointReference,
  UiValidationInput,
  UiValidationIssue,
} from "./types.js";

export function validateV1Ui(input: UiValidationInput) {
  const parsed = parseV1Ui(input.content);
  const issues = [...parsed.errors];
  const pointReferences: UiPointReference[] = [];
  const assets: UiAssetReference[] = [];
  const actionMap = pointMap(normalizePointDefinitions(input.actions));
  const signalMap = pointMap(normalizePointDefinitions(input.signals));
  const parserDetection = detectFrontendParser(input.recipeFiles ?? []);
  const schemaMap = parseFrontendSchemas(input.schemasJson, issues);
  const frontendSchemaOverrides = new Map<string, FrontendSchemaOverride>();
  let elementCount = 0;

  if (parsed.root) {
    if (parsed.root.name !== "pages")
      addIssue(
        issues,
        parsed.root,
        "error",
        "UI_ROOT_INVALID",
        `Expected root element pages, found ${parsed.root.name}.`,
      );
    const stylesheet = parsed.processingInstructions.find((entry) => entry.target.toLowerCase() === "xml-stylesheet");
    if (
      !stylesheet ||
      !/\btype\s*=\s*["']text\/xsl["']/u.test(stylesheet.body) ||
      !/\bhref\s*=\s*["']v1\/index\.xsl["']/u.test(stylesheet.body)
    ) {
      issues.push({
        severity: "error",
        code: "UI_STYLESHEET_MISSING",
        message: 'V1 XML UI requires <?xml-stylesheet type="text/xsl" href="v1/index.xsl"?>.',
      });
    }
    const files = new Set(input.filePaths);
    walkElements(parsed.root, (element, parent) => {
      elementCount += 1;
      validateElementCatalog(element, parent, issues);
      collectPointReferences(element, pointReferences, issues);
      collectAssets(element, files, assets, issues);
      validateElementValues(
        element,
        parent,
        actionMap,
        signalMap,
        issues,
        parserDetection.detected,
        schemaMap,
        frontendSchemaOverrides,
      );
    });
  }

  emitFrontendSchemaOverrides(frontendSchemaOverrides, issues);
  validatePointReferences(pointReferences, actionMap, signalMap, issues, parserDetection.detected);
  const liveValues = input.liveEntries
    ? validateLiveValues(parsed.root, input.liveEntries, input.dynamicOptionWarningThreshold ?? 100, issues)
    : undefined;
  if (parserDetection.detected)
    issues.push({
      severity: "info",
      code: "UI_FRONTEND_PARSER_DETECTED",
      message:
        "Detected the standard Frontend XML parser. Parser-specific schema and generated-point checks were applied.",
      parserSpecific: true,
    });

  const boundedIssues = issues.slice(0, input.maxIssues ?? 200);
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  return {
    ok: errorCount === 0,
    format: "v1_xml_xslt",
    path: input.path,
    source: input.source,
    sha256: createHash("sha256").update(input.content).digest("hex"),
    summary: {
      elementCount,
      actionReferenceCount: pointReferences.filter((reference) => reference.kind === "action").length,
      eventReferenceCount: pointReferences.filter((reference) => reference.kind === "event").length,
      assetReferenceCount: assets.length,
      errorCount,
      warningCount,
      infoCount: issues.length - errorCount - warningCount,
      returnedIssueCount: boundedIssues.length,
      truncatedIssues: issues.length > boundedIssues.length,
    },
    issues: boundedIssues,
    generatedPoints: summarizePointReferences(pointReferences),
    assets,
    frontendParser: {
      detected: parserDetection.detected,
      matchedFingerprints: parserDetection.matched,
      schemaFilePresent: input.schemasJson !== undefined,
      schemaKeys: Object.keys(schemaMap),
    },
    liveValues,
  };
}
