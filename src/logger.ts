type LogLevel = "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

import { getRequestContext } from "./shared/requestContext.js";
import { sanitizeSensitiveMessage, sanitizeSensitiveValue } from "./shared/publicErrors.js";

function write(level: LogLevel, message: string, fields: LogFields = {}) {
  const context = getRequestContext();
  const entry = JSON.stringify({
    level,
    message: sanitizeSensitiveMessage(message),
    time: new Date().toISOString(),
    ...(context ? { requestId: context.requestId } : {}),
    ...(sanitizeSensitiveValue(fields) as LogFields),
  });

  if (level === "error") {
    process.stderr.write(`${entry}\n`);
    return;
  }

  process.stdout.write(`${entry}\n`);
}

export const logger = {
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) => write("error", message, fields),
};
