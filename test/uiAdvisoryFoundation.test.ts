import assert from "node:assert/strict";
import test from "node:test";
import { parse, parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { decodeUiInput, parseHtml, walkHtml, type HtmlNode } from "../src/domain/ui/html.js";
import { recognizeUi } from "../src/domain/ui/recognition.js";
import { UI_ADVISORY_LIMITS } from "../src/domain/ui/limits.js";

void test("recognizes v1 by canonical path and pages root, not arbitrary XML", () => {
  assert.equal(recognizeUi({ path: "content/index.xml", content: "<html/>" }).kind, "v1");
  assert.equal(recognizeUi({ path: "other.xml", content: "<pages><page/></pages>" }).kind, "v1");
  assert.equal(recognizeUi({ path: "other.xml", content: "<recipe/>" }).kind, "unknown");
  assert.equal(recognizeUi({ path: "archive/content/index.xml", content: "<recipe/>" }).kind, "unknown");
  assert.equal(recognizeUi({ path: "other.xml", content: "<html><body><pages/></body></html>" }).kind, "unknown");
  assert.equal(
    recognizeUi({ path: "other.xml", content: '<?xml-stylesheet title="v1" href="other.xsl"?><recipe/>' }).kind,
    "unknown",
  );
  assert.equal(
    recognizeUi({ path: "other.xml", content: '<!-- prolog --><?xml-stylesheet href="v1/index.xsl"?><recipe/>' }).kind,
    "v1",
  );
});

void test("recognizes real v2 elements and runtime markup but ignores comments, scripts, and escaped examples", () => {
  for (const content of ["<!-- <nodel-app/> -->", "<script>const x = '<nodel-app/>'</script>", "&lt;nodel-app&gt;"])
    assert.equal(recognizeUi({ path: "content/page.html", content }).kind, "unknown");
  assert.equal(recognizeUi({ path: "content/page.html", content: "<nodel-app></nodel-app>" }).kind, "v2");
  assert.equal(
    recognizeUi({ path: "content/page.html", content: '<script type="module" src="../v2/nodel-webui.js"></script>' })
      .kind,
    "v2",
  );
  assert.equal(recognizeUi({ path: "content/index.xml", content: "<nodel-app/>" }).kind, "mixed");
  const formatsChanged = recognizeUi({
    path: "page.html",
    content: "<pages><page/></pages>",
    originalContent: "<nodel-app/>",
  });
  assert.equal(formatsChanged.kind, "mixed");
  assert.ok(formatsChanged.basis.includes("original_content"));
  assert.ok(formatsChanged.basis.includes("nodel_element"));
});

void test("uses original evidence, supports explicit selection, and avoids non-UI parsing", () => {
  const removedMarker = recognizeUi({
    path: "content/page.html",
    content: "<html></html>",
    originalContent: "<nodel-app/>",
  });
  assert.equal(removedMarker.kind, "v2");
  assert.ok(removedMarker.basis.includes("original_content"));
  assert.equal(recognizeUi({ path: "script.js", content: "<nodel-app/>" }).parseSkipped, true);
  assert.equal(recognizeUi({ path: "page.html", content: "<html/>", selection: "v2" }).selectedFormat, "v2");
  assert.equal(recognizeUi({ path: "draft.txt", content: "<nodel-app/>", selection: "v2" }).selectedFormat, "v2");
  assert.equal(recognizeUi({ path: "page.html", selection: "skip" }).parseSkipped, true);
});

void test("decodes strict UTF-8 base64 without modifying bytes and bounds inputs", () => {
  const bytes = Buffer.from("<nodel-app>é</nodel-app>");
  const decoded = decodeUiInput({ base64: bytes.toString("base64") });
  assert.equal(decoded.content, bytes.toString("utf8"));
  assert.equal(decoded.sha256?.length, 64);
  assert.equal(decodeUiInput({ base64: "***" }).error, "invalid_base64");
  assert.equal(decodeUiInput({ base64: "/w==" }).error, "invalid_utf8");
  assert.equal(decodeUiInput({ content: "12345" }, 4).error, "too_large");
  assert.equal(decodeUiInput({ base64: "A".repeat(8 * 1024 * 1024) }).error, "too_large");
  const bomContent = decodeUiInput({ base64: Buffer.from("\uFEFF<!doctype html><nodel-app/>").toString("base64") });
  assert.equal(bomContent.content?.charCodeAt(0), 0xfeff);
  const bomParsed = parseHtml(bomContent.content!);
  assert.equal(
    bomParsed.errors.some((issue) => issue.code === "HTML_MISSING_DOCTYPE"),
    false,
  );
  const located = parseHtml(bomContent.content!);
  const locatedStack = [...(located.root?.childNodes ?? [])];
  let locatedApp: (typeof locatedStack)[number] | undefined;
  while (locatedStack.length) {
    const node = locatedStack.pop()!;
    if (node.tagName === "nodel-app") {
      locatedApp = node;
      break;
    }
    locatedStack.push(...(node.childNodes ?? []));
  }
  assert.equal(locatedApp?.sourceCodeLocation?.startOffset, 16);
});

void test("HTML parser exposes locations and reports bounded iterative traversal truncation", () => {
  const parsed = parseHtml("<nodel-app><div>ok</div></nodel-app>");
  const stack = [...(parsed.root?.childNodes ?? [])];
  let app: (typeof stack)[number] | undefined;
  while (stack.length) {
    const node = stack.pop()!;
    if (node.tagName === "nodel-app") {
      app = node;
      break;
    }
    stack.push(...(node.childNodes ?? []));
  }
  assert.equal(typeof app?.sourceCodeLocation?.startOffset, "number");
  assert.ok(parseHtml('<div id="a" id="b"></div>').errors.some((issue) => issue.code === "HTML_DUPLICATE_ATTRIBUTE"));
  const manyDuplicateAttrs = Array.from({ length: 300 }, () => '<i a="1" a="2"></i>').join("");
  assert.ok(parseHtml(manyDuplicateAttrs).errors.length <= UI_ADVISORY_LIMITS.maxParserErrors);
  const limited = parseHtml("<a><b><c></c></b></a>", { maxDepth: 1 });
  assert.equal(limited.truncated, true);
  assert.ok(limited.errors.some((issue) => issue.code === "HTML_ANALYSIS_TRUNCATED"));
  assert.equal(UI_ADVISORY_LIMITS.maxInputBytes, 2 * 1024 * 1024);
  const tenThousand = `<p${' a="1" a="2"'.repeat(10_000)}></p>`;
  const pathological = parseHtml(tenThousand, { maxNodes: 1 });
  assert.equal(pathological.complete, false);
  assert.equal(pathological.truncationReason, "attributes_per_tag");
  assert.equal(pathological.createdNodes, 1);
  const tooManyNodes = parseHtml("<p></p>".repeat(10_000), { maxNodes: 1 });
  assert.equal(tooManyNodes.truncationReason, "node_count");
  assert.ok(tooManyNodes.root);
  const tooDeep = recognizeUi({
    path: "page.html",
    content: `${"<div>".repeat(130)}<nodel-app/>${"</div>".repeat(130)}`,
  });
  assert.equal(tooDeep.complete, false);
  assert.equal(tooDeep.truncated, true);
  assert.equal(tooDeep.kind, "unknown");
  const tooLarge = recognizeUi({ path: "page.html", content: " ".repeat(UI_ADVISORY_LIMITS.maxInputBytes + 1) });
  assert.equal(tooLarge.complete, false);
  assert.ok(tooLarge.errors.some((issue) => issue.code === "HTML_ANALYSIS_TRUNCATED"));
  assert.equal(tooLarge.kind, "unknown");
  const oversizedOriginal = recognizeUi({
    path: "page.html",
    content: "<nodel-app/>",
    originalContent: " ".repeat(UI_ADVISORY_LIMITS.maxInputBytes + 1),
  });
  assert.equal(oversizedOriginal.complete, false);
  assert.equal(oversizedOriginal.kind, "v2");
  const repeatedDuplicates = recognizeUi({
    path: "page.html",
    content: '<p a="1" a="2"></p>'.repeat(10_000),
  });
  assert.equal(repeatedDuplicates.complete, false);
  assert.equal(repeatedDuplicates.candidate?.truncationReason, "parser_errors");
  assert.ok(repeatedDuplicates.errors.length <= UI_ADVISORY_LIMITS.maxParserErrors);
});

function find(root: HtmlNode | undefined, tagName: string): HtmlNode | undefined {
  let result: HtmlNode | undefined;
  walkHtml(root, (node) => {
    if (node.tagName === tagName) result = node;
  });
  return result;
}

function treeShape(node: HtmlNode | undefined): unknown {
  if (!node) return undefined;
  const source = node as DefaultTreeAdapterMap["node"];
  return {
    nodeName: node.nodeName,
    attrs: node.attrs,
    value: "value" in source ? source.value : undefined,
    data: "data" in source ? source.data : undefined,
    name: "name" in source ? source.name : undefined,
    location: node.sourceCodeLocation,
    children: node.childNodes?.map(treeShape),
    content: node.content ? treeShape(node.content) : undefined,
  };
}

void test("parse5 recovery semantics and source locations match the unmodified parser", () => {
  const fixtures = [
    '<!doctype html><html lang="en"><head><title>t &amp; t</title></head><body><nodel-app id="é😀">a\r\nb</nodel-app></body></html>',
    '<!--><nodel-app title="a &amp; b"></nodel-app>',
    "<!-- x --!><p>one<p>two<ul><li>one<li>two</ul><nodel-app/>",
    "<textarea>" + "<div>".repeat(130) + "</textarea><nodel-app></nodel-app>",
    "<title>examples &lt;nodel-app&gt; <div></title><nodel-app/>",
    '<script>const fake = "</scriptx><nodel-app>";</script><nodel-real></nodel-real>',
    "<script><!--<script>double escaped</script>--></script><nodel-real/>",
    "<style>/* </stylex><nodel-app> */</style><nodel-real/>",
    "<xmp><nodel-fake/></xmp><iframe><nodel-fake/></iframe><nodel-real/>",
    "<plaintext><nodel-fake/>",
    "<noscript><nodel-fake/></noscript><nodel-real/>",
    "<table>before<tr><td>a</td></tr>after</table><nodel-app/>",
    "<b><p>one</b>two</p><nodel-app/>",
    "<template>a<br><template>b<br><nodel-app/></template></template>",
    "<svg><![CDATA[<nodel-fake/>]]><foreignObject><nodel-real/></foreignObject></svg>",
    "<math><mtext><nodel-real/></mtext></math>",
    '<div a="1" a="2">x &#x1f600; &amp; y</div>',
    // Cross chunk boundaries, including an entity and a speculative raw-text end tag.
    "<script>" + "a".repeat(1012) + "</scriptx>" + "b".repeat(70_000) + "</script><nodel-real/>",
    '<div title="' + "a".repeat(1008) + '&amp;z">x</div><nodel-app/>',
  ];
  for (const source of fixtures) {
    for (const fragment of [false, true]) {
      const parsed = parseHtml(source, { fragment });
      assert.equal(parsed.complete, true, `${source.slice(0, 80)} (fragment=${fragment})`);
      const expected = fragment
        ? parseFragment(source, { sourceCodeLocationInfo: true })
        : parse(source, { sourceCodeLocationInfo: true });
      assert.deepEqual(treeShape(parsed.root), treeShape(expected as HtmlNode));
      walkHtml(parsed.root, (node) => {
        for (const child of node.childNodes ?? []) assert.equal(child.parentNode, node);
        if (node.content)
          assert.equal(node.content.parentNode, undefined, "template ownership is not a DOM parent edge");
      });
    }
  }
});

void test("real tokenizer stops malformed-comment attribute bombs before quadratic attribute work", () => {
  const attributes = Array.from({ length: 40_000 }, (_, i) => ` a${i}="x"`).join("");
  for (const prefix of ["<!-->", "<!--x--!>", "<!bogus>", "<?bogus>", ""]) {
    const result = parseHtml(`${prefix}<nodel-app${attributes}></nodel-app>`);
    assert.equal(result.truncationReason, "attributes_per_tag");
    assert.equal(result.complete, false);
    assert.ok(result.processedCharacters < 5_000, `${prefix}: ${result.processedCharacters}`);
    assert.equal(find(result.root, "nodel-app"), undefined, "unfinished tokens are not evidence");
  }
  const duplicate = parseHtml(`<nodel-app${' a="1" a="2"'.repeat(40_000)}>`);
  assert.equal(duplicate.truncationReason, "attributes_per_tag");
  assert.ok(duplicate.errors.some((error) => error.code === "HTML_DUPLICATE_ATTRIBUTE"));
});

void test("token size bounds apply during names, values, comments and doctypes, including unterminated tokens", () => {
  for (const source of [
    '<div a="' + "x".repeat(100_000),
    '<div a="' + "x".repeat(100_000) + '">',
    "<" + "x".repeat(100_000) + ">",
    "<!--" + "x".repeat(100_000),
    '<!doctype html PUBLIC "' + "x".repeat(100_000),
    '<div a="&#' + "1".repeat(100_000) + ';">',
  ]) {
    const parsed = parseHtml(source);
    assert.equal(parsed.truncationReason, "tag_size", source.slice(0, 30));
    assert.ok(
      parsed.processedCharacters <= UI_ADVISORY_LIMITS.maxTagCharacters + UI_ADVISORY_LIMITS.parserChunkCharacters,
    );
  }
});

void test("depth budgets use recovered trees, not unmatched end tags or lexical start-tag counts", () => {
  const unmatched = "<div></bogus>".repeat(140) + "<nodel-app>";
  const rejected = recognizeUi({ path: "page.html", content: unmatched });
  assert.equal(rejected.candidate?.truncationReason, "depth");
  assert.equal(rejected.kind, "unknown");
  assert.match(rejected.explanation!, /incomplete|unanalysed/u);
  for (const content of [
    "<p>x".repeat(130) + "<nodel-app></nodel-app>",
    "<ul>" + "<li>x".repeat(130) + "</ul><nodel-app></nodel-app>",
    "<textarea>" + "<div>".repeat(130) + "</textarea><nodel-app></nodel-app>",
  ]) {
    const recognized = recognizeUi({ path: "page.html", content });
    assert.equal(recognized.complete, true);
    assert.equal(recognized.kind, "v2");
  }
  const rawtext = recognizeUi({
    path: "page.html",
    content: '<script>"</scriptx>' + "<div>".repeat(140) + '<nodel-fake>"</script>',
  });
  assert.equal(rawtext.complete, true);
  assert.equal(rawtext.kind, "unknown");
});

void test("every text, doctype and template allocation is included in node budgets", () => {
  const fixtures = [
    "x<br>".repeat(12_000) + "<nodel-app>",
    "<template>" + "x<br>".repeat(12_000) + "<nodel-app></template>",
    "<table>" + "x<tr><td>y</td></tr>".repeat(7_000) + "</table><nodel-app>",
    "<!doctype html>" + "<!--x-->".repeat(20_000) + "<nodel-app>",
  ];
  for (const content of fixtures) {
    const parsed = parseHtml(content);
    assert.equal(parsed.complete, false);
    assert.ok(parsed.createdNodes <= UI_ADVISORY_LIMITS.maxVisitedNodes);
    assert.ok(parsed.visitedNodes <= parsed.createdNodes);
    assert.ok(parsed.treeOperations <= UI_ADVISORY_LIMITS.maxTreeOperations);
    assert.equal(find(parsed.root, "nodel-app"), undefined);
    const recognized = recognizeUi({ path: "page.html", content });
    assert.equal(recognized.complete, false);
    assert.equal(recognized.kind, "unknown");
  }
  assert.equal(parseHtml("<!doctype html>", { maxNodes: 1 }).truncationReason, "node_count");
  const merged = parseHtml("<div>a &amp; b c</div>");
  assert.equal(merged.complete, true);
  assert.equal(merged.createdNodes, merged.visitedNodes);
});

void test("fragment finalization and tiny budgets cannot escape the advisory parser", () => {
  for (const fragment of [false, true]) {
    for (const maxNodes of [0, 1, 2, 3, 4]) {
      const parsed = parseHtml("<nodel-app/>", { fragment, maxNodes });
      assert.equal(parsed.complete, false);
      assert.ok(parsed.createdNodes <= maxNodes);
    }
    assert.equal(parseHtml("<nodel-app/>", { fragment, maxNodes: 5 }).complete, true);
    assert.equal(parseHtml("<div/>", { fragment, maxDepth: 0 }).complete, false);
  }
  for (const source of ["<i>".repeat(19_997), "<i></i>".repeat(19_997)]) {
    const parsed = parseHtml(source, { fragment: true });
    assert.equal(parsed.complete, false);
    assert.ok(parsed.errors.some((error) => error.code === "HTML_ANALYSIS_TRUNCATED"));
  }
  const wide = parseHtml("<i></i>".repeat(19_996), { fragment: true });
  assert.equal(wide.complete, true);
  assert.equal(wide.root?.nodeName, "#document-fragment");
  assert.equal(wide.createdNodes, 20_000);
  assert.equal(wide.root.childNodes?.length, 19_996);
});

void test("diagnostic caps expose totals and omissions without discarding earlier parse errors", () => {
  const source = "<!doctype html>" + '<p a="1" a="2"></p>'.repeat(350);
  const parsed = parseHtml(source);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.errorCount, 350);
  assert.equal(parsed.omittedErrors, parsed.errorCount - parsed.errors.length);
  assert.equal(parsed.errorCountIsLowerBound, false);
  assert.equal(parsed.errors[0]?.code, "HTML_DUPLICATE_ATTRIBUTE");
  const truncated = parseHtml(source, { maxNodes: 10 });
  assert.equal(truncated.complete, false);
  assert.equal(truncated.errors[0]?.code, "HTML_DUPLICATE_ATTRIBUTE");
  assert.equal(truncated.errors.at(-1)?.code, "HTML_ANALYSIS_TRUNCATED");
  const errorLimited = parseHtml(source, { maxErrorEvents: 5 });
  assert.equal(errorLimited.truncationReason, "parser_errors");
  assert.equal(errorLimited.errorCount, 6);
  assert.equal(errorLimited.errorCountIsLowerBound, true);
  const recognition = recognizeUi({ path: "page.html", content: source, originalContent: source });
  assert.equal(recognition.candidate?.errorCount, 350);
  assert.equal(recognition.original?.errorCount, 350);
  assert.equal(recognition.errorCount, 700);
  assert.equal(recognition.omittedErrors, 700 - recognition.errors.length);
  assert.equal(recognition.errors[0]?.source, "candidate");
});

void test("BOM mappings survive truncation and cover attribute/start/end-tag locations exactly once", () => {
  const source = '\uFEFF<!doctype html><nodel-app id="é😀">x</nodel-app><div>' + "<b>".repeat(140);
  const parsed = parseHtml(source);
  assert.equal(parsed.truncationReason, "depth");
  const app = find(parsed.root, "nodel-app");
  assert.equal(app?.sourceCodeLocation?.startOffset, 16);
  assert.equal(app?.sourceCodeLocation?.startTag?.startOffset, 16);
  const attr = app?.sourceCodeLocation?.attrs?.id;
  assert.equal(attr?.startOffset, source.indexOf("id="));
  assert.equal(source.slice(attr?.startOffset, attr?.endOffset), 'id="é😀"');
  assert.equal(app?.sourceCodeLocation?.endTag?.startOffset, source.indexOf("</nodel-app>"));
  assert.equal(app?.sourceCodeLocation?.startCol, 17);
  const duplicate = parseHtml('\uFEFF<!doctype html><div a="1" a="2">' + "<b>".repeat(140));
  const error = duplicate.errors.find((item) => item.code === "HTML_DUPLICATE_ATTRIBUTE");
  assert.equal(error?.startOffset, 28);
  assert.equal(error?.column, 29);
});

void test("XML evidence is independently bounded and never depends on HTML self-closing recovery", () => {
  for (const path of ["page.xml", "page.html"]) {
    const recognized = recognizeUi({ path, content: "<pages><page>" + "<status/>".repeat(130) + "</page></pages>" });
    assert.equal(recognized.kind, "v1");
    // The XML evidence survives either way. HTML self-closing recovery is still
    // bounded and cannot claim it inspected the suffix after its depth limit.
    assert.equal(recognized.complete, path.endsWith(".xml"));
    assert.equal(recognized.candidate?.parser, path.endsWith(".xml") ? "xml" : "html");
    if (path.endsWith(".xml")) assert.deepEqual(recognized.errors, []);
    else assert.equal(recognized.candidate?.truncationReason, "depth");
  }
  assert.equal(recognizeUi({ path: "page.xml", content: "<root><pages/></root>" }).kind, "unknown");
  const pi = '<!-- prolog --><?xml-stylesheet type="text/xsl" href="v1/index.xsl"?><pages/>';
  assert.ok(recognizeUi({ path: "page.xml", content: pi }).basis.includes("v1_stylesheet"));
  for (const content of [
    "<?xml-stylesheet title=\"href='v1/index.xsl'\"?><root/>",
    '<?xml-stylesheet title="v1/index.xsl" href="other.xsl"?><root/>',
    '<!-- <?xml-stylesheet href="v1/index.xsl"?> --><root/>',
    '<root><?xml-stylesheet href="v1/index.xsl"?></root>',
    "<root><![CDATA[<pages><nodel-app/>]]></root>",
  ])
    assert.equal(recognizeUi({ path: "page.xml", content }).kind, "unknown");
  const attrs = recognizeUi({
    path: "page.xml",
    content: "<pages" + Array.from({ length: 40_000 }, (_, i) => ` a${i}="x"`).join("") + "/>",
  });
  assert.equal(attrs.candidate?.truncationReason, "attributes_per_tag");
  assert.equal(attrs.complete, false);
  const deep = recognizeUi({ path: "page.xml", content: "<pages>" + "<page>".repeat(140) });
  assert.equal(deep.candidate?.truncationReason, "depth");
  assert.equal(deep.complete, false);
  const longToken = recognizeUi({ path: "page.xml", content: '<pages a="' + "x".repeat(100_000) });
  assert.equal(longToken.candidate?.truncationReason, "tag_size");
  assert.equal(longToken.complete, false);
  const unfinished = recognizeUi({ path: "page.html", content: '<pages unfinished="' });
  assert.equal(unfinished.kind, "unknown");
  assert.equal(unfinished.complete, true);
  assert.ok(unfinished.errors.some((error) => error.code === "HTML_EOF_IN_TAG"));
  const piLimited = recognizeUi({
    path: "page.html",
    content:
      "<?xml-stylesheet" +
      Array.from({ length: 300 }, (_, i) => ` a${i}="x"`).join("") +
      ' href="v1/index.xsl"?><root/>',
  });
  assert.equal(piLimited.kind, "unknown");
  assert.equal(piLimited.complete, false);
  assert.equal(piLimited.candidate?.truncationReason, "attributes_per_tag");
});

void test("large allowed base64 is decoded without a regexp stack overflow and noncanonical data is rejected", () => {
  const bytes = Buffer.alloc(UI_ADVISORY_LIMITS.maxInputBytes, 97);
  const decoded = decodeUiInput({ base64: bytes.toString("base64") });
  assert.equal(decoded.error, undefined);
  assert.deepEqual(decoded.bytes, bytes);
  for (const base64 of ["YQ", "YQ=", "YQ===", "YR==", "=AAA", "AAAA=AAA", "YQ==\n"])
    assert.equal(decodeUiInput({ base64 }).error, "invalid_base64", base64);
});

void test("original and candidate uncertainty and positive evidence remain separately inspectable", () => {
  const result = recognizeUi({
    path: "draft.txt",
    selection: "v2",
    content: "<nodel-app/>",
    originalContent: "<div>".repeat(140),
  });
  assert.equal(result.selectedFormat, "v2");
  assert.ok(result.basis.includes("explicit"));
  assert.equal(result.kind, "v2");
  assert.equal(result.complete, false);
  assert.equal(result.candidate?.complete, true);
  assert.equal(result.original?.complete, false);
  assert.ok(result.original?.errors.some((error) => error.code === "HTML_ANALYSIS_TRUNCATED"));
  assert.ok(result.errors.some((error) => error.source === "original"));
  const removed = recognizeUi({
    path: "page.html",
    content: "<html></html>",
    originalContent: "<pages><nodel-app/></pages>",
  });
  assert.equal(removed.kind, "mixed");
  assert.ok(removed.basis.includes("original_content"));
  assert.ok(removed.basis.includes("pages_root"));
  assert.ok(removed.basis.includes("nodel_element"));
});

void test("attribute adoption, recovery moves and traversal have explicit work/ownership bounds", () => {
  const adopted = parseHtml(
    "<html><head></head><body>" + Array.from({ length: 300 }, (_, i) => `<body a${i}="x">`).join(""),
  );
  assert.equal(adopted.truncationReason, "attributes_per_tag");
  assert.equal(find(adopted.root, "body")?.attrs?.length, UI_ADVISORY_LIMITS.maxAttributesPerTag);
  const ended = parseHtml("<div></div" + ' a="x"'.repeat(300) + ">");
  assert.equal(ended.truncationReason, "attributes_per_tag");
  const moved = "<table>" + "<b><p>x</b>y</p>".repeat(500) + "</table><nodel-app/>";
  const parsed = parseHtml(moved, { maxTreeOperations: 500 });
  assert.equal(parsed.truncationReason, "tree_work");
  assert.ok(parsed.treeOperations <= 500);
  walkHtml(parsed.root, (node) => {
    for (const child of node.childNodes ?? []) assert.equal(child.parentNode, node);
  });
  const cyclic: HtmlNode = { nodeName: "cycle", childNodes: [] };
  cyclic.childNodes!.push(cyclic);
  assert.deepEqual(
    walkHtml(cyclic, () => undefined),
    { visitedNodes: 1, truncationReason: "node_count" },
  );
  const wide: HtmlNode = { nodeName: "root", childNodes: Array.from({ length: 10 }, () => ({ nodeName: "child" })) };
  assert.deepEqual(
    walkHtml(wide, () => undefined, 3),
    { visitedNodes: 3, truncationReason: "node_count" },
  );
  assert.deepEqual(
    walkHtml(wide, () => undefined, 20, 0),
    { visitedNodes: 1, truncationReason: "depth" },
  );
});

void test("XML v1 structure does not promote script-text components or runtime examples into v2 evidence", () => {
  for (const path of ["content/page.html", "content/page.xml"]) {
    for (const script of [
      'const x = "<nodel-app/>";',
      'const x = "<div><nodel-app/></div><nodel-fake/>";',
      "const x = \"<script src='v2/nodel-webui.js'/><link href='v2/nodel-webui.css'/>\";",
      '<![CDATA[const x = "<nodel-app/>";]]>',
      'const x = "&lt;nodel-app/&gt;";',
    ]) {
      const result = recognizeUi({ path, content: `<pages><script>${script}</script><page><status/></page></pages>` });
      assert.equal(result.kind, "v1", script);
      assert.equal(result.complete, true, script);
      assert.ok(result.basis.includes("pages_root"));
      assert.equal(result.basis.includes("nodel_element"), false);
      assert.equal(result.basis.includes("v2_runtime_reference"), false);
    }
    const actual = recognizeUi({
      path,
      content: '<pages><script>const x = "<nodel-fake/>";</script><page><nodel-app/></page></pages>',
    });
    assert.equal(actual.kind, "mixed");
    assert.equal(actual.complete, true);
    assert.ok(actual.basis.includes("nodel_element"));
    const runtime = recognizeUi({
      path,
      content: '<pages><script src="v2/nodel-webui.js">const x = "<nodel-fake/>";</script></pages>',
    });
    assert.equal(runtime.kind, "mixed");
    assert.ok(runtime.basis.includes("v2_runtime_reference"));
    assert.equal(runtime.basis.includes("nodel_element"), false);
  }
});

void test("XML markup limits do not bound ordinary whitespace, text, entities or CDATA as tags", () => {
  for (const path of ["content/page.html", "content/page.xml"]) {
    for (const content of [
      " ".repeat(70_000) + "<pages/>",
      "<pages><page>" + "x".repeat(70_000) + "</page></pages>",
      "<pages>" + " \n\t".repeat(30_000) + "<page/></pages>" + " ".repeat(70_000),
      "<pages><page>" + "x &gt; &lt;nodel-app/&gt; &amp; 😀".repeat(3_000) + "</page></pages>",
      // Close to the existing input limit, with a text chunk larger than the tag budget.
      "<pages>" + "x".repeat(UI_ADVISORY_LIMITS.maxInputBytes - 32) + "</pages>",
    ]) {
      const result = recognizeUi({ path, content });
      assert.equal(result.kind, "v1");
      assert.equal(result.complete, true, content.slice(0, 40));
      assert.equal(result.truncated, false);
      if (path.endsWith(".xml")) assert.deepEqual(result.errors, []);
      assert.equal(result.basis.includes("nodel_element"), false);
    }
  }
  const cdata = recognizeUi({
    path: "content/page.xml",
    content: "<pages><![CDATA[" + "<nodel-fake/>".repeat(6_000) + "]]></pages>",
  });
  assert.equal(cdata.complete, true);
  assert.equal(cdata.kind, "v1");
  assert.deepEqual(cdata.errors, []);
  const html = recognizeUi({
    path: "content/page.html",
    content: " ".repeat(70_000) + "<!doctype html><html><body><nodel-app></nodel-app></body></html>",
  });
  assert.equal(html.kind, "v2");
  assert.equal(html.complete, true);
  assert.equal(html.candidate?.truncationReason, undefined);
});

void test("HTML v2 evidence always uses HTML semantics even after XML root or stylesheet evidence", () => {
  const bodies = [
    "<script>if (a && b) run();</script><nodel-real></nodel-real>",
    "<script>void 0; //<script></script><nodel-real></nodel-real></script>",
    "<script><!--<script><nodel-fake></script>--></script><nodel-real></nodel-real>",
    "<textarea><nodel-fake></textarea><nodel-real></nodel-real>",
    "<style><nodel-fake></style><nodel-real></nodel-real>",
    "<!--><nodel-real></nodel-real>",
  ];
  for (const prefix of ["<pages>", '<!-- prolog --><?xml-stylesheet href="v1/index.xsl"?><pages>']) {
    for (const body of bodies) {
      const content = `${prefix}${body}</pages>`;
      const result = recognizeUi({ path: "page.html", content });
      assert.equal(result.kind, "mixed", content);
      assert.equal(result.complete, true, content);
      assert.equal(result.candidate?.parser, "html");
      assert.ok(result.basis.includes("pages_root"));
      assert.ok(result.basis.includes("nodel_element"));
      assert.equal(
        result.errors.some((error) => error.code.startsWith("XML_")),
        false,
      );
      const removed = recognizeUi({ path: "page.html", content: "<p>removed</p>", originalContent: content });
      assert.equal(removed.kind, "mixed");
      assert.equal(removed.original?.complete, true);
      assert.ok(removed.basis.includes("original_content"));
    }
  }
  for (const body of [
    '<script>if (a && b) x = "<nodel-fake>";</script>',
    "<textarea><nodel-fake></textarea>",
    "<style><nodel-fake></style>",
    "<!-- <nodel-fake> -->&lt;nodel-fake&gt;",
  ]) {
    const result = recognizeUi({ path: "page.html", content: `<pages>${body}</pages>` });
    assert.equal(result.kind, "v1", body);
    assert.equal(result.complete, true, body);
  }
  const nested = recognizeUi({ path: "page.html", content: "<html><body><pages></pages></body></html>" });
  assert.equal(nested.kind, "unknown");
  assert.equal(nested.basis.includes("pages_root"), false);
  // XML paths keep XML syntax/error semantics instead of silently recovering as HTML.
  const xml = recognizeUi({ path: "page.xml", content: `<pages>${bodies[0]}</pages>` });
  assert.equal(xml.kind, "v1");
  assert.equal(xml.complete, false);
  assert.ok(xml.errors.some((error) => error.code === "XML_PARSE_FAILED"));
});

void test("HTML root/prolog evidence tolerates HTML doctype case and common prolog permutations", () => {
  const pi = '<?xml-stylesheet type="text/xsl" href="v1/index.xsl"?>';
  const doctypes = [
    "<!DOCTYPE html>",
    "<!doctype html>",
    "<!DoCtYpE HTML>",
    "<!doctype\nhtml>",
    "<!doctype\fhtml>",
    '<!doctype html SYSTEM "about:legacy-compat">',
    '<!doctype html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">',
  ];
  for (const doctype of doctypes) {
    for (const prolog of [
      doctype,
      `\uFEFF${doctype}`,
      ` \n\t${doctype}\r\n`,
      `<!-- before -->${doctype}<!-- after -->`,
      `<!-- foo--bar -->${doctype}<!-- after -->`,
      `\f${doctype}\f`,
      `${pi}${doctype}`,
      `${doctype}${pi}`,
      `<!-- before -->${pi}\n${doctype}<!-- after -->`,
      `<?xml version="1.0"?>${pi}${doctype}`,
    ]) {
      const result = recognizeUi({
        path: "content/page.html",
        content: `${prolog}<pages><script>if (a && b) run();</script><nodel-app></nodel-app></pages>`,
      });
      assert.equal(result.kind, "mixed", prolog);
      assert.equal(result.complete, true, prolog);
      assert.ok(result.basis.includes("pages_root"), prolog);
      assert.equal(result.basis.includes("v1_stylesheet"), prolog.includes(pi), prolog);
      assert.equal(
        result.errors.some((error) => error.code.startsWith("XML_")),
        false,
        prolog,
      );
      const nested = recognizeUi({
        path: "content/page.html",
        content: `${prolog}<html lang=en><body class=main><pages></pages></body></html>`,
      });
      assert.equal(nested.basis.includes("pages_root"), false, prolog);
      assert.equal(nested.kind, prolog.includes(pi) ? "v1" : "unknown", prolog);
      assert.equal(nested.complete, true, prolog);
    }
  }
  // Doctype-like text in another token must not be normalized or become evidence.
  const decoys = recognizeUi({
    path: "page.html",
    content: '<!-- <!doctype html><pages/> --><?example value="<!doctype html"?><html></html>',
  });
  assert.equal(decoys.kind, "unknown");
  const xml = recognizeUi({ path: "page.xml", content: "<!doctype html><pages/>" });
  assert.equal(xml.complete, false, "XML declarations remain case-sensitive");
  assert.ok(xml.errors.some((error) => error.code === "XML_PARSE_FAILED"));
});

void test("HTML-authored root and stylesheet evidence follow source order and HTML recovery", () => {
  const pi = '<?xml-stylesheet href="v1/index.xsl"?>';
  for (const prefix of ["", "<!-- foo--bar -->", "<!doctype\fhtml>", pi]) {
    const result = recognizeUi({
      path: "page.html",
      content: `${prefix}<pages class=main><script>if (a && b) run();</script><nodel-app></nodel-app></pages>`,
    });
    assert.equal(result.kind, "mixed");
    assert.equal(result.complete, true);
  }
  for (const content of [
    `<html lang=en>${pi}<body><pages></pages></body></html>`,
    `<!-- ${pi} --><div><pages></pages></div>`,
    `<script>const example = '${pi}<pages>';</script>`,
    `<table><pages></pages></table>`, // Foster parenting changes tree order, not authored root.
    `<template><pages></pages>${pi}</template>`,
  ]) {
    const result = recognizeUi({ path: "page.html", content });
    assert.equal(result.kind, "unknown", content);
    assert.equal(result.complete, true, content);
  }
  for (const instruction of [
    "<?xml-stylesheet title=\"href='v1/index.xsl'\"?>",
    '<?xml-stylesheet title="v1/index.xsl" href="other.xsl"?>',
  ])
    assert.equal(recognizeUi({ path: "page.html", content: `${instruction}<div></div>` }).kind, "unknown");
});

void test("authored HTML body text terminates stylesheet prolog evidence in source order", () => {
  const pi = '<?xml-stylesheet href="v1/index.xsl"?>';
  const component = "<nodel-app></nodel-app>";
  for (const bodyText of ["Help", " \nHelp", "&lt;example&gt;", "&nbsp;", "\u00a0"]) {
    const content = `<!doctype html>${bodyText}${pi}${component}`;
    const result = recognizeUi({ path: "page.html", content });
    assert.equal(result.kind, "v2", content);
    assert.equal(result.complete, true);
    assert.equal(result.basis.includes("v1_stylesheet"), false);
    const original = recognizeUi({ path: "page.html", content: "", originalContent: content });
    assert.equal(original.kind, "v2");
    assert.equal(original.original?.basis.includes("v1_stylesheet"), false);
  }
  for (const prefix of ["", " \t\r\n\f", "<!doctype html> \n", "<!-- Help -->", "<!doctype html><!-- Help -->\n"]) {
    const result = recognizeUi({ path: "page.html", content: `${prefix}${pi}Help${component}` });
    assert.equal(result.kind, "mixed", prefix);
    assert.equal(result.complete, true);
    assert.ok(result.basis.includes("v1_stylesheet"));
  }
});

void test("XML markup-token guards remain effective after long text and through quotes and entities", () => {
  for (const token of [
    '<page a="' + "x".repeat(100_000),
    '<page a="' + ">&gt;&quot;".repeat(10_000) + '"/>',
    "<page " + " ".repeat(100_000) + "/>",
    "<" + "p".repeat(100_000) + "/>",
    "<!--" + "<>".repeat(50_000) + "-->",
    "<?example " + "x".repeat(100_000) + "?>",
  ]) {
    const result = recognizeUi({
      path: "content/page.xml",
      content: " ".repeat(70_000) + "<pages>" + "x".repeat(70_000) + token + "</pages>",
    });
    assert.equal(result.kind, "v1");
    assert.equal(result.complete, false);
    assert.equal(result.candidate?.truncationReason, "tag_size", token.slice(0, 20));
  }
  const afterText = recognizeUi({
    path: "content/page.html",
    content: " ".repeat(70_000) + "<pages>" + "x".repeat(70_000) + "<nodel-app/></pages>",
  });
  assert.equal(afterText.kind, "mixed");
  assert.equal(afterText.complete, true);
});
