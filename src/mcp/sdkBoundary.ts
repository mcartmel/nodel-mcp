import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolErrorResult = ReturnType<McpServer["createToolError"]>;

/** Converts SDK pre-handler failures into the sidecar's stable public envelope. */
export function normalizeSdkToolError(errorMessage: string): ToolErrorResult {
  const toolName = /tool ([^ ]+) (?:not found|disabled)/iu.exec(errorMessage)?.[1];
  const validation = /input validation|invalid arguments|validation error/iu.test(errorMessage);
  const code = validation ? "VALIDATION" : toolName ? "TOOL_UNAVAILABLE" : "VALIDATION";
  const message = validation
    ? "Invalid arguments for tool. Check the advertised input schema."
    : toolName
      ? `Tool ${toolName} is not available.`
      : "The tool request was rejected before the handler ran.";
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, status: "failed", error: { code, message, retryable: false } }),
      },
    ],
    isError: true,
  };
}

/** Per-server SDK seam; domain handlers continue to use the normal McpServer API. */
export class StableMcpServer extends McpServer {
  constructor(...args: ConstructorParameters<typeof McpServer>) {
    super(...args);
    // The SDK marks createToolError private in its declarations but dispatches it
    // dynamically from the request handler. Keep the compatibility seam local.
    Object.defineProperty(this, "createToolError", {
      value: (errorMessage: string) => normalizeSdkToolError(errorMessage),
      configurable: true,
    });
  }
}
