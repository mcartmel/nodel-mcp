import type { NodelClient } from "../../nodel/client.js";
import { deriveRecipeLoadOrder } from "../../nodel/recipeComposition.js";
import { extractFileEntries } from "../../shared/extraction.js";
import { PublicError } from "../../shared/publicErrors.js";
import type { ResolvedNode } from "../../nodel/types.js";
import { UI_ADVISORY_LIMITS } from "./limits.js";
import { decodeDefinitions, decodeFiles } from "../../nodel/contracts/decoders.js";
import { assertSafeRecipePath } from "../../nodel/pathPolicy.js";
import { isRecord } from "./utils.js";

const MAX_RECIPE_FILES = 32;
const MAX_RECIPE_FILE_BYTES = 64 * 1024;
const MAX_RECIPE_TOTAL_BYTES = 512 * 1024;
const RECIPE_CONCURRENCY = 4;
const MAX_CONTEXT_ENTRIES = 4_096;
export type UiProbe<T> = { available: true; value: T } | { available: false; reason: string; value?: T };
export type UiLiveContext = {
  actions: UiProbe<unknown>;
  signals: UiProbe<unknown>;
  files: UiProbe<string[]>;
  recipeFiles: UiProbe<Array<{ path: string; content: string }>>;
  schemas: UiProbe<string | undefined>;
  omittedRecipeFiles: number;
};

const usableName = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Strict only at the advisory evidence boundary; legacy endpoint decoders remain compatible. */
export function decodeUiActivity(value: unknown): unknown[] {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value)
      ? (["entries", "activity", "items"].map((key) => value[key]).find(Array.isArray) ??
        (Object.keys(value).length > 0 ? Object.values(value) : undefined))
      : undefined;
  if (
    !Array.isArray(entries) ||
    entries.length > MAX_CONTEXT_ENTRIES ||
    !entries.every(
      (entry) =>
        isRecord(entry) &&
        usableName(entry.alias) &&
        (Object.hasOwn(entry, "arg") ||
          (Number.isSafeInteger(entry.seq) &&
            typeof entry.source === "string" &&
            ["local", "remote", "unbound"].includes(entry.source) &&
            typeof entry.type === "string" &&
            ["action", "event", "actionBinding", "eventBinding"].includes(entry.type))),
    )
  )
    throw new Error("Activity response has no usable alias/value catalogue.");
  // Java host.LogEntry.arg is optional (null is omitted in serialized activity).
  // Such entries are valid activity, but carry no value for selector inspection.
  return entries.filter((entry) => Object.hasOwn(entry, "arg"));
}

function policy(error: unknown): error is PublicError {
  return error instanceof PublicError && error.code === "POLICY";
}
async function boundedMap<T, R>(entries: T[], concurrency: number, fn: (entry: T) => Promise<R>) {
  const results: R[] = new Array(entries.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= entries.length) return;
        results[index] = await fn(entries[index]!);
      }
    }),
  );
  return results;
}

/** Independent best-effort probes: a failed point catalogue is never represented as empty. */
export async function readUiLiveContext(
  client: NodelClient,
  node: ResolvedNode,
  deadlineMs?: number,
  includeRecipe = true,
): Promise<UiLiveContext> {
  const controller = new AbortController();
  const readOptions = { deadlineMs, signal: controller.signal, maxResponseBytes: 1024 * 1024 };
  const catalogue = async (endpoint: string): Promise<UiProbe<unknown>> => {
    try {
      const { response } = await client.nodeRequest<unknown>(node, endpoint, readOptions);
      if (response && typeof response === "object" && !Array.isArray(response) && Object.hasOwn(response, "__proto__"))
        return {
          available: false,
          reason: `${endpoint} catalogue contains a dictionary key unsupported by the definitions decoder.`,
        };
      if (
        response &&
        typeof response === "object" &&
        (Array.isArray(response) ? response.length : Object.keys(response).length) > UI_ADVISORY_LIMITS.maxVisitedNodes
      )
        return { available: false, reason: `${endpoint} catalogue exceeded the bounded entry limit.` };
      const decoded = decodeDefinitions(response);
      const identitiesKnown = Array.isArray(decoded)
        ? decoded.every((entry) =>
            usableName(typeof entry.name === "string" && entry.name.length ? entry.name : entry.title),
          )
        : Object.keys(decoded).every(usableName);
      if (!identitiesKnown) return { available: false, reason: `${endpoint} catalogue contains unnamed definitions.` };
      return { available: true, value: decoded };
    } catch (error) {
      if (policy(error)) {
        controller.abort();
        throw error;
      }
      return { available: false, reason: `${endpoint} catalogue was unavailable or malformed.` };
    }
  };
  // Start the file pipeline immediately. A stalled point endpoint must not hold
  // an already-received listing hostage until its shared deadline expires.
  try {
    const outcomes = await Promise.allSettled([
      catalogue("actions"),
      catalogue("events"),
      readFileContext(client, node, deadlineMs, includeRecipe, controller.signal, () => controller.abort()).catch(
        (error: unknown) => {
          if (policy(error)) {
            controller.abort();
            throw error;
          }
          const unavailable = { available: false as const, reason: "File context was unavailable or malformed." };
          return { files: unavailable, recipeFiles: unavailable, schemas: unavailable, omittedRecipeFiles: 0 };
        },
      ),
    ]);
    const [actionOutcome, signalOutcome, fileOutcome] = outcomes;
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    if (
      actionOutcome.status !== "fulfilled" ||
      signalOutcome.status !== "fulfilled" ||
      fileOutcome.status !== "fulfilled"
    )
      throw new Error("Unreachable probe outcome.");
    const actions = actionOutcome.value,
      signals = signalOutcome.value,
      fileContext = fileOutcome.value;
    return { actions, signals, ...fileContext };
  } finally {
    controller.abort();
  }
}

async function readFileContext(
  client: NodelClient,
  node: ResolvedNode,
  deadlineMs: number | undefined,
  includeRecipe: boolean,
  signal: AbortSignal,
  cancelSiblings: () => void,
): Promise<Omit<UiLiveContext, "actions" | "signals">> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    return await readFileContextInner(client, node, deadlineMs, includeRecipe, controller.signal, cancelSiblings);
  } finally {
    controller.abort();
    signal.removeEventListener("abort", abort);
  }
}

async function readFileContextInner(
  client: NodelClient,
  node: ResolvedNode,
  deadlineMs: number | undefined,
  includeRecipe: boolean,
  signal: AbortSignal,
  cancelSiblings: () => void,
): Promise<Omit<UiLiveContext, "actions" | "signals">> {
  const readOptions = { deadlineMs, signal, maxResponseBytes: 1024 * 1024 };
  const expired = () => deadlineMs !== undefined && Date.now() >= deadlineMs;
  let entries: unknown[] | undefined;
  let paths: string[] | undefined;
  let listingReason = "File listing was unavailable or malformed.";
  try {
    const { response } = await client.nodeRequest<unknown>(node, "files", readOptions);
    // Cap before decoder/extractor/composition work, but never filter malformed
    // entries into a successful empty/partial catalogue.
    entries = Array.isArray(response)
      ? response
      : response && typeof response === "object"
        ? Object.values(response)
        : undefined;
    if (entries && entries.length <= MAX_CONTEXT_ENTRIES) {
      const decoded = decodeFiles(response);
      const extracted = extractFileEntries(decoded);
      if (extracted.length === entries.length && extracted.every((entry) => entry.path.length > 0))
        paths = extracted.map((entry) => assertSafeRecipePath(entry.path));
    }
  } catch (error) {
    if (policy(error)) throw error;
    listingReason = "File listing probe failed or its response was malformed.";
  }
  const listingTruncated = !!entries && entries.length > MAX_CONTEXT_ENTRIES;
  if (!paths)
    return {
      files: {
        available: false,
        reason: listingTruncated
          ? "File listing exceeded the bounded context entry limit; asset coverage is unknown."
          : listingReason,
      },
      recipeFiles: { available: false, reason: "Recipe context skipped because the file listing was unavailable." },
      schemas: { available: false, reason: "Schema check skipped because the file listing was unavailable." },
      omittedRecipeFiles: listingTruncated ? entries!.length : 0,
    };
  if (!includeRecipe)
    return {
      files: { available: true, value: paths },
      recipeFiles: { available: false, reason: "Recipe parser context is not needed for v2." },
      schemas: { available: false, reason: "Legacy schema context is not needed for v2." },
      omittedRecipeFiles: 0,
    };
  const pathSet = new Set(paths);
  const schemasPromise: Promise<UiProbe<string | undefined>> = pathSet.has("content/schemas.json")
    ? client
        .getNodeFileContents(node, "content/schemas.json", { ...readOptions, maxResponseBytes: MAX_RECIPE_FILE_BYTES })
        .then((value) => {
          try {
            if (isRecord(JSON.parse(value))) return { available: true as const, value };
          } catch {
            // Retain the source for existing static parse diagnostics, but never
            // treat a failed decode as usable schema evidence.
          }
          return { available: false as const, value, reason: "Schema file could not be parsed as a JSON object." };
        })
        .catch((error: unknown) => {
          if (policy(error)) {
            // allSettled observes the rejection immediately but must not delay
            // cancellation until the config/recipe pipeline reaches its join.
            cancelSiblings();
            throw error;
          }
          return { available: false as const, reason: "Schema file could not be read or parsed as a JSON object." };
        })
    : Promise.resolve({ available: true as const, value: undefined });
  // Attach immediately so a policy rejection cannot become an unhandled promise
  // while config/recipe work is still pending.
  const schemasSettled = Promise.allSettled([schemasPromise]);
  let configKnown = true;
  const nodeConfig = pathSet.has("nodeConfig.json")
    ? await client
        .getNodeFileContents(node, "nodeConfig.json", { ...readOptions, maxResponseBytes: MAX_RECIPE_FILE_BYTES })
        .catch((error: unknown) => {
          if (policy(error)) throw error;
          configKnown = false;
          return undefined;
        })
    : undefined;
  if (nodeConfig !== undefined) {
    try {
      const decoded = JSON.parse(nodeConfig) as { dependencies?: unknown } | null;
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) configKnown = false;
      else if (Array.isArray(decoded.dependencies) && decoded.dependencies.length > MAX_CONTEXT_ENTRIES)
        configKnown = false;
    } catch {
      configKnown = false;
    }
  }
  let order: ReturnType<typeof deriveRecipeLoadOrder> | undefined;
  if (configKnown && !expired()) {
    try {
      order = deriveRecipeLoadOrder(paths, { nodeConfigJson: nodeConfig });
    } catch (error) {
      if (policy(error)) throw error;
      // Invalid dependency paths only invalidate composition, not independently
      // observed point/file catalogues or the concurrently read schema file.
    }
  }
  const orderKnown = !!order && !order.issues.some((issue) => issue.code.startsWith("RECIPE_NODE_CONFIG"));
  const ordered = orderKnown
    ? [...new Set(order!.loadOrder.filter((path) => pathSet.has(path) && path.endsWith(".py")))]
    : [];
  const selected = ordered.slice(0, MAX_RECIPE_FILES);
  let total = 0;
  const readResults = await boundedMap(selected, RECIPE_CONCURRENCY, async (path) => {
    if (expired() || total >= MAX_RECIPE_TOTAL_BYTES) return { path, omitted: true as const };
    try {
      const content = await client.getNodeFileContents(node, path, {
        ...readOptions,
        maxResponseBytes: MAX_RECIPE_FILE_BYTES,
      });
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MAX_RECIPE_FILE_BYTES || total + bytes > MAX_RECIPE_TOTAL_BYTES)
        return { path, omitted: true as const };
      total += bytes;
      return { path, content, omitted: false as const };
    } catch (error) {
      if (policy(error)) throw error;
      return { path, omitted: true as const };
    }
  });
  const recipeFiles = readResults
    .filter((entry): entry is { path: string; content: string; omitted: false } => !entry.omitted)
    .map(({ path, content }) => ({ path, content }));
  const [schemaOutcome] = await schemasSettled;
  if (schemaOutcome!.status === "rejected") throw schemaOutcome!.reason;
  const schemasResult = schemaOutcome!.value;
  return {
    files: { available: true, value: paths },
    recipeFiles: orderKnown
      ? { available: true, value: recipeFiles }
      : {
          available: false,
          reason:
            "Recipe load order is unknown because nodeConfig.json was unavailable/invalid or the context deadline expired; no default order was assumed.",
        },
    schemas: schemasResult,
    omittedRecipeFiles:
      ordered.length -
      recipeFiles.length +
      (order?.source === "nodeConfig.json dependencies"
        ? order.missingFiles.filter((path) => path.endsWith(".py")).length
        : 0),
  };
}
