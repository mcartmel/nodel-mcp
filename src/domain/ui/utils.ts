import type { UiElement } from "./parser.js";
import type { UiIssueSeverity, UiValidationIssue } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function addIssue(
  issues: UiValidationIssue[],
  element: UiElement,
  severity: UiIssueSeverity,
  code: string,
  message: string,
  attribute?: string,
  parserSpecific?: boolean,
) {
  issues.push({
    severity,
    code,
    message,
    element: element.name,
    attribute,
    line: element.line,
    column: element.column,
    parserSpecific,
  });
}

export function walkElements(
  element: UiElement,
  visit: (element: UiElement, parent?: UiElement) => void,
  parent?: UiElement,
) {
  visit(element, parent);
  for (const child of element.children) walkElements(child, visit, element);
}

export function numberAttribute(value: string | undefined) {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function approximatelyInteger(value: number) {
  return Math.abs(value - Math.round(value)) < 1e-9;
}
export function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
export function jsonType(value: unknown) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}
export function jsonEqual(left: unknown, right: unknown) {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
