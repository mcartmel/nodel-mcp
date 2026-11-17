import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readdir, readFile, readlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { sendFixtureFailure } from "../scripts/ui-browser-smoke-http.mjs";
import { supervise } from "../scripts/ui-browser-smoke.mjs";

const linux = process.platform === "linux";
const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/ui-browser-smoke.mjs", import.meta.url));
const browserOptIn = process.env.RUN_UI_BROWSER_TESTS === "1";
const browserOptions = { skip: !browserOptIn, timeout: 25_000 };

test(
  "browser supervisor accepts successful child without requiring browser or namespaces",
  { skip: !linux },
  async () => {
    const result = await supervise(process.execPath, ["-e", 'process.stdout.write("complete\\n")'], {
      timeoutMs: 3000,
    });
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout, "complete\n");
  },
);

test(
  "browser supervisor hard deadline kills its child group and bounds captured logs",
  { skip: !linux, timeout: 5000 },
  async () => {
    const start = performance.now();
    const result = await supervise(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { spawn } from 'node:child_process';
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stderr.write('DESCENDANT=' + descendant.pid + '\\n');
    process.stdout.write('x'.repeat(1024 * 1024));
    setInterval(() => {}, 1000);
  `,
      ],
      { timeoutMs: 500 },
    );
    assert.equal(result.timedOut, true);
    assert.equal(result.signal, "SIGKILL");
    assert.ok(performance.now() - start < 2500, "supervisor must not await cooperative cleanup");
    assert.equal(result.outputTruncated, true);
    assert.ok(Buffer.byteLength(result.stdout) <= 256 * 1024);
    const match = /DESCENDANT=(\d+)/.exec(result.stderr);
    assert.ok(match, "child must actually start a descendant");
    await assertNotRunning(Number(match[1]));
  },
);

test("browser worker refuses direct execution outside a private PID namespace", { skip: !linux }, async () => {
  const worker = fileURLToPath(new URL("../scripts/ui-browser-smoke-worker.mjs", import.meta.url));
  await assert.rejects(run(process.execPath, [worker, "{}"], { timeout: 3000 }), (error) => {
    const failure = /** @type {import("node:child_process").ExecFileException & {stderr: string}} */ (error);
    assert.match(failure.stderr, /worker must be PID namespace init/);
    return true;
  });
});

test("browser fixture request errors do not disclose exception details in HTTP responses", async () => {
  const server = createServer();
  const originalConsoleError = console.error;
  let loggedError;
  console.error = (...args) => {
    loggedError = args;
  };
  server.on("request", async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/trigger-error") throw new Error("secret /srv/private/fixture.js:42\nError: secret stack");
    } catch (error) {
      sendFixtureFailure(res, error);
    }
  });
  try {
    await new Promise((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined)));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/trigger-error`, {
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.equal(body, "fixture request failed");
    assert.doesNotMatch(body, /secret|\/srv\/private|Error/);
    assert.ok(loggedError, "fixture error should be logged server-side");
    assert.equal(loggedError[0], "UI smoke fixture request failed:");
    assert.match(String(loggedError[1]), /secret \/srv\/private\/fixture\.js:42/);
  } finally {
    console.error = originalConsoleError;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

// Explicit opt-in only: preinstalled Chromium/Playwright, explicit built runtime paths,
// and Linux namespace support are required. No downloads, no external services.
test(
  "isolated browser uses actual MCP starter and cannot send WebRTC UDP to host listener",
  browserOptions,
  async () => {
    requireBrowserPaths();
    const { stdout } = await run(process.execPath, [script], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const report = JSON.parse(stdout);
    assert.equal(report.result, "passed");
    assert.equal(report.mcpTool, "nodel.get_ui_guidelines");
    assert.equal(report.runtime.runtimeBuildRevision, "unverified");
    assert.equal(report.runtime.contractHashVerified, true);
    assert.equal(report.runtime.referenceSourceRevision, "b4f9f03dd40ac4670d48efa749ae8d5ad96c2980");
    assert.match(report.runtime.authenticity, /Not established/);
    assert.deepEqual(report.isolation.interfaces, ["lo"]);
    assert.ok(report.isolation.routes.every((route) => route.dev === "lo" && route.dst !== "default"));
    for (const kind of ["user", "net", "pid"]) {
      assert.notEqual(report.isolation.namespaces[kind], await readlink(`/proc/self/ns/${kind}`));
    }
    assert.ok(
      report.isolation.udpProbe.insideStunPackets > 0,
      "must actually emit WebRTC STUN, not merely disable WebRTC",
    );
    assert.equal(report.isolation.udpProbe.outsidePackets, 0);
    assert.equal(report.isolation.udpProbe.outsideListenerCalibrated, true);
    assert.ok(report.requests.some((item) => item.includes("REST/activity")));
    assert.equal(report.mockActions, 1);
    await assertNamespaceGone(report.isolation.namespaces.net);
  },
);

test(
  "parent hard deadline survives context.close that never resolves and kills all browser descendants",
  browserOptions,
  async () => {
    requireBrowserPaths();
    const start = performance.now();
    let stderr = "";
    await assert.rejects(
      run(process.execPath, [script, "--test-hang-context-close"], {
        env: { ...process.env, UI_SMOKE_TEST_MODE: "1", UI_SMOKE_TEST_TIMEOUT_MS: "7000" },
        timeout: 12_000,
        maxBuffer: 1024 * 1024,
      }),
      (error) => {
        const failure = /** @type {import("node:child_process").ExecFileException & {stderr: string}} */ (error);
        assert.equal(failure.code, 1, "parent must fail itself, not be killed by the test's outer timeout");
        assert.equal(failure.killed, false);
        assert.equal(failure.signal, null);
        stderr = failure.stderr;
        assert.match(
          stderr,
          /UI_SMOKE_TEST_CLOSE_HANG/,
          "must reach injected context.close hang after browser assertions",
        );
        assert.match(stderr, /hard deadline exceeded \(7000ms\)/);
        return true;
      },
    );
    assert.ok(performance.now() - start < 10_000, "hard deadline plus finite reap budget must bound total runtime");
    const match = /UI_SMOKE_ISOLATION (.+)/.exec(stderr);
    assert.ok(match, "must capture worker namespace before browser launch");
    const isolation = JSON.parse(match[1]);
    await assertNamespaceGone(isolation.namespaces.net);
  },
);

function requireBrowserPaths() {
  assert.equal(linux, true, "opt-in browser qualification requires Linux");
  assert.ok(process.env.UI_RUNTIME_DIST, "set UI_RUNTIME_DIST to explicit prebuilt dist/v2");
  assert.ok(process.env.UI_PLAYWRIGHT_MODULE, "set UI_PLAYWRIGHT_MODULE to explicit preinstalled module");
}

async function assertNotRunning(pid) {
  // A dead orphan may remain a zombie until the host's init reaps it; it cannot execute.
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    if (!status || /^State:\s+Z/m.test(status)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`test child ${pid} still running after supervisor termination`);
}

async function assertNamespaceGone(namespace) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const entries = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
    const active = await Promise.all(
      entries.map(async (pid) => {
        const net = await readlink(`/proc/${pid}/ns/net`).catch(() => null);
        return net === namespace ? pid : null;
      }),
    );
    if (active.every((pid) => pid === null)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`worker/browser processes still hold namespace ${namespace}`);
}
