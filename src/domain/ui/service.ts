import type { NodelClient } from "../../nodel/client.js";
import { assertSafeRecipePath } from "../../nodel/pathPolicy.js";
import { deriveRecipeLoadOrder } from "../../nodel/recipeComposition.js";
import { publicError } from "../../shared/publicErrors.js";
import { extractEntries, extractFileEntries } from "../../shared/extraction.js";
import { validateV1Ui } from "./validator.js";

const UI_PATH = "content/index.xml";

export async function verifyUiFile(
  nodelClient: NodelClient,
  node: string,
  inputPath: string,
  proposedContent: string | undefined,
  includeLiveValues: boolean,
  dynamicOptionWarningThreshold: number,
  maxIssues: number,
) {
  const path = assertSafeRecipePath(inputPath);
  if (!path.toLowerCase().endsWith(".xml")) throw publicError("VALIDATION", "UI validation path must end with .xml.");
  const resolved = await nodelClient.resolveNode(node);
  const [actionsResponse, signalsResponse, filesResponse, activityResponse] = await Promise.all([
    nodelClient.nodeRequest<unknown>(resolved, "actions"),
    nodelClient.nodeRequest<unknown>(resolved, "events"),
    nodelClient.nodeRequest<unknown>(resolved, "files"),
    includeLiveValues ? nodelClient.nodeRequest<unknown>(resolved, "activity?from=-1") : Promise.resolve(undefined),
  ]);
  const entries = extractFileEntries(filesResponse.response);
  const filePaths = entries.map((entry) => entry.path);
  const content = proposedContent ?? (await nodelClient.getNodeFileContents(resolved, path));
  const recipeFiles = await readRecipeContext(nodelClient, resolved, filePaths);
  const schemasJson = filePaths.includes("content/schemas.json")
    ? await nodelClient.getNodeFileContents(resolved, "content/schemas.json")
    : undefined;
  return {
    node: resolved,
    ...validateV1Ui({
      path,
      content,
      source: proposedContent === undefined ? "saved" : "provided",
      actions: actionsResponse.response,
      signals: signalsResponse.response,
      filePaths,
      recipeFiles,
      schemasJson,
      liveEntries: activityResponse ? extractEntries(activityResponse.response) : undefined,
      dynamicOptionWarningThreshold,
      maxIssues,
    }),
  };
}

async function readRecipeContext(
  nodelClient: NodelClient,
  node: Awaited<ReturnType<NodelClient["resolveNode"]>>,
  filePaths: string[],
) {
  const nodeConfigJson = filePaths.includes("nodeConfig.json")
    ? await nodelClient.getNodeFileContents(node, "nodeConfig.json")
    : undefined;
  const order = deriveRecipeLoadOrder(filePaths, { nodeConfigJson });
  const paths = [...new Set(order.loadOrder.filter((path) => filePaths.includes(path) && path.endsWith(".py")))];
  return Promise.all(paths.map(async (path) => ({ path, content: await nodelClient.getNodeFileContents(node, path) })));
}

export { UI_PATH };
