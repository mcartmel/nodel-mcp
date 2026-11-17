import type { UiValidationIssue } from "./types.js";
import { UI_ADVISORY_LIMITS } from "./limits.js";

export function issueLimit(requested?: number, ceiling: number = UI_ADVISORY_LIMITS.maxIssues) {
  return Number.isFinite(requested)
    ? Math.max(0, Math.min(ceiling, Math.trunc(requested!)))
    : UI_ADVISORY_LIMITS.maxIssues;
}

/** Array-compatible sink for the legacy rules. Count every observed diagnostic,
 * but never retain an unbounded list before applying the output limit. */
export function diagnosticCollector(requested?: number, ceiling: number = UI_ADVISORY_LIMITS.maxIssues) {
  const limit = issueLimit(requested, ceiling);
  const issues: UiValidationIssue[] = [];
  const counts = { error: 0, warning: 0, info: 0 };
  let total = 0;
  Object.defineProperty(issues, "push", {
    value: (...entries: UiValidationIssue[]) => {
      for (const entry of entries) {
        counts[entry.severity]++;
        total++;
        if (issues.length < limit)
          Array.prototype.push.call(
            issues,
            entry.message.length > 2000 ? { ...entry, message: `${entry.message.slice(0, 1997)}...` } : entry,
          );
      }
      return issues.length;
    },
  });
  return {
    issues,
    counts,
    get total() {
      return total;
    },
    get truncated() {
      return total > issues.length;
    },
  };
}
