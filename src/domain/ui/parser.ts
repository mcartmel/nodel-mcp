import { SaxesParser, type SaxesTag } from "saxes";
import { UI_ADVISORY_LIMITS } from "./limits.js";
export type ParsedUiDocument = {
  content: string;
  processingInstructions: string[];
};
export type UiParserIssue = {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  element?: string;
  attribute?: string;
  line?: number;
  column?: number;
  parserSpecific?: boolean;
};
export type UiElement = {
  name: string;
  attributes: Record<string, string>;
  children: UiElement[];
  line: number;
  column: number;
};
export type ParsedUi = {
  complete: boolean;
  truncationReason?: string;
  root?: UiElement;
  processingInstructions: Array<{
    target: string;
    body: string;
    line: number;
    column: number;
  }>;
  errors: UiParserIssue[];
};

// The validator owns issue construction; this small parser boundary keeps raw XML
// extraction independent from catalog, live-node, and MCP concerns.
export function parseProcessingInstructions(content: string): ParsedUiDocument {
  return {
    content,
    processingInstructions: [...content.matchAll(/<\?([\w-]+)([^?]*)\?>/gu)].map((match) => `${match[1]}${match[2]}`),
  };
}

export function parseV1Ui(content: string): ParsedUi {
  const processingInstructions: ParsedUi["processingInstructions"] = [];
  const errors: UiParserIssue[] = [];
  const stack: UiElement[] = [];
  let root: UiElement | undefined;
  let parseError: Error | undefined;
  let truncationReason: string | undefined;
  let nodes = 0;
  let attributes = 0;
  let instructions = 0;
  let errorEvents = 0;
  const stop = (reason: string): never => {
    truncationReason = reason;
    throw new Error("XML resource budget exhausted");
  };
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentagstart", () => {
    if (++nodes > UI_ADVISORY_LIMITS.maxVisitedNodes) stop("node_count");
    if (stack.length >= UI_ADVISORY_LIMITS.maxDepth) stop("depth");
    attributes = 0;
  });
  parser.on("attribute", () => {
    if (++attributes > UI_ADVISORY_LIMITS.maxAttributesPerTag) stop("attributes_per_tag");
  });
  parser.on("processinginstruction", (instruction) =>
    ++instructions > UI_ADVISORY_LIMITS.maxVisitedNodes
      ? stop("processing_instructions")
      : processingInstructions.push({
          target: instruction.target,
          body: instruction.body,
          line: parser.line,
          column: parser.column,
        }),
  );
  parser.on("opentag", (tag: SaxesTag) => {
    let tagSize = tag.name.length;
    for (const [name, value] of Object.entries(tag.attributes)) {
      tagSize += name.length + String(value).length;
      if (tagSize > UI_ADVISORY_LIMITS.maxTagCharacters) stop("tag_size");
    }
    const element: UiElement = {
      name: tag.name,
      attributes: Object.fromEntries(
        Object.entries(tag.attributes).map(([name, value]) => [
          name,
          typeof value === "string" ? value : String(value),
        ]),
      ),
      children: [],
      line: parser.line,
      column: parser.column,
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(element);
    else if (!root) root = element;
    stack.push(element);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.on("error", (error) => {
    parseError = error;
    if (++errorEvents > UI_ADVISORY_LIMITS.maxParserErrorEvents) stop("parser_errors");
  });
  try {
    if (Buffer.byteLength(content, "utf8") > UI_ADVISORY_LIMITS.maxInputBytes) stop("input_bytes");
    parser.write(content).close();
  } catch (error) {
    if (!truncationReason) parseError = error as Error;
  }
  if (parseError)
    errors.push({
      severity: "error",
      code: "UI_XML_NOT_WELL_FORMED",
      message: parseError.message,
      line: parser.line,
      column: parser.column,
    });
  if (truncationReason)
    errors.push({
      severity: "warning",
      code: "UI_XML_ANALYSIS_TRUNCATED",
      message: `XML analysis stopped at the ${truncationReason} resource limit.`,
    });
  return { root, processingInstructions, errors, complete: !truncationReason, truncationReason };
}
