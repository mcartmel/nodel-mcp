import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CancelledNotificationSchema, type RequestId } from "@modelcontextprotocol/sdk/types.js";

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
    // SDK 1.32.2's default cancellation handler drops valid falsy request IDs
    // (0 and ""). Keep the workaround local to our pinned SDK boundary, using
    // its notification registration API and the same per-request controllers.
    // Refuse to start if the private compatibility seam changes on an upgrade:
    // silently losing cancellation would be unsafe for approval handlers.
    const controllers: unknown = Reflect.get(this.server, "_requestHandlerAbortControllers");
    if (!(controllers instanceof Map)) throw new Error("Unsupported SDK request cancellation boundary.");
    const requestControllers = controllers as Map<RequestId, AbortController>;
    this.server.setNotificationHandler(CancelledNotificationSchema, ({ params }) => {
      if (params.requestId !== undefined) requestControllers.get(params.requestId)?.abort(params.reason);
    });
    // The SDK marks createToolError private in its declarations but dispatches it
    // dynamically from the request handler. Keep the compatibility seam local.
    Object.defineProperty(this, "createToolError", {
      value: (errorMessage: string) => normalizeSdkToolError(errorMessage),
      configurable: true,
    });
  }
}
