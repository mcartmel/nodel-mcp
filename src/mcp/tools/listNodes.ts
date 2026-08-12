import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NodelClient } from "../../nodel/client.js";
import { remoteReadOnlyToolAnnotations } from "../toolAnnotations.js";
import { toolResult } from "./common.js";

export function registerListNodesTool(server: McpServer, nodelClient: NodelClient) {
  server.registerTool(
    "nodel.list_nodes",
    {
      title: "List Nodel Nodes",
      description: "List all discoverable Nodel nodes via POST /REST/nodeURLs.",
      inputSchema: {
        filter: z.string().optional().default(""),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ filter }) =>
      toolResult(async () => {
        const nodes = await nodelClient.listNetworkNodeUrls(filter ?? "");
        return { scope: "all", source: "POST /REST/nodeURLs", filter, count: countNodes(nodes), nodes };
      }),
  );

  server.registerTool(
    "nodel.list_local_nodes",
    {
      title: "List Local Nodel Nodes",
      description: "List only nodes hosted by the local Nodel runtime via GET /REST.",
      inputSchema: {
        onlyAllowed: z.boolean().optional().default(false),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ onlyAllowed }) =>
      toolResult(async () => {
        const nodes = await nodelClient.listLocalNodes(onlyAllowed ?? false);
        return { scope: "local", count: nodes.length, nodes };
      }),
  );
}

function countNodes(nodes: unknown) {
  if (Array.isArray(nodes)) {
    return nodes.length;
  }
  if (typeof nodes === "object" && nodes !== null) {
    return Object.keys(nodes).length;
  }
  return undefined;
}
