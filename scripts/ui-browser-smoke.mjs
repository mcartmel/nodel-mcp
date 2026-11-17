#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { constants } from "node:fs";
import { access, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// No download/install or unsafe fallback. Fixture, MCP tool call and Chromium all run
// inside private Linux namespaces; this parent never imports the browser/runtime module.
const WALL_TIMEOUT_MS = 90_000;
const MAX_LOG_BYTES = 256 * 1024;
const REAP_TIMEOUT_MS = 1000;
const LOG_DRAIN_MS = 100;

/** Run one detached process group with an independent hard deadline, including cleanup.
 * For the namespace launcher, --kill-child=SIGKILL kills PID 1 on launcher death;
 * the kernel then kills ALL PID-namespace descendants, even new process groups.
 * The deadline callback never awaits cooperative child/browser cleanup.
 */
export function supervise(command, args, { timeoutMs = WALL_TIMEOUT_MS, env = process.env } = {}) {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= WALL_TIMEOUT_MS);
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputTruncated = false;
    let finished = false;
    let childExited = false;
    let killSent = false;
    let timedOut = false;
    let interrupted;
    let reapTimer;
    let drainTimer;
    const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
    const capture = (previous, data) => {
      const combined = Buffer.concat([previous, data]);
      if (combined.length <= MAX_LOG_BYTES) return combined;
      outputTruncated = true;
      return combined.subarray(combined.length - MAX_LOG_BYTES);
    };
    child.stdout.on("data", (data) => {
      stdout = capture(stdout, data);
    });
    child.stderr.on("data", (data) => {
      stderr = capture(stderr, data);
    });
    const killGroup = () => {
      // Never signal a reaped leader's numeric PID/group: it could have been reused.
      // Normal namespace-launcher exit already kills its PID-namespace descendants.
      if (!child.pid || childExited || killSent) return;
      killSent = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") stderr = capture(stderr, Buffer.from(`group kill failed: ${error.message}\n`));
      }
    };
    const finish = (code, signal, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(reapTimer);
      clearTimeout(drainTimer);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
      // Never wait indefinitely for 'close': inherited pipes cannot extend the deadline.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve({
        code,
        signal,
        error: error?.message,
        timedOut,
        interrupted,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        outputTruncated,
      });
    };
    const terminate = () => {
      killGroup();
      // A finite reap budget even if a child is stuck in an uninterruptible kernel wait.
      reapTimer ??= setTimeout(
        () => finish(null, "SIGKILL", new Error("child did not reap within cleanup budget")),
        REAP_TIMEOUT_MS,
      );
    };
    const onInterrupt = (signal) => {
      interrupted = signal;
      terminate();
    };
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onInterrupt);
    const deadline = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.once("error", (error) => finish(null, null, error));
    child.once("exit", (code, signal) => {
      childExited = true;
      // 'exit' can precede the last stdout data. Give it a bounded drain interval,
      // with the hard deadline STILL active, rather than truncating a valid report.
      drainTimer = setTimeout(() => finish(code, signal), LOG_DRAIN_MS);
      child.once("close", () => finish(code, signal));
    });
  });
}

async function executable(candidates, label) {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try next explicit system path */
    }
  }
  throw new Error(`unsupported qualification: required ${label} executable not found (no unsafe fallback)`);
}

async function qualify(options) {
  if (process.platform !== "linux")
    throw new Error("unsupported qualification: Linux user/network/PID namespaces required");
  const unshare = await executable(["/usr/bin/unshare", "/bin/unshare"], "unshare");
  const ipTool = await executable(["/usr/bin/ip", "/usr/sbin/ip", "/sbin/ip", "/bin/ip"], "ip");
  const parentNamespaces = {};
  for (const kind of ["user", "net", "pid"]) parentNamespaces[kind] = await readlink(`/proc/self/ns/${kind}`);
  const probe = createSocket("udp4");
  let outsidePackets = 0;
  probe.on("message", () => {
    outsidePackets += 1;
  });
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.bind(0, "127.0.0.1", () => resolve(undefined));
    });
    const udpProbePort = probe.address().port;
    // Calibrate the outside listener locally, then count every packet for the worker lifetime.
    const sender = createSocket("udp4");
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("UDP listener calibration timed out")), 1000);
        probe.once("message", () => {
          clearTimeout(timer);
          resolve();
        });
        sender.send(Buffer.from("local-listener-calibration"), udpProbePort, "127.0.0.1", (error) => {
          if (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
      });
    } finally {
      sender.close();
    }
    outsidePackets = 0;
    const config = {
      ...options,
      runtimeDist: await realpath(options.runtimeDist),
      playwrightModule: await realpath(options.playwrightModule),
      ipTool,
      parentNamespaces,
      udpProbePort,
    };
    const worker = fileURLToPath(new URL("./ui-browser-smoke-worker.mjs", import.meta.url));
    const result = await supervise(
      unshare,
      [
        "--user",
        "--map-root-user",
        "--net",
        "--pid",
        "--fork",
        "--mount-proc",
        "--kill-child=SIGKILL",
        process.execPath,
        worker,
        JSON.stringify(config),
      ],
      { timeoutMs: options.timeoutMs },
    );
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.outputTruncated) console.error("Worker output truncated to bounded log tails.");
    if (result.timedOut)
      throw new Error(
        `Browser smoke hard deadline exceeded (${options.timeoutMs}ms); namespace process group SIGKILL sent; no cooperative cleanup awaited.`,
      );
    if (result.interrupted)
      throw new Error(`Browser smoke interrupted (${result.interrupted}); namespace process group killed.`);
    if (result.code !== 0)
      throw new Error(
        `${result.stderr.includes("UI_SMOKE_ISOLATION") ? "Browser qualification failed" : "unsupported qualification: required namespace isolation could not start/verify (no unsafe fallback)"}: ${result.error ?? result.signal ?? result.code}`,
      );
    assert.equal(outsidePackets, 0, "WebRTC/worker UDP escaped to outside namespace listener");
    assert.equal(result.outputTruncated, false, "qualification report exceeded output bound");
    const report = JSON.parse(result.stdout);
    report.isolation.udpProbe.outsidePackets = outsidePackets;
    report.isolation.udpProbe.outsideListenerCalibrated = true;
    report.supervisor = {
      deadlineMs: options.timeoutMs,
      cleanup: "PID namespace init exit kills all descendants; parent deadline active through cleanup",
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    // No unbounded promise is awaited in parent cleanup.
    probe.close();
  }
}

function parseArgs(values) {
  const out = {
    runtimeDist: process.env.UI_RUNTIME_DIST,
    playwrightModule: process.env.UI_PLAYWRIGHT_MODULE,
    timeoutMs: WALL_TIMEOUT_MS,
    testHangContextClose: false,
  };
  for (let i = 0; i < values.length; i++) {
    const key = values[i];
    if (key === "--runtime-dist") out.runtimeDist = values[++i];
    else if (key === "--playwright-module") out.playwrightModule = values[++i];
    else if (key === "--test-hang-context-close" && process.env.UI_SMOKE_TEST_MODE === "1")
      out.testHangContextClose = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!out.runtimeDist) throw new Error("pass --runtime-dist or set UI_RUNTIME_DIST");
  if (!out.playwrightModule) throw new Error("pass --playwright-module or set UI_PLAYWRIGHT_MODULE");
  if (process.env.UI_SMOKE_TEST_MODE === "1" && process.env.UI_SMOKE_TEST_TIMEOUT_MS) {
    out.timeoutMs = Number(process.env.UI_SMOKE_TEST_TIMEOUT_MS);
    assert.ok(
      Number.isInteger(out.timeoutMs) && out.timeoutMs >= 1000 && out.timeoutMs <= WALL_TIMEOUT_MS,
      "test timeout must be 1000..90000ms (cannot extend deadline)",
    );
  }
  return out;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    await qualify(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
