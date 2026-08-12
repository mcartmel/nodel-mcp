import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import { redactedConfig } from "../../config.js";
import type { NodelClient } from "../../nodel/client.js";
import { remoteReadOnlyToolAnnotations } from "../toolAnnotations.js";
import { toolResult } from "./common.js";
import { sanitizeSensitiveMessage } from "../../shared/publicErrors.js";
import packageJson from "../../../package.json" with { type: "json" };

export function registerHealthTool(server: McpServer, nodelClient: NodelClient, config: AppConfig) {
  server.registerTool(
    "nodel.health",
    {
      title: "Health",
      description: "Return sidecar configuration and optionally verify Nodel reachability via GET /REST.",
      inputSchema: {
        checkNodel: z.boolean().optional().default(false),
      },
      annotations: remoteReadOnlyToolAnnotations,
    },
    async ({ checkNodel }) =>
      toolResult(async () => {
        const result: Record<string, unknown> = {
          ok: true,
          version: packageJson.version,
          timestamp: new Date().toISOString(),
          config: redactedConfig(config),
        };

        if (checkNodel) {
          try {
            const status = await nodelClient.getHostStatus();
            result.nodel = {
              ok: true,
              started: status.started,
              nodeCount: Object.keys(status.nodes ?? {}).length,
            };
          } catch (error) {
            result.ok = false;
            result.nodel = {
              ok: false,
              error: sanitizeSensitiveMessage(error),
            };
          }
        }

        return result;
      }),
  );
}
