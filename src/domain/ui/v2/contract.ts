import bundledContract from "../../../nodel/v2/contract.json" with { type: "json" };
import provenance from "../../../nodel/v2/provenance.json" with { type: "json" };

export interface V2NumericConstraint {
  integer?: boolean;
  normalizesToInteger?: boolean;
  min?: number;
  exclusiveMin?: boolean;
  max?: number;
  unit?: string;
  clamp?: boolean;
}
export interface V2Attribute {
  name: string;
  description: string;
  values?: string[];
  valueType?: string;
  syntax?: string;
  numeric?: V2NumericConstraint;
  defaultValue?: string;
  defaultDescription?: string;
  common?: boolean;
  legacy?: string;
  completable?: boolean;
  completion?: string;
  consumption?: string;
  lifecycle?: string;
  consumer?: string;
}
export interface V2ContractElement {
  name: string;
  description: string;
  attributes: V2Attribute[];
  snippet?: string;
  catalogue?: boolean;
  defaultSignalTarget?: string;
  aggregateSignalTargets?: string[];
  audience: string;
  registration: string;
  completion: string;
  actionBindings: { attribute: string; phases: string[]; defaultPhase?: string }[];
  signalBindings: { attribute: string; defaultTarget?: string; targets: { name: string; aggregations: string[] }[] }[];
  events: { name: string; description: string; bubbles: boolean; composed: boolean; detailFields: string[] }[];
  composition?: { requiredParent?: string; requiredDirectChildren?: string[]; advisoryDirectChildren?: string[] };
}
export interface V2Contract {
  schemaVersion: 1;
  packageVersion: string;
  commonAttributes: V2Attribute[];
  elements: V2ContractElement[];
  styles: {
    semanticClasses: { name: string; description: string }[];
    stateClasses: { name: string; description: string }[];
    tailwindUtilities: { name: string; description: string }[];
  };
}
export interface ContractDecodeResult {
  ok: boolean;
  contract?: V2Contract;
  errors: string[];
  limitations: string[];
}

const MAX_DEPTH = 32;
const MAX_ITEMS = 12000;
const MAX_STRING = 16000;
const MAX_ELEMENTS = 512;
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function decodeV2Contract(input: unknown): ContractDecodeResult {
  const errors: string[] = [];
  const limitations: string[] = [];
  let items = 0;
  const fail = (path: string, message: string) => {
    if (errors.length < 100) errors.push(`${path}: ${message}`);
  };
  const walk = (value: unknown, path: string, depth: number): void => {
    if (++items > MAX_ITEMS) {
      fail(path, "contract exceeds item limit");
      return;
    }
    if (depth > MAX_DEPTH) {
      fail(path, "contract exceeds nesting limit");
      return;
    }
    if (typeof value === "string") {
      if (value.length > MAX_STRING) fail(path, "string exceeds length limit");
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_ITEMS) fail(path, "array exceeds item limit");
      for (let i = 0; i < Math.min(value.length, MAX_ITEMS); i++) walk(value[i], `${path}[${i}]`, depth + 1);
      return;
    }
    if (isRecord(value))
      for (const [key, entry] of Object.entries(value)) {
        if (key.length > 128 || ["__proto__", "prototype", "constructor"].includes(key))
          fail(path, `unsafe object key ${key.slice(0, 40)}`);
        walk(entry, `${path}.${key}`, depth + 1);
      }
  };
  walk(input, "$", 0);
  const required = (
    value: Record<string, unknown>,
    key: string,
    type: "string" | "array" | "boolean" | "number",
    path: string,
  ): unknown => {
    if (!own(value, key)) {
      fail(`${path}.${key}`, "required field is missing");
      return undefined;
    }
    const entry = value[key];
    const valid = type === "array" ? Array.isArray(entry) : typeof entry === type;
    if (!valid) fail(`${path}.${key}`, `expected ${type}`);
    return valid ? entry : undefined;
  };
  const text = (value: unknown, path: string, optional = false): void => {
    if (value === undefined && optional) return;
    if (typeof value !== "string" || !value.trim() || value.length > MAX_STRING)
      fail(path, "expected non-empty bounded string");
  };
  const bool = (value: unknown, path: string): void => {
    if (value !== undefined && typeof value !== "boolean") fail(path, "expected boolean");
  };
  const strArray = (value: unknown, path: string): void => {
    if (!Array.isArray(value)) {
      fail(path, "expected array");
      return;
    }
    const seen = new Set<string>();
    value.forEach((entry, i) => {
      text(entry, `${path}[${i}]`);
      if (typeof entry === "string") {
        if (seen.has(entry)) fail(`${path}[${i}]`, "duplicate value");
        seen.add(entry);
      }
    });
  };
  const uniqueNames = (value: unknown, path: string): Set<string> => {
    const names = new Set<string>();
    if (!Array.isArray(value)) {
      fail(path, "expected array");
      return names;
    }
    value.forEach((entry, i) => {
      if (!isRecord(entry)) {
        fail(`${path}[${i}]`, "expected object");
        return;
      }
      text(entry.name, `${path}[${i}].name`);
      if (typeof entry.name === "string") {
        if (names.has(entry.name)) fail(`${path}[${i}].name`, "duplicate name");
        names.add(entry.name);
      }
    });
    return names;
  };
  const validateAttrs = (attrs: unknown, path: string): Set<string> => {
    const names = uniqueNames(attrs, path);
    if (!Array.isArray(attrs)) return names;
    attrs.forEach((raw, i) => {
      if (!isRecord(raw)) return;
      const at = `${path}[${i}]`;
      text(raw.description, `${at}.description`);
      for (const key of ["valueType", "completion", "consumption", "lifecycle"]) text(raw[key], `${at}.${key}`);
      const enumValues: Record<string, string[]> = {
        valueType: [
          "boolean",
          "presence-or-text",
          "string",
          "binding",
          "enum",
          "enum-or-string",
          "number",
          "integer",
          "template-data",
        ],
        completion: ["recommended", "advanced", "hidden"],
        consumption: ["observed", "initialization", "parent", "contextual-child", "wildcard"],
        lifecycle: ["dynamic", "initialization"],
      };
      for (const [key, choices] of Object.entries(enumValues))
        if (raw[key] !== undefined && (typeof raw[key] !== "string" || !choices.includes(raw[key] as string)))
          fail(`${at}.${key}`, `unsupported known ${key} semantic`);
      if (raw.values !== undefined) strArray(raw.values, `${at}.values`);
      if (raw.values !== undefined && Array.isArray(raw.values) && raw.values.length === 0)
        fail(`${at}.values`, "must not be empty when provided");
      if (raw.values !== undefined && !["enum", "enum-or-string"].includes(String(raw.valueType)))
        fail(`${at}.values`, "values require enum or enum-or-string valueType");
      if (Array.isArray(raw.values) && typeof raw.defaultValue === "string" && !raw.values.includes(raw.defaultValue))
        fail(`${at}.defaultValue`, "enum default is not accepted");
      for (const key of ["common", "completable"]) bool(raw[key], `${at}.${key}`);
      for (const key of ["syntax", "defaultValue", "defaultDescription", "legacy", "consumer"])
        text(raw[key], `${at}.${key}`, true);
      if (typeof raw.defaultValue === "string") {
        if (raw.valueType === "boolean" && raw.defaultValue !== "true" && raw.defaultValue !== "false")
          fail(`${at}.defaultValue`, "boolean default must be true or false");
        if (raw.valueType === "number" && !Number.isFinite(Number(raw.defaultValue)))
          fail(`${at}.defaultValue`, "number default must be finite");
        if (raw.valueType === "integer" && !Number.isInteger(Number(raw.defaultValue)))
          fail(`${at}.defaultValue`, "integer default must be an integer");
      }
      if (raw.numeric !== undefined) {
        if (!isRecord(raw.numeric)) fail(`${at}.numeric`, "expected object");
        else {
          const n = raw.numeric;
          for (const key of ["min", "max"])
            if (n[key] !== undefined && (typeof n[key] !== "number" || !Number.isFinite(n[key])))
              fail(`${at}.numeric.${key}`, "expected finite number");
          for (const key of ["integer", "normalizesToInteger", "exclusiveMin", "clamp"])
            bool(n[key], `${at}.numeric.${key}`);
          text(n.unit, `${at}.numeric.unit`, true);
          if (typeof n.min === "number" && typeof n.max === "number" && n.min > n.max)
            fail(`${at}.numeric`, "minimum exceeds maximum");
          if (typeof n.min === "number" && n.min === n.max && n.exclusiveMin === true)
            fail(`${at}.numeric`, "exclusive minimum cannot equal maximum");
          if (n.exclusiveMin === true && typeof n.min !== "number") fail(`${at}.numeric.exclusiveMin`, "requires min");
          if (!["number", "integer"].includes(String(raw.valueType)))
            fail(`${at}.numeric`, "numeric constraints require a numeric valueType");
          if (typeof raw.defaultValue === "string") {
            const value = Number(raw.defaultValue);
            if (
              !Number.isFinite(value) ||
              (typeof n.min === "number" && (n.exclusiveMin === true ? value <= n.min : value < n.min)) ||
              (typeof n.max === "number" && value > n.max)
            )
              fail(`${at}.defaultValue`, "outside numeric range");
          }
        }
      }
    });
    return names;
  };
  if (!isRecord(input)) return { ok: false, errors: ["$: expected object"], limitations };
  required(input, "schemaVersion", "number", "$");
  if (input.schemaVersion !== 1) fail("$.schemaVersion", "unsupported schema version");
  text(required(input, "packageVersion", "string", "$"), "$.packageVersion");
  const common = validateAttrs(required(input, "commonAttributes", "array", "$"), "$.commonAttributes");
  if (common.size === 0) fail("$.commonAttributes", "must not be empty");
  const elementsRaw = required(input, "elements", "array", "$");
  const elementNames = uniqueNames(elementsRaw, "$.elements");
  if (elementNames.size === 0) fail("$.elements", "must not be empty");
  if (elementNames.size > MAX_ELEMENTS) fail("$.elements", "too many components");
  if (Array.isArray(elementsRaw))
    elementsRaw.forEach((raw, i) => {
      if (!isRecord(raw)) return;
      const path = `$.elements[${i}]`;
      text(raw.description, `${path}.description`);
      for (const key of ["audience", "registration", "completion"]) text(raw[key], `${path}.${key}`);
      if (!["custom", "core", "internal"].includes(String(raw.audience)))
        fail(`${path}.audience`, "unsupported audience");
      if (!["eager", "lazy", "auto-host"].includes(String(raw.registration)))
        fail(`${path}.registration`, "unsupported registration");
      if (!["recommended", "advanced", "hidden"].includes(String(raw.completion)))
        fail(`${path}.completion`, "unsupported completion");
      if (
        raw.registration === "auto-host" &&
        (raw.audience !== "internal" || raw.completion !== "hidden" || raw.catalogue === true)
      )
        fail(path, "auto-host elements must be internal, hidden, and not catalogue-visible");
      const attrs = validateAttrs(required(raw, "attributes", "array", path), `${path}.attributes`);
      if (raw.catalogue !== undefined) bool(raw.catalogue, `${path}.catalogue`);
      text(raw.snippet, `${path}.snippet`, true);
      text(raw.defaultSignalTarget, `${path}.defaultSignalTarget`, true);
      if (raw.aggregateSignalTargets !== undefined)
        strArray(raw.aggregateSignalTargets, `${path}.aggregateSignalTargets`);
      for (const field of ["actionBindings", "signalBindings", "events"])
        if (!Array.isArray(required(raw, field, "array", path))) continue;
      if (Array.isArray(raw.actionBindings))
        uniqueFieldValues(raw.actionBindings, "attribute", `${path}.actionBindings`, fail);
      if (Array.isArray(raw.actionBindings))
        raw.actionBindings.forEach((binding, j) => {
          const p = `${path}.actionBindings[${j}]`;
          if (!isRecord(binding)) {
            fail(p, "expected object");
            return;
          }
          text(binding.attribute, `${p}.attribute`);
          strArray(binding.phases, `${p}.phases`);
          text(binding.defaultPhase, `${p}.defaultPhase`, true);
          if (typeof binding.attribute === "string" && !attrs.has(binding.attribute))
            fail(`${p}.attribute`, "references undefined attribute");
          if (Array.isArray(binding.phases) && binding.phases.length === 0) fail(`${p}.phases`, "must not be empty");
          if (
            typeof binding.defaultPhase === "string" &&
            Array.isArray(binding.phases) &&
            !binding.phases.includes(binding.defaultPhase)
          )
            fail(`${p}.defaultPhase`, "not listed in phases");
        });
      if (Array.isArray(raw.signalBindings))
        uniqueFieldValues(raw.signalBindings, "attribute", `${path}.signalBindings`, fail);
      if (Array.isArray(raw.signalBindings))
        raw.signalBindings.forEach((binding, j) => {
          const p = `${path}.signalBindings[${j}]`;
          if (!isRecord(binding)) {
            fail(p, "expected object");
            return;
          }
          text(binding.attribute, `${p}.attribute`);
          text(binding.defaultTarget, `${p}.defaultTarget`, true);
          if (typeof binding.attribute === "string" && !attrs.has(binding.attribute))
            fail(`${p}.attribute`, "references undefined attribute");
          uniqueNames(binding.targets, `${p}.targets`);
          if (Array.isArray(binding.targets) && binding.targets.length === 0) fail(`${p}.targets`, "must not be empty");
          if (Array.isArray(binding.targets)) {
            const targetNames = new Set(
              binding.targets
                .filter(isRecord)
                .map((target) => target.name)
                .filter((name): name is string => typeof name === "string"),
            );
            if (typeof binding.defaultTarget === "string" && !targetNames.has(binding.defaultTarget))
              fail(`${p}.defaultTarget`, "references an undefined signal target");
            binding.targets.forEach((target, k) => {
              if (isRecord(target)) {
                strArray(target.aggregations, `${p}.targets[${k}].aggregations`);
                if (
                  Array.isArray(target.aggregations) &&
                  target.aggregations.some((item) => item !== "any" && item !== "all")
                )
                  fail(`${p}.targets[${k}].aggregations`, "aggregation must be any or all");
              }
            });
          }
        });
      if (Array.isArray(raw.events)) {
        uniqueNames(raw.events, `${path}.events`);
        raw.events.forEach((event, j) => {
          const p = `${path}.events[${j}]`;
          if (!isRecord(event)) {
            fail(p, "expected object");
            return;
          }
          text(event.name, `${p}.name`);
          text(event.description, `${p}.description`);
          if (typeof event.bubbles !== "boolean") fail(`${p}.bubbles`, "expected boolean");
          if (typeof event.composed !== "boolean") fail(`${p}.composed`, "expected boolean");
          strArray(event.detailFields, `${p}.detailFields`);
        });
      }
      if (raw.composition !== undefined) {
        if (!isRecord(raw.composition)) fail(`${path}.composition`, "expected object");
        else
          for (const key of ["requiredParent", "requiredDirectChildren", "advisoryDirectChildren"]) {
            const v = raw.composition[key];
            if (key === "requiredParent" && v !== undefined) text(v, `${path}.composition.${key}`);
            else if (v !== undefined) strArray(v, `${path}.composition.${key}`);
            for (const ref of typeof v === "string" ? [v] : Array.isArray(v) ? v : [])
              if (typeof ref === "string" && !elementNames.has(ref) && ref !== "template")
                fail(`${path}.composition.${key}`, `unknown component reference ${ref}`);
          }
      }
    });
  const styles = input.styles;
  if (!isRecord(input.styles)) fail("$.styles", "expected object");
  else
    for (const key of ["semanticClasses", "stateClasses", "tailwindUtilities"]) {
      const entries = required(input.styles, key, "array", "$.styles");
      const names = uniqueNames(entries, `$.styles.${key}`);
      if (names.size === 0) fail(`$.styles.${key}`, "must not be empty");
      if (Array.isArray(entries))
        entries.forEach((entry, i) => {
          if (isRecord(entry)) text(entry.description, `$.styles.${key}[${i}].description`);
        });
      void names;
    }
  void styles;
  if (input.schemaVersion === 1 && errors.length === 0)
    limitations.push(
      "Schema 1 metadata does not fully encode runtime behavior for all custom elements; validation remains advisory.",
    );
  if (errors.length) return { ok: false, errors, limitations };
  const contract = JSON.parse(JSON.stringify(input)) as V2Contract;
  return { ok: true, contract: deepFreeze(contract), errors, limitations };
}

function uniqueFieldValues(
  entries: unknown[],
  field: string,
  path: string,
  fail: (path: string, message: string) => void,
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry[field] !== "string") return;
    const value = entry[field] as string;
    if (seen.has(value)) fail(`${path}[${index}].${field}`, "duplicate value");
    seen.add(value);
  });
}

export const PINNED_V2_CONTRACT: V2Contract = (() => {
  const decoded = decodeV2Contract(bundledContract);
  if (!decoded.contract) throw new Error(`Invalid bundled v2 contract: ${decoded.errors.join("; ")}`);
  return deepFreeze(decoded.contract);
})();
export const PINNED_V2_PROVENANCE = deepFreeze(provenance);

export type ContractSource =
  | { kind: "deployed"; compatibility: "verified-contract"; contract: V2Contract; limitations: string[] }
  | {
      kind: "bundled";
      compatibility: "unverified";
      contract: V2Contract;
      detectionFailure: string;
      limitations: string[];
    };
export function selectV2Contract(deployed: unknown, deploymentFailure: string): ContractSource {
  const result = decodeV2Contract(deployed);
  if (result.contract)
    return {
      kind: "deployed",
      compatibility: "verified-contract",
      contract: result.contract,
      limitations: result.limitations,
    };
  return {
    kind: "bundled",
    compatibility: "unverified",
    contract: PINNED_V2_CONTRACT,
    detectionFailure: `${deploymentFailure}${result.errors.length ? `; invalid deployed contract: ${result.errors.slice(0, 4).join("; ")}` : ""}`,
    limitations: [
      "Pinned fallback is authoring reference only and does not establish deployment compatibility.",
      ...result.limitations,
    ],
  };
}

export interface V2ReferenceOptions {
  query?: string;
  audience?: "custom" | "core" | "internal" | "all";
  completion?: "recommended" | "advanced" | "hidden" | "all";
  offset?: number;
  limit?: number;
}
export function listV2Components(contract: V2Contract = PINNED_V2_CONTRACT, options: V2ReferenceOptions = {}) {
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 40)));
  const query = options.query?.trim().toLowerCase();
  const all = contract.elements.filter((item) => {
    const audienceMatches =
      options.audience === "all" ||
      (options.audience === undefined ? item.audience !== "internal" : item.audience === options.audience);
    const completionMatches =
      options.completion === "all" ||
      (options.completion === undefined ? item.completion === "recommended" : item.completion === options.completion);
    return (
      audienceMatches &&
      completionMatches &&
      (!query || `${item.name} ${item.description}`.toLowerCase().includes(query))
    );
  });
  return {
    components: all.slice(offset, offset + limit).map(({ name, description, audience, completion, catalogue }) => ({
      name,
      description,
      audience,
      completion,
      catalogue,
    })),
    total: all.length,
    offset,
    limit,
    hasMore: offset + limit < all.length,
  };
}
export function getV2Component(name: string, contract: V2Contract = PINNED_V2_CONTRACT) {
  return contract.elements.find((item) => item.name === name);
}
