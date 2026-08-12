import dotenv from "dotenv";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { sanitizeSensitiveMessage } from "./shared/publicErrors.js";
import { startHttpServer } from "./mcp/server.js";

try {
  dotenv.config({ processEnv: process.env });
  const config = loadConfig(process.env, process.cwd());
  for (const warning of config.configWarnings) {
    logger.warn("Configuration policy warning", warning);
  }
  const server = await startHttpServer(config);

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info("Received shutdown signal", { signal });
    void server
      .shutdown()
      .then(({ forced }) => {
        logger.info("HTTP server stopped", { forced });
        process.exit(0);
      })
      .catch((error) => {
        logger.error("HTTP server shutdown failed", { error: sanitizeSensitiveMessage(error) });
        process.exit(1);
      });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  logger.error("Failed to start Nodel MCP sidecar", { error: sanitizeSensitiveMessage(error) });
  process.exit(1);
}
