import { createHash } from "node:crypto";
import { BoundedReadLimiter, createReadScope } from "../../nodel/http/bounded.js";
import { NodelTimeoutError, NodelTransportError } from "../../nodel/http/errors.js";
import { assertSafeRecipePath } from "../../nodel/pathPolicy.js";
import type { ResolvedNode, StaticAsset, StaticAssetReadResult } from "../../nodel/types.js";
import { PublicError, sanitizeSensitiveMessage } from "../../shared/publicErrors.js";
import { UiCapabilityCache, type CapabilityCacheRead } from "./capabilities-cache.js";
import { resolveUiPageRuntimeContext } from "./capabilities-page.js";
import { UI_ADVISORY_LIMITS as limits } from "./limits.js";
import {
  decodeV2Contract,
  selectV2Contract,
  PINNED_V2_CONTRACT,
  PINNED_V2_PROVENANCE,
  type V2Contract,
} from "./v2/contract.js";
import type {
  UiAssetEvidence,
  UiCapabilities,
  UiCapabilityClient,
  UiCapabilityContext,
  UiCapabilityOptions,
  UiCapabilityState,
  UiContractEvidence,
  UiContractProvenance,
} from "./capabilities-types.js";

export type * from "./capabilities-types.js";
export { resolveUiPageRuntimeContext } from "./capabilities-page.js";

type ContractObservation = { evidence: UiContractEvidence; contract?: V2Contract; bytes: number };
type Observation = {
  assets: Partial<Record<StaticAsset, UiAssetEvidence>>;
  contract?: ContractObservation;
  policyError?: PublicError;
};
const artifacts: StaticAsset[] = ["contract", "script", "stylesheet"];
const caches = new WeakMap<UiCapabilityClient, UiCapabilityCache<Observation>>();
const resolutions = new WeakMap<UiCapabilityClient, BoundedReadLimiter>();
// Never hand the mutable imported JSON fixture to a caller of the service.
const fallbackContract = deepFreeze(structuredClone(PINNED_V2_CONTRACT));
const deploymentLimitation =
  "Supported contract and entry-asset evidence does not prove complete chunks/icons, matching runtime versions, primary UI selection, component upgrades, or browser operation. No downloaded code was executed.";

/** Compact advisory result; no contract JSON, JS/CSS samples, or remote error bodies. */
export async function getUiCapabilities(
  client: UiCapabilityClient,
  node: string,
  path = "content/index.html",
  options: UiCapabilityOptions = {},
): Promise<UiCapabilities> {
  return (await getUiCapabilityContext(client, node, path, options)).capabilities;
}

/** Internal validator/reference authority. Resolved identities must come from this client's trusted resolver.
 * A resolved argument pins an enclosing operation even on refresh; standalone string calls still re-resolve.
 * A deployed contract is never merged with bundled elements.
 */
export async function getUiCapabilityContext(
  client: UiCapabilityClient,
  node: string | ResolvedNode,
  path = "content/index.html",
  options: UiCapabilityOptions = {},
): Promise<UiCapabilityContext> {
  assertSafeRecipePath(path);
  if (path.length > 4096) throw new TypeError("Page path exceeds the supported length.");
  const budget = options.automatic ? limits.automaticDeadlineMs : limits.explicitDeadlineMs;
  if (options.deadlineMs !== undefined && options.deadlineMs <= Date.now()) {
    return assemble(
      undefined,
      path,
      options,
      { value: { assets: {} }, hit: false, deduplicated: false, ageMs: 0, ttlMs: 0, interrupted: true },
      "aggregate_timeout",
    );
  }
  const scope = createReadScope(new URL("http://nodel.invalid/"), budget, {
    signal: options.signal,
    deadlineMs: options.deadlineMs,
  });
  let resolved: ResolvedNode | undefined;
  try {
    let resolutionLimiter = resolutions.get(client);
    if (!resolutionLimiter) {
      resolutionLimiter = new BoundedReadLimiter(limits.capabilityConcurrentProbes, limits.capabilityQueuedProbes);
      resolutions.set(client, resolutionLimiter);
    }
    const request = await resolutionLimiter.run(scope.options.signal, () =>
      client.resolveStaticAssetRequest(node, "contract", scope.options),
    );
    resolved = request.node;
    // The facade exposes its configured lower timeout as an absolute deadline;
    // resolution time is included, rather than resetting that timeout per asset.
    const effectiveDeadline = Math.min(scope.options.deadlineMs!, request.deadlineMs ?? Infinity);
    const subscription = createReadScope(new URL(request.url), budget, {
      signal: scope.options.signal,
      deadlineMs: effectiveDeadline,
    });
    try {
      const requests = await Promise.all(
        artifacts.map((artifact) => client.resolveStaticAssetRequest(resolved!, artifact, subscription.options)),
      );
      const key = JSON.stringify([resolved.nodeBaseUrl, ...requests.map((entry) => entry.url)]);
      let cache = caches.get(client);
      if (!cache) {
        cache = new UiCapabilityCache();
        caches.set(client, cache);
      }
      const read = await cache.read(
        key,
        { refresh: options.refresh, signal: subscription.options.signal! },
        () => ({ assets: {} }),
        async (progress, signal, deadlineMs) => {
          await Promise.all(
            artifacts.map(async (artifact) => {
              try {
                const result = await client.readStaticAsset(resolved!, artifact, { signal, deadlineMs });
                progress.assets[artifact] = assetEvidence(result);
                if (artifact === "contract") progress.contract = inspectContract(result);
              } catch (error) {
                if (error instanceof PublicError && error.code === "POLICY") {
                  progress.policyError = error;
                  throw error;
                }
                // Policy was already enforced by resolution. Never copy arbitrary
                // exception text into an advisory response or reinterpret it as absence.
                progress.assets[artifact] = {
                  artifact,
                  outcome: signal.aborted ? "aborted" : "network_error",
                  bytesRead: 0,
                  bodyComplete: false,
                };
              }
            }),
          );
          return progress;
        },
        (observation) => ({
          positive: capabilityState(observation) === "available",
          bytes: observation.contract?.bytes ?? 0,
        }),
      );
      return assemble(
        resolved,
        path,
        options,
        read,
        read.interrupted ? (read.interruptionReason ?? interruptionReason(subscription.options.signal!)) : undefined,
      );
    } finally {
      subscription.close();
    }
  } catch (error) {
    // Advisory network failures are unknown. Authorization policy remains a real
    // error and never causes a probe of another runtime or fallback URL.
    if (error instanceof PublicError && error.code === "POLICY") throw error;
    return assemble(
      resolved,
      path,
      options,
      { value: { assets: {} }, hit: false, deduplicated: false, ageMs: 0, ttlMs: 0, interrupted: true },
      safeFailure(error, scope.options.signal!),
    );
  } finally {
    scope.close();
  }
}

/** Preserve the pinned authoring reference when capability discovery cannot start. */
export function unavailableUiCapabilityContext(
  path: string,
  reason: string,
  options: UiCapabilityOptions = {},
): UiCapabilityContext {
  return assemble(
    undefined,
    path,
    options,
    { value: { assets: {} }, hit: false, deduplicated: false, ageMs: 0, ttlMs: 0, interrupted: true },
    reason,
  );
}

function assemble(
  node: ResolvedNode | undefined,
  path: string,
  options: UiCapabilityOptions,
  read: CapabilityCacheRead<Observation>,
  interruption?: string,
): UiCapabilityContext {
  const observation = read.value;
  if (observation.policyError) throw observation.policyError;
  const state = capabilityState(observation);
  const deployed = observation.contract?.evidence ?? { state: "unavailable", diagnostics: [], limitations: [] };
  const failure = interruption ?? contractFailure(observation);
  const selection = selectV2Contract(observation.contract?.contract, failure);
  const contract = selection.kind === "deployed" ? selection.contract : fallbackContract;
  const contractAsset = observation.assets.contract;
  const provenance: UiContractProvenance =
    selection.kind === "deployed"
      ? {
          contractSource: "deployed",
          schemaVersion: 1,
          packageVersion: deployed.packageVersion ?? sanitizeSensitiveMessage(contract.packageVersion).slice(0, 128),
          contentHash: deployed.contentHash!,
          sourceUrl: contractAsset?.finalUrl,
          retrievedAt: contractAsset?.retrievedAt,
          cacheAgeMs: contractAsset?.retrievedAt
            ? Math.max(0, Date.now() - Date.parse(contractAsset.retrievedAt))
            : read.ageMs,
          deploymentApplicable: true,
          compatibility: "supported-contract",
        }
      : {
          contractSource: "bundled",
          schemaVersion: PINNED_V2_PROVENANCE.schemaVersion,
          packageVersion: PINNED_V2_PROVENANCE.packageVersion,
          contentHash: PINNED_V2_PROVENANCE.sha256,
          repository: PINNED_V2_PROVENANCE.repository,
          repositoryRevision: PINNED_V2_PROVENANCE.revision,
          license: PINNED_V2_PROVENANCE.license,
          cacheAgeMs: read.ageMs,
          deploymentApplicable: false,
          compatibility: "unverified",
          detectionFailure: failure,
        };
  const assets = Object.fromEntries(
    artifacts.map((artifact) => [
      artifact,
      observation.assets[artifact] ?? {
        artifact,
        outcome: "not_run",
        bytesRead: 0,
        bodyComplete: false,
        reason: interruption ?? "No observation was completed.",
      },
    ]),
  ) as Record<StaticAsset, UiAssetEvidence>;
  const page = resolveUiPageRuntimeContext(node?.nodeBaseUrl, path, options.content);
  const recommendation: UiCapabilities["recommendation"] = /\.xml$/iu.test(path)
    ? {
        format: "preserve_v1",
        scope: "node_root",
        reason:
          "Preserve the existing XML format; node-root v2 availability does not reinterpret an XML document or migrate it.",
      }
    : state === "available"
      ? {
          format: "v2",
          scope: "node_root",
          reason:
            "A supported deployed contract and both stable entry assets were observed. Recommend v2 for new node-root pages; the page-specific reference/API assessment remains separate.",
        }
      : {
          format: "undetermined",
          scope: "node_root",
          reason:
            "Deployment support is not established. Preserve existing formats; v1 remains an option and bundled v2 is unverified authoring reference only.",
        };
  const capabilities: UiCapabilities = {
    advisory: true,
    ...(node ? { target: { name: node.name, nodeBaseUrl: node.nodeBaseUrl } } : {}),
    state,
    assets,
    deployedContract: deployed,
    contract: provenance,
    page,
    recommendation,
    cache: {
      hit: read.hit,
      deduplicated: read.deduplicated,
      ageMs: read.ageMs,
      ttlMs: read.ttlMs,
      refresh: options.refresh ?? false,
    },
    ...(!node ? { resolution: { state: "failed" as const, reason: interruption ?? "resolution_failed" } } : {}),
    limitations: [
      deploymentLimitation,
      ...selection.limitations,
      ...page.limitations,
      ...(interruption
        ? [`Capability checks were interrupted: ${interruption}. Unfinished reads are not evidence of absence.`]
        : []),
    ],
    browserTested: false,
  };
  // Public metadata is detached from cached observations, including nested arrays.
  // The only shared value returned internally is the deeply immutable contract.
  return { capabilities: structuredClone(capabilities), contract, provenance: structuredClone(provenance) };
}

function capabilityState(observation: Observation): UiCapabilityState {
  if (
    observation.contract?.evidence.state === "invalid" ||
    observation.contract?.evidence.state === "unsupported_schema"
  )
    return "incompatible_contract";
  if (
    observation.contract?.contract &&
    observation.assets.script?.outcome === "observed" &&
    observation.assets.stylesheet?.outcome === "observed"
  )
    return "available";
  if (
    artifacts.every((artifact) => {
      const evidence = observation.assets[artifact];
      return evidence?.outcome === "http_error" && (evidence.status === 404 || evidence.status === 410);
    })
  )
    return "not_detected";
  if (artifacts.some((artifact) => observation.assets[artifact]?.outcome === "observed")) return "incomplete";
  return "unknown";
}

function assetEvidence(result: StaticAssetReadResult): UiAssetEvidence {
  return {
    artifact: result.artifact,
    outcome: result.outcome,
    url: result.url,
    finalUrl: result.finalUrl,
    status: result.status,
    mimeType: result.mimeType,
    bytesRead: result.bytesRead,
    bodyComplete: result.bodyComplete,
    retrievedAt: result.retrievedAt,
    durationMs: result.durationMs,
    contentHash: result.contentSha256,
  };
}

function inspectContract(result: StaticAssetReadResult): ContractObservation {
  const evidence: UiContractEvidence = { state: "unavailable", diagnostics: [], limitations: [] };
  if (result.outcome !== "observed" || result.content === undefined) return { evidence, bytes: 0 };
  if (!result.bodyComplete) {
    evidence.diagnostics.push("The contract body was not fully read; partial JSON is not used as authority.");
    return { evidence, bytes: 0 };
  }
  evidence.contentHash = result.contentSha256 ?? createHash("sha256").update(result.content).digest("hex");
  let input: unknown;
  try {
    input = JSON.parse(result.content.replace(/^\ufeff/u, "")) as unknown;
  } catch {
    evidence.state = "invalid";
    evidence.diagnostics.push("The deployed contract body was not valid JSON; response text is not included.");
    return { evidence, bytes: 0 };
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const raw = input as Record<string, unknown>;
    if (typeof raw.schemaVersion === "number" && Number.isFinite(raw.schemaVersion))
      evidence.schemaVersion = raw.schemaVersion;
    else if (typeof raw.schemaVersion === "string")
      evidence.schemaVersion = sanitizeSensitiveMessage(raw.schemaVersion).slice(0, 128);
    if (typeof raw.packageVersion === "string")
      evidence.packageVersion = sanitizeSensitiveMessage(raw.packageVersion).slice(0, 128);
    if (evidence.schemaVersion !== undefined && raw.schemaVersion !== 1) {
      evidence.state = "unsupported_schema";
      evidence.diagnostics.push("$.schemaVersion: unsupported schema version; it was not interpreted as schema 1.");
      return { evidence, bytes: 0 };
    }
  }
  const decoded = decodeV2Contract(input);
  evidence.diagnostics = decoded.errors.slice(0, 10).map(sanitizeSensitiveMessage);
  evidence.limitations = decoded.limitations;
  if (!decoded.contract) {
    evidence.state = "invalid";
    return { evidence, bytes: 0 };
  }
  evidence.state = "supported";
  return { evidence, contract: deepFreeze(decoded.contract), bytes: result.bytesRead };
}

function contractFailure(observation: Observation): string {
  const state = observation.contract?.evidence.state;
  if (state === "unsupported_schema") return "The deployed contract uses an unsupported schema version.";
  if (state === "invalid") return "The deployed contract is malformed or has invalid/unsupported known fields.";
  const asset = observation.assets.contract;
  return asset
    ? `Deployed contract unavailable: ${asset.outcome}${asset.status ? ` (HTTP ${asset.status})` : ""}.`
    : "Deployed contract was not observed.";
}
function interruptionReason(signal: AbortSignal) {
  return signal.reason instanceof NodelTimeoutError
    ? "aggregate_timeout"
    : signal.aborted
      ? "caller_aborted"
      : "probe_capacity";
}
function safeFailure(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return interruptionReason(signal);
  if (error instanceof NodelTransportError)
    return error.code === "TIMEOUT"
      ? "aggregate_timeout"
      : error.details.status
        ? `resolution_http_${error.details.status}`
        : "resolution_network_error";
  return "resolution_failed";
}
function deepFreeze<T>(value: T): T {
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length) {
    const entry = stack.pop();
    if (entry === null || typeof entry !== "object" || seen.has(entry)) continue;
    seen.add(entry);
    stack.push(...Object.values(entry));
    Object.freeze(entry);
  }
  return value;
}
