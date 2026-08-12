const DEFAULT_LOG_BYTES = 1024;

export class CompatibilityToolError extends Error {
  /**
   * Stable code for machine handling; message intentionally excludes raw payloads.
   */
  constructor(code) {
    super(code);
    this.name = "CompatibilityToolError";
    this.code = code;
  }
}

function isString(value) {
  return typeof value === "string";
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeLogMessage(value, maxBytes = DEFAULT_LOG_BYTES) {
  const text = isString(value) ? value : value instanceof Error ? value.message : String(value);
  const redacted = redactSensitiveText(text);
  const buffer = Buffer.from(redacted, "utf8");
  return buffer.length <= maxBytes ? redacted : buffer.subarray(0, maxBytes).toString("utf8");
}

function redactSensitiveText(text) {
  let sanitized = text;

  sanitized = sanitized.replace(/\b(Bearer)\s+[^\s,}\]]+/giu, "$1 [REDACTED]");

  sanitized = sanitized.replace(/(?:https?:\/\/)(?:[^@:\s]+):([^@\s]+)@/giu, "https://[REDACTED]:[REDACTED]@");

  sanitized = sanitized.replace(
    /\b((?:authorization|bearer|token|password|secret|access[_-]?token|api[_-]?key|private[_-]?key|key)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/giu,
    "$1[REDACTED]",
  );

  return sanitized;
}

export function parseSseDataEnvelope(text) {
  const lines = isString(text) ? text.split(/\r?\n/u) : [];
  const events = [];
  let eventData = [];

  const flushEvent = () => {
    if (eventData.length === 0) return;
    events.push(eventData.join("\n"));
    eventData = [];
  };

  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      eventData.push(line.slice(5).trimStart());
      continue;
    }
    if (!line.trim()) {
      flushEvent();
      continue;
    }
  }

  flushEvent();

  for (const event of events) {
    if (!event || event === "[DONE]") continue;
    try {
      const parsed = JSON.parse(event);
      if (isRecord(parsed) || Array.isArray(parsed)) return parsed;
    } catch {
      continue;
    }
  }

  return undefined;
}

export function parseMcpResponseBody(text) {
  const trimmed = isString(text) ? text.trim() : "";
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    const sse = parseSseDataEnvelope(trimmed);
    if (sse !== undefined) return sse;
  }

  throw new Error("Unable to parse MCP response body");
}

export function parseMcpResultEnvelope(response) {
  if (!isRecord(response)) {
    throw new CompatibilityToolError("MCP_INVALID_RESPONSE");
  }

  if (response.error) {
    const code = isRecord(response.error) && isString(response.error.code) ? response.error.code : "MCP_RPC_ERROR";
    throw new CompatibilityToolError(code);
  }

  const result = response.result;
  if (!isRecord(result)) {
    throw new CompatibilityToolError("MCP_MISSING_RESULT");
  }

  return result;
}

export function parseToolResultEnvelope(response) {
  const result = parseMcpResultEnvelope(response);

  const text =
    Array.isArray(result.content) && result.content[0] && isString(result.content[0]?.text)
      ? result.content[0].text
      : undefined;

  if (text === undefined) {
    if (result.isError) throw new CompatibilityToolError("MCP_RESULT_ERROR");
    return result;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new CompatibilityToolError("MCP_TOOL_CONTENT_JSON");
  }

  if (result.isError || (isRecord(payload) && payload.ok === false)) {
    const errorCode =
      isRecord(payload?.error) && isString(payload.error.code) ? payload.error.code : "MCP_TOOL_FAILURE";
    throw new CompatibilityToolError(errorCode);
  }

  if (!isRecord(payload)) {
    throw new CompatibilityToolError("MCP_TOOL_INVALID_PAYLOAD");
  }

  return payload;
}
