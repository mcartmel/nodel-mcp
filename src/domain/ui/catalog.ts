import { getV1UiComponent } from "../../nodel/v1UiCatalog.js";
import type { UiElement } from "./parser.js";
import type { UiValidationIssue } from "./types.js";
import { addIssue, numberAttribute } from "./utils.js";

const universallyAllowedAttributes = new Set(["xmlns", "xmlns:xsi", "xsi:noNamespaceSchemaLocation"]);

export function validateElementCatalog(element: UiElement, parent: UiElement | undefined, issues: UiValidationIssue[]) {
  const component = getV1UiComponent(element.name);
  if (!component) {
    addIssue(
      issues,
      element,
      "warning",
      "UI_ELEMENT_UNKNOWN",
      `Element ${element.name} is not in the supported public v1 component catalog.`,
    );
    return;
  }
  const supported = new Set(component.attributes.map((attribute) => attribute.name));
  for (const attribute of Object.keys(element.attributes)) {
    if (!supported.has(attribute) && !universallyAllowedAttributes.has(attribute))
      addIssue(
        issues,
        element,
        "warning",
        "UI_ATTRIBUTE_UNSUPPORTED",
        `Attribute ${attribute} is unsupported or ignored on ${element.name}.`,
        attribute,
      );
  }
  for (const attribute of component.attributes) {
    const value = element.attributes[attribute.name];
    if (value === undefined) continue;
    if (attribute.values && !attribute.values.includes(value))
      addIssue(
        issues,
        element,
        "error",
        "UI_ATTRIBUTE_VALUE_UNSUPPORTED",
        `${element.name}@${attribute.name} must be one of: ${attribute.values.join(", ")}.`,
        attribute.name,
      );
    if ((attribute.type === "number" || attribute.type === "pixels") && numberAttribute(value) === undefined)
      addIssue(
        issues,
        element,
        "error",
        "UI_ATTRIBUTE_NUMBER_INVALID",
        `${element.name}@${attribute.name} must be numeric.`,
        attribute.name,
      );
    if (attribute.type === "1-12") {
      const width = numberAttribute(value);
      if (width === undefined || !Number.isInteger(width) || width < 1 || width > 12)
        addIssue(
          issues,
          element,
          "error",
          "UI_COLUMN_WIDTH_INVALID",
          `${element.name}@${attribute.name} must be an integer from 1 to 12.`,
          attribute.name,
        );
    }
  }
  if (
    element.attributes.class !== undefined &&
    (component.classPropagation.status === "ignored" || component.classPropagation.status === "unsupported")
  )
    addIssue(
      issues,
      element,
      "warning",
      "UI_CLASS_IGNORED",
      `XML class is ${component.classPropagation.status} on ${element.name}; use a propagated ancestor such as row for CSS scoping.`,
      "class",
    );
  for (const attribute of component.attributes.filter((candidate) => candidate.required)) {
    if (!hasNonEmptyAttribute(element, attribute.name))
      addIssue(
        issues,
        element,
        "error",
        "UI_ATTRIBUTE_REQUIRED",
        `${element.name} requires attribute ${attribute.name}.`,
        attribute.name,
      );
  }
  const requiredChildren =
    element.name === "row" && parent?.name === "grid" ? ["cell"] : (component.allowedChildren.required ?? []);
  for (const requiredChild of requiredChildren)
    if (!requiredChildPresent(element.children, requiredChild))
      addIssue(
        issues,
        element,
        "warning",
        "UI_CHILD_REQUIRED",
        `${element.name} normally requires a ${requiredChild} child.`,
      );
  for (const child of element.children)
    if (!childAllowed(component.allowedChildren.allowed, child.name))
      addIssue(
        issues,
        child,
        "warning",
        "UI_CHILD_UNSUPPORTED",
        `${child.name} is not a supported direct child of ${element.name}.`,
      );
  if (parent?.name === "grid" && element.name === "row" && element.children.some((child) => child.name !== "cell"))
    addIssue(
      issues,
      element,
      "warning",
      "UI_GRID_ROW_CHILD_INVALID",
      "Rows directly under grid should contain cell children.",
    );
  const join = element.attributes.join;
  if (join && (element.attributes.action || element.attributes.event))
    addIssue(
      issues,
      element,
      "warning",
      "UI_JOIN_OVERRIDES_POINTS",
      "join takes precedence over action/event on this element; remove the ignored attributes.",
      "join",
    );
  if (
    element.name === "button" &&
    element.attributes.type === "momentary" &&
    (element.attributes.action || element.attributes.join)
  )
    addIssue(
      issues,
      element,
      "warning",
      "UI_MOMENTARY_IGNORES_ACTION",
      "Momentary button uses action-on/action-off; normal action/join attributes are ignored.",
      "type",
    );
}

function childAllowed(allowed: readonly string[], childName: string) {
  const child = getV1UiComponent(childName);
  for (const rule of allowed.filter((entry) => entry.startsWith("any catalog"))) {
    if (!child) continue;
    if (rule.includes("non-document") && child.category !== "document") return true;
    const categories = ["content", "control", "layout"].filter((category) => rule.includes(category));
    if (!categories.includes(child.category)) continue;
    if (rule.includes("except document shell elements") && child.category === "document") continue;
    const exclusion = /except\s+(.+)$/u.exec(rule)?.[1]?.split("/") ?? [];
    if (!exclusion.includes(childName)) return true;
  }
  return allowed.includes("text content only")
    ? false
    : allowed.includes(childName) ||
        allowed.some((entry) => entry.endsWith("*") && childName.startsWith(entry.slice(0, -1)));
}

function requiredChildPresent(children: UiElement[], rule: string) {
  return rule.split(/\s+or\s+/u).some((name) => children.some((child) => child.name === name));
}
function hasNonEmptyAttribute(element: UiElement, name: string) {
  return typeof element.attributes[name] === "string" && element.attributes[name].trim().length > 0;
}
