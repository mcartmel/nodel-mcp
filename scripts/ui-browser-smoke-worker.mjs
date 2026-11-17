#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { readFile, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sendFixtureFailure } from "./ui-browser-smoke-http.mjs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerUiTools } from "../dist/mcp/tools/ui.js";

// Internal worker: never launch Chromium unless the parent-created namespaces are verified.
const EXPECTED_REVISION = "b4f9f03dd40ac4670d48efa749ae8d5ad96c2980";
const EXPECTED_CONTRACT = "47ca302aea65ed7a47002b6c312f978471aa681f923c10878bc7b2782210d2a8";
const config = JSON.parse(process.argv[2] ?? "null");
assert.ok(config, "internal worker requires namespace supervisor configuration");
const isolation = await verifyIsolation(config);
console.error(`UI_SMOKE_ISOLATION ${JSON.stringify(isolation)}`);
const runtimeDir = path.resolve(config.runtimeDist);
const playwrightEntry = path.resolve(config.playwrightModule);

const runtimeReal = await realpath(runtimeDir);
const moduleReal = await realpath(playwrightEntry);
const contractBytes = await readFile(path.join(runtimeReal, "nodel-components.json"));
const runtimeContract = JSON.parse(contractBytes.toString("utf8"));
const contractHash = await createHash(contractBytes);
assert.equal(contractHash, EXPECTED_CONTRACT, "built runtime contract differs from bundled MCP contract");
assert.equal(runtimeContract.schemaVersion, 1, "unexpected component-contract schema");

const { chromium } = await import(pathToFileURL(moduleReal).href);
let browser;
const server = createServer();
const sockets = new Set();
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
const calls = [];
const requested = new Set();
const failures = [];
const consoleWarnings = [];
const observedAssetHashes = {};
let browserContext;
let client;
let mcpServer;
let cleanupPromise;
let activityPolls = 0;
let report;

try {
  assert.ok(await stat(chromium.executablePath()).then((entry) => entry.isFile()), "browser must already be installed");
  browser = await chromium.launch({
    headless: true,
    // A loopback-only netns otherwise has no ICE-eligible interface in Chromium.
    // Enable it for the local STUN regression; the OS boundary remains authoritative.
    args: ["--allow-loopback-in-peer-connection", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
  });
  const starter = await callGuidelines();
  assert.equal(starter.format, "v2_html_custom_elements");
  assert.equal(starter.starterProvenance.deploymentApplicable, false);
  assert.equal(starter.bundledContractProvenance.repositoryRevision, EXPECTED_REVISION);
  assert.equal(starter.bundledContractProvenance.contentHash, contractHash, "MCP and fixture contracts must match");
  assert.equal(
    await createHash(Buffer.from(starter.starter)),
    starter.starterProvenance.sha256,
    "MCP starter bytes must match provenance",
  );
  const html = starter.starter.replace(
    "<nodel-text>Your content goes here.</nodel-text>",
    '<nodel-text signal="SmokeSignal">Waiting for mocked signal</nodel-text>\n            <nodel-button action="SmokeAction" class="nodel-button-primary">Run smoke action</nodel-button>',
  );

  server.on("request", async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/nodes/Mock/index.html") return send(res, 200, html, "text/html; charset=utf-8");
      if (url.pathname.startsWith("/nodes/Mock/v2/")) {
        const rel = url.pathname.slice("/nodes/Mock/v2/".length);
        return await sendSafeAsset(res, runtimeReal, rel);
      }
      if (url.pathname === "/nodes/Mock/REST/actions" && req.method === "GET")
        return sendJson(res, { SmokeAction: {} });
      if (url.pathname === "/nodes/Mock/REST/events" && req.method === "GET") return sendJson(res, { SmokeSignal: {} });
      if (url.pathname === "/nodes/Mock/REST/activity" && req.method === "GET") {
        activityPolls += 1;
        if (activityPolls > 30) return sendJson(res, { error: "mock activity poll limit exceeded" }, 429);
        return sendJson(res, [
          {
            source: "local",
            type: "event",
            alias: "SmokeSignal",
            arg: "BrowserMockValue",
            seq: 1,
            timestamp: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (url.pathname === "/nodes/Mock/REST/hasRestarted" && req.method === "GET") return sendJson(res, false);
      if (
        url.pathname.startsWith("/nodes/Mock/REST/actions/") &&
        url.pathname.endsWith("/call") &&
        req.method === "POST"
      ) {
        calls.push({ path: url.pathname, body: await bodyText(req) });
        return sendJson(res, { ok: true });
      }
      if (url.pathname.startsWith("/nodes/Mock/REST/events/") && req.method === "GET")
        return sendJson(res, { value: "ready" });
      if (url.pathname === "/favicon.ico") return send(res, 204, "", "image/x-icon");
      send(res, 404, "not found", "text/plain; charset=utf-8");
    } catch (error) {
      sendFixtureFailure(res, error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "fixture must bind a TCP address");
  const origin = `http://127.0.0.1:${address.port}`;
  browserContext = await browser.newContext();
  await browserContext.routeWebSocket(/.*/, (ws) => ws.close());
  await browserContext.route("**/*", async (route) => {
    const url = route.request().url();
    if (new URL(url).origin !== origin) return route.abort("blockedbyclient");
    requested.add(new URL(url).pathname + new URL(url).search);
    await route.continue();
  });
  // Chromium treats a loopback-only host as offline, and the runtime suspends activity
  // polling while offline. Model fixture connectivity explicitly, without changing any
  // runtime bytes, browser network APIs or OS routes. This is reported as a mock.
  await browserContext.addInitScript(() => {
    Object.defineProperty(navigator, "onLine", { get: () => true });
  });
  const page = await browserContext.newPage();
  assert.equal(await page.evaluate(() => navigator.onLine), true, "fixture browser must report online");
  const udpProbe = await probeWebRtc(page, config.udpProbePort);
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) =>
    failures.push(`requestfailed: ${request.url()} (${request.failure()?.errorText})`),
  );
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  page.on("console", (message) => {
    if (message.type() === "warning") consoleWarnings.push(message.text());
  });
  // Nodel stores content/index.html but serves it at the node root URL.
  await page.goto(`${origin}/nodes/Mock/index.html`, { waitUntil: "networkidle", timeout: 20000 });
  await page.locator("nodel-app nodel-page nodel-button").waitFor({ state: "visible", timeout: 10000 });
  await page
    .waitForFunction(() => customElements.get("nodel-app") && customElements.get("nodel-button"), null, {
      timeout: 10000,
    })
    .catch(async (error) => {
      throw new Error(
        `${error.message}; defined=${await page.evaluate(() => ["nodel-app", "nodel-button"].map((name) => [name, Boolean(customElements.get(name))]))}; requested=${[...requested].join(",")}; failures=${failures.join(" | ")}`,
      );
    });
  assert.ok(requested.has("/nodes/Mock/v2/nodel-webui.js"));
  assert.ok(requested.has("/nodes/Mock/v2/nodel-webui.css"));
  assert.ok(
    [...requested].some((item) => item.startsWith("/nodes/Mock/v2/chunks/")),
    "runtime chunks were not requested",
  );
  await page.getByText("BrowserMockValue", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
  assert.ok(
    [...requested].some((item) => item.startsWith("/nodes/Mock/REST/activity")),
    "runtime did not subscribe to the mocked signal activity",
  );
  const [actionResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/nodes/Mock/REST/actions/SmokeAction/call" &&
        response.request().method() === "POST",
      { timeout: 10000 },
    ),
    page.getByRole("button", { name: "Run smoke action" }).click(),
  ]);
  assert.equal(actionResponse.status(), 200, "mock action must complete successfully");
  // Confirm click behavior through the loopback mock, independent of shadow-DOM internals.
  assert.ok(
    calls.some((call) => call.path.endsWith("/SmokeAction/call")),
    "mock action endpoint was not called",
  );
  if (failures.length) throw new Error(`Browser network/runtime failures:\n${failures.join("\n")}`);
  report = {
    result: "passed",
    mcpTool: "nodel.get_ui_guidelines",
    starterSha256: starter.starterProvenance.sha256,
    runtime: {
      referenceSourceRevision: EXPECTED_REVISION,
      runtimeBuildRevision: "unverified",
      contractSha256: contractHash,
      contractHashVerified: true,
      directory: runtimeReal,
      observedAssetHashes,
      authenticity:
        "Not established: matching contract and observed asset hashes do not prove source/build provenance.",
    },
    isolation: {
      ...isolation,
      udpProbe,
      browserOnlineStatus: "navigator.onLine=true mocked for loopback-only fixture",
      browserDns: "hostname resolution denied by host-resolver-rules; OS namespace also has no egress routes",
    },
    browser: await browser.version(),
    assertions: [
      "pinned contract match",
      "MCP-generated starter served",
      "stable JS/CSS and hashed chunks loaded",
      "custom elements upgraded and rendered",
      "mock signal activity rendered",
      "mock action invoked",
      "private user/network/PID namespaces; loopback only, no egress routes",
      "WebRTC STUN emitted inside namespace, not delivered to outside listener",
    ],
    requests: [...requested].sort(),
    mockActions: calls.length,
    consoleWarnings,
  };
} catch (error) {
  console.error(JSON.stringify({ requested: [...requested], failures, activityPolls, consoleWarnings }));
  throw error;
} finally {
  // Deliberately allowed to hang in the opt-in regression: only the PARENT owns the hard deadline.
  if (config.testHangContextClose && browserContext && report) {
    browserContext.close = () => new Promise(() => {});
    console.error("UI_SMOKE_TEST_CLOSE_HANG");
  }
  await cleanup();
}
// Exiting PID 1 also makes the kernel kill any remaining descendants in this PID namespace.
process.stdout.write(JSON.stringify(report, null, 2) + "\n", () => process.exit(0));

async function callGuidelines() {
  // Exercise the registered tool over the MCP SDK client/server protocol using an in-memory transport pair.
  const [serverTransport, clientTransport] = memoryTransports();
  mcpServer = new McpServer({ name: "ui-browser-smoke", version: "1.0.0" });
  // Any accidental Nodel access must fail, never reach equipment from this fixture.
  const offlineClient = /** @type {import("../dist/nodel/client.js").NodelClient} */ (
    new Proxy(
      {},
      {
        get() {
          throw new Error("Browser smoke MCP starter must not access Nodel");
        },
      },
    )
  );
  registerUiTools(mcpServer, offlineClient);
  client = new Client({ name: "ui-browser-smoke", version: "1.0.0" });
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "nodel.get_ui_guidelines", arguments: { format: "v2" } });
  assert.ok(Array.isArray(result.content));
  const body = JSON.parse(result.content.find((part) => part.type === "text").text);
  assert.equal(body.ok, true);
  return body;
}

function memoryTransports() {
  const a = {
    onmessage: undefined,
    onerror: undefined,
    onclose: undefined,
    peer: null,
    async start() {},
    async close() {
      this.onclose?.();
    },
    async send(message) {
      queueMicrotask(() => this.peer.onmessage?.(message));
    },
  };
  const b = {
    ...a,
    async send(message) {
      queueMicrotask(() => this.peer.onmessage?.(message));
    },
  };
  a.peer = b;
  b.peer = a;
  return [a, b];
}

async function sendSafeAsset(res, root, relative) {
  const decoded = decodeURIComponent(relative);
  if (decoded.includes("\\") || decoded.split("/").some((part) => part === ".." || part === "."))
    return send(res, 400, "invalid path", "text/plain");
  const candidate = path.resolve(root, decoded);
  if (candidate !== root && !candidate.startsWith(root + path.sep))
    return send(res, 403, "outside runtime", "text/plain");
  const real = await realpath(candidate).catch(() => null);
  if (!real || (real !== root && !real.startsWith(root + path.sep)) || !(await stat(real)).isFile())
    return send(res, 404, "missing runtime asset", "text/plain");
  const ext = path.extname(real).toLowerCase();
  const mime =
    {
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
    }[ext] ?? "application/octet-stream";
  const bytes = await readFile(real);
  if (ext === ".js" || ext === ".css") observedAssetHashes[relative] = await createHash(bytes);
  send(res, 200, bytes, mime);
}
function send(res, status, data, type) {
  res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*" });
  res.end(data);
}
function sendJson(res, value, status = 200) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}
function bodyText(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (part) => chunks.push(part));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function createHash(data) {
  const { createHash: hash } = await import("node:crypto");
  return hash("sha256").update(data).digest("hex");
}
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    await browserContext?.close().catch(() => {});
    await client?.close().catch(() => {});
    await mcpServer?.close().catch(() => {});
    if (server.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    for (const socket of sockets) socket.destroy();
    await browser?.close().catch(() => {});
  })();
  return cleanupPromise;
}

async function verifyIsolation(options) {
  assert.equal(process.platform, "linux", "unsupported qualification: Linux namespaces required");
  assert.equal(process.pid, 1, "unsupported qualification: worker must be PID namespace init");
  const namespaces = {};
  for (const kind of ["user", "net", "pid"]) {
    namespaces[kind] = await readlink(`/proc/self/ns/${kind}`);
    assert.notEqual(namespaces[kind], options.parentNamespaces[kind], `worker must have a private ${kind} namespace`);
  }
  // This is the ONLY network mutation, performed after verifying a different network namespace.
  execFileSync(options.ipTool, ["link", "set", "lo", "up"], { timeout: 2000 });
  const ip = (...args) =>
    JSON.parse(execFileSync(options.ipTool, ["-j", ...args], { timeout: 2000, encoding: "utf8" }));
  const interfaces = ip("address", "show");
  assert.deepEqual(
    interfaces.map((item) => item.ifname),
    ["lo"],
    "network namespace must contain only loopback",
  );
  assert.ok(interfaces[0].flags.includes("UP"), "loopback must be up");
  for (const address of interfaces[0].addr_info) {
    assert.ok(["127.0.0.1", "::1"].includes(address.local), "only loopback addresses allowed");
  }
  const routes = [...ip("route", "show", "table", "all"), ...ip("-6", "route", "show", "table", "all")];
  assert.ok(
    routes.every((route) => route.dev === "lo" && route.dst !== "default"),
    "no egress routes allowed",
  );
  return {
    namespaces,
    interfaces: ["lo"],
    routes,
    boundary: "Linux network namespace (including UDP/DNS), not Playwright routing",
  };
}

async function probeWebRtc(page, port) {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  // The parent binds the SAME loopback port outside this netns. A successful bind here plus
  // actual STUN receipt proves browser UDP is attempted, but goes to a different network stack.
  const socket = createSocket("udp4");
  let packets = 0;
  socket.on("message", (packet) => {
    if (packet.length >= 20 && packet.readUInt32BE(4) === 0x2112a442) packets += 1;
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(port, "127.0.0.1", () => resolve(undefined));
    });
    await page.evaluate(async (probePort) => {
      const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${probePort}` }] });
      try {
        peer.createDataChannel("namespace-regression");
        await peer.setLocalDescription(await peer.createOffer());
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } finally {
        peer.close();
      }
    }, port);
    assert.ok(packets > 0, "WebRTC regression must actually emit STUN inside the namespace");
    return { address: "127.0.0.1", port, insideStunPackets: packets };
  } finally {
    socket.close();
  }
}
