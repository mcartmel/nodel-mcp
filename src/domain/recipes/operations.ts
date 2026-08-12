import { sha256 } from "../../shared/canonicalJson.js";
import { publicError } from "../../shared/publicErrors.js";

export const SCRIPT_PATH = "script.py";
export const NODE_CONFIG_PATH = "nodeConfig.json";
export function recipeScriptSaveRequest(script: string) {
  return {
    restPath: "script/save",
    method: "POST" as const,
    headers: { "content-type": "application/json" },
    body: { script },
  };
}
export function nodeFileSaveRequest(path: string, bytes: Uint8Array) {
  return {
    restPath: `files/save?path=${encodeURIComponent(path)}`,
    method: "POST" as const,
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  };
}
export function applyTextEdits(
  content: string,
  edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }>,
) {
  let next = content;
  const applied: Array<{ index: number; replaceAll: boolean; occurrences: number; oldHash: string; newHash: string }> =
    [];
  edits.forEach((edit, index) => {
    const occurrences = next.split(edit.oldText).length - 1;
    if (occurrences === 0) throw publicError("VALIDATION", `Edit ${index + 1} oldText was not found.`);
    if (!edit.replaceAll && occurrences > 1)
      throw publicError(
        "VALIDATION",
        `Edit ${index + 1} oldText matched ${occurrences} times. Set replaceAll=true or provide more context.`,
      );
    next = edit.replaceAll ? next.split(edit.oldText).join(edit.newText) : next.replace(edit.oldText, edit.newText);
    applied.push({
      index,
      replaceAll: Boolean(edit.replaceAll),
      occurrences: edit.replaceAll ? occurrences : 1,
      oldHash: sha256(edit.oldText),
      newHash: sha256(edit.newText),
    });
  });
  return { content: next, applied };
}
export type NormalizedContent = {
  mode: "text" | "base64";
  bytes: Uint8Array;
  text?: string;
  byteLength: number;
  hash: string;
};
export function normalizeTextContent(content: string): NormalizedContent {
  const bytes = new Uint8Array(Buffer.from(content, "utf8"));
  return { mode: "text", bytes, text: content, byteLength: bytes.byteLength, hash: sha256(bytes) };
}
export function normalizeBase64Content(value: string): NormalizedContent {
  const normalized = value.trim();
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || /=.*[^=]/u.test(normalized))
    throw publicError("VALIDATION", "contentBase64 must be valid standard base64.");
  const bytes = new Uint8Array(Buffer.from(normalized, "base64"));
  if (Buffer.from(bytes).toString("base64") !== normalized)
    throw publicError("VALIDATION", "contentBase64 must be valid standard base64.");
  return { mode: "base64", bytes, byteLength: bytes.byteLength, hash: sha256(bytes) };
}
