// Compatibility facade for existing consumers; validation implementation is domain-owned.
export { validateV1Ui } from "../domain/ui/validator.js";
export type {
  UiAssetReference,
  UiIssueSeverity,
  UiPointReference,
  UiValidationInput,
  UiValidationIssue,
} from "../domain/ui/types.js";
