import type { V2Contract, V2ContractElement } from "./contract.js";

/** Source-backed supplements to metadata omissions, not a fallback contract.
 * Only the inspected 0.2.0 runtime is known. Missing elements/features in the
 * SELECTED contract are never supplied from the bundled reference. */
export function knownRuntimeRules(contract: V2Contract) {
  return contract.schemaVersion === 1 && contract.packageVersion === "0.2.0";
}

export function declares(element: V2ContractElement | undefined, ...attributes: string[]) {
  return !!element && attributes.every((name) => element.attributes.some((attribute) => attribute.name === name));
}
