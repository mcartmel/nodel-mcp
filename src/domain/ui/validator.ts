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
import { diagnosticCollector } from "./diagnostics.js";
import { UI_ADVISORY_LIMITS } from "./limits.js";

export type {
  UiAssetReference,
  UiIssueSeverity,
  UiPointReference,
  UiValidationInput,
  UiValidationIssue,
} from "./types.js";

export function validateV1Ui(input: UiValidationInput) {
  const parsed = parseV1Ui(input.content);
  // Preserve the existing v1 tool's advertised 1..1000 output option. The
  // default remains 200; retained diagnostics still have a hard bound.
  const diagnostics = diagnosticCollector(input.maxIssues, 1000);
  const { issues } = diagnostics;
  issues.push(...parsed.errors);
  const pointReferences: UiPointReference[] = [];
  const assets: UiAssetReference[] = [];
  const actionMap = pointMap(normalizePointDefinitions(input.actions));
  const signalMap = pointMap(normalizePointDefinitions(input.signals));
  const parserDetection = detectFrontendParser(input.recipeFiles ?? []);
  const schemaMap = parseFrontendSchemas(input.schemasJson, issues);
  const frontendSchemaOverrides = new Map<string, FrontendSchemaOverride>();
  let elementCount = 0;
  let remainingWork = UI_ADVISORY_LIMITS.maxVisitedNodes;
  let workTruncated = false;

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
      // Reserve work before rules parse action arrays or emit reference objects.
      // Attribute characters give a conservative upper bound on array entries.
      const cost =
        1 +
        Object.entries(element.attributes).reduce(
          (total, [name, value]) => total + (name === "action" || name === "join" ? value.length : 1),
          0,
        );
      if (cost > remainingWork || workTruncated) {
        workTruncated = true;
        return;
      }
      remainingWork -= cost;
      elementCount += 1;
      validateElementCatalog(element, parent, issues, parsed.complete);
      collectPointReferences(element, pointReferences, issues);
      collectAssets(element, files, assets, issues, input.filePathsAvailable !== false);
      validateElementValues(
        element,
        parent,
        actionMap,
        signalMap,
        issues,
        parserDetection.detected && input.schemasAvailable !== false,
        schemaMap,
        frontendSchemaOverrides,
      );
    });
  }

  emitFrontendSchemaOverrides(frontendSchemaOverrides, issues);
  if (input.schemasAvailable === false)
    issues.push({
      severity: "info",
      code: "UI_FRONTEND_SCHEMA_CHECK_SKIPPED",
      message: "Frontend schema-dependent checks were skipped because schema context was unavailable or malformed.",
      parserSpecific: true,
    });
  if (workTruncated)
    issues.push({
      severity: "info",
      code: "UI_V1_RULE_WORK_TRUNCATED",
      message: "Rule/reference work limit reached; unvisited checks are unknown and counts are lower bounds.",
    });
  if (input.actionsAvailable !== false && input.signalsAvailable !== false) {
    validatePointReferences(pointReferences, actionMap, signalMap, issues, parserDetection.detected);
  } else {
    validatePointReferences(
      pointReferences.filter((reference) =>
        reference.kind === "action" ? input.actionsAvailable !== false : input.signalsAvailable !== false,
      ),
      actionMap,
      signalMap,
      issues,
      parserDetection.detected,
    );
    if (input.actionsAvailable === false)
      issues.push({
        severity: "info",
        code: "UI_ACTION_CHECK_SKIPPED",
        message: "Action existence checks were skipped because action discovery was unavailable.",
      });
    if (input.signalsAvailable === false)
      issues.push({
        severity: "info",
        code: "UI_EVENT_CHECK_SKIPPED",
        message: "Event existence checks were skipped because event discovery was unavailable.",
      });
  }
  const liveValues = input.liveEntries
    ? validateLiveValues(parsed.root, input.liveEntries, input.dynamicOptionWarningThreshold ?? 100, issues)
    : undefined;
  if (parserDetection.detected)
    issues.push({
      severity: "info",
      code: "UI_FRONTEND_PARSER_DETECTED",
      message:
        input.schemasAvailable === false
          ? "Detected the standard Frontend XML parser. Schema-dependent checks remain unavailable."
          : "Detected the standard Frontend XML parser. Parser-specific schema and generated-point checks were applied.",
      parserSpecific: true,
    });

  const boundedIssues = issues;
  const errorCount = diagnostics.counts.error;
  const warningCount = diagnostics.counts.warning;
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
      infoCount: diagnostics.counts.info,
      returnedIssueCount: boundedIssues.length,
      truncatedIssues: diagnostics.truncated,
      incomplete:
        !parsed.complete ||
        diagnostics.truncated ||
        workTruncated ||
        input.actionsAvailable === false ||
        input.signalsAvailable === false ||
        input.schemasAvailable === false ||
        input.filePathsAvailable === false,
      countsAreLowerBounds: !parsed.complete || workTruncated,
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
    parse: { complete: parsed.complete, truncationReason: parsed.truncationReason, omittedErrors: 0 },
  };
}
