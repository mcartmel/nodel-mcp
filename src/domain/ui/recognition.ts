import { parseHtml, walkHtml, type HtmlParseError, type HtmlTruncationReason } from "./html.js";
import { SaxesParser } from "saxes";
import { UI_ADVISORY_LIMITS } from "./limits.js";
import type { UiDetectionBasis, UiDetectionKind, UiFormatSelection } from "./advisory-types.js";

export type UiRecognitionEvidence = {
  kind: UiDetectionKind;
  basis: UiDetectionBasis[];
  complete: boolean;
  truncated: boolean;
  errors: HtmlParseError[];
  errorCount: number;
  omittedErrors: number;
  errorCountIsLowerBound: boolean;
  parser: "html" | "xml" | "none";
  truncationReason?: HtmlTruncationReason;
};
export type UiRecognition = {
  kind: UiDetectionKind;
  basis: UiDetectionBasis[];
  explanation?: string;
  selectedFormat?: "v1" | "v2";
  parseSkipped: boolean;
  complete: boolean;
  truncated: boolean;
  errors: Array<HtmlParseError & { source?: "candidate" | "original" }>;
  errorCount: number;
  omittedErrors: number;
  errorCountIsLowerBound: boolean;
  candidate?: UiRecognitionEvidence;
  original?: UiRecognitionEvidence;
};
export type UiRecognitionInput = {
  path: string;
  content?: string;
  originalContent?: string;
  selection?: UiFormatSelection;
};

const NON_UI_EXTENSIONS = /\.(?:js|mjs|cjs|css|json|py|pyc|png|jpe?g|gif|svg|ico|woff2?|ttf|pdf|zip)$/iu;
const V2_RUNTIME = /(?:^|[./])v2\/nodel-webui\.(?:js|css)(?:[?#]|$)|(?:^|["'\s])nodel-webui-v2(?:["'\s/]|$)/iu;
const V1_STYLESHEET = /(?:^|\/)v1\/index\.xsl(?:[?#]|$)/iu;
const isRuntimeAttribute = (name: string, value: string): boolean =>
  (name === "src" || name === "href" || name === "data-nodel-runtime") && V2_RUNTIME.test(value);

/** Parse pseudo-attributes, not href-like text embedded in another attribute's value. */
function isV1Stylesheet(body: string): boolean | undefined {
  const sax = new SaxesParser({ xmlns: false });
  let href: string | undefined;
  let attrs = 0;
  let limited = false;
  sax.on("attribute", () => {
    if (++attrs > UI_ADVISORY_LIMITS.maxAttributesPerTag) {
      limited = true;
      throw new Error("attributes");
    }
  });
  sax.on("opentag", (tag) => {
    href = tag.attributes.href;
  });
  try {
    sax.write(`<stylesheet ${body}/>`).close();
    return href !== undefined && V1_STYLESHEET.test(href);
  } catch {
    return limited ? undefined : false;
  }
}

/**
 * XML paths only: XML self-closing/CDATA rules throughout. No DTD/entity
 * loading, tree retention, or script execution. HTML never enters this parser.
 */
function xmlEvidence(text: string): {
  basis: UiDetectionBasis[];
  error?: HtmlParseError;
  truncationReason?: HtmlTruncationReason;
} {
  const sax = new SaxesParser({ xmlns: false });
  const abort = new Error("XML recognition budget reached");
  const basis: UiDetectionBasis[] = [];
  let seenRoot = false;
  let depth = 0;
  let nodes = 0;
  let attrs = 0;
  let scriptDepth = 0;
  let markupStart: number | undefined;
  let markupLimit: number = UI_ADVISORY_LIMITS.maxTagCharacters;
  let reason: HtmlTruncationReason | undefined;
  const stop = (why: HtmlTruncationReason): never => {
    reason = why;
    throw abort;
  };
  const mark = (item: UiDetectionBasis): void => {
    if (!basis.includes(item)) basis.push(item);
  };
  const checkTokenSize = (): void => {
    if (markupStart !== undefined && sax.position - markupStart > markupLimit) stop("tag_size");
  };
  const tokenEnd = (): void => {
    checkTokenSize();
    markupStart = undefined;
  };
  const node = (): void => {
    if (++nodes > UI_ADVISORY_LIMITS.maxVisitedNodes) stop("node_count");
  };
  const markupNode = (): void => {
    node();
    tokenEnd();
  };
  sax.on("processinginstruction", (instruction) => {
    markupNode();
    if (!seenRoot && instruction.target === "xml-stylesheet") {
      const stylesheet = isV1Stylesheet(instruction.body);
      if (stylesheet === undefined) stop("attributes_per_tag");
      if (stylesheet) {
        mark("v1_stylesheet");
      }
    }
  });
  sax.on("opentagstart", () => {
    seenRoot = true;
    if (nodes >= UI_ADVISORY_LIMITS.maxVisitedNodes) stop("node_count");
    if (++depth > UI_ADVISORY_LIMITS.maxDepth) stop("depth");
    attrs = 0;
  });
  sax.on("attribute", () => {
    if (++attrs > UI_ADVISORY_LIMITS.maxAttributesPerTag) stop("attributes_per_tag");
  });
  sax.on("opentag", (tag) => {
    markupNode();
    if (depth === 1 && tag.name.toLowerCase() === "pages") mark("pages_root");
    // XML still supplies structural v1 evidence, but apparent elements inside
    // script content are not rendered components or authored runtime references.
    // Keep the script's own src eligible, and resume at its matching XML close.
    if (!scriptDepth) {
      if (tag.name.toLowerCase().startsWith("nodel-")) mark("nodel_element");
      for (const [name, value] of Object.entries(tag.attributes))
        if (isRuntimeAttribute(name.toLowerCase(), value)) mark("v2_runtime_reference");
      if (tag.name.toLowerCase() === "script") scriptDepth = depth;
    }
  });
  sax.on("closetag", () => {
    if (depth === scriptDepth) scriptDepth = 0;
    depth--;
    tokenEnd();
  });
  sax.on("comment", markupNode);
  sax.on("doctype", markupNode);
  sax.on("cdata", markupNode);
  sax.on("text", node);
  sax.on("xmldecl", tokenEnd);
  try {
    // A literal '<' outside an active XML token begins markup. Only SAX events
    // end that token: quoted '>', entities, nested DTD syntax and comment/CDATA
    // contents cannot fool the guard. Split before every '<' so a completed
    // token cannot hide a later token in the same write. Cache the next delimiter
    // to avoid repeatedly scanning a long plain-text suffix. Text (including
    // CDATA) uses the existing 2 MiB input bound, not the markup-size budget.
    let nextMarkup = text.indexOf("<");
    for (let offset = 0; offset < text.length; ) {
      if (offset === nextMarkup) {
        if (markupStart === undefined) {
          markupStart = offset;
          markupLimit = text.startsWith("<![CDATA[", offset)
            ? UI_ADVISORY_LIMITS.maxInputBytes
            : UI_ADVISORY_LIMITS.maxTagCharacters;
        }
        nextMarkup = text.indexOf("<", offset + 1);
      }
      const end = Math.min(
        offset + UI_ADVISORY_LIMITS.parserChunkCharacters,
        nextMarkup < 0 ? text.length : nextMarkup,
      );
      sax.write(text.slice(offset, end));
      checkTokenSize();
      offset = end;
    }
    sax.close();
  } catch (error) {
    if (error === abort)
      return {
        basis,
        truncationReason: reason,
        error: { code: "XML_ANALYSIS_TRUNCATED", message: `XML recognition reached the ${reason} limit.` },
      };
    return {
      basis,
      error: {
        code: "XML_PARSE_FAILED",
        message: "XML recognition stopped at a syntax error.",
        line: sax.line,
        column: sax.columnIndex + 1,
        startOffset: sax.position,
      },
    };
  }
  return { basis };
}

function classify(path: string, text: string): UiRecognitionEvidence {
  const basis: UiDetectionBasis[] = [];
  if (path === "content/index.xml") basis.push("canonical_path");
  // Do not invoke *either* parser for an oversized candidate.
  const oversized = Buffer.byteLength(text, "utf8") > UI_ADVISORY_LIMITS.maxInputBytes;
  const xmlPath = /\.xml$/iu.test(path);
  const xml = !oversized && xmlPath ? xmlEvidence(text) : undefined;
  if (xml) basis.push(...xml.basis);
  let errors: HtmlParseError[];
  let errorCount: number;
  let complete: boolean;
  let truncated: boolean;
  let truncationReason: HtmlTruncationReason | undefined;
  let parser: UiRecognitionEvidence["parser"];
  if (xmlPath && xml) {
    errors = xml.error ? [xml.error] : [];
    errorCount = errors.length;
    complete = !xml.error;
    truncated = !!xml.truncationReason;
    truncationReason = xml.truncationReason;
    parser = "xml";
  } else {
    const parsed = parseHtml(text);
    let firstElement: { name: string; offset: number } | undefined;
    let firstTextOffset = Infinity;
    const instructions: Array<{ body: string; offset: number }> = [];
    const walked = walkHtml(parsed.root, (node) => {
      // Tree order can differ from source order (e.g. foster parenting). Only
      // authored opening tags count; implicit html/head/body have no startTag.
      const start = node.sourceCodeLocation?.startTag;
      if (node.tagName && start && (!firstElement || start.startOffset < firstElement.offset))
        firstElement = { name: node.tagName, offset: start.startOffset };
      if (node.nodeName === "#text" && node.sourceCodeLocation) {
        const location = node.sourceCodeLocation;
        // Authored body text ends the prolog even without an explicit body tag.
        // Use HTML ASCII whitespace and source positions, not recovered tree order.
        const nonWhitespace = text.slice(location.startOffset, location.endOffset).search(/[^\t\n\f\r ]/u);
        if (nonWhitespace >= 0) firstTextOffset = Math.min(firstTextOffset, location.startOffset + nonWhitespace);
      }
      if (node.nodeName === "#comment" && node.sourceCodeLocation) {
        const location = node.sourceCodeLocation;
        const source = text.slice(location.startOffset, location.endOffset);
        // HTML represents processing instructions as bogus comments. Inspect
        // original bytes, not comment data: ordinary <!-- examples --> are not PIs.
        const instruction = /^<\?xml-stylesheet[\t\n\f\r ]+([\s\S]*?)\?>$/u.exec(source);
        if (instruction) instructions.push({ body: instruction[1]!, offset: location.startOffset });
      }
      if (node.tagName?.startsWith("nodel-") && !basis.includes("nodel_element")) basis.push("nodel_element");
      if (
        node.attrs?.some((attr) => isRuntimeAttribute(attr.name, attr.value)) &&
        !basis.includes("v2_runtime_reference")
      )
        basis.push("v2_runtime_reference");
    });
    errors = [...parsed.errors];
    errorCount = parsed.errorCount;
    let attributesComplete = true;
    truncationReason = parsed.truncationReason ?? walked.truncationReason;
    if (firstElement?.name === "pages") basis.push("pages_root");
    for (const instruction of instructions) {
      if (instruction.offset >= Math.min(firstElement?.offset ?? Infinity, firstTextOffset)) continue;
      // Parse pseudo-attributes with the same bounded HTML parser, not XML.
      // Only the synthetic link's own href counts, never markup in other values.
      const attributes = parseHtml(`<link ${instruction.body}>`, { fragment: true });
      truncationReason ??= attributes.truncationReason;
      const link = attributes.root?.childNodes?.[0];
      if (
        link?.tagName === "link" &&
        link.attrs?.some((attr) => attr.name === "href" && V1_STYLESHEET.test(attr.value)) &&
        !basis.includes("v1_stylesheet")
      )
        basis.push("v1_stylesheet");
      if (!attributes.complete) {
        attributesComplete = false;
        errorCount++;
        if (errors.length < UI_ADVISORY_LIMITS.maxParserErrors)
          errors.push({
            code: "HTML_ANALYSIS_TRUNCATED",
            message: "HTML stylesheet attribute analysis is incomplete.",
          });
      }
    }
    complete = parsed.complete && attributesComplete && !truncationReason;
    truncated = !!truncationReason;
    parser = oversized ? "none" : "html";
  }
  const v1 = basis.some((item) => item === "canonical_path" || item === "pages_root" || item === "v1_stylesheet");
  const v2 = basis.some((item) => item === "nodel_element" || item === "v2_runtime_reference");
  return {
    kind: v1 && v2 ? "mixed" : v1 ? "v1" : v2 ? "v2" : "unknown",
    basis,
    complete,
    truncated,
    errors,
    errorCount,
    omittedErrors: errorCount - errors.length,
    errorCountIsLowerBound: !complete,
    parser,
    truncationReason,
  };
}

/** Evidence is positive-only when incomplete: unknown never proves that markers are absent. */
export function recognizeUi(input: UiRecognitionInput): UiRecognition {
  const path = input.path.replaceAll("\\", "/");
  const explicit = input.selection === "v1" || input.selection === "v2" ? input.selection : undefined;
  if (input.selection === "skip" || (!explicit && (NON_UI_EXTENSIONS.test(path) || !/\.(?:html?|xml)$/iu.test(path))))
    return {
      kind: input.selection === "skip" ? "unknown" : "not_ui",
      basis: [],
      explanation:
        input.selection === "skip"
          ? "UI feedback was explicitly skipped."
          : "File type is not eligible for automatic UI analysis.",
      parseSkipped: true,
      complete: true,
      truncated: false,
      errors: [],
      errorCount: 0,
      omittedErrors: 0,
      errorCountIsLowerBound: false,
    };
  const candidate = classify(path, input.content ?? "");
  const original = input.originalContent === undefined ? undefined : classify(path, input.originalContent);
  const basis = [...candidate.basis];
  const originalMarkers = original?.basis.filter((item) => item !== "canonical_path");
  if (originalMarkers?.length) {
    basis.push("original_content");
    for (const item of originalMarkers) if (!basis.includes(item)) basis.push(item);
  }
  let kind = candidate.kind;
  if (kind === "unknown" && original) kind = original.kind;
  if (original && candidate.kind !== "unknown" && original.kind !== "unknown" && original.kind !== candidate.kind)
    kind = "mixed";
  if (explicit) basis.push("explicit");
  const complete = candidate.complete && (original?.complete ?? true);
  const errorCount = candidate.errorCount + (original?.errorCount ?? 0);
  const errors = [
    ...candidate.errors.map((error) => ({ ...error, source: "candidate" as const })),
    ...(original?.errors.map((error) => ({ ...error, source: "original" as const })) ?? []),
  ].slice(0, UI_ADVISORY_LIMITS.maxParserErrors);
  return {
    kind,
    basis,
    explanation: explicit
      ? "Format was explicitly selected; selection does not imply successful validation."
      : kind === "unknown"
        ? complete
          ? "No reliable Nodel UI markers were found; plain HTML/XML is not automatically treated as v2."
          : "Recognition is incomplete; Nodel UI markers may be present in unanalysed input. Choose a format explicitly."
        : kind === "mixed"
          ? "Both v1 and v2 markers are present, or original and proposed formats differ; choose a format explicitly."
          : !complete
            ? "UI markers were found, but recognition is incomplete; additional or mixed markers may be unanalysed."
            : undefined,
    selectedFormat: explicit ?? (kind === "v1" || kind === "v2" ? kind : undefined),
    parseSkipped: false,
    complete,
    truncated: candidate.truncated || (original?.truncated ?? false),
    errors,
    errorCount,
    omittedErrors: errorCount - errors.length,
    errorCountIsLowerBound: !complete,
    candidate,
    original,
  };
}
