import { createHash, timingSafeEqual } from "node:crypto";

/** Compares strings without leaking where equally-sized values differ. */
export function timingSafeStringEqual(left: string, right: string) {
  // Hash first so different-length supplied credentials take the same compare path.
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
