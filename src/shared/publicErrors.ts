export type PublicErrorCode =
  | "VALIDATION"
  | "CONFLICT"
  | "APPROVAL_REQUIRED"
  | "POLICY"
  | "STATE"
  | "REMOTE"
  | "INTERNAL";

export type PublicErrorOptions = {
  retryable?: boolean;
  ambiguous?: boolean;
  cause?: unknown;
};

export class PublicError extends Error {
  readonly retryable: boolean;
  readonly ambiguous: boolean | undefined;

  constructor(
    readonly code: PublicErrorCode,
    message: string,
    options: PublicErrorOptions = {},
  ) {
    super(sanitizeSensitiveMessage(message));
    this.name = "PublicError";
    this.retryable = options.retryable ?? false;
    this.ambiguous = options.ambiguous;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function publicError(code: PublicErrorCode, message: string, options?: PublicErrorOptions) {
  return new PublicError(code, message, options);
}

export function sanitizeSensitiveMessage(value: unknown) {
  const source = value instanceof Error ? value.message : typeof value === "string" ? value : "Operation failed.";
  return source
    .replace(/[\r\n][\s\S]*$/u, "")
    .replace(/Bearer\s+[^\s,;}\]]+/giu, "Bearer [redacted]")
    .replace(/((?:authorization|token|password|secret|key)\s*[:=]\s*)["']?[^\s,;"'}\]]+["']?/giu, "$1[redacted]")
    .replace(
      /([?&](?:authorization|token|password|secret|key)=[^&\s]*)/giu,
      (match) => `${match.slice(0, match.indexOf("=") + 1)}[redacted]`,
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[redacted]@")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

/** Redacts free-form strings recursively before they leave process memory. */
export function sanitizeSensitiveValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeSensitiveMessage(value);
  if (value instanceof Error) return { name: value.name, message: sanitizeSensitiveMessage(value) };
  if (Array.isArray(value)) return value.map(sanitizeSensitiveValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, sanitizeSensitiveValue(child)]),
  );
}

export function publicErrorPayload(error: PublicError) {
  return {
    code: error.code,
    message: sanitizeSensitiveMessage(error.message),
    retryable: error.retryable,
    ...(error.ambiguous === undefined ? {} : { ambiguous: error.ambiguous }),
  };
}
