import { SaxesParser, type SaxesTag } from "saxes";
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
  const parser = new SaxesParser({ xmlns: false });
  parser.on("processinginstruction", (instruction) =>
    processingInstructions.push({
      target: instruction.target,
      body: instruction.body,
      line: parser.line,
      column: parser.column,
    }),
  );
  parser.on("opentag", (tag: SaxesTag) => {
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
  });
  try {
    parser.write(content).close();
  } catch (error) {
    parseError = error as Error;
  }
  if (parseError)
    errors.push({
      severity: "error",
      code: "UI_XML_NOT_WELL_FORMED",
      message: parseError.message,
      line: parser.line,
      column: parser.column,
    });
  return { root, processingInstructions, errors };
}
