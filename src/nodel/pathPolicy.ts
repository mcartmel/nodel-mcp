const uiAssetExtensions = new Set([
  ".avif",
  ".bmp",
  ".css",
  ".eot",
  ".gif",
  ".htm",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".map",
  ".mjs",
  ".otf",
  ".png",
  ".svg",
  ".ttf",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
]);

export function assertSafeRecipePath(path: string) {
  if (path.trim() !== path || path.length === 0) {
    throw publicError("VALIDATION", "Recipe path must be a non-empty relative path without surrounding whitespace.");
  }
  if (/\p{C}/u.test(path)) {
    throw publicError("VALIDATION", "Recipe path must not contain control characters.");
  }
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path)) {
    throw publicError("VALIDATION", "Recipe path must be relative.");
  }
  if (path.includes("\\")) {
    throw publicError("VALIDATION", "Recipe path must use forward slashes.");
  }
  if (path.includes("?") || path.includes("#")) {
    throw publicError("VALIDATION", "Recipe path must not contain query or hash delimiters.");
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw publicError(
      "VALIDATION",
      "Recipe path must not contain empty, current-directory, or parent-directory segments.",
    );
  }

  return path;
}

export function assertSafePublicRecipePath(path: string) {
  return assertSafeRecipePath(path.replace(/^\/+|\/+$/gu, ""));
}

export function contentAssetPathWarning(path: string) {
  if (path.startsWith("content/") || !isUiAssetPath(path)) {
    return undefined;
  }

  return `UI/static asset "${path}" is outside content/. Nodel serves custom UI assets from the special content/ folder; prefer "content/${path}" for storage unless this path is intentional. Browser-facing URLs should omit the content/ prefix.`;
}

function isUiAssetPath(path: string) {
  const name = path.toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) {
    return false;
  }

  return uiAssetExtensions.has(name.slice(dot));
}
import { publicError } from "../shared/publicErrors.js";
