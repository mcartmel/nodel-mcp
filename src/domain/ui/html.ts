import {
  defaultTreeAdapter,
  Parser,
  Tokenizer,
  type DefaultTreeAdapterMap,
  type ParserError,
  type ParserOptions,
  type Token,
} from "parse5";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { UI_ADVISORY_LIMITS } from "./limits.js";

/** Locations are UTF-16 source indices (not UTF-8 byte offsets), including any BOM. */
export type HtmlNode = {
  nodeName: string;
  tagName?: string;
  attrs?: Token.Attribute[];
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  parentNode?: HtmlNode | null;
  sourceCodeLocation?: Token.ElementLocation | null;
};
export type HtmlTruncationReason =
  | "input_bytes"
  | "node_count"
  | "depth"
  | "attributes_per_tag"
  | "tag_size"
  | "parser_errors"
  | "tree_work";
export type HtmlParseError = {
  code: string;
  message: string;
  line?: number;
  column?: number;
  startOffset?: number;
  endOffset?: number;
};
export type HtmlParseResult = {
  root?: HtmlNode;
  errors: HtmlParseError[];
  /** Observed diagnostics, including the truncation/failure diagnostic; not errors in unparsed input. */
  errorCount: number;
  omittedErrors: number;
  errorCountIsLowerBound: boolean;
  visitedNodes: number;
  /** Includes detached/context/template/text/doctype nodes, not just reachable elements. */
  createdNodes: number;
  processedCharacters: number;
  treeOperations: number;
  truncated: boolean;
  inputBytes: number;
  document: boolean;
  complete: boolean;
  truncationReason?: HtmlTruncationReason;
};
export type HtmlParseOptions = {
  maxBytes?: number;
  maxNodes?: number;
  maxDepth?: number;
  maxAttributesPerTag?: number;
  maxTagCharacters?: number;
  maxErrorEvents?: number;
  maxTreeOperations?: number;
  fragment?: boolean;
};
export type UiByteInput = { content: string } | { base64: string };
export type DecodedUiInput = {
  content?: string;
  bytes?: Buffer;
  sha256?: string;
  error?: "invalid_base64" | "invalid_utf8" | "too_large";
};

export function decodeUiInput(input: UiByteInput, maxBytes = UI_ADVISORY_LIMITS.maxInputBytes): DecodedUiInput {
  let bytes: Buffer;
  if ("base64" in input) {
    const maxEncodedLength = 4 * Math.ceil(maxBytes / 3);
    if (input.base64.length > maxEncodedLength) return { error: "too_large" };
    // A quantified group over a multi-megabyte base64 string can overflow the regexp stack.
    if (input.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(input.base64)) return { error: "invalid_base64" };
    bytes = Buffer.from(input.base64, "base64");
    if (bytes.toString("base64") !== input.base64) return { error: "invalid_base64" };
  } else {
    const byteLength = Buffer.byteLength(input.content, "utf8");
    if (byteLength > maxBytes) return { error: "too_large" };
    bytes = Buffer.from(input.content, "utf8");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength > maxBytes) return { sha256, error: "too_large" };
  try {
    return { content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), bytes, sha256 };
  } catch {
    return { bytes, sha256, error: "invalid_utf8" };
  }
}

/** Iterative, bounded traversal, including template ownership edges. No parent edges are followed. */
export function walkHtml(
  root: HtmlNode | undefined,
  visit: (node: HtmlNode) => void,
  maxNodes: number = UI_ADVISORY_LIMITS.maxVisitedNodes,
  maxDepth: number = UI_ADVISORY_LIMITS.maxDepth,
): { visitedNodes: number; truncationReason?: "node_count" | "depth" } {
  if (!root) return { visitedNodes: 0 };
  const stack = [{ node: root, depth: 0, next: -1 }];
  const seen = new Set<HtmlNode>();
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    if (frame.next === -1) {
      if (seen.size >= maxNodes || seen.has(frame.node))
        return { visitedNodes: seen.size, truncationReason: "node_count" };
      if (frame.depth > maxDepth) return { visitedNodes: seen.size, truncationReason: "depth" };
      seen.add(frame.node);
      visit(frame.node);
      frame.next = 0;
    }
    const children = frame.node.childNodes ?? [];
    const child =
      frame.next < children.length
        ? children[frame.next]
        : frame.next === children.length
          ? frame.node.content
          : undefined;
    frame.next++;
    if (child) stack.push({ node: child, depth: frame.depth + 1, next: -1 });
    else stack.pop();
  }
  return { visitedNodes: seen.size };
}

/**
 * parse5 7.3.0's real tokenizer/tree builder, with budgets *inside* parser work.
 * The protected tokenizer hooks are version-sensitive: keep parse5 pinned and run
 * the recovery/parity tests when upgrading. No second HTML lexer is involved.
 */
export function parseHtml(content: string, options: HtmlParseOptions = {}): HtmlParseResult {
  const budget = (value: number | undefined, fallback: number): number =>
    value === undefined ? fallback : Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const maxBytes = budget(options.maxBytes, UI_ADVISORY_LIMITS.maxInputBytes);
  const maxNodes = budget(options.maxNodes, UI_ADVISORY_LIMITS.maxVisitedNodes);
  const maxDepth = budget(options.maxDepth, UI_ADVISORY_LIMITS.maxDepth);
  const maxAttrs = budget(options.maxAttributesPerTag, UI_ADVISORY_LIMITS.maxAttributesPerTag);
  const maxToken = budget(options.maxTagCharacters, UI_ADVISORY_LIMITS.maxTagCharacters);
  const maxErrors = budget(options.maxErrorEvents, UI_ADVISORY_LIMITS.maxParserErrorEvents);
  const maxWork = budget(options.maxTreeOperations, UI_ADVISORY_LIMITS.maxTreeOperations);
  const inputBytes = Buffer.byteLength(content, "utf8");
  const sourceOffset = content.startsWith("\uFEFF") ? 1 : 0;
  const parserInput = sourceOffset ? content.slice(1) : content;
  const errors: HtmlParseError[] = [];
  let errorCount = 0;
  let createdNodes = 0;
  let processedCharacters = 0;
  let treeOperations = 0;
  let reason: HtmlTruncationReason | undefined;
  let failed = false;
  let root: HtmlNode | undefined;
  let parser: Parser<DefaultTreeAdapterMap> | undefined;
  const abort = new Error("HTML analysis budget reached");
  const stop = (why: HtmlTruncationReason): never => {
    reason = why;
    throw abort;
  };
  const record = (error: HtmlParseError, terminal = false): void => {
    errorCount++;
    // Reserve a terminal slot. Never overwrite an earlier parse diagnostic.
    if (errors.length < UI_ADVISORY_LIMITS.maxParserErrors - (terminal ? 0 : 1)) errors.push(error);
  };
  const charge = (units = 1): void => {
    if (units > maxWork - treeOperations) stop("tree_work");
    treeOperations += units;
  };
  const allocate = (): void => {
    if (createdNodes >= maxNodes) stop("node_count");
    createdNodes++;
  };
  type Node = DefaultTreeAdapterMap["node"];
  type Parent = DefaultTreeAdapterMap["parentNode"];
  const templateOwners = new WeakMap<Node, Node>();
  const parentOf = (node: Node): Node | undefined => {
    if ("parentNode" in node && node.parentNode) return node.parentNode;
    return templateOwners.get(node);
  };
  const checkAttachment = (parent: Node, child: Node): void => {
    let depth = 1;
    for (let ancestor: Node | undefined = parent; ancestor; ancestor = parentOf(ancestor)) {
      charge();
      if (ancestor === child || depth > maxDepth) stop("depth");
      if (parentOf(ancestor)) depth++;
    }
    // Reparenting during adoption-agency recovery can move an existing subtree.
    const walked = walkHtml(child as HtmlNode, () => charge(), maxNodes, Math.max(0, maxDepth - depth));
    if (walked.truncationReason) stop(walked.truncationReason);
  };
  const adapter: typeof defaultTreeAdapter = {
    ...defaultTreeAdapter,
    createDocument() {
      allocate();
      return defaultTreeAdapter.createDocument();
    },
    createDocumentFragment() {
      allocate();
      return defaultTreeAdapter.createDocumentFragment();
    },
    createElement(...args) {
      allocate();
      return defaultTreeAdapter.createElement(...args);
    },
    createCommentNode(data) {
      allocate();
      return defaultTreeAdapter.createCommentNode(data);
    },
    createTextNode(text) {
      allocate();
      return defaultTreeAdapter.createTextNode(text);
    },
    appendChild(parent, child) {
      checkAttachment(parent, child);
      defaultTreeAdapter.appendChild(parent, child);
    },
    insertBefore(parent, child, reference) {
      checkAttachment(parent, child);
      charge(parent.childNodes.length);
      defaultTreeAdapter.insertBefore(parent, child, reference);
    },
    detachNode(node) {
      charge(node.parentNode?.childNodes.length ?? 1);
      defaultTreeAdapter.detachNode(node);
    },
    setTemplateContent(template, fragment) {
      checkAttachment(template, fragment);
      templateOwners.set(fragment, template);
      defaultTreeAdapter.setTemplateContent(template, fragment);
    },
    setDocumentType(document, name, publicId, systemId) {
      charge(document.childNodes.length);
      const existing = document.childNodes.find((node) => defaultTreeAdapter.isDocumentTypeNode(node));
      if (existing) Object.assign(existing, { name, publicId, systemId });
      else {
        allocate();
        adapter.appendChild(document, { nodeName: "#documentType", name, publicId, systemId, parentNode: null });
      }
    },
    insertText(parent, text) {
      const previous = parent.childNodes[parent.childNodes.length - 1];
      if (previous && defaultTreeAdapter.isTextNode(previous)) previous.value += text;
      else adapter.appendChild(parent, adapter.createTextNode(text));
    },
    insertTextBefore(parent, text, reference) {
      charge(parent.childNodes.length);
      const previous = parent.childNodes[parent.childNodes.indexOf(reference) - 1];
      if (previous && defaultTreeAdapter.isTextNode(previous)) previous.value += text;
      else adapter.insertBefore(parent, adapter.createTextNode(text), reference);
    },
    adoptAttributes(recipient, attrs) {
      const names = new Set(recipient.attrs.map((attr) => attr.name));
      for (const attr of attrs) {
        charge();
        if (!names.has(attr.name)) {
          if (recipient.attrs.length >= maxAttrs) stop("attributes_per_tag");
          recipient.attrs.push(attr);
          names.add(attr.name);
        }
      }
    },
  };

  class BoundedTokenizer extends Tokenizer {
    private tokenStart: number | undefined;
    private attributes = 0;
    private startToken(): void {
      this.tokenStart = this.currentToken?.location?.startOffset;
      this.attributes = 0;
    }
    protected override _createStartTagToken(): void {
      super._createStartTagToken();
      this.startToken();
    }
    protected override _createEndTagToken(): void {
      super._createEndTagToken();
      this.startToken();
    }
    protected override _createCommentToken(offset: number): void {
      super._createCommentToken(offset);
      this.startToken();
    }
    protected override _createDoctypeToken(name: string | null): void {
      super._createDoctypeToken(name);
      this.startToken();
    }
    protected override _createAttr(first: string): void {
      if (this.attributes >= maxAttrs) stop("attributes_per_tag");
      this.attributes++;
      super._createAttr(first);
    }
    protected override prepareToken(token: Token.Token): void {
      this.checkTokenSize();
      super.prepareToken(token);
      this.tokenStart = undefined;
    }
    protected override handleSpecialEndTag(cp: number): boolean {
      const fallback = super.handleSpecialEndTag(cp);
      // parse5 may leave a speculative end-tag token behind on </scriptx>.
      if (fallback) this.tokenStart = undefined;
      return fallback;
    }
    private checkTokenSize(): void {
      if (this.tokenStart !== undefined && this.preprocessor.offset - this.tokenStart >= maxToken) stop("tag_size");
    }
    protected override _callState(cp: number): void {
      processedCharacters = Math.max(processedCharacters, Math.min(parserInput.length, this.preprocessor.offset + 1));
      this.checkTokenSize();
      super._callState(cp);
      this.checkTokenSize();
    }
  }
  class BoundedParser extends Parser<DefaultTreeAdapterMap> {
    constructor(
      opts: ParserOptions<DefaultTreeAdapterMap>,
      document?: DefaultTreeAdapterMap["document"],
      context?: DefaultTreeAdapterMap["element"] | null,
    ) {
      super(opts, document, context);
      const tokenizer = new BoundedTokenizer(this.options, this);
      tokenizer.inForeignNode = this.tokenizer.inForeignNode;
      this.tokenizer = tokenizer;
    }
    override onItemPush(node: Parent, tid: number, top: boolean): void {
      if (this.openElements.stackTop >= maxDepth) stop("depth");
      super.onItemPush(node, tid, top);
    }
    override getFragment(): DefaultTreeAdapterMap["documentFragment"] {
      // parse5's repeated detach/shift is quadratic for wide fragments. Transfer once.
      const fragment = adapter.createDocumentFragment();
      const container = adapter.getFirstChild(this.document) as Parent | undefined;
      if (container) {
        charge(container.childNodes.length);
        fragment.childNodes = container.childNodes;
        container.childNodes = [];
        for (const child of fragment.childNodes) {
          child.parentNode = fragment;
        }
      }
      return fragment;
    }
  }
  try {
    if (inputBytes > maxBytes) stop("input_bytes");
    if (maxErrors === 0) stop("parser_errors");
    const parserOptions: ParserOptions<DefaultTreeAdapterMap> = {
      sourceCodeLocationInfo: true,
      treeAdapter: adapter,
      onParseError: (error: ParserError) => {
        record({
          code: `HTML_${error.code.toUpperCase().replaceAll("-", "_")}`,
          message: `HTML parser reported ${error.code}.`,
          line: error.startLine,
          column: error.startCol + (sourceOffset && error.startLine === 1 ? 1 : 0),
          startOffset: error.startOffset >= 0 ? error.startOffset + sourceOffset : undefined,
          endOffset: error.endOffset >= 0 ? error.endOffset + sourceOffset : undefined,
        });
        if (errorCount >= maxErrors) stop("parser_errors");
      },
    };
    parser = options.fragment ? BoundedParser.getFragmentParser(null, parserOptions) : new BoundedParser(parserOptions);
    root = parser.document as HtmlNode;
    for (let offset = 0; offset < parserInput.length; offset += UI_ADVISORY_LIMITS.parserChunkCharacters)
      parser.tokenizer.write(parserInput.slice(offset, offset + UI_ADVISORY_LIMITS.parserChunkCharacters), false);
    parser.tokenizer.write("", true);
    if (options.fragment) root = parser.getFragment() as HtmlNode;
  } catch (error) {
    if (error !== abort) {
      failed = true;
      record({ code: "HTML_PARSE_FAILED", message: "HTML parsing failed; analysis is incomplete." }, true);
    }
  }
  // A constructor/getFragment failure may not produce a usable root. Do not
  // dereference an unassigned parser or try to continue a partially aborted parser.
  root ??= parser?.document as HtmlNode | undefined;
  const adjusted = new Set<Token.Location>();
  const adjust = (location: Token.Location | undefined): void => {
    if (!location || adjusted.has(location)) return;
    adjusted.add(location);
    if (location.startOffset >= 0) location.startOffset += sourceOffset;
    if (location.endOffset >= 0) location.endOffset += sourceOffset;
    if (location.startLine === 1) location.startCol += sourceOffset;
    if (location.endLine === 1) location.endCol += sourceOffset;
  };
  const walked = walkHtml(
    root,
    (node) => {
      const location = node.sourceCodeLocation;
      if (!sourceOffset || !location) return;
      adjust(location);
      adjust(location.startTag);
      adjust(location.endTag);
      for (const attribute of Object.values(location.attrs ?? {})) adjust(attribute);
    },
    maxNodes,
    maxDepth,
  );
  reason ??= walked.truncationReason;
  if (reason) record({ code: "HTML_ANALYSIS_TRUNCATED", message: `HTML analysis reached the ${reason} limit.` }, true);
  const complete = !reason && !failed;
  return {
    root,
    errors,
    errorCount,
    omittedErrors: errorCount - errors.length,
    errorCountIsLowerBound: !complete,
    visitedNodes: walked.visitedNodes,
    createdNodes,
    processedCharacters: processedCharacters + (processedCharacters ? sourceOffset : 0),
    treeOperations,
    truncated: !!reason,
    complete,
    truncationReason: reason,
    inputBytes,
    document: !options.fragment,
  };
}
