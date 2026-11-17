import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTestConfig } from "../src/config.js";
import { NodelClient } from "../src/nodel/client.js";
import {
  getUiCapabilities,
  getUiCapabilityContext,
  resolveUiPageRuntimeContext,
} from "../src/domain/ui/capabilities.js";
import { analyzeUiCandidate } from "../src/domain/ui/service.js";
import type { UiCapabilities } from "../src/domain/ui/capabilities-types.js";
import { PINNED_V2_CONTRACT, PINNED_V2_PROVENANCE } from "../src/domain/ui/v2/contract.js";
import { PublicError } from "../src/shared/publicErrors.js";

const producerContract = structuredClone(PINNED_V2_CONTRACT);
const contract = {
  ...producerContract,
  packageVersion: "older-1.0",
  // A real older/smaller authority, not an empty shell rejected by the producer's
  // nonempty contract rules. Keep one independent element and no composition links.
  elements: producerContract.elements.filter((element) => !element.composition).slice(0, 1),
};
type Reply = { status?: number; mime?: string; body?: string; stall?: boolean; delay?: number };
type Fixture = {
  client: NodelClient;
  base: string;
  paths: string[];
  replies: Record<"json" | "js" | "css", Reply>;
  closed: string[];
  setNode: (name: string) => void;
  setDiscoveryStatus: (status: number) => void;
};
async function fixture(run: (fixture: Fixture) => Promise<void>, timeoutMs = 1000, resolutionDelayMs = 0) {
  const paths: string[] = [];
  const closed: string[] = [];
  let name = "Display";
  let discoveryStatus = 200;
  const replies: Fixture["replies"] = {
    json: { mime: "application/json", body: JSON.stringify(contract) },
    js: { mime: "application/javascript", body: "export const runtime = true;" },
    css: { mime: "text/css", body: "body { color: red }" },
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    paths.push(request.url!);
    if (request.url === "/prefix/REST") {
      response.setHeader("content-type", "application/json");
      response.statusCode = discoveryStatus;
      const send = () => response.end(JSON.stringify({ nodes: { display: { name } } }));
      if (resolutionDelayMs) {
        const timer = setTimeout(send, resolutionDelayMs);
        response.on("close", () => clearTimeout(timer));
      } else send();
      return;
    }
    const extension = request.url!.split(".").at(-1) as keyof typeof replies;
    const reply = replies[extension];
    if (!reply) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.statusCode = reply.status ?? 200;
    if (reply.mime) response.setHeader("content-type", reply.mime);
    response.on("close", () => closed.push(extension));
    if (reply.stall) {
      response.write(reply.body ?? " ");
      return;
    }
    if (reply.delay) {
      const timer = setTimeout(() => response.end(reply.body ?? ""), reply.delay);
      response.on("close", () => clearTimeout(timer));
    } else response.end(reply.body ?? "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/prefix`;
  try {
    await run({
      client: new NodelClient(createTestConfig({ nodelBaseUrl: base, nodelRequestTimeoutMs: timeoutMs })),
      base,
      paths,
      replies,
      closed,
      setNode: (value) => {
        name = value;
      },
      setDiscoveryStatus: (value) => {
        discoveryStatus = value;
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
const staticCount = (paths: string[]) => paths.filter((path) => path.includes("/v2/")).length;

void test("explicit v2 validation retains pinned provenance and static findings after HTTP discovery failure", async () => {
  await fixture(async ({ client, paths, setDiscoveryStatus }) => {
    setDiscoveryStatus(503);
    const content = '<nodel-button unsupported="true"></nodel-button>';
    const result = await analyzeUiCandidate(client, "Display", "content/index.html", content, { selection: "v2" });
    const feedback = result.uiFeedback;
    assert.equal(feedback.selectedFormat, "v2");
    assert.equal(feedback.provenance?.contractSource, "bundled");
    assert.equal(feedback.provenance?.contentHash, PINNED_V2_PROVENANCE.sha256);
    assert.equal(feedback.provenance?.schemaVersion, PINNED_V2_PROVENANCE.schemaVersion);
    assert.equal(feedback.provenance?.repositoryRevision, PINNED_V2_PROVENANCE.revision);
    assert.equal(feedback.provenance?.deploymentApplicable, false);
    assert.equal(feedback.provenance?.compatibility, "unverified");
    assert.ok(feedback.provenance?.detectionFailure);
    const capabilities = feedback.capabilities as UiCapabilities;
    assert.equal(capabilities.state, "unknown");
    assert.equal(capabilities.resolution?.state, "failed");
    assert.ok(feedback.issues.some(({ code }) => code === "UI_V2_ATTRIBUTE_UNKNOWN"));
    assert.equal(paths.filter((path) => path === "/prefix/REST").length, 1, "failed discovery is not retried");
  });
});

void test("4KiB adversarial static prefixes cannot block the real capability deadline (isolated hard timeout)", async () => {
  await fixture(async ({ base, replies, closed }) => {
    const attack = 'location="/login"+x\n'.repeat(300).slice(0, 4089) + ";foo() ";
    assert.equal(Buffer.byteLength(attack), 4096);
    replies.js.body = attack;
    replies.css.stall = true;
    // A test-runner timeout cannot interrupt synchronous regexp backtracking.
    // Run both lexical probes and the actual HTTP capability call in a child
    // killed by the parent, not by the potentially blocked child's event loop.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import { performance } from 'node:perf_hooks';
      import { hasStaticEntryEvidence as evidence } from './dist/nodel/http/staticContentEvidence.js';
      import { createTestConfig } from './dist/config.js';
      import { NodelClient } from './dist/nodel/client.js';
      import { getUiCapabilities } from './dist/domain/ui/capabilities.js';
      const attack = ${JSON.stringify(attack)};
      const started = performance.now();
      const samples = [attack,
        'location="/login"+x\\n'.repeat(12)+';foo()',
        'location.replace("/login"+x)\\n'.repeat(200).slice(0,4096),
        'function '.repeat(455).slice(0,4096),
        '('.repeat(2048)+')'.repeat(2048),
        'window.'.repeat(585).slice(0,4096),
        ' '.repeat(4096),
        'location="/login"+'+'x+'.repeat(2048).slice(0,4078)
      ];
      for (let round=0; round<20; round++) for (const sample of samples) evidence('script',sample,false);
      assert.equal(evidence('script',attack,false),false);
      for (const sample of [
        'import{bk as a}from"./chunks/main-CrDbG2Aa.js";export{a as loadNodelComponent};',
        'export function go(){location.replace("/login")}',
        'const example = "location=login";',
        '/* location="/login" */ import "./runtime.js";'
      ]) assert.equal(evidence('script',sample,true),true,sample);
      assert.equal(evidence('stylesheet','*,:before,:after{--tw-border-spacing-x: 0;',false),true);
      assert(performance.now()-started < 500, 'lexical scan exceeded CPU budget');
      const client = new NodelClient(createTestConfig({nodelBaseUrl:${JSON.stringify(base)},nodelRequestTimeoutMs:1000}));
      const begin = performance.now();
      const result = await getUiCapabilities(client,'Display',undefined,{deadlineMs:Date.now()+150});
      const elapsed = performance.now()-begin;
      assert(elapsed < 500, '150ms capability deadline blocked for '+elapsed+'ms');
      assert.equal(result.assets.script.outcome,'unexpected_content');
      assert(['timeout','not_run'].includes(result.assets.stylesheet.outcome));
      assert(elapsed >= 100, 'stalled CSS should exercise the aggregate timer');
      assert.notEqual(result.state,'available');
      console.log(JSON.stringify({elapsed}));
    `,
      ],
      { cwd: new URL("..", import.meta.url), timeout: 3000, killSignal: "SIGKILL" },
    );
    assert.match(stdout, /"elapsed":/u);
    assert(closed.includes("css"), "deadline must cancel the actual stalled CSS response");
  });
});

void test("available capability is compact, target-scoped, cacheable, and separate from page verification", async () => {
  await fixture(async ({ client, base, paths }) => {
    const first = await getUiCapabilityContext(client, "Display");
    assert.equal(first.capabilities.state, "available");
    assert.equal(first.capabilities.recommendation.format, "v2");
    assert.equal(first.capabilities.page.state, "not_inspected");
    assert.equal(first.capabilities.page.browserUrl, `${base}/nodes/Display/index.html`);
    assert.equal(first.capabilities.contract.contractSource, "deployed");
    assert.equal(first.capabilities.contract.packageVersion, "older-1.0");
    assert.equal(first.contract.elements.length, 1, "older deployed contract must not be merged with fallback");
    assert(first.contract.elements.length < PINNED_V2_CONTRACT.elements.length);
    assert.equal(first.capabilities.browserTested, false);
    assert(!JSON.stringify(first.capabilities).includes("commonAttributes"));
    assert(!JSON.stringify(first.capabilities).includes("export const"));
    assert.equal(staticCount(paths), 3);
    first.capabilities.assets.script.outcome = "http_error";
    first.capabilities.deployedContract.diagnostics.push("poison");
    first.provenance.packageVersion = "poison";
    assert.throws(() => first.contract.elements.push({} as never), TypeError);
    const cached = await getUiCapabilities(client, "Display");
    assert.equal(cached.cache.hit, true);
    assert.equal(cached.cache.ttlMs, 60_000);
    assert.equal(cached.assets.script.outcome, "observed");
    assert.deepEqual(cached.deployedContract.diagnostics, []);
    assert.equal(cached.contract.packageVersion, "older-1.0");
    assert.equal(staticCount(paths), 3);
    const nested = await getUiCapabilities(client, "Display", "content/pages/control.html", {
      content: '<script src="../v2/nodel-webui.js"></script><link rel="stylesheet" href="../v2/nodel-webui.css">',
    });
    assert.equal(nested.cache.hit, true);
    assert.equal(nested.page.state, "mismatched");
    assert.equal(cached.page.state, "not_inspected");
    assert.equal(staticCount(paths), 3);
    assert(paths.every((path) => !path.includes("files") && !path.endsWith("index.html")));
    const xml = await getUiCapabilities(client, "Display", "content/index.xml");
    assert.equal(xml.recommendation.format, "preserve_v1");
  });
});

void test("404 absence, auth uncertainty, missing assets, malformed/unknown contract, HTML and additive schema fields remain distinct", async () => {
  await fixture(async ({ client, replies }) => {
    for (const status of [404, 401, 403]) {
      for (const reply of Object.values(replies)) {
        reply.status = status;
        reply.body = "password=secret";
      }
      const result = await getUiCapabilities(client, "Display", undefined, { refresh: true });
      assert.equal(result.state, status === 404 ? "not_detected" : "unknown");
      assert.equal(result.assets.contract.status, status);
      assert.equal(result.contract.contractSource, "bundled");
      assert.equal(result.contract.deploymentApplicable, false);
      assert.equal(result.contract.contentHash, PINNED_V2_PROVENANCE.sha256);
      assert.equal(result.cache.ttlMs, 10_000);
      assert.notEqual(result.recommendation.format, "v2");
      assert(!JSON.stringify(result).includes("password=secret"));
      assert.equal((await getUiCapabilities(client, "Display")).cache.hit, true);
    }
    Object.assign(replies.json, { status: 200, body: JSON.stringify(contract), mime: "application/json" });
    Object.assign(replies.js, { status: 200, body: "export {};", mime: "application/javascript" });
    Object.assign(replies.css, { status: 404, body: "not found" });
    const missing = await getUiCapabilities(client, "Display", undefined, { refresh: true });
    assert.equal(missing.state, "incomplete");
    assert.equal(missing.contract.contractSource, "deployed");
    replies.css.status = 200;
    replies.css.body = "body{}";
    replies.json.body = "{invalid token=secret";
    const malformed = await getUiCapabilities(client, "Display", undefined, { refresh: true });
    assert.equal(malformed.state, "incompatible_contract");
    assert.equal(malformed.deployedContract.state, "invalid");
    assert(!JSON.stringify(malformed).includes("token=secret"));
    replies.json.body = JSON.stringify({ ...contract, schemaVersion: 9, secret: "must not leak" });
    const unsupported = await getUiCapabilities(client, "Display", undefined, { refresh: true });
    assert.equal(unsupported.state, "incompatible_contract");
    assert.equal(unsupported.deployedContract.schemaVersion, 9);
    assert.match(unsupported.deployedContract.diagnostics[0]!, /not interpreted as schema 1/u);
    assert.equal(unsupported.contract.compatibility, "unverified");
    assert(!JSON.stringify(unsupported).includes("must not leak"));
    replies.json.body = JSON.stringify({ ...contract, futureOptional: { additive: true } });
    assert.equal((await getUiCapabilities(client, "Display", undefined, { refresh: true })).state, "available");
    replies.json.mime = "text/html";
    replies.json.body = "<html>login password=secret</html>";
    const html = await getUiCapabilities(client, "Display", undefined, { refresh: true });
    assert.equal(html.state, "incomplete");
    assert.equal(html.assets.contract.outcome, "unexpected_content");
    assert.equal(html.contract.compatibility, "unverified");
    assert(!JSON.stringify(html).includes("password=secret"));
    replies.json.mime = "application/json";
    replies.json.body = " ".repeat(2 * 1024 * 1024 + 1);
    const oversized = await getUiCapabilities(client, "Display", undefined, { refresh: true });
    assert.equal(oversized.assets.contract.outcome, "too_large");
    assert.equal(oversized.state, "incomplete");
    assert.equal(oversized.contract.compatibility, "unverified");
  });
});

void test("refresh re-resolves the node, bypasses cache, and separates changed node-root keys and client instances", async () => {
  await fixture(async ({ client, base, paths, replies, setNode }) => {
    await getUiCapabilities(client, "Display");
    replies.json.body = JSON.stringify({ ...contract, packageVersion: "new-2.0" });
    assert.equal((await getUiCapabilities(client, "Display")).contract.packageVersion, "older-1.0");
    const fresh = await getUiCapabilities(client, "Display", undefined, { refresh: true });
    assert.equal(fresh.cache.hit, false);
    assert.equal(fresh.contract.packageVersion, "new-2.0");
    assert.equal(staticCount(paths), 6);
    setNode("Display Alternative");
    const changed = await getUiCapabilities(client, "Display", undefined, { refresh: true });
    assert.equal(changed.target?.nodeBaseUrl, `${base}/nodes/DisplayAlternative/`);
    assert.equal(changed.cache.hit, false);
    assert.equal(staticCount(paths), 9);
    const other = new NodelClient(createTestConfig({ nodelBaseUrl: base }));
    assert.equal((await getUiCapabilities(other, "Display")).cache.hit, false);
    assert.equal(staticCount(paths), 12);
  });
});

void test("concurrent probes deduplicate and one subscriber cancellation does not abort or poison another", async () => {
  await fixture(async ({ client, paths, replies }) => {
    for (const reply of Object.values(replies)) reply.delay = 80;
    const controller = new AbortController();
    const cancelled = getUiCapabilities(client, "Display", undefined, { signal: controller.signal });
    const surviving = getUiCapabilities(client, "Display");
    setTimeout(() => controller.abort(), 30);
    const [partial, complete] = await Promise.all([cancelled, surviving]);
    assert.equal(partial.state, "unknown");
    assert(partial.limitations.some((entry) => entry.includes("caller_aborted")));
    assert.equal(complete.state, "available");
    assert.equal(complete.cache.deduplicated, true);
    assert.equal(staticCount(paths), 3);
    assert.equal((await getUiCapabilities(client, "Display")).cache.hit, true);
  });
});

void test("aggregate timeout preserves completed evidence, aborts real pending reads and does not cache caller cancellation", async () => {
  await fixture(async ({ client, paths, replies, closed }) => {
    replies.css.stall = true;
    const partial = await getUiCapabilities(client, "Display", undefined, { deadlineMs: Date.now() + 80 });
    assert.equal(partial.state, "incomplete");
    assert.equal(partial.assets.contract.outcome, "observed");
    assert.equal(partial.assets.script.outcome, "observed");
    assert.notEqual(partial.assets.stylesheet.outcome, "observed");
    assert(partial.limitations.some((entry) => entry.includes("aggregate_timeout")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(closed.includes("css"));
    replies.css.stall = false;
    const complete = await getUiCapabilities(client, "Display");
    assert.equal(complete.cache.hit, false);
    assert.equal(complete.state, "available");
    assert.equal(staticCount(paths), 6);
    const controller = new AbortController();
    controller.abort();
    const count = paths.length;
    assert.equal(
      (await getUiCapabilities(client, "Display", undefined, { signal: controller.signal })).state,
      "unknown",
    );
    assert.equal(paths.length, count);
    assert.equal(
      (await getUiCapabilities(client, "Display", undefined, { deadlineMs: Date.now() - 1 })).state,
      "unknown",
    );
    assert.equal(paths.length, count);
  });
});

void test("configured lower timeout includes resolution and pending probe time", async () => {
  await fixture(
    async ({ client, replies }) => {
      replies.css.stall = true;
      const started = Date.now();
      const result = await getUiCapabilities(client, "Display");
      assert.equal(result.state, "incomplete");
      assert(Date.now() - started < 270);
      assert(result.limitations.some((entry) => entry.includes("aggregate_timeout")));
    },
    200,
    100,
  );
});

void test("node policy errors remain errors without probing files or replacing them with fallback", async () => {
  await fixture(async ({ base, paths }) => {
    const denied = new NodelClient(createTestConfig({ nodelBaseUrl: base, allowedNodePrefixes: ["Allowed"] }));
    await assert.rejects(
      () => getUiCapabilities(denied, "Display"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "POLICY",
    );
    assert.equal(staticCount(paths), 0);
  });
});

void test("automatic/explicit deadlines are shared absolute 3s/10s ceilings", async () => {
  await fixture(async ({ client }) => {
    const remaining: number[] = [];
    const resolve = client.resolveStaticAssetRequest.bind(client);
    client.resolveStaticAssetRequest = (node, artifact, options) => {
      if (typeof node === "string") remaining.push(options!.deadlineMs! - Date.now());
      return resolve(node, artifact, options);
    };
    await getUiCapabilities(client, "Display", undefined, { automatic: true });
    await getUiCapabilities(client, "Display");
    assert(remaining[0]! > 2900 && remaining[0]! <= 3000);
    assert(remaining[1]! > 9900 && remaining[1]! <= 10_000);
  }, 20_000);
});

void test("policy failure during a probe is not swallowed into fallback advice", async () => {
  await fixture(async ({ client, paths }) => {
    client.readStaticAsset = async () => {
      throw new PublicError("POLICY", "Static access denied.");
    };
    await assert.rejects(
      () => getUiCapabilities(client, "Display"),
      (error: unknown) => error instanceof PublicError && error.code === "POLICY",
    );
    assert.equal(staticCount(paths), 0);
  });
});

void test("page URL/reference analysis handles nested/base/external/custom layouts without fetching them", () => {
  const root = "https://host/prefix/nodes/%CE%94%20Display/";
  const links =
    '<script type="module" src="./v2/nodel-webui.js"></script><link rel="stylesheet" href="./v2/nodel-webui.css">';
  assert.equal(resolveUiPageRuntimeContext(root, undefined, links).state, "matches_node_root");
  const nested = resolveUiPageRuntimeContext(root, "content/pages/control.html", links);
  assert.equal(nested.state, "mismatched");
  assert.equal(nested.apiResolution, "different_path");
  assert.equal(nested.references[0]?.resolvedUrl, `${root}pages/v2/nodel-webui.js`);
  const relative = resolveUiPageRuntimeContext(root, "content/pages/control.html", links.replaceAll("./v2/", "../v2/"));
  assert(relative.references.every((entry) => entry.state === "matches_node_root"));
  assert.equal(relative.apiResolution, "different_path", "asset rewriting must not claim relative REST works");
  const based = resolveUiPageRuntimeContext(root, "content/pages/control.html", '<base href="../">' + links);
  assert.equal(based.state, "matches_node_root");
  assert.equal(based.apiResolution, "node_root");
  const external = resolveUiPageRuntimeContext(
    root,
    undefined,
    '<base href="https://external.invalid/?token=secret">' + links,
  );
  assert.equal(external.state, "unchecked");
  assert.equal(external.apiResolution, "external");
  assert(!JSON.stringify(external).includes("token=secret"));
  assert.equal(resolveUiPageRuntimeContext(root, "control.html", links).state, "unchecked");
  assert.equal(
    resolveUiPageRuntimeContext(root, undefined, '<script src="custom-runtime.js"></script>').state,
    "unchecked",
  );
  assert.equal(
    resolveUiPageRuntimeContext(root, undefined, "<!--" + links + "--><template>" + links + "</template>").references
      .length,
    0,
  );
  assert.equal(
    resolveUiPageRuntimeContext(
      root,
      undefined,
      '<script>const example = `<script src="./v2/nodel-webui.js">`;</script>',
    ).references.length,
    0,
  );
});

void test("proposed page analysis never broadens static network probes", async () => {
  await fixture(async ({ client, paths }) => {
    const page =
      '<base href="https://attacker.invalid/"><script src="https://user:password@attacker.invalid/v2/nodel-webui.js?token=secret"></script><link rel="stylesheet" href="REST/actions">';
    const result = await getUiCapabilities(client, "Display", "content/nested/control.html", { content: page });
    assert.equal(result.state, "available");
    assert.equal(result.page.state, "unchecked");
    assert.equal(staticCount(paths), 3);
    assert.equal(paths.length, 4);
    assert(!JSON.stringify(result).includes("password"));
    assert(!JSON.stringify(result).includes("token=secret"));
  });
});

void test("NanoHTTPD's JavaScript-labelled JSON contract plus actual compiled entry evidence is available", async () => {
  await fixture(async ({ client, replies, paths }) => {
    replies.json.mime = "application/javascript";
    replies.json.body = JSON.stringify(PINNED_V2_CONTRACT);
    replies.js.body = 'import{bk as a}from"./chunks/main-CrDbG2Aa.js";export{a as loadNodelComponent};';
    replies.css.body = "*,:before,:after{--tw-border-spacing-x: 0;--tw-border-spacing-y: 0;--tw-translate-x: 0;";
    const available = await getUiCapabilityContext(client, "Display");
    assert.equal(available.capabilities.assets.contract.mimeType, "application/javascript");
    assert.equal(available.capabilities.state, "available");
    assert.equal(available.capabilities.recommendation.format, "v2");
    assert.equal(available.provenance.contractSource, "deployed");
    assert.equal(available.provenance.packageVersion, PINNED_V2_CONTRACT.packageVersion);
    assert.equal(available.contract.elements.length, PINNED_V2_CONTRACT.elements.length);
    assert.equal(staticCount(paths), 3);
    replies.json.body = "export {};";
    const nonJson = await getUiCapabilities(client, "Display", undefined, { refresh: true });
    assert.equal(nonJson.state, "incompatible_contract");
    assert.equal(nonJson.contract.compatibility, "unverified");
    assert.equal(nonJson.recommendation.format, "undetermined");
    replies.json.body = "<html>login password=secret</html>";
    const html = await getUiCapabilities(client, "Display", undefined, { refresh: true });
    assert.equal(html.assets.contract.outcome, "unexpected_content");
    assert.notEqual(html.state, "available");
    assert(!JSON.stringify(html).includes("password=secret"));
  });
});

void test("HTTP 200 labelled plain errors never produce available capabilities or a v2 recommendation", async () => {
  await fixture(async ({ client, replies }) => {
    replies.json.mime = "application/javascript";
    replies.json.body = JSON.stringify(PINNED_V2_CONTRACT);
    const js = replies.js.body;
    const css = replies.css.body;
    for (const message of [
      "Not Found",
      "Unauthorized",
      "Forbidden",
      "Access denied",
      "503 Service Unavailable",
      "some ambiguous proxy response",
      '{"error":"Not Found","token":"secret"}',
    ]) {
      for (const artifact of ["js", "css"] as const) {
        replies.js.body = artifact === "js" ? message : js;
        replies.css.body = artifact === "css" ? message : css;
        const result = await getUiCapabilities(client, "Display", undefined, { refresh: true });
        assert.equal(result.assets[artifact === "js" ? "script" : "stylesheet"].outcome, "unexpected_content");
        assert.equal(result.state, "incomplete");
        assert.equal(result.recommendation.format, "undetermined");
        assert.equal(result.contract.contractSource, "deployed");
        assert(!JSON.stringify(result).includes("secret"));
      }
    }
    replies.js.body = js;
    replies.css.body = css;
    assert.equal((await getUiCapabilities(client, "Display", undefined, { refresh: true })).state, "available");
  });
});

void test("valid contract and CSS with a login redirect JS response never recommend v2", async () => {
  await fixture(async ({ client, replies, paths }) => {
    replies.json.mime = "application/javascript";
    replies.json.body = JSON.stringify(PINNED_V2_CONTRACT);
    const actualRuntime = 'import{bk as a}from"./chunks/main-CrDbG2Aa.js";export{a as loadNodelComponent};';
    for (const script of [
      'window.location.href = "/login";',
      "window.location.replace('/login');",
      "location = '/login?token=secret';",
      'location.assign("/signin");',
      'window["location"]["href"]="/login";',
      '(function(){window.location.href="/login";})();',
      'if (!hasSession()) location.replace("/login");',
      'document.body.innerHTML="<form id=login>Unauthorized</form>";',
    ]) {
      replies.js.body = script;
      const result = await getUiCapabilities(client, "Display", undefined, { refresh: true });
      assert.equal(result.assets.contract.outcome, "observed");
      assert.equal(result.assets.stylesheet.outcome, "observed");
      assert.equal(result.assets.script.outcome, "unexpected_content");
      assert.equal(result.state, "incomplete");
      assert.equal(result.recommendation.format, "undetermined");
      assert.equal(result.contract.contractSource, "deployed");
      assert(!JSON.stringify(result).includes("secret"));
    }
    replies.js.body = actualRuntime;
    const runtime = await getUiCapabilities(client, "Display", undefined, { refresh: true });
    assert.equal(runtime.state, "available");
    assert.equal(runtime.recommendation.format, "v2");
    assert(
      paths.every(
        (path) =>
          path === "/prefix/REST" || /\/nodes\/Display\/v2\/nodel-(?:components\.json|webui\.(?:js|css))$/u.test(path),
      ),
    );
  });
});
