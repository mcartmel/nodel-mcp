export function bindingApprovalPayload(input: {
  mode: "merge" | "replace";
  currentHash: string;
  nextHash: string;
  bindings: unknown;
  removePaths?: string[][];
}) {
  return {
    mode: input.mode,
    currentHash: input.currentHash,
    nextHash: input.nextHash,
    bindings: input.bindings,
    removePaths: (input.removePaths ?? []).map((path) => [...path]),
  };
}
