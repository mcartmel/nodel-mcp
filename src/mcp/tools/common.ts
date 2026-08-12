import { PostSideEffectAuditError, RemoteFailureAuditError } from "../../state/audit.js";
import { NodelTransportError } from "../../nodel/http/errors.js";
import { PublicError, publicErrorPayload, sanitizeSensitiveMessage } from "../../shared/publicErrors.js";
export { extractEntries, extractFileEntries } from "../../shared/extraction.js";

// Compatibility re-export; canonical ownership is src/shared/canonicalJson.
export { sha256, stableJsonHash, stableStringify } from "../../shared/canonicalJson.js";

export type ToolErrorPayload = {
  code: string;
  message: string;
  retryable: boolean;
  ambiguous?: boolean;
  operationId?: string;
  status?: "succeeded_audit_failed";
};

export async function toolResult(read: () => Promise<unknown>) {
  try {
    const value = await read();
    const payload =
      isRecord(value) && typeof value.ok === "boolean"
        ? { ok: true, ...withoutOk(value), resultOk: value.ok }
        : isRecord(value)
          ? { ok: true, ...value }
          : { ok: true, value };
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    const classified = classifyToolError(error);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ok: false,
              status:
                classified.status ??
                (classified.ambiguous ? "ambiguous" : isRemoteError(classified) ? "remote_failed" : "failed"),
              error: classified,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
}

function isRemoteError(error: ToolErrorPayload) {
  return error.code.startsWith("NODEL_");
}

export function classifyToolError(error: unknown): ToolErrorPayload {
  if (error instanceof PublicError) return { ...publicErrorPayload(error), ...operationIdPayload(error) };
  if (error instanceof PostSideEffectAuditError) {
    return {
      code: "AUDIT_POST_SIDE_EFFECT",
      message: safeMessage(error),
      retryable: false,
      ambiguous: true,
      operationId: error.operationId,
      status: "succeeded_audit_failed",
    };
  }
  if (error instanceof RemoteFailureAuditError) {
    return {
      code: "AUDIT_REMOTE_FAILURE",
      message: safeMessage(error),
      retryable: false,
      ambiguous: true,
      operationId: error.operationId,
    };
  }
  if (error instanceof NodelTransportError) {
    const retryable =
      error.code === "TIMEOUT" ||
      error.code === "NETWORK" ||
      (error.code === "HTTP" && (error.details.status ?? 0) >= 500);
    const operationId = readOperationId(error);
    const ambiguous = Boolean(operationId) && ["TIMEOUT", "NETWORK", "INVALID_JSON", "REDIRECT"].includes(error.code);
    return {
      code: `NODEL_${error.code}`,
      message: safeMessage(error),
      retryable,
      ...(ambiguous ? { ambiguous: true } : {}),
      ...(operationId ? { operationId } : {}),
    };
  }
  return { code: "INTERNAL", message: safeMessage(error), retryable: false, ...operationIdPayload(error) };
}

function safeMessage(error: unknown) {
  return sanitizeSensitiveMessage(error);
}
function operationIdPayload(error: unknown) {
  const operationId = readOperationId(error);
  return typeof operationId === "string" ? { operationId } : {};
}

function readOperationId(error: unknown) {
  const operationId = (error as { operationId?: unknown } | undefined)?.operationId;
  return typeof operationId === "string" && operationId.length > 0 ? operationId : undefined;
}

function withoutOk(value: Record<string, unknown>) {
  const { ok: _ok, ...rest } = value;
  return rest;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function truncateUtf8(text: string, maxBytes: number) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return text;
  }
  return buffer.subarray(0, maxBytes).toString("utf8");
}

export function decodeBase64Strict(value: string) {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return new Uint8Array();
  }
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || /=.*[^=]/u.test(normalized)) {
    throw new PublicError("VALIDATION", "contentBase64 must be valid standard base64.");
  }

  const buffer = Buffer.from(normalized, "base64");
  if (buffer.toString("base64") !== normalized) {
    throw new PublicError("VALIDATION", "contentBase64 must be valid standard base64.");
  }
  return new Uint8Array(buffer);
}

export function utf8DecodeStrict(bytes: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function bestNameMatch<T>(items: T[], readName: (item: T) => string | undefined, input: string) {
  const normalizedInput = normalizeText(input);
  const matches = items
    .map((item) => {
      const name = readName(item) ?? "";
      return { item, name, score: nameMatchScore(name, input, normalizedInput) };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  const bestScore = matches[0]?.score ?? 0;
  if (bestScore === 0) {
    return undefined;
  }

  const bestMatches = matches.filter((entry) => entry.score === bestScore);
  if (bestMatches.length > 1) {
    throw new PublicError(
      "VALIDATION",
      `Name is ambiguous: ${input}. Candidates: ${bestMatches.map((entry) => entry.name).join(", ")}`,
    );
  }

  return bestMatches[0]?.item;
}

function nameMatchScore(name: string, input: string, normalizedInput: string) {
  if (name === input) {
    return 100;
  }
  const normalizedName = normalizeText(name);
  if (normalizedName === normalizedInput) {
    return 90;
  }
  if (normalizedInput.length > 0 && normalizedName.includes(normalizedInput)) {
    return 50;
  }
  return 0;
}

function normalizeText(value: string) {
  return value.trim().toLocaleLowerCase();
}
