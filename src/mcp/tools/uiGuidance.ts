import type { NodelClient } from "../../nodel/client.js";
import { getUiCapabilityContext } from "../../domain/ui/capabilities.js";
import { recognizeUi } from "../../domain/ui/recognition.js";
import { UI_ADVISORY_LIMITS } from "../../domain/ui/limits.js";
import { createReadScope } from "../../nodel/http/bounded.js";
import { NodelTransportError } from "../../nodel/http/errors.js";
import { PublicError } from "../../shared/publicErrors.js";
import { assertSafeRecipePath } from "../../nodel/pathPolicy.js";
import { v1XmlUiGuidance, v2HtmlUiGuidance } from "../../nodel/uiGuidelines.js";
import type { UiCapabilityClient, UiCapabilityContext } from "../../domain/ui/capabilities-types.js";
import { uiReferenceOptions, v2ComponentReference, type V2ReferenceInput } from "./uiReference.js";

export type UiFormat = "v1" | "v2" | "auto";
type SelectionInput = { format?: UiFormat; node?: string; path?: string; refresh?: boolean };
type Observation = {
  format?: "v1" | "v2";
  reason: string;
  context?: UiCapabilityContext;
  uncertainty?: { state: "unknown"; resolution: { state: "failed"; reason: string } };
};

/** No canonical-path bias while recognizing supplied content; comments/text are not markup. */
export function defaultUiVerificationPath(format?: UiFormat, content?: string) {
  return defaultUiVerificationDecision(format, content).path;
}

/** Preserve neutral recognition uncertainty when choosing a parser-specific path. */
export function defaultUiVerificationDecision(
  format?: UiFormat,
  content?: string,
): {
  path: string;
  forceAutoUnselectedReason?: string;
} {
  if (format === "v2") return { path: "content/index.html" };
  if (format === "v1" || content === undefined) return { path: "content/index.xml" };
  const xml = recognizeUi({ path: "candidate.xml", content });
  const html = recognizeUi({ path: "candidate.html", content });
  // Resource limits take precedence over one-sided prefix markers. Do not add
  // a canonical XML default before the shared service can decline selection.
  if (xml.truncated || html.truncated)
    return {
      path: "content/index.html",
      forceAutoUnselectedReason: `Default-path recognition is incomplete (resource-truncated in ${[xml.truncated ? "XML" : undefined, html.truncated ? "HTML" : undefined].filter(Boolean).join(" and ")}); a subsequent path-specific parse cannot clear that uncertainty. Choose v1 or v2 explicitly for bounded validation.`,
    };
  if (xml.basis.includes("pages_root") || xml.basis.includes("v1_stylesheet")) return { path: "content/index.xml" };
  if (html.complete && html.kind === "v2") return { path: "content/index.html" };
  if (format === undefined) return { path: "content/index.xml" };
  // A supplied but unrecognized document must not acquire v1 evidence merely
  // from the canonical legacy filename. Saved no-content calls retain XML above.
  return { path: "content/index.html" };
}

/** Only marker-free legacy fallback may force v1, including malformed XML. */
export function legacyUiVerificationSelection(content?: string): UiFormat {
  if (content === undefined) return "v1";
  return ["candidate.xml", "candidate.html"].some((path) => {
    const evidence = recognizeUi({ path, content });
    return (
      evidence.truncated ||
      evidence.basis.some((basis) => basis === "nodel_element" || basis === "v2_runtime_reference")
    );
  })
    ? "auto"
    : "v1";
}

/** Local no-argument behavior intentionally remains the legacy v1 result. */
export async function uiGuidelines(client: NodelClient, input: SelectionInput = {}) {
  const requested = input.format ?? "v1";
  if (requested === "v1")
    return !input.node && !input.path
      ? v1XmlUiGuidance()
      : { ...v1XmlUiGuidance(), selection: { requested, selected: "v1", path: input.path } };
  const observation = await observe(client, input);
  const selection = { requested, selected: observation.format, reason: observation.reason };
  if (!observation.format)
    return {
      selection,
      capability: observation.context?.capabilities ?? observation.uncertainty,
      options: ["v1", "v2"],
      guidance:
        "No format was selected. Preserve existing documents; choose v1 XML or explicit v2 for unverified offline drafting.",
    };
  if (observation.format === "v1")
    return {
      ...v1XmlUiGuidance(),
      selection,
      capability: observation.context?.capabilities ?? observation.uncertainty,
    };
  return {
    ...v2HtmlUiGuidance(observation.context?.capabilities ?? observation.uncertainty, input.path),
    selection,
  };
}

export async function uiComponentReference(
  client: NodelClient,
  input: SelectionInput & V2ReferenceInput,
  v1Reference: (
    components?: string[],
    includeMarkup?: boolean,
    includeCss?: boolean,
    includeExamples?: boolean,
    cssRecipes?: string[],
  ) => unknown,
) {
  const requested = input.format ?? "v1";
  const legacy = () =>
    v1Reference(input.components, input.includeMarkup, input.includeCss, input.includeExamples, input.cssRecipes);
  if (requested === "v1")
    return !input.node && !input.path
      ? legacy()
      : { ...(legacy() as object), selection: { requested, selected: "v1", path: input.path } };
  const observation = await observe(client, input);
  const selection = { requested, selected: observation.format, reason: observation.reason };
  if (!observation.format)
    return uiReferenceOptions(selection, observation.context?.capabilities ?? observation.uncertainty);
  if (observation.format === "v1")
    return {
      ...(legacy() as object),
      selection,
      capability: observation.context?.capabilities ?? observation.uncertainty,
    };
  return v2ComponentReference(input, observation.context, selection, observation.uncertainty);
}

/** One trusted identity, one capability observation and one absolute cancellable read budget. */
async function observe(client: NodelClient, input: SelectionInput): Promise<Observation> {
  const explicit = input.format === "v2";
  if (!input.node)
    return {
      format: explicit ? "v2" : undefined,
      reason: "No target was supplied; bundled v2 is offline reference only, not deployment support.",
    };
  const path = input.path ?? "content/index.html";
  assertSafeRecipePath(path);
  const scope = createReadScope(new URL("http://nodel.invalid/"), UI_ADVISORY_LIMITS.explicitDeadlineMs);
  try {
    let request;
    try {
      // This stable facade both pins a trusted node and exposes the configured lower deadline.
      request = await client.resolveStaticAssetRequest(input.node, "contract", scope.options);
    } catch (error) {
      if (error instanceof PublicError && error.code === "POLICY") throw error;
      return {
        format: explicit ? "v2" : undefined,
        reason:
          "Target resolution failed; support is unknown, not absence. Bundled v2 is unverified offline reference only.",
        uncertainty: { state: "unknown", resolution: { state: "failed", reason: failureReason(error) } },
      };
    }
    const operation = createReadScope(new URL(request.url), UI_ADVISORY_LIMITS.explicitDeadlineMs, {
      signal: scope.options.signal,
      deadlineMs: Math.min(scope.options.deadlineMs!, request.deadlineMs ?? Infinity),
    });
    try {
      let saved: ReturnType<typeof recognizeUi> | undefined;
      let fileFailure: string | undefined;
      let missing = false;
      if (input.path && !explicit) {
        try {
          const bytes = await client.getNodeFileBytes(request.node, path, {
            ...operation.options,
            maxResponseBytes: UI_ADVISORY_LIMITS.maxInputBytes,
          });
          saved = recognizeUi({ path, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
        } catch (error) {
          if (error instanceof PublicError && error.code === "POLICY") throw error;
          missing = error instanceof NodelTransportError && error.details.status === 404;
          fileFailure = missing
            ? "The requested file returned HTTP 404. A new-page recommendation is conditional on that absence evidence; no write is performed."
            : "Existing file could not be read within bounded UTF-8 limits; do not assume absence or infer its format from the host.";
        }
      }
      const context = await getUiCapabilityContext(client as unknown as UiCapabilityClient, request.node, path, {
        ...operation.options,
        refresh: input.refresh,
      });
      if (explicit)
        return { format: "v2", context, reason: "Explicit v2 reference selection does not establish target support." };
      if (saved) {
        if (saved.complete && !saved.truncated && saved.kind !== "mixed" && saved.selectedFormat)
          return {
            format: saved.selectedFormat,
            context,
            reason: `Preserve existing document: ${saved.basis.join(", ")}. Support recommendations are separate.`,
          };
        return {
          context,
          reason: saved.explanation ?? "Document recognition is ambiguous or incomplete; choose a format explicitly.",
        };
      }
      if (fileFailure && !missing) return { context, reason: fileFailure };
      if (missing && /\.xml$/iu.test(path))
        return {
          format: "v1",
          context,
          reason: `${fileFailure} Preserve the XML path as v1; host availability does not reinterpret it as HTML.`,
        };
      if (input.path && !/\.html?$/iu.test(path))
        return {
          context,
          reason: `${fileFailure ?? ""} This is not an HTML UI path; no new v2 page or starter is recommended for it.`,
        };
      if (context.capabilities.state === "available")
        return {
          format: "v2",
          context,
          reason: `${fileFailure ?? "New-page context (no saved path requested)."} Supported contract and entry assets were observed on this target; recommend v2, not browser verification.`,
        };
      return {
        context,
        reason: `${fileFailure ?? ""} Target v2 capability is ${context.capabilities.state}; no format was selected automatically.`,
      };
    } finally {
      operation.close();
    }
  } finally {
    scope.close();
  }
}

function failureReason(error: unknown) {
  return error instanceof NodelTransportError
    ? error.details.status
      ? `resolution_http_${error.details.status}`
      : `resolution_${error.code.toLowerCase()}`
    : "resolution_failed";
}
