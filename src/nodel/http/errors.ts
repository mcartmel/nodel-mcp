const MAX_DIAGNOSTIC_LENGTH = 300;

export type NodelErrorCode = "TIMEOUT" | "NETWORK" | "HTTP" | "INVALID_JSON" | "NOT_FOUND" | "REDIRECT";

export class NodelTransportError extends Error {
  constructor(
    readonly code: NodelErrorCode,
    message: string,
    readonly details: { url: string; status?: number; diagnostic?: string; cause?: unknown },
  ) {
    super(message);
    this.name = "NodelTransportError";
  }
}

export class NodelTimeoutError extends NodelTransportError {
  constructor(url: URL, timeoutMs: number) {
    super("TIMEOUT", `Nodel request timed out after ${timeoutMs}ms: ${safeUrl(url)}`, { url: safeUrl(url) });
    this.name = "NodelTimeoutError";
  }
}

export class NodelNetworkError extends NodelTransportError {
  constructor(url: URL, cause: unknown) {
    super("NETWORK", `Nodel network request failed: ${safeUrl(url)}`, { url: safeUrl(url), cause });
    this.name = "NodelNetworkError";
  }
}

export class NodelHttpError extends NodelTransportError {
  constructor(url: URL, status: number, statusText: string, responseText: string) {
    const diagnostic = sanitizeDiagnostic(responseText);
    super("HTTP", `Nodel request failed: ${status} ${statusText} ${safeUrl(url)}`, {
      url: safeUrl(url),
      status,
      diagnostic,
    });
    this.name = "NodelHttpError";
  }
}

export class NodelNotFoundError extends NodelHttpError {
  constructor(url: URL, responseText: string) {
    super(url, 404, "Not Found", responseText);
    this.name = "NodelNotFoundError";
    Object.defineProperty(this, "code", { value: "NOT_FOUND" });
  }
}

export class NodelInvalidJsonError extends NodelTransportError {
  constructor(url: URL, responseText: string, cause: unknown) {
    super("INVALID_JSON", `Nodel response was not valid JSON: ${safeUrl(url)}`, {
      url: safeUrl(url),
      diagnostic: sanitizeDiagnostic(responseText),
      cause,
    });
    this.name = "NodelInvalidJsonError";
  }
}

export class NodelRedirectError extends NodelTransportError {
  constructor(url: URL, diagnostic: string) {
    super("REDIRECT", `Nodel redirect rejected: ${safeUrl(url)}`, {
      url: safeUrl(url),
      diagnostic: sanitizeDiagnostic(diagnostic),
    });
    this.name = "NodelRedirectError";
  }
}

export function sanitizeDiagnostic(value: string) {
  return value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/([?&](?:token|authorization|password|secret|key)=)[^&\s]*/giu, "$1[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

export function safeUrl(url: URL) {
  return `${url.origin}${url.pathname}`;
}
