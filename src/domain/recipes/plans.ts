import { stableJsonHash } from "../../shared/canonicalJson.js";

export function recipeWriteProposalHash(
  operation: string,
  target: string,
  currentHash: string | undefined,
  nextHash: string | undefined,
  path: string,
  extraPlan: Record<string, unknown>,
) {
  return stableJsonHash({ operation, target, payload: { currentHash, nextHash, path, extraPlan } });
}
export function writeApprovalDetails(operation: string, target: string, payload: unknown) {
  return { operation, target, proposalHash: stableJsonHash({ operation, target, payload }) };
}
export function lifecycleRequest(
  operation: "restart_node" | "create_node" | "delete_node",
  method: "POST" | "DELETE",
  restPath: string,
  body?: unknown,
) {
  return { operation, method, restPath, body };
}
