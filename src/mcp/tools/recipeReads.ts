import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import { fetchAndConsumeWithTimeout } from "../../nodel/client.js";
import { RECIPE_GUIDELINES } from "../../nodel/guidelines.js";
import type { NodelClient } from "../../nodel/client.js";
import { assertSafePublicRecipePath, assertSafeRecipePath } from "../../nodel/pathPolicy.js";
import { remoteReadOnlyToolAnnotations } from "../toolAnnotations.js";
import { extractFileEntries, toolResult, truncateUtf8, isRecord, readString } from "./common.js";
import { sha256 } from "../../shared/canonicalJson.js";
import { publicError, sanitizeSensitiveMessage } from "../../shared/publicErrors.js";
import { NodelTransportError } from "../../nodel/http/errors.js";

const PUBLIC_RECIPE_REPO_API = "https://api.github.com/repos/museumsvictoria/nodel-recipes/contents";
const PUBLIC_RECIPE_RAW = "https://raw.githubusercontent.com/museumsvictoria/nodel-recipes/master";
const textExtensions = new Set([
  "",
  ".py",
  ".js",
  ".json",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
  ".html",
  ".css",
  ".xml",
  ".csv",
  ".ini",
  ".cfg",
  ".conf",
]);

export function registerRecipeReadTools(server: McpServer, nodelClient: NodelClient, config: AppConfig) {
  server.registerTool(
    "nodel.read_recipe",
    {
      title: "Read Recipe",
      description: "Read recipe source files from a node via REST/files and REST/files/contents.",
      inputSchema: {
        node: z.string().min(1),
        paths: z.array(z.string().min(1)).optional(),
        maxBytesPerFile: z.number().int().min(1).max(262144).optional().default(65536),
        maxFiles: z.number().int().min(1).max(200).optional().default(20),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ node, paths, maxBytesPerFile, maxFiles }) =>
      toolResult(async () => {
        const listed = await nodelClient.getNodeFiles(node);
        const entries = extractFileEntries(listed.files);
        const explicitPaths = paths?.map(assertSafeRecipePath);
        const selected = selectRecipePaths(
          entries.map((entry) => entry.path),
          explicitPaths,
          maxFiles ?? 20,
        );
        const contents: Record<string, unknown> = {};

        for (const path of selected) {
          const entry = entries.find((candidate) => candidate.path === path);
          if (!isLikelyTextFile(path)) {
            if (explicitPaths?.includes(path)) {
              const bytes = await nodelClient.getNodeFileBytes(listed.node, path);
              contents[path] = { binary: true, sha256: sha256(bytes), byteLength: bytes.byteLength };
              continue;
            }
            contents[path] = { skipped: true, reason: "binary_or_unknown_extension" };
            continue;
          }
          if (typeof entry?.size === "number" && entry.size > (maxBytesPerFile ?? 65536)) {
            contents[path] = { skipped: true, reason: "oversized", size: entry.size, maxBytes: maxBytesPerFile };
            continue;
          }
          const text = await nodelClient.getNodeFileContents(listed.node, path);
          contents[path] = {
            text: truncateUtf8(text, maxBytesPerFile ?? 65536),
            sha256: sha256(text),
            truncated: Buffer.byteLength(text, "utf8") > (maxBytesPerFile ?? 65536),
          };
        }

        return { node: listed.node, files: entries, selected, contents };
      }),
  );

  server.registerTool(
    "nodel.get_recipe_guidelines",
    {
      title: "Get Recipe Guidelines",
      description: "Return local Nodel recipe authoring/debugging guidelines.",
      inputSchema: {
        topic: z.string().optional(),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ topic }) => toolResult(async () => ({ topic, guidelines: RECIPE_GUIDELINES })),
  );

  server.registerTool(
    "nodel.list_public_recipes",
    {
      title: "List Public Recipes",
      description: "List public recipes from museumsvictoria/nodel-recipes.",
      inputSchema: {
        filter: z.string().optional().default(""),
        limit: z.number().int().min(1).max(200).optional().default(50),
        includeRetired: z.boolean().optional().default(false),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ filter, limit, includeRetired }) =>
      toolResult(async () => {
        const entries = await fetchJson<unknown[]>(PUBLIC_RECIPE_REPO_API, config.publicRecipeRequestTimeoutMs);
        const normalizedFilter = (filter ?? "").trim().toLocaleLowerCase();
        const recipes = entries
          .flatMap((entry) =>
            isRecord(entry) && entry.type === "dir"
              ? [
                  {
                    name: readString(entry.name) ?? "",
                    path: readString(entry.path) ?? "",
                    htmlUrl: readString(entry.html_url),
                  },
                ]
              : [],
          )
          .filter(
            (entry) =>
              (includeRetired || !entry.path.startsWith("(retired)")) &&
              (!normalizedFilter || entry.name.toLocaleLowerCase().includes(normalizedFilter)),
          )
          .slice(0, limit ?? 50);
        return { source: "museumsvictoria/nodel-recipes", count: recipes.length, recipes };
      }),
  );

  server.registerTool(
    "nodel.read_public_recipe",
    {
      title: "Read Public Recipe",
      description: "Read selected files from a public museumsvictoria/nodel-recipes recipe directory.",
      inputSchema: {
        recipe: z.string().min(1),
        files: z.array(z.string().min(1)).optional(),
        maxBytesPerFile: z.number().int().min(1).max(262144).optional().default(65536),
        maxFiles: z.number().int().min(1).max(50).optional().default(10),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ recipe, files, maxBytesPerFile, maxFiles }) =>
      toolResult(async () => {
        const recipePath = assertSafePublicRecipePath(recipe);
        const listing = await fetchJson<unknown[]>(
          `${PUBLIC_RECIPE_REPO_API}/${encodeURIComponentPath(recipePath)}`,
          config.publicRecipeRequestTimeoutMs,
        );
        const entries = listing.flatMap((entry) =>
          isRecord(entry) && entry.type === "file"
            ? [
                {
                  name: readString(entry.name) ?? "",
                  path: readString(entry.path) ?? "",
                  size: typeof entry.size === "number" ? entry.size : undefined,
                },
              ]
            : [],
        );
        const selected = selectRecipePaths(
          entries.map((entry) => entry.name),
          files?.map(assertSafePublicRecipePath),
          maxFiles ?? 10,
        );
        const contents: Record<string, unknown> = {};

        for (const name of selected) {
          const entry = entries.find((candidate) => candidate.name === name || candidate.path === name);
          if (!entry) {
            contents[name] = { skipped: true, reason: "not_found" };
            continue;
          }
          if (!isLikelyTextFile(entry.name)) {
            contents[name] = { skipped: true, reason: "binary_or_unknown_extension" };
            continue;
          }
          const url = `${PUBLIC_RECIPE_RAW}/${encodeURIComponentPath(entry.path)}`;
          const text = await fetchText(url, config.publicRecipeRequestTimeoutMs);
          contents[entry.path] = {
            text: truncateUtf8(text, maxBytesPerFile ?? 65536),
            sha256: sha256(text),
            truncated: Buffer.byteLength(text, "utf8") > (maxBytesPerFile ?? 65536),
          };
        }

        return { source: "museumsvictoria/nodel-recipes", recipe: recipePath, files: entries, selected, contents };
      }),
  );

  server.registerTool(
    "nodel.read_toolkit",
    {
      title: "Read Toolkit",
      description: "Read the Nodel scripting toolkit from /REST/Toolkit.",
      inputSchema: {
        topic: z.string().optional(),
        maxBytes: z.number().int().min(1).max(524288).optional().default(262144),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ topic, maxBytes }) =>
      toolResult(async () => {
        const toolkit = await nodelClient.getToolkit();
        const script = readString(isRecord(toolkit) ? toolkit.script : undefined);
        const response: Record<string, unknown> = {
          topic,
          source: "/REST/Toolkit",
          toolkit,
          guidelines: RECIPE_GUIDELINES,
        };

        if (script) {
          response.script = {
            text: truncateUtf8(script, maxBytes ?? 262144),
            sha256: sha256(script),
            truncated: Buffer.byteLength(script, "utf8") > (maxBytes ?? 262144),
          };
        }

        return response;
      }),
  );
}

function selectRecipePaths(paths: string[], explicitPaths: string[] | undefined, maxFiles: number) {
  if (explicitPaths && explicitPaths.length > 0) {
    return explicitPaths.slice(0, maxFiles);
  }
  const preferred = paths.filter(
    (path) => path === "script.py" || path.endsWith(".py") || path.endsWith(".md") || path.endsWith(".txt"),
  );
  return (preferred.length > 0 ? preferred : paths.filter(isLikelyTextFile)).slice(0, maxFiles);
}

function isLikelyTextFile(path: string) {
  const name = path.toLowerCase();
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot) : "";
  return textExtensions.has(extension);
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const text = await fetchPublicText(url, { headers: { accept: "application/vnd.github+json" } }, timeoutMs);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw publicError("REMOTE", `GitHub returned invalid JSON: ${sanitizeSensitiveMessage(error)}`, {
      retryable: false,
      ambiguous: false,
      cause: error,
    });
  }
}

async function fetchText(url: string, timeoutMs: number) {
  return fetchPublicText(url, {}, timeoutMs);
}

async function fetchPublicText(url: string, init: RequestInit, timeoutMs: number) {
  try {
    return await fetchAndConsumeWithTimeout(url, init, timeoutMs, "Public recipe request", async (response) => {
      const text = await response.text();
      if (!response.ok)
        throw publicError("REMOTE", `Public recipe fetch failed: ${response.status} ${response.statusText}`, {
          retryable: response.status >= 500,
        });
      return text;
    });
  } catch (error) {
    if (error instanceof NodelTransportError) {
      const retryable = error.code === "TIMEOUT" || error.code === "NETWORK" || error.code === "HTTP";
      throw publicError("REMOTE", `Public recipe request failed: ${sanitizeSensitiveMessage(error)}`, {
        retryable,
        ambiguous: false,
        cause: error,
      });
    }
    throw error;
  }
}

function encodeURIComponentPath(path: string) {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}
