import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  CompatibilityToolError,
  isRecord,
  parseMcpResultEnvelope,
  parseMcpResponseBody,
  parseToolResultEnvelope,
  safeLogMessage,
} from "./nodel-compatibility-smoke-helpers.mjs";

const DEFAULT_BASE_URL = process.env.NODEL_COMPAT_BASE_URL ?? "http://127.0.0.1:8085";
const DEFAULT_POLL_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_LOG_BYTES = 1024;

const PACKAGE_JSON_PATH = new URL("../package.json", import.meta.url);

const DEFAULT_REQUIRED_TOOLS = [
  "nodel.list_local_nodes",
  "nodel.create_node",
  "nodel.set_node_parameter",
  "nodel.get_node_parameters",
  "nodel.verify_node_ready",
  "nodel.delete_node",
];

const RETRIABLE_TOOL_ERROR_CODES = new Set([
  "MCP_TOOL_FAILURE",
  "MCP_TOOL_INVALID_PAYLOAD",
  "MCP_TOOL_CONTENT_JSON",
  "MCP_RESULT_ERROR",
  "MCP_MISSING_RESULT",
]);

export const readPackageMetadata = async (packagePath = PACKAGE_JSON_PATH) => {
  try {
    const raw = await readFile(packagePath, "utf8");
    const parsed = JSON.parse(raw);
    const name = isRecord(parsed) && typeof parsed.name === "string" ? parsed.name : "";
    const version = isRecord(parsed) && typeof parsed.version === "string" ? parsed.version : "";

    if (!name || !version) {
      throw new CompatibilityToolError("PACKAGE_METADATA_INVALID");
    }

    return { name, version };
  } catch {
    throw new CompatibilityToolError("PACKAGE_METADATA_MISSING");
  }
};

export const isRetryablePollError = (error) => {
  return error instanceof CompatibilityToolError && RETRIABLE_TOOL_ERROR_CODES.has(error.code);
};

export const assertCompatibleServer = (initializeResult, expectedMetadata) => {
  const serverInfo = initializeResult?.serverInfo;
  if (!isRecord(serverInfo)) {
    throw new CompatibilityToolError("INITIALIZE_INVALID_RESPONSE");
  }

  if (serverInfo.name !== expectedMetadata.name) {
    throw new CompatibilityToolError("INITIALIZE_SERVER_NAME_MISMATCH");
  }

  if (serverInfo.version !== expectedMetadata.version) {
    throw new CompatibilityToolError("INITIALIZE_VERSION_MISMATCH");
  }

  return serverInfo;
};

export const assertRequiredTools = (toolList) => {
  if (!isRecord(toolList) || !Array.isArray(toolList.tools)) {
    throw new CompatibilityToolError("MCP_TOOLS_LIST_INVALID");
  }

  const names = new Set(
    toolList.tools
      .filter(isRecord)
      .map((tool) => tool.name)
      .filter(Boolean),
  );

  for (const requiredName of DEFAULT_REQUIRED_TOOLS) {
    if (!names.has(requiredName)) {
      throw new CompatibilityToolError("MCP_TOOLS_LIST_MISSING");
    }
  }
};

export const createCompatibilityRunner = (options = {}) => {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const logPath = options.logPath ?? process.env.NODEL_COMPAT_LOG;
  const fetchImpl = options.fetchImpl ?? fetch;
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const logger = options.logger ?? ((message) => console.log(message));
  const name = options.name ?? `nodel-ai-compat-${Date.now()}`;
  const compatibilityMarker = options.compatibilityMarker ?? "stage-8";
  const packageMetadataProvider = options.packageMetadataProvider ?? readPackageMetadata;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let requestId = 0;

  const log = async (message) => {
    const safe = safeLogMessage(message, DEFAULT_LOG_BYTES);
    if (logPath) {
      await appendFile(
        logPath,
        `${JSON.stringify({ level: "info", message: safe, time: new Date().toISOString() })}\n`,
      );
    }

    return logger(safe);
  };

  const request = async (path, requestOptions = {}, parseBody = true) => {
    const response = await fetchImpl(`${baseUrl}${path}`, requestOptions);
    const text = await response.text();

    if (!response.ok) {
      throw new CompatibilityToolError(`HTTP_${response.status}`);
    }

    if (!parseBody) return undefined;

    try {
      return parseMcpResponseBody(text);
    } catch {
      throw new CompatibilityToolError("MCP_INVALID_RESPONSE");
    }
  };

  const mcp = async (method, params) => {
    const shouldParseBody = !method.startsWith("notifications/");
    /** @type {{ jsonrpc: string, method: string, id?: number, params?: unknown }} */
    const body = { jsonrpc: "2.0", ...(shouldParseBody ? { id: ++requestId } : {}), method };
    if (params) body.params = params;

    const envelope = await request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
      },
      shouldParseBody,
    );

    if (!shouldParseBody) return undefined;
    parseMcpResultEnvelope(envelope);
    return envelope;
  };

  const callTool = async (name, args) => {
    const response = await mcp("tools/call", { name, arguments: args });
    return parseToolResultEnvelope(response);
  };

  const findLocalNodeByName = (nodes, needle) => {
    if (Array.isArray(nodes)) {
      return nodes.find((entry) => {
        if (isRecord(entry)) return entry.name === needle;
        return entry === needle;
      });
    }

    if (!isRecord(nodes)) return undefined;
    return Object.values(nodes).find((entry) => isRecord(entry) && entry.name === needle);
  };

  const waitFor = async (
    predicate,
    timeout = pollTimeoutMs,
    interval = pollIntervalMs,
    isRetryable = isRetryablePollError,
  ) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const result = await predicate();
        if (result) {
          return result;
        }
      } catch (error) {
        if (!isRetryable?.(error)) {
          throw error;
        }
      }

      await sleep(interval);
    }

    throw new CompatibilityToolError("MCP_TOOL_POLL_TIMEOUT");
  };

  const waitForNodeAndReadiness = async () => {
    await waitFor(
      async () => {
        const local = await callTool("nodel.list_local_nodes", { onlyAllowed: false });
        return isRecord(local) && Boolean(findLocalNodeByName(local.nodes, name));
      },
      pollTimeoutMs,
      pollIntervalMs,
    );

    await waitFor(
      async () => {
        const ready = await callTool("nodel.verify_node_ready", {
          node: name,
          probes: ["actions", "signals", "bindings", "console"],
          consoleMax: 20,
        });
        return ready.ready === true;
      },
      pollTimeoutMs,
      pollIntervalMs,
    );
  };

  const run = async () => {
    await writeFile(logPath ?? "/tmp/nodel-compatibility.log", "Nodel compatibility smoke\n");
    let created = false;
    let primaryError;

    try {
      const metadata = await packageMetadataProvider();
      const init = await mcp("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "nodel-ai-compatibility", version: metadata.version },
      });
      const initResult = parseMcpResultEnvelope(init);
      assertCompatibleServer(initResult, metadata);

      await mcp("notifications/initialized");

      const toolsEnvelope = await mcp("tools/list", {});
      const toolsResult = parseMcpResultEnvelope(toolsEnvelope);
      assertRequiredTools(toolsResult);

      await callTool("nodel.create_node", { name, reason: "compatibility smoke" });
      created = true;

      await waitForNodeAndReadiness();

      await callTool("nodel.set_node_parameter", {
        node: name,
        name: "__nodel_ai_compat_probe",
        value: compatibilityMarker,
        reason: "compatibility smoke",
        waitForReady: false,
      });

      const readback = await callTool("nodel.get_node_parameters", { node: name });
      if (!isRecord(readback.parameters) || readback.parameters.__nodel_ai_compat_probe !== compatibilityMarker) {
        throw new Error("Compatibility marker read-back was missing or mismatched.");
      }

      await log(`Compatibility read/write/read-back passed for disposable node ${name}.`);
    } catch (error) {
      primaryError = error;
    } finally {
      if (created) {
        try {
          await callTool("nodel.delete_node", {
            node: name,
            confirmNodeName: name,
            reason: "compatibility cleanup",
          });
        } catch (cleanupError) {
          if (primaryError === undefined) {
            primaryError = cleanupError;
          } else {
            await log(`Cleanup failed: ${safeLogMessage(cleanupError)}`);
          }
        }
      }
    }

    if (primaryError) throw primaryError;
  };

  return {
    name,
    callTool,
    mcp,
    waitFor,
    waitForNodeAndReadiness,
    isRetryablePollError,
    run,
  };
};

export const run = (options = {}) => createCompatibilityRunner(options).run();

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(async (error) => {
    const safe = safeLogMessage(error);
    if (error instanceof CompatibilityToolError) {
      await console.log(safe);
    } else {
      await console.log(safe);
    }
    process.exitCode = 1;
  });
}
