export { parseProcessingInstructions, parseV1Ui } from "./parser.js";
export { canonicalPointName, schemaTypes } from "./points-schema.js";
export { isExternalUiAsset, normalizeUiAssetPath } from "./assets-live.js";
export { validateV1Ui } from "./validator.js";
export { analyzeUiCandidate, verifyUiFile, UI_PATH } from "./service.js";
export type { UiAnalysisOptions } from "./service.js";
export { validateV2Ui } from "./v2/validator.js";
export type { V2ValidationOptions } from "./v2/validator.js";
export type {
  FrontendSchemaOverride,
  PointDefinition,
  UiAssetReference,
  UiIssueSeverity,
  UiPointReference,
  UiValidationInput,
  UiValidationIssue,
} from "./types.js";
