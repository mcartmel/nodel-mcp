import type { V2Attribute, V2Contract, V2ContractElement } from "../../domain/ui/v2/contract.js";
import { publicError } from "../../shared/publicErrors.js";

/** Explicit schema-1 fields, not an arbitrary property/path query into remote JSON. */
export const UI_REFERENCE_FIELDS = [
  "contract",
  "components",
  "component",
  "attributes",
  "commonAttributes",
  "attribute.values",
  "commonAttribute.values",
  "actionBindings",
  "actionBinding.phases",
  "signalBindings",
  "signalBinding.targets",
  "signalTarget.aggregations",
  "events",
  "event.detailFields",
  "aggregateSignalTargets",
  "composition.requiredDirectChildren",
  "composition.advisoryDirectChildren",
  "styles.semanticClasses",
  "styles.stateClasses",
  "styles.tailwindUtilities",
] as const;
export type UiReferenceField = (typeof UI_REFERENCE_FIELDS)[number];
export const UI_REFERENCE_TEXT_PROPERTIES = [
  "name",
  "description",
  "snippet",
  "packageVersion",
  "valueType",
  "syntax",
  "defaultValue",
  "defaultDescription",
  "legacy",
  "completion",
  "consumption",
  "lifecycle",
  "consumer",
  "numeric.unit",
  "defaultSignalTarget",
  "composition.requiredParent",
  "attribute",
  "defaultPhase",
  "defaultTarget",
] as const;
export type UiReferenceFieldInput = {
  field?: UiReferenceField;
  attributeName?: string;
  bindingAttribute?: string;
  targetName?: string;
  eventName?: string;
  fieldOffset?: number;
  fieldLimit?: number;
  textOffset?: number;
  textLimit?: number;
  textProperty?: (typeof UI_REFERENCE_TEXT_PROPERTIES)[number];
};

function splitsSurrogatePair(value: string, offset: number) {
  const previous = value.charCodeAt(offset - 1);
  const current = value.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
}

/** UTF-16 cursors, but never introduce a lone surrogate into a wire string. */
export function scalarTextEnd(value: string, start: number, limit: number) {
  const end = Math.min(value.length, start + limit);
  return splitsSurrogatePair(value, end) ? (end - 1 === start ? end + 1 : end - 1) : end;
}

/** Focused field pages retain every supported scalar via exact, non-executed text segments. */
export function v2FieldReference(
  contract: V2Contract,
  input: UiReferenceFieldInput & { components?: string[] },
  envelope: Record<string, unknown>,
  maxBytes: number,
) {
  const names = [...new Set(input.components ?? [])];
  const entry = names.length === 1 ? contract.elements.find((item) => item.name === names[0]) : undefined;
  const field = input.field!;
  const requireComponent = () => {
    if (!entry)
      throw publicError("VALIDATION", "This field requires one exact component present in the selected contract.");
    return entry;
  };
  const requireAttribute = (common = false) => {
    const attrs = common ? contract.commonAttributes : requireComponent().attributes;
    const found = attrs.find((item) => item.name === input.attributeName);
    if (!found) throw publicError("VALIDATION", "Select an exact attributeName from the selected attribute catalogue.");
    return found;
  };
  const requireAction = () => {
    const found = requireComponent().actionBindings.find((item) => item.attribute === input.bindingAttribute);
    if (!found) throw publicError("VALIDATION", "Select an exact bindingAttribute from actionBindings.");
    return found;
  };
  const requireSignal = () => {
    const found = requireComponent().signalBindings.find((item) => item.attribute === input.bindingAttribute);
    if (!found) throw publicError("VALIDATION", "Select an exact bindingAttribute from signalBindings.");
    return found;
  };
  const requireEvent = () => {
    const found = requireComponent().events.find((item) => item.name === input.eventName);
    if (!found) throw publicError("VALIDATION", "Select an exact eventName from events.");
    return found;
  };
  const requireTarget = () => {
    const found = requireSignal().targets.find((item) => item.name === input.targetName);
    if (!found) throw publicError("VALIDATION", "Select an exact targetName from signalBinding.targets.");
    return found;
  };
  const requestedTextLimit = Math.min(512, Math.max(1, input.textLimit ?? 512));
  let textLimit = requestedTextLimit;
  const textOffset = Math.min(16000, Math.max(0, input.textOffset ?? 0));
  const offset = Math.min(12000, Math.max(0, input.fieldOffset ?? 0));
  const requestedLimit = Math.min(100, Math.max(1, input.fieldLimit ?? 20));
  let limit = requestedLimit;
  let segmented = false;
  const supportedProperties = new Set<string>();
  const segment = (value: string | undefined, property?: string) => {
    if (property) supportedProperties.add(property);
    if (input.textProperty && input.textProperty !== property) return undefined;
    if (value === undefined) return undefined;
    const start = Math.min(textOffset, value.length);
    if (splitsSurrogatePair(value, start))
      throw publicError(
        "VALIDATION",
        "textOffset splits a UTF-16 surrogate pair; use the preceding offset or the segment's nextOffset.",
      );
    const text = value.slice(start, scalarTextEnd(value, start, textLimit));
    const hasMore = start + text.length < value.length;
    if (hasMore || start > 0) segmented = true;
    return {
      text,
      offset: start,
      returned: text.length,
      total: value.length,
      hasMore,
      nextOffset: hasMore ? start + text.length : undefined,
    };
  };
  const ref = (field: UiReferenceField, total: number) => ({
    field,
    total,
    note: "Retrieve separately with fieldOffset/fieldLimit; exact string tails use textOffset/textLimit.",
  });
  const attr = (value: V2Attribute, common: boolean) => ({
    name: segment(value.name, "name"),
    description: segment(value.description, "description"),
    valueType: segment(value.valueType, "valueType"),
    syntax: segment(value.syntax, "syntax"),
    defaultValue: segment(value.defaultValue, "defaultValue"),
    defaultDescription: segment(value.defaultDescription, "defaultDescription"),
    common: value.common,
    legacy: segment(value.legacy, "legacy"),
    completable: value.completable,
    completion: segment(value.completion, "completion"),
    consumption: segment(value.consumption, "consumption"),
    lifecycle: segment(value.lifecycle, "lifecycle"),
    consumer: segment(value.consumer, "consumer"),
    values: value.values ? ref(common ? "commonAttribute.values" : "attribute.values", value.values.length) : undefined,
    numeric: value.numeric
      ? {
          integer: value.numeric.integer,
          normalizesToInteger: value.numeric.normalizesToInteger,
          min: value.numeric.min,
          exclusiveMin: value.numeric.exclusiveMin,
          max: value.numeric.max,
          unit: segment(value.numeric.unit, "numeric.unit"),
          clamp: value.numeric.clamp,
        }
      : undefined,
  });
  const component = (value: V2ContractElement) => ({
    name: segment(value.name, "name"),
    description: segment(value.description, "description"),
    snippet: segment(value.snippet, "snippet"),
    audience: value.audience,
    registration: value.registration,
    completion: value.completion,
    catalogue: value.catalogue,
    defaultSignalTarget: segment(value.defaultSignalTarget, "defaultSignalTarget"),
    aggregateSignalTargets: ref("aggregateSignalTargets", value.aggregateSignalTargets?.length ?? 0),
    attributes: ref("attributes", value.attributes.length),
    actionBindings: ref("actionBindings", value.actionBindings.length),
    signalBindings: ref("signalBindings", value.signalBindings.length),
    events: ref("events", value.events.length),
    composition: value.composition
      ? {
          requiredParent: segment(value.composition.requiredParent, "composition.requiredParent"),
          requiredDirectChildren: ref(
            "composition.requiredDirectChildren",
            value.composition.requiredDirectChildren?.length ?? 0,
          ),
          advisoryDirectChildren: ref(
            "composition.advisoryDirectChildren",
            value.composition.advisoryDirectChildren?.length ?? 0,
          ),
        }
      : undefined,
  });
  const page = <T>(values: T[], project: (value: T) => unknown) => ({
    total: values.length,
    items: values.slice(offset, offset + limit).map((value) => project(value)),
  });
  const source = () => {
    switch (field) {
      case "contract":
        return page([contract], (item) => ({
          schemaVersion: item.schemaVersion,
          packageVersion: segment(item.packageVersion, "packageVersion"),
        }));
      case "components":
        return page(contract.elements, component);
      case "component":
        return page([requireComponent()], component);
      case "attributes":
        return page(
          requireComponent().attributes.filter((item) => !input.attributeName || item.name === input.attributeName),
          (item) => attr(item, false),
        );
      case "commonAttributes":
        return page(
          contract.commonAttributes.filter((item) => !input.attributeName || item.name === input.attributeName),
          (item) => attr(item, true),
        );
      case "attribute.values":
        return page(requireAttribute().values ?? [], segment);
      case "commonAttribute.values":
        return page(requireAttribute(true).values ?? [], segment);
      case "actionBindings":
        return page(requireComponent().actionBindings, (item) => ({
          attribute: segment(item.attribute, "attribute"),
          defaultPhase: segment(item.defaultPhase, "defaultPhase"),
          phases: ref("actionBinding.phases", item.phases.length),
        }));
      case "actionBinding.phases":
        return page(requireAction().phases, segment);
      case "signalBindings":
        return page(requireComponent().signalBindings, (item) => ({
          attribute: segment(item.attribute, "attribute"),
          defaultTarget: segment(item.defaultTarget, "defaultTarget"),
          targets: ref("signalBinding.targets", item.targets.length),
        }));
      case "signalBinding.targets":
        return page(requireSignal().targets, (item) => ({
          name: segment(item.name, "name"),
          aggregations: ref("signalTarget.aggregations", item.aggregations.length),
        }));
      case "signalTarget.aggregations":
        return page(requireTarget().aggregations, segment);
      case "events":
        return page(requireComponent().events, (item) => ({
          name: segment(item.name, "name"),
          description: segment(item.description, "description"),
          bubbles: item.bubbles,
          composed: item.composed,
          detailFields: ref("event.detailFields", item.detailFields.length),
        }));
      case "event.detailFields":
        return page(requireEvent().detailFields, segment);
      case "aggregateSignalTargets":
        return page(requireComponent().aggregateSignalTargets ?? [], segment);
      case "composition.requiredDirectChildren":
        return page(requireComponent().composition?.requiredDirectChildren ?? [], segment);
      case "composition.advisoryDirectChildren":
        return page(requireComponent().composition?.advisoryDirectChildren ?? [], segment);
      case "styles.semanticClasses":
      case "styles.stateClasses":
      case "styles.tailwindUtilities": {
        const key = field.slice("styles.".length) as keyof V2Contract["styles"];
        return page(contract.styles[key], (item) => ({
          name: segment(item.name, "name"),
          description: segment(item.description, "description"),
        }));
      }
    }
  };
  const build = () => {
    segmented = false;
    supportedProperties.clear();
    const all = source();
    const items = all.items;
    if (input.textProperty && items.length && !supportedProperties.has(input.textProperty))
      throw publicError(
        "VALIDATION",
        "textProperty is not a supported text property for the selected field items; omit it for scalar arrays.",
      );
    const hasMore = offset + items.length < all.total;
    return {
      ...envelope,
      fieldResponse: {
        field,
        items,
        offset,
        requestedLimit,
        limit: items.length,
        returned: items.length,
        total: all.total,
        hasMore,
        nextOffset: hasMore ? offset + items.length : undefined,
        truncated: items.length < Math.min(requestedLimit, Math.max(0, all.total - offset)),
        textProperty: input.textProperty,
        textOffset,
        requestedTextLimit,
        textLimit,
        textUnits:
          "UTF-16 code units; scalar-safe segments may exceed textLimit=1 by one unit. Mid-pair textOffset is rejected; follow nextOffset and concatenate without ellipses.",
        notice:
          "Explicit contract-field discovery may include hidden/core/internal metadata; discoverability is not an ordinary authoring recommendation.",
      },
      output: {
        maxSerializedBytes: maxBytes,
        truncated: limit < requestedLimit || textLimit < requestedTextLimit || segmented,
        paging:
          "Advance fieldOffset using fieldResponse.nextOffset; for independent string cursors select one item (fieldLimit=1) and its allowlisted textProperty, then advance textOffset using that segment's nextOffset. Omit textProperty for scalar arrays. Arrays are references to explicit supported fields, never silently truncated tails. No downloaded code or snippet is executed.",
      },
    };
  };
  let response = build();
  while (Buffer.byteLength(JSON.stringify({ ok: true, ...response }, null, 2)) > maxBytes) {
    if (limit > 1) limit = Math.max(1, Math.floor(limit / 2));
    else if (textLimit > 1) textLimit = Math.max(1, Math.floor(textLimit / 2));
    else throw new Error("UI field metadata exceeded the fixed output budget.");
    response = build();
  }
  return response;
}
