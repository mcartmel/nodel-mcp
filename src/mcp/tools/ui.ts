import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NodelClient } from "../../nodel/client.js";
import { verifyUiFile } from "../../domain/ui/index.js";
import { v1XmlUiGuidance } from "../../nodel/uiGuidelines.js";
import {
  V1_UI_CATALOG_METADATA,
  V1_UI_COMPONENT_INDEX,
  V1_UI_CSS_RECIPES,
  getV1UiComponents,
  getV1UiCssRecipes,
  suggestV1UiComponents,
} from "../../nodel/v1UiCatalog.js";
import { localReadOnlyToolAnnotations, remoteReadOnlyToolAnnotations } from "../toolAnnotations.js";
import { toolResult } from "./common.js";
import { publicError } from "../../shared/publicErrors.js";

const UI_PATH = "content/index.xml";

export function registerUiTools(server: McpServer, nodelClient: NodelClient) {
  server.registerTool(
    "nodel.get_ui_guidelines",
    {
      title: "Get UI Guidelines",
      description: "Return bundled legacy v1 XML/XSLT dashboard construction guidance and a component index.",
      inputSchema: {},
      annotations: localReadOnlyToolAnnotations,
    },
    async () => toolResult(async () => v1XmlUiGuidance()),
  );

  server.registerTool(
    "nodel.get_ui_component_reference",
    {
      title: "Get UI Component Reference",
      description:
        "Return filtered source-backed v1 XML component markup, classes, point rules, CSS defaults, and practical CSS recipes.",
      inputSchema: {
        components: z.array(z.string().min(1)).max(20).optional(),
        includeMarkup: z.boolean().optional().default(true),
        includeCss: z.boolean().optional().default(true),
        includeExamples: z.boolean().optional().default(true),
        cssRecipes: z.array(z.string().min(1)).max(20).optional(),
      },
      annotations: localReadOnlyToolAnnotations,
    },
    async ({ components, includeMarkup, includeCss, includeExamples, cssRecipes }) =>
      toolResult(async () =>
        componentReference(components, includeMarkup ?? true, includeCss ?? true, includeExamples ?? true, cssRecipes),
      ),
  );

  server.registerTool(
    "nodel.verify_ui_file",
    {
      title: "Verify UI File",
      description:
        "Validate a saved or proposed legacy v1 XML UI against XML/XSLT rules, live node points/schemas, assets, and detected Frontend parser behavior.",
      inputSchema: {
        node: z.string().min(1),
        path: z.string().min(1).optional().default(UI_PATH),
        content: z.string().max(2_000_000).optional(),
        includeLiveValues: z.boolean().optional().default(false),
        dynamicOptionWarningThreshold: z.number().int().min(1).max(10000).optional().default(100),
        maxIssues: z.number().int().min(1).max(1000).optional().default(200),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ node, path, content, includeLiveValues, dynamicOptionWarningThreshold, maxIssues }) =>
      toolResult(async () =>
        verifyUiFile(
          nodelClient,
          node,
          path ?? UI_PATH,
          content,
          includeLiveValues ?? false,
          dynamicOptionWarningThreshold ?? 100,
          maxIssues ?? 200,
        ),
      ),
  );
}

export function componentReference(
  componentNames: string[] | undefined,
  includeMarkup = true,
  includeCss = true,
  includeExamples = true,
  cssRecipeNames?: string[],
) {
  if (!componentNames || componentNames.length === 0) {
    return {
      catalogMetadata: V1_UI_CATALOG_METADATA,
      componentIndex: V1_UI_COMPONENT_INDEX,
      cssRecipeIndex: V1_UI_CSS_RECIPES.map(({ name, title, components, description }) => ({
        name,
        title,
        components,
        description,
      })),
      message:
        "Pass components to retrieve focused generated markup/CSS details; the full catalog is intentionally not returned by default.",
    };
  }

  const selected = getV1UiComponents(componentNames);
  if (selected.unknown.length > 0) {
    throw publicError(
      "VALIDATION",
      selected.unknown
        .map((name) => `Unknown v1 UI component ${name}. Suggestions: ${suggestV1UiComponents(name).join(", ")}.`)
        .join(" "),
    );
  }
  const recipes = getV1UiCssRecipes(cssRecipeNames);
  if (recipes.unknown.length > 0) {
    throw publicError(
      "VALIDATION",
      `Unknown CSS recipes: ${recipes.unknown.join(", ")}. Available: ${V1_UI_CSS_RECIPES.map((recipe) => recipe.name).join(", ")}.`,
    );
  }

  return {
    catalogMetadata: V1_UI_CATALOG_METADATA,
    components: selected.components.map((component) => ({
      name: component.name,
      category: component.category,
      summary: component.summary,
      attributes: component.attributes,
      allowedChildren: component.allowedChildren,
      variants: component.variants,
      classPropagation: component.classPropagation,
      pointRules: component.pointRules,
      valueBehavior: component.valueBehavior,
      markup: includeMarkup ? component.markup : undefined,
      css: includeCss ? component.css : undefined,
      sourceRefs: component.sourceRefs,
    })),
    cssRecipes: includeExamples
      ? recipes.recipes.filter((recipe) =>
          cssRecipeNames ? true : recipe.components.some((component) => componentNames.includes(component)),
        )
      : undefined,
  };
}

export { verifyUiFile } from "../../domain/ui/index.js";
