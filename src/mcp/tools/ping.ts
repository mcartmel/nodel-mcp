import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { localReadOnlyToolAnnotations } from "../toolAnnotations.js";
import { toolResult } from "./common.js";

export function registerPingTool(server: McpServer) {
  server.registerTool(
    "nodel.ping",
    {
      title: "Ping",
      description: "Return a timestamp and optional echo payload to verify MCP connectivity.",
      inputSchema: {
        echo: z.unknown().optional(),
      },
      annotations: localReadOnlyToolAnnotations,
    },
    async ({ echo }) => toolResult(async () => ({ ok: true, timestamp: new Date().toISOString(), echo })),
  );
}
