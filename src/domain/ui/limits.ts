/** Internal safety budgets shared by advisory UI analysis. */
export const UI_ADVISORY_LIMITS = Object.freeze({
  maxInputBytes: 2 * 1024 * 1024,
  maxVisitedNodes: 20_000,
  maxDepth: 128,
  maxAttributesPerTag: 256,
  maxTagCharacters: 65_536,
  maxParserErrors: 200,
  // Output diagnostics and actual parser error work have separate bounds.
  maxParserErrorEvents: 2_000,
  maxTreeOperations: 2_000_000,
  parserChunkCharacters: 1_024,
  maxIssues: 200,
  automaticDeadlineMs: 3_000,
  explicitDeadlineMs: 10_000,
  capabilitySuccessTtlMs: 60_000,
  capabilityFailureTtlMs: 10_000,
  capabilityCacheEntries: 64,
  capabilityCacheContractBytes: 16 * 1024 * 1024,
  capabilityConcurrentProbes: 3,
  capabilityQueuedProbes: 64,
  maxRuntimeReferences: 64,
});

export type UiLimitName = keyof typeof UI_ADVISORY_LIMITS;
