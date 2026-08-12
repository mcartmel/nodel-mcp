// Compatibility facade and public catalog API.
export * from "./v1UiCatalog/shared.js";

import { V1_DOCUMENT_COMPONENTS } from "./v1UiCatalog/document.js";
import { V1_LAYOUT_COMPONENTS } from "./v1UiCatalog/layout.js";
import { V1_CONTENT_COMPONENTS } from "./v1UiCatalog/content.js";
import { V1_CONTROL_COMPONENTS } from "./v1UiCatalog/control.js";
import { V1_STATE_COMPONENTS } from "./v1UiCatalog/state.js";
import { V1_BUILTIN_COMPONENTS } from "./v1UiCatalog/builtin.js";
import { V1_UI_CSS_RECIPES } from "./v1UiCatalog/cssRecipes.js";
import type {
  V1UiComponent,
  V1UiComponentCategory,
  V1UiComponentIndexEntry,
  V1UiCssRecipe,
} from "./v1UiCatalog/shared.js";

export { V1_UI_CSS_RECIPES };

export const V1_UI_COMPONENTS = [
  ...V1_DOCUMENT_COMPONENTS,
  ...V1_LAYOUT_COMPONENTS,
  ...V1_CONTENT_COMPONENTS,
  ...V1_CONTROL_COMPONENTS,
  ...V1_STATE_COMPONENTS,
  ...V1_BUILTIN_COMPONENTS,
] as const satisfies readonly V1UiComponent[];

export const V1_UI_COMPONENT_NAMES = V1_UI_COMPONENTS.map((component) => component.name);

export const V1_UI_COMPONENT_INDEX = V1_UI_COMPONENTS.map((component) => ({
  name: component.name,
  category: component.category,
  summary: component.summary,
  variants: component.variants.map((variant) => variant.name),
  classPropagation: component.classPropagation.status,
})) satisfies V1UiComponentIndexEntry[];

const COMPONENTS_BY_NAME: ReadonlyMap<string, V1UiComponent> = new Map(
  V1_UI_COMPONENTS.map((component) => [component.name, component]),
);

const normalizeLookupName = (name: string) => name.trim().toLowerCase();

export function getV1UiComponent(name: string): V1UiComponent | undefined {
  return COMPONENTS_BY_NAME.get(normalizeLookupName(name));
}

export function getV1UiComponents(names: readonly string[]) {
  const components: V1UiComponent[] = [];
  const unknown: string[] = [];

  for (const name of names) {
    const component = getV1UiComponent(name);
    if (component) components.push(component);
    else unknown.push(name);
  }

  return { components, unknown };
}

export function getV1UiComponentIndex(category?: V1UiComponentCategory): V1UiComponentIndexEntry[] {
  return V1_UI_COMPONENT_INDEX.filter((entry) => !category || entry.category === category);
}

const levenshteinDistance = (left: string, right: string) => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length] ?? 0;
};

export function suggestV1UiComponents(name: string, limit = 5): string[] {
  const normalized = normalizeLookupName(name);
  return [...V1_UI_COMPONENT_NAMES]
    .sort((left, right) => {
      const leftIncludes = left.includes(normalized) || normalized.includes(left) ? -10 : 0;
      const rightIncludes = right.includes(normalized) || normalized.includes(right) ? -10 : 0;
      return (
        leftIncludes + levenshteinDistance(normalized, left) - (rightIncludes + levenshteinDistance(normalized, right))
      );
    })
    .slice(0, Math.max(0, limit));
}

export function getV1ClassPropagationSummary() {
  return {
    propagates: V1_UI_COMPONENTS.filter((component) => component.classPropagation.status === "propagates").map(
      (component) => component.name,
    ),
    partial: V1_UI_COMPONENTS.filter((component) => component.classPropagation.status === "partial").map(
      (component) => component.name,
    ),
    ignored: V1_UI_COMPONENTS.filter((component) => component.classPropagation.status === "ignored").map(
      (component) => component.name,
    ),
    unsupported: V1_UI_COMPONENTS.filter((component) => component.classPropagation.status === "unsupported").map(
      (component) => component.name,
    ),
  };
}

const CSS_RECIPES_BY_NAME: ReadonlyMap<string, V1UiCssRecipe> = new Map(
  V1_UI_CSS_RECIPES.map((recipe) => [recipe.name, recipe]),
);

export function getV1UiCssRecipe(name: string): V1UiCssRecipe | undefined {
  return CSS_RECIPES_BY_NAME.get(normalizeLookupName(name));
}

export function getV1UiCssRecipes(names?: readonly string[]) {
  if (!names || names.length === 0) return { recipes: [...V1_UI_CSS_RECIPES], unknown: [] as string[] };

  const recipes: V1UiCssRecipe[] = [];
  const unknown: string[] = [];

  for (const name of names) {
    const recipe = getV1UiCssRecipe(name);
    if (recipe) recipes.push(recipe);
    else unknown.push(name);
  }

  return { recipes, unknown };
}

const rbrace = /^(?:\{[\w\W]*\}|\[[\w\W]*\])$/;

export function isV1JQueryCanonicalNumberLiteral(value: string): boolean {
  return value === `${Number(value)}`;
}

export function decodeV1DataAttribute(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;

  if (isV1JQueryCanonicalNumberLiteral(value)) return Number(value);

  if (rbrace.test(value)) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }

  return value;
}
