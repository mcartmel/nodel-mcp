import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { createTestConfig } from "../src/config.js";
import { NodelClient, NodelResponseTooLargeError, NodelTimeoutError, NodelRedirectError } from "../src/nodel/client.js";
import { NodelHttpTransport } from "../src/nodel/http/transport.js";
import { NODEL_STATIC_READ_LIMITS } from "../src/nodel/http/staticAssets.js";
import type { ResolvedNode, StaticAsset } from "../src/nodel/types.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
async function fixture(handler: Handler, run: (base: string, paths: string[]) => Promise<void>) {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url!);
    handler(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`, paths);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
function client(base: string, timeoutMs = 1000) {
  return new NodelClient(createTestConfig({ nodelBaseUrl: base, nodelRequestTimeoutMs: timeoutMs }));
}
function local(request: IncomingMessage, response: ServerResponse, prefix = "") {
  if (request.url !== `${prefix}/REST`) return false;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ nodes: { Display: { name: "Display" } } }));
  return true;
}

void test("fixed static requests preserve runtime base paths and discovered encoded node names", async () => {
  await fixture(
    (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/prefix/REST") response.end('{"nodes":{}}');
      else if (request.url === "/prefix/REST/nodeURLs") {
        response.end(
          JSON.stringify([
            { node: "Δ display", address: `http://${request.headers.host}/prefix/nodes/%CE%94%20display/` },
          ]),
        );
      } else response.end('{"schemaVersion":1}');
    },
    async (base, paths) => {
      const c = client(`${base}/prefix`);
      const request = await c.resolveStaticAssetRequest("Δ display", "contract");
      assert.equal(request.url, `${base}/prefix/nodes/%CE%94%20display/v2/nodel-components.json`);
      assert.equal(Object.isFrozen(request.node), true);
      paths.length = 0;
      const read = await c.readStaticAsset(request.node, "contract");
      assert.equal(read.outcome, "observed");
      assert.equal(read.content, '{"schemaVersion":1}');
      assert.equal(read.contentSha256, createHash("sha256").update('{"schemaVersion":1}').digest("hex"));
      assert.equal(read.bodyComplete, true);
      assert.equal(read.mimeType, "application/json");
      assert.equal(read.finalUrl, request.url);
      assert.deepEqual(paths, ["/prefix/nodes/%CE%94%20display/v2/nodel-components.json"]);
      assert(read.durationMs >= 0);
      assert(Number.isFinite(Date.parse(read.retrievedAt)));
    },
  );
});

void test("forged or copied resolved nodes cannot bypass discovery in static or REST reads", async () => {
  await fixture(
    (request, response) => {
      if (local(request, response)) return;
      response.setHeader("content-type", "application/json");
      response.end("{}");
    },
    async (base, paths) => {
      const c = client(base);
      const genuine = await c.resolveNode("Display");
      const forged: ResolvedNode = { ...genuine, nodeBaseUrl: "http://attacker.invalid/nodes/Display/", allowed: true };
      paths.length = 0;
      const result = await c.readStaticAsset(forged, "contract");
      assert.equal(result.url, `${base}/nodes/Display/v2/nodel-components.json`);
      await c.nodeRequest(forged, "actions");
      assert.deepEqual(paths, [
        "/REST",
        "/nodes/Display/v2/nodel-components.json",
        "/REST",
        "/nodes/Display/REST/actions",
      ]);
      assert.throws(() => {
        genuine.nodeBaseUrl = "http://attacker.invalid/";
      }, TypeError);
      await assert.rejects(() => c.readStaticAsset(genuine, "../REST" as StaticAsset), /Unknown static artifact/u);
    },
  );
});

void test("untrusted caller URL is only sent to trusted discovery, never fetched", async () => {
  await fixture(
    (request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(request.url === "/REST" ? '{"nodes":{}}' : "[]");
    },
    async (base, paths) => {
      await assert.rejects(
        () => client(base, 3000).readStaticAsset("http://attacker.invalid/nodes/Display/", "contract"),
        /not found/u,
      );
      assert(paths.every((path) => path.startsWith("/REST")));
    },
  );
});

void test("chunked contract limit is enforced without Content-Length and the actual body is cancelled", async () => {
  let closed = false;
  await fixture(
    (request, response) => {
      if (local(request, response)) return;
      response.setHeader("content-type", "application/json");
      response.flushHeaders();
      const chunk = Buffer.alloc(65536, 32);
      const interval = setInterval(() => response.write(chunk), 1);
      response.on("close", () => {
        clearInterval(interval);
        closed = true;
      });
    },
    async (base) => {
      const result = await client(base).readStaticAsset("Display", "contract");
      assert.equal(result.outcome, "too_large");
      assert.equal(result.content, undefined);
      assert.equal(result.sample, undefined);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(closed, true);
    },
  );
});

void test("contract accepts exactly 2MiB and rejects declared oversize before sampling", async () => {
  let oversize = false;
  await fixture(
    (request, response) => {
      if (local(request, response)) return;
      response.setHeader("content-type", "application/json; charset=utf-8");
      if (oversize) {
        response.setHeader("content-length", NODEL_STATIC_READ_LIMITS.contractBytes + 1);
        response.flushHeaders();
      } else response.end('"' + "x".repeat(NODEL_STATIC_READ_LIMITS.contractBytes - 2) + '"');
    },
    async (base) => {
      const c = client(base);
      const node = await c.resolveNode("Display");
      const exact = await c.readStaticAsset(node, "contract");
      assert.equal(exact.outcome, "observed");
      assert.equal(exact.bytesRead, NODEL_STATIC_READ_LIMITS.contractBytes);
      oversize = true;
      const rejected = await c.readStaticAsset(node, "contract");
      assert.equal(rejected.outcome, "too_large");
      assert.equal(rejected.bytesRead, 0);
    },
  );
});

void test("JS/CSS prefix sampling stops at 4KiB and closes unfinished response streams", async () => {
  let closed = 0;
  await fixture(
    (request, response) => {
      if (local(request, response)) return;
      response.setHeader("content-type", request.url!.endsWith(".js") ? "application/javascript" : "text/css");
      response.write(
        (request.url!.endsWith(".js") ? '/* evidence */ const runtime = "' : "/* evidence */ body { --evidence: ") +
          "x".repeat(16384),
      );
      const interval = setInterval(() => response.write("x".repeat(8192)), 5);
      response.on("close", () => {
        clearInterval(interval);
        closed++;
      });
    },
    async (base) => {
      const c = client(base);
      const node = await c.resolveNode("Display");
      for (const artifact of ["script", "stylesheet"] as const) {
        const result = await c.readStaticAsset(node, artifact);
        assert.equal(result.outcome, "observed");
        assert.equal(result.bytesRead, 4096);
        assert.equal(result.sample?.length, 4096);
        assert.equal(result.bodyComplete, false);
        assert.equal(result.content, undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(closed, 2);
    },
  );
});

void test("HTML/login, missing/ambiguous MIME, and HTTP errors never expose response bodies", async () => {
  let status = 200;
  let mime: string | undefined = "text/html";
  await fixture(
    (request, response) => {
      if (local(request, response)) return;
      response.statusCode = status;
      if (mime) response.setHeader("content-type", mime);
      response.end("<html><form>password=secret</form></html>");
    },
    async (base) => {
      const c = client(base);
      const node = await c.resolveNode("Display");
      for (const entry of [
        { status: 200, mime: "text/html" },
        { status: 200, mime: "application/json" },
        { status: 200, mime: undefined },
        { status: 401, mime: "application/json" },
        { status: 403, mime: "text/html" },
        { status: 404, mime: "text/html" },
        { status: 503, mime: "text/plain" },
      ]) {
        ({ status, mime } = entry);
        const result = await c.readStaticAsset(node, "contract");
        assert.equal(result.outcome, status === 200 ? "unexpected_content" : "http_error");
        assert.equal(result.status, status);
        assert.equal(result.content, undefined);
        assert.equal(result.sample, undefined);
        assert.equal(JSON.stringify(result).includes("secret"), false);
      }
    },
  );
});

void test("redirects cannot escape origin, node, artifact, or lexical path policy", async () => {
  let location = "";
  await fixture(
    (request, response) => {
      if (local(request, response)) return;
      response.writeHead(302, { location, "content-type": "text/plain" });
      response.write("secret response body");
    },
    async (base, paths) => {
      const c = client(base);
      const node = await c.resolveNode("Display");
      const root = "/nodes/Display/v2/";
      for (const target of [
        "http://attacker.invalid/nodes/Display/v2/nodel-components.json",
        `${base.replace("http://", "http://user:secret@")}${root}nodel-components.json`,
        "/REST",
        "/nodes/Other/v2/nodel-components.json",
        "/nodes/Display/REST/actions",
        `${root}nodel-components.json?token=secret`,
        `${root}nodel-components.json?`,
        `${root}nodel-components.json#fragment`,
        `${root}../v2/nodel-components.json`,
        `${root}%2e%2e/v2/nodel-components.json`,
        `${root}%252e%252e/nodel-components.json`,
        `${root}%6eodel-components.json`,
        `${root}nodel-webui.js`,
        `${root}a%2fnodel-components.json`,
        `${root}a\\..\\nodel-components.json`,
      ]) {
        location = target;
        paths.length = 0;
        const result = await c.readStaticAsset(node, "contract");
        assert.equal(result.outcome, "redirect_rejected", target);
        assert.equal(result.finalUrl, `${base}${root}nodel-components.json`);
        assert.equal(result.content, undefined);
        assert.deepEqual(paths, [`${root}nodel-components.json`]);
        assert.equal(JSON.stringify(result).includes("secret"), false);
      }
      location = `${root}nodel-components.json`;
      paths.length = 0;
      const loop = await c.readStaticAsset(node, "contract");
      assert.equal(loop.outcome, "redirect_rejected");
      assert(paths.length <= 2);
    },
  );
});

void test("caller cancellation and lower configured timeout abort real pending body reads", async () => {
  let closed = 0;
  await fixture(
    (request, response) => {
      if (local(request, response)) return;
      response.setHeader("content-type", "application/json");
      response.write('{"never":');
      response.on("close", () => closed++);
    },
    async (base) => {
      const c = client(base, 60);
      const node = await c.resolveNode("Display");
      const started = Date.now();
      const timeout = await c.readStaticAsset(node, "contract", { timeoutMs: 10_000 });
      assert.equal(timeout.outcome, "timeout");
      assert(Date.now() - started < 500);
      const controller = new AbortController();
      const pending = c.readStaticAsset(node, "contract", { signal: controller.signal });
      setTimeout(() => controller.abort(), 15);
      assert.equal((await pending).outcome, "aborted");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(closed, 2);
    },
  );
});

void test("opt-in bounded REST/file reads cancel pending streams and enforce byte caps; defaults stay legacy", async () => {
  let mode = "oversize";
  let closed = 0;
  await fixture(
    (request, response) => {
      if (local(request, response)) return;
      if (mode === "oversize") response.end("0123456789");
      else {
        response.write("x");
        response.on("close", () => closed++);
      }
    },
    async (base) => {
      const c = client(base);
      const node = await c.resolveNode("Display");
      assert.equal(await c.getNodeFileContents(node, "content/index.html"), "0123456789");
      await assert.rejects(
        () => c.getNodeFileContents(node, "content/index.html", { maxResponseBytes: 4 }),
        NodelResponseTooLargeError,
      );
      mode = "stall";
      const controller = new AbortController();
      const request = c.nodeRequest(node, "files/contents?path=content%2Findex.html", {
        responseMode: "bytes",
        signal: controller.signal,
        timeoutMs: 500,
        maxResponseBytes: 100,
      });
      setTimeout(() => controller.abort(), 15);
      await assert.rejects(request);
      await assert.rejects(() => c.getNodeFileBytes(node, "content/index.html", { timeoutMs: 20 }), NodelTimeoutError);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(closed, 2);
    },
  );
});

void test("expired aggregate deadlines and pre-aborted signals perform no HTTP work", async () => {
  await fixture(
    (_request, response) => response.end("unexpected"),
    async (base, paths) => {
      const c = client(base);
      await assert.rejects(
        () => c.readStaticAsset("Display", "contract", { deadlineMs: Date.now() - 1 }),
        NodelTimeoutError,
      );
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(() => c.nodeRequest("Display", "actions", { signal: controller.signal }));
      assert.deepEqual(paths, []);
      const transport = new NodelHttpTransport(1000);
      await assert.rejects(
        () => transport.request(`${base}/REST`, {}, "text", { maxResponseBytes: 0 }),
        /positive safe integer/u,
      );
      assert.deepEqual(paths, []);
    },
  );
});

void test("static reads bound in-flight requests and queued cancellation never starts a request", async () => {
  let active = 0;
  let maximum = 0;
  const finish: Array<() => void> = [];
  await fixture(
    (request, response) => {
      if (local(request, response)) return;
      active++;
      maximum = Math.max(maximum, active);
      response.setHeader("content-type", "text/css");
      finish.push(() => {
        active--;
        response.end("body { color: red }");
      });
    },
    async (base, paths) => {
      const c = client(base);
      const node = await c.resolveNode("Display");
      const pending = Array.from({ length: 6 }, () => c.readStaticAsset(node, "stylesheet"));
      const controller = new AbortController();
      const aborted = c.readStaticAsset(node, "stylesheet", { signal: controller.signal });
      controller.abort();
      await assert.rejects(aborted);
      for (let round = 0; round < 2; round++) {
        while (finish.length < 3) await new Promise((resolve) => setTimeout(resolve, 5));
        for (const release of finish.splice(0)) release();
      }
      assert((await Promise.all(pending)).every((result) => result.outcome === "observed"));
      assert.equal(maximum, 3);
      assert.equal(paths.filter((path) => path.endsWith(".css")).length, 6);
    },
  );
});

void test("static reader cancels redirect/error/MIME-rejected bodies without reading secrets", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = 0;
  let mode = "redirect";
  try {
    globalThis.fetch = async (url) => {
      if (url.toString().endsWith("/REST")) return new Response('{"nodes":{"Display":{"name":"Display"}}}');
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled++;
        },
      });
      if (mode === "redirect")
        return new Response(body, { status: 302, headers: { location: "/REST?password=secret" } });
      if (mode === "error") return new Response(body, { status: 500 });
      return new Response(body, { headers: { "content-type": "text/html" } });
    };
    const c = client("http://example.test");
    const node = await c.resolveNode("Display");
    for (const entry of ["redirect", "error", "mime"]) {
      mode = entry;
      const result = await c.readStaticAsset(node, "contract");
      assert.equal(result.content, undefined);
      assert(!JSON.stringify(result).includes("secret"));
    }
    assert.equal(cancelled, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("aggregate deadline cancels real discovery reads and stops waiting during resolver retries", async () => {
  let stall = true;
  let closed = false;
  await fixture(
    (request, response) => {
      response.setHeader("content-type", "application/json");
      if (stall) {
        response.write('{"nodes":');
        response.on("close", () => {
          closed = true;
        });
      } else response.end(request.url === "/REST" ? '{"nodes":{}}' : "[]");
    },
    async (base, paths) => {
      const c = client(base, 1000);
      await assert.rejects(
        () => c.resolveStaticAssetRequest("Display", "contract", { deadlineMs: Date.now() + 30 }),
        NodelTimeoutError,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(closed, true);
      stall = false;
      paths.length = 0;
      const started = Date.now();
      await assert.rejects(() => c.resolveNode("Missing", { timeoutMs: 50 }), NodelTimeoutError);
      assert(Date.now() - started < 200);
      const requestsAtAbort = paths.length;
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(paths.length, requestsAtAbort);
    },
  );
});

void test("contract bytes use strict UTF-8 and exact-byte hashing, while prefix decoding permits a split code point", async () => {
  let body = Buffer.from('\ufeff{"version":1}');
  let mime = "application/json";
  await fixture(
    (request, response) => {
      if (local(request, response)) return;
      response.setHeader("content-type", mime);
      response.end(body);
    },
    async (base) => {
      const c = client(base);
      const node = await c.resolveNode("Display");
      const bom = await c.readStaticAsset(node, "contract");
      assert.equal(bom.content, '\ufeff{"version":1}');
      assert.equal(bom.contentSha256, createHash("sha256").update(body).digest("hex"));
      body = Buffer.from([0xff, 0xfe, 0x61]);
      assert.equal((await c.readStaticAsset(node, "contract")).outcome, "unexpected_content");
      mime = "application/javascript";
      const preamble = 'const runtime = "';
      body = Buffer.concat([Buffer.from(preamble + "x".repeat(4095 - preamble.length)), Buffer.from('😀 rest";')]);
      const prefix = await c.readStaticAsset(node, "script");
      assert.equal(prefix.outcome, "observed");
      assert.equal(prefix.bytesRead, 4096);
      assert(!prefix.sample?.includes("�"));
      body = Buffer.from("<html>login secret</html>");
      const html = await c.readStaticAsset(node, "script");
      assert.equal(html.outcome, "unexpected_content");
      assert.equal(html.sample, undefined);
    },
  );
});

void test("decoded streaming cap is enforced even when compressed Content-Length fits the budget", async () => {
  const compressed = gzipSync(Buffer.alloc(NODEL_STATIC_READ_LIMITS.contractBytes + 1, 32));
  assert(compressed.byteLength < NODEL_STATIC_READ_LIMITS.contractBytes);
  await fixture(
    (request, response) => {
      if (local(request, response)) return;
      response.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": compressed.byteLength,
      });
      response.end(compressed);
    },
    async (base) => {
      const result = await client(base).readStaticAsset("Display", "contract");
      assert.equal(result.outcome, "too_large");
      assert.equal(result.content, undefined);
    },
  );
});

void test("static probes use the discovered remote runtime and node overrides, never either host root", async () => {
  await fixture(
    (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end('{"nodeOverride":true}');
    },
    async (remote, remotePaths) => {
      await fixture(
        (request, response) => {
          response.setHeader("content-type", "application/json");
          response.end(
            request.url === "/REST"
              ? '{"nodes":{}}'
              : JSON.stringify([{ node: "Display", address: `${remote}/gateway/nodes/Display/` }]),
          );
        },
        async (base, localPaths) => {
          const result = await client(base).readStaticAsset("Display", "contract");
          assert.equal(result.outcome, "observed");
          assert.equal(result.finalUrl, `${remote}/gateway/nodes/Display/v2/nodel-components.json`);
          assert.equal(result.content, '{"nodeOverride":true}');
          assert.deepEqual(localPaths, ["/REST", "/REST/nodeURLs"]);
          assert.deepEqual(remotePaths, ["/gateway/nodes/Display/v2/nodel-components.json"]);
        },
      );
    },
  );
});

void test("static reads retain allowed-node policy and reject unsafe discovered namespace encodings", async () => {
  await fixture(
    (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/REST") response.end('{"nodes":{"Display":{"name":"Display"}}}');
      else response.end("unexpected");
    },
    async (base, paths) => {
      const c = new NodelClient(createTestConfig({ nodelBaseUrl: base, allowedNodePrefixes: ["Allowed"] }));
      await assert.rejects(() => c.readStaticAsset("Display", "contract"), /allow/u);
      assert.deepEqual(paths, ["/REST"]);
    },
  );
  await fixture(
    (request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        request.url === "/REST"
          ? '{"nodes":{}}'
          : JSON.stringify([{ node: "Display", address: `http://${request.headers.host}/nodes/Display%252fOther/` }]),
      );
    },
    async (base, paths) => {
      await assert.rejects(() => client(base).readStaticAsset("Display", "contract"), NodelRedirectError);
      assert(paths.every((path) => path.startsWith("/REST")));
    },
  );
});

void test("fixed contract accepts NanoHTTPD's application/javascript JSON mapping without broadening entry MIME policy", async () => {
  let body = '{"schemaVersion":1}';
  let mime = "application/javascript; charset=UTF-8";
  await fixture(
    (request, response) => {
      if (local(request, response)) return;
      response.setHeader("content-type", mime);
      response.end(body);
    },
    async (base) => {
      const c = client(base);
      const node = await c.resolveNode("Display");
      const read = await c.readStaticAsset(node, "contract");
      assert.equal(read.outcome, "observed");
      assert.equal(read.mimeType, "application/javascript");
      assert.equal(read.content, body);
      assert.equal(read.bodyComplete, true);
      assert.equal(read.contentSha256, createHash("sha256").update(body).digest("hex"));
      body = "<html>login password=secret</html>";
      const login = await c.readStaticAsset(node, "contract");
      assert.equal(login.outcome, "unexpected_content");
      assert.equal(login.content, undefined);
      mime = "application/json";
      body = "export {};";
      assert.equal((await c.readStaticAsset(node, "script")).outcome, "unexpected_content");
      mime = "application/javascript";
      body = "body {}";
      assert.equal((await c.readStaticAsset(node, "stylesheet")).outcome, "unexpected_content");
    },
  );
});

void test("MIME-labelled 200 status messages, JSON errors, comment-only samples and ambiguous prose are not entry evidence", async () => {
  let body = "";
  await fixture(
    (request, response) => {
      if (local(request, response)) return;
      response.setHeader("content-type", request.url!.endsWith(".js") ? "application/javascript" : "text/css");
      response.end(body);
    },
    async (base) => {
      const c = client(base);
      const node = await c.resolveNode("Display");
      for (const message of [
        "Not Found",
        "Unauthorized",
        "Unauthorised",
        "Forbidden",
        "Access Denied",
        "Permission denied.",
        "Authentication required",
        "Authorization required",
        "Login required",
        "Please log in to continue.",
        "HTTP/1.1 404 Not Found",
        "503 Service Unavailable",
        "Internal Server Error",
        "Bad Gateway",
        "Service Unavailable",
        "Gateway Timeout",
        "Error: missing asset token=secret",
        "Cannot GET /v2/nodel-webui.js",
        "Failed to load resource",
        '{"error":"Not Found","password":"secret"}',
        "a response whose content is ambiguous",
        "/* export {}; body {} */",
        "/* license */ Not Found",
        '"function fake() { return true; }"',
        "'body {color:red}'",
        "// export {};",
      ]) {
        body = message;
        for (const artifact of ["script", "stylesheet"] as const) {
          const read = await c.readStaticAsset(node, artifact);
          assert.equal(read.outcome, "unexpected_content", `${artifact}: ${message}`);
          assert.equal(read.sample, undefined);
          assert.equal(read.content, undefined);
          assert.equal(JSON.stringify(read).includes("secret"), false);
        }
      }
    },
  );
});

void test("generic syntax evidence accepts actual compiled entry prefixes and different bundler/release forms without executing them", async () => {
  // Exact compiled JS and initial CSS prefix inspected read-only in the sibling
  // nodel-webui-v2/dist/v2 artifacts. No test depends on that checkout or chunk hash.
  const compiledJs = 'import{bk as a}from"./chunks/main-CrDbG2Aa.js";export{a as loadNodelComponent};';
  const compiledCssPrefix = "*,:before,:after{--tw-border-spacing-x: 0;--tw-border-spacing-y: 0;--tw-translate-x: 0;";
  let body = "";
  await fixture(
    (request, response) => {
      if (local(request, response)) return;
      response.setHeader("content-type", request.url!.endsWith(".js") ? "application/javascript" : "text/css");
      response.end(body);
    },
    async (base, paths) => {
      const c = client(base);
      const node = await c.resolveNode("Display");
      for (const source of [
        compiledJs,
        'import entry from "./future-release.mjs";',
        'import "./preload.js";',
        'import"./preload.js";',
        "const _runtime = true;",
        "export {};",
        "(()=>{var renamed=1;})()",
        "!function(){let renamed=1;}();",
        '"use strict";var renamed=Object.create(null);',
        "globalThis.renamed = {initialize(){}};",
        'Object.defineProperty(globalThis,"renamed",{value:true});',
        "class FutureElement extends HTMLElement {}",
        'const load=()=>import("./future/chunk.js");',
        'async function load(){await import("./chunk.js")}',
        '/*! license */const template = "<html>example</html>";',
      ]) {
        body = source;
        assert.equal((await c.readStaticAsset(node, "script")).outcome, "observed", source);
      }
      for (const source of [
        compiledCssPrefix,
        '@charset "UTF-8";body{color:red}',
        '@import url("./future.css");',
        "@layer reset,base;",
        "@supports (display:grid){.future{display:grid}}",
        "@media (width > 1px){body{color:red}}",
        ".shell > .child{display:grid}",
        '[data-theme="future"]{color:var(--future)}',
        "/* license body {} */ :root{--future:1}",
        '@font-face{font-family:"future";src:url("./font.woff2")}',
        "@future-rule example { body{} }",
        "body{}",
      ]) {
        body = source;
        assert.equal((await c.readStaticAsset(node, "stylesheet")).outcome, "observed", source);
      }
      assert(paths.every((path) => path === "/REST" || /\/v2\/nodel-webui\.(?:js|css)$/u.test(path)));
    },
  );
});

void test("standalone navigation/login scripts are not entry evidence and are never executed or followed", async () => {
  let body = "";
  await fixture(
    (request, response) => {
      if (local(request, response)) return;
      response.setHeader("content-type", "application/javascript");
      response.end(body);
    },
    async (base, paths) => {
      const c = client(base);
      const node = await c.resolveNode("Display");
      for (const redirect of [
        'window.location.href = "/login";',
        "window.location.replace('/login');",
        "location.assign('/signin');",
        'location.href="/auth/login";',
        'location = "/login?token=secret";',
        'window.location="/login";',
        'self.location.href="/login";',
        'document.location="/login";',
        'top.location.replace("/login");',
        'parent.location.assign("/login");',
        'globalThis.location.href="/login";',
        'window.top.location.href="/login";',
        'window["location"]["href"]="/login";',
        "location['replace']('/login');",
        '"use strict";window.location.href="/login";',
        '/* authentication gateway */ window.location.href="/login";',
        '(function(){window.location.href="/login";})();',
        '(()=>{location.replace("/login");})()',
        '(function redirect(){window.location.href="/login";})();',
        '(()=>location.href="/login")()',
        '!function(){location="/login";}();',
        'if (!authenticated) { window.location.href="/login"; }',
        'if (!hasSession()) location.assign("/signin");',
        'window.location.href="/login?next=" + encodeURIComponent(location.href);',
        'location="/login"; /* ambiguous trailing code */ foo();',
        'if(a){if(b){if(c){if(d){location="/login";}}}}',
        'location.replace("\\x2flogin");',
        'alert("Session expired. Please log in.");',
        'document.write(\'<form action="/login"><input type="password"></form>\');',
        'document.body.innerHTML="<div>Unauthorized</div>";',
        'window.location.href="/login?next=' + "x".repeat(8192) + '";',
      ]) {
        body = redirect;
        const read = await c.readStaticAsset(node, "script");
        assert.equal(read.outcome, "unexpected_content", redirect.slice(0, 120));
        assert.equal(read.sample, undefined);
        assert.equal(read.content, undefined);
        assert.equal(JSON.stringify(read).includes("secret"), false);
        assert(read.bytesRead <= 4096);
      }
      for (const source of [
        'import{bk as a}from"./chunks/main-CrDbG2Aa.js";export{a as loadNodelComponent};',
        'export function navigateToLogin(){window.location.href="/login";}',
        "const example = 'window.location.href = \"/login\";';export {};",
        '/* window.location.replace("/login"); */ import "./chunks/future.js";',
        'function go(){location.replace("/login")}export{go};',
        'window["theme"]="dark";',
      ]) {
        body = source;
        assert.equal((await c.readStaticAsset(node, "script")).outcome, "observed", source);
      }
      assert(paths.every((path) => path === "/REST" || path === "/nodes/Display/v2/nodel-webui.js"));
    },
  );
});
