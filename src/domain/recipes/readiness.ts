import type { AppConfig } from "../../config.js";
import type { NodelClient } from "../../nodel/client.js";
import type { ResolvedNode } from "../../nodel/types.js";
import { sanitizeSensitiveMessage } from "../../shared/publicErrors.js";

export type PostWriteReadinessOptions = {
  waitForReady: boolean;
  readyTimeoutSeconds?: number;
  operation: string;
};

export async function waitForNodeReadyAfterWrite(
  nodelClient: Pick<NodelClient, "nodeRequest">,
  config: AppConfig,
  node: ResolvedNode,
  options: PostWriteReadinessOptions,
) {
  const timeoutMs = Math.max(1000, (options.readyTimeoutSeconds ?? config.postWriteReadyTimeoutSeconds ?? 20) * 1000);
  const settleMs = config.postWriteSettleMs ?? 3000;
  const pollMs = 500;
  const probe = "REST/actions";

  if (!options.waitForReady) {
    return {
      operation: options.operation,
      attempted: false,
      ready: undefined,
      nodeMayRestart: true,
      message:
        "Write was sent, but post-write readiness waiting was skipped. Wait for the Nodel node to finish reloading before verification reads or further writes.",
    };
  }

  const startedAt = Date.now();
  if (settleMs > 0) await sleep(settleMs);
  let attempts = 0;
  let consecutiveSuccesses = 0;
  let lastError: string | undefined;
  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    try {
      await nodelClient.nodeRequest(node, "actions", { responseMode: "json" });
      consecutiveSuccesses += 1;
      if (consecutiveSuccesses >= 2) {
        return {
          operation: options.operation,
          attempted: true,
          ready: true,
          nodeMayRestart: true,
          probe,
          attempts,
          elapsedMs: Date.now() - startedAt,
          settleMs,
          message: "Node responded to two post-write readiness probes. Continue with verification reads now.",
        };
      }
    } catch (error) {
      consecutiveSuccesses = 0;
      lastError = sanitizeSensitiveMessage(error);
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollMs, remainingMs));
  }
  return {
    operation: options.operation,
    attempted: true,
    ready: false,
    nodeMayRestart: true,
    probe,
    attempts,
    elapsedMs: Date.now() - startedAt,
    settleMs,
    timeoutMs,
    lastError,
    message:
      "Write was sent, but the node did not become ready before the timeout. Do not assume the runtime has reloaded; check console/activity and retry readiness-sensitive reads.",
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
