import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NodelClient } from "../../nodel/client.js";
import { verifyUiFile } from "../../domain/ui/index.js";
import {
  V1_UI_CATALOG_METADATA,
  V1_UI_COMPONENT_INDEX,
  V1_UI_CSS_RECIPES,
  getV1UiComponents,
  getV1UiCssRecipes,
  suggestV1UiComponents,
} from "../../nodel/v1UiCatalog.js";
import { remoteReadOnlyToolAnnotations } from "../toolAnnotations.js";
import { toolResult } from "./common.js";
import { publicError } from "../../shared/publicErrors.js";
import { getUiCapabilities } from "../../domain/ui/capabilities.js";
import {
  defaultUiVerificationDecision,
  legacyUiVerificationSelection,
  uiComponentReference,
  uiGuidelines,
  type UiFormat,
} from "./uiGuidance.js";
import type { UiCapabilityClient } from "../../domain/ui/capabilities-types.js";
import { UI_REFERENCE_FIELDS, UI_REFERENCE_TEXT_PROPERTIES } from "./uiReferenceFields.js";

export function registerUiTools(server: McpServer, nodelClient: NodelClient) {
  server.registerTool(
    "nodel.get_ui_guidelines",
    {
      title: "Get UI Guidelines",
      description:
        "Return v1 XML or v2 HTML UI guidance. No-argument calls return the bundled v1 guide; node-aware calls may make bounded read-only requests to that target.",
      inputSchema: {
        format: z.enum(["v1", "v2", "auto"]).optional().default("v1"),
        node: z.string().min(1).optional(),
        path: z.string().min(1).optional(),
        refresh: z.boolean().optional().default(false),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ format, node, path, refresh }) =>
      toolResult(async () => uiGuidelines(nodelClient, { format: format as UiFormat, node, path, refresh })),
  );

  server.registerTool(
    "nodel.get_ui_component_reference",
    {
      title: "Get UI Component Reference",
      description:
        "Return a bounded v1 XML or v2 HTML component reference. No-argument calls retain the local v1 reference; node-aware calls may read target capabilities.",
      inputSchema: {
        format: z.enum(["v1", "v2", "auto"]).optional().default("v1"),
        node: z.string().min(1).optional(),
        path: z.string().min(1).optional(),
        refresh: z.boolean().optional().default(false),
        components: z.array(z.string().min(1)).max(20).optional(),
        includeMarkup: z.boolean().optional(),
        includeCss: z.boolean().optional(),
        includeExamples: z.boolean().optional(),
        cssRecipes: z.array(z.string().min(1)).max(20).optional(),
        indexOffset: z.number().int().min(0).max(10000).optional().default(0),
        indexLimit: z.number().int().min(1).max(200).optional().default(100),
        stylesOffset: z.number().int().min(0).max(10000).optional().default(0),
        stylesLimit: z.number().int().min(1).max(200).optional().default(100),
        includeCore: z.boolean().optional().default(false),
        attributesOffset: z.number().int().min(0).max(10000).optional().default(0),
        attributesLimit: z.number().int().min(1).max(200).optional().default(40),
        commonOffset: z.number().int().min(0).max(10000).optional().default(0),
        commonLimit: z.number().int().min(1).max(200).optional().default(40),
        detailsOffset: z.number().int().min(0).max(20).optional().default(0),
        detailsLimit: z.number().int().min(1).max(20).optional().default(20),
        field: z
          .enum(UI_REFERENCE_FIELDS)
          .optional()
          .describe(
            "V2-only focused supported-field retrieval, including nested array tails and exact text segments. Not an arbitrary JSON query.",
          ),
        attributeName: z.string().min(1).optional(),
        bindingAttribute: z.string().min(1).optional(),
        targetName: z.string().min(1).optional(),
        eventName: z.string().min(1).optional(),
        fieldOffset: z.number().int().min(0).max(12000).optional().default(0),
        fieldLimit: z.number().int().min(1).max(100).optional().default(20),
        textProperty: z
          .enum(UI_REFERENCE_TEXT_PROPERTIES)
          .optional()
          .describe(
            "Select one supported string property independently (for example description or snippet). Use fieldLimit=1 for independent cursors; omit for scalar arrays. Not an arbitrary JSON path.",
          ),
        textOffset: z
          .number()
          .int()
          .min(0)
          .max(16000)
          .optional()
          .default(0)
          .describe(
            "UTF-16 text offset within each selected supported string. Mid-surrogate-pair offsets are rejected. Follow each segment's nextOffset to reconstruct it exactly.",
          ),
        textLimit: z
          .number()
          .int()
          .min(1)
          .max(512)
          .optional()
          .default(512)
          .describe(
            "Target maximum UTF-16 units per scalar-safe string segment; limit 1 includes a whole surrogate pair (2 units) to ensure progress. The response budget may reduce it further.",
          ),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({
      format,
      node,
      path,
      refresh,
      components,
      includeMarkup,
      includeCss,
      includeExamples,
      cssRecipes,
      indexOffset,
      indexLimit,
      stylesOffset,
      stylesLimit,
      includeCore,
      attributesOffset,
      attributesLimit,
      commonOffset,
      commonLimit,
      detailsOffset,
      detailsLimit,
      field,
      attributeName,
      bindingAttribute,
      targetName,
      eventName,
      fieldOffset,
      fieldLimit,
      textOffset,
      textLimit,
      textProperty,
    }) =>
      toolResult(async () =>
        uiComponentReference(
          nodelClient,
          {
            format: format as UiFormat,
            node,
            path,
            refresh,
            components,
            includeMarkup,
            includeCss,
            includeExamples,
            cssRecipes,
            indexOffset,
            indexLimit,
            stylesOffset,
            stylesLimit,
            includeCore,
            attributesOffset,
            attributesLimit,
            commonOffset,
            commonLimit,
            detailsOffset,
            detailsLimit,
            field,
            attributeName,
            bindingAttribute,
            targetName,
            eventName,
            fieldOffset,
            fieldLimit,
            textOffset,
            textLimit,
            textProperty,
          },
          componentReference,
        ),
      ),
  );

  server.registerTool(
    "nodel.get_ui_capabilities",
    {
      title: "Get UI Capabilities",
      description:
        "Read compact, advisory v2 contract and entry-asset evidence from a trusted target node. No remote code is executed and support does not imply browser verification.",
      inputSchema: {
        node: z.string().min(1),
        path: z.string().min(1).optional().default("content/index.html"),
        refresh: z.boolean().optional().default(false),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ node, path, refresh }) =>
      toolResult(async () =>
        getUiCapabilities(nodelClient as unknown as UiCapabilityClient, node, path ?? "content/index.html", {
          refresh,
        }),
      ),
  );

  server.registerTool(
    "nodel.verify_ui_file",
    {
      title: "Verify UI File",
      description:
        "Run advisory static/live-context checks for v1 XML or v2 HTML UI files. Omitted format/path retain the legacy XML default unless supplied content positively identifies v2; explicit auto remains conservative. This does not execute a browser or gate file writes.",
      inputSchema: {
        node: z.string().min(1),
        path: z.string().min(1).optional(),
        content: z.string().max(2_000_000).optional(),
        format: z.enum(["auto", "v1", "v2"]).optional(),
        refresh: z.boolean().optional().default(false),
        includeLiveValues: z.boolean().optional().default(false),
        dynamicOptionWarningThreshold: z.number().int().min(1).max(10000).optional().default(100),
        maxIssues: z.number().int().min(1).max(1000).optional().default(200),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ node, path, content, format, refresh, includeLiveValues, dynamicOptionWarningThreshold, maxIssues }) => {
      const decision = path === undefined ? defaultUiVerificationDecision(format, content) : { path };
      const verifyPath = decision.path;
      return toolResult(async () =>
        verifyUiFile(
          nodelClient,
          node,
          verifyPath,
          content,
          includeLiveValues ?? false,
          dynamicOptionWarningThreshold ?? 100,
          maxIssues ?? 200,
          {
            selection:
              format ??
              (path === undefined && verifyPath === "content/index.xml"
                ? legacyUiVerificationSelection(content)
                : "auto"),
            refresh,
            forceAutoUnselectedReason: decision.forceAutoUnselectedReason,
          },
        ),
      );
    },
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
