import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CompatibilityToolError, safeLogMessage } from "../scripts/nodel-compatibility-smoke-helpers.mjs";
import {
  parseMcpResponseBody,
  parseSseDataEnvelope,
  parseToolResultEnvelope,
} from "../scripts/nodel-compatibility-smoke-helpers.mjs";
import {
  assertCompatibleServer,
  assertRequiredTools,
  createCompatibilityRunner,
  isRetryablePollError,
} from "../scripts/nodel-compatibility-smoke.mjs";

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

const projectRoot = new URL("..", import.meta.url).pathname;
const supervisorPath = new URL("../scripts/nodel-compatibility-supervisor.sh", import.meta.url).pathname;
const sanitizerPath = new URL("../scripts/sanitize-compatibility-logs.mjs", import.meta.url).pathname;

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForFile = async (path) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await lstat(path);
      return;
    } catch {
      await sleep(20);
    }
  }
  throw new Error("test fixture did not create expected process metadata");
};

const waitForExit = (child) =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

const assertNotLive = async (pid) => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    assert.equal(/\)\s+Z\s/u.test(stat), true);
  } catch (error) {
    assert.equal(error.code, "ENOENT");
  }
};

const allocatePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("test port allocation did not return a TCP address"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

test("parseMcpResponseBody parses JSON payloads", () => {
  assert.deepEqual(parseMcpResponseBody('{"hello":"world"}'), { hello: "world" });
});

test("parseMcpResponseBody parses SSE data envelopes", () => {
  const envelope = parseMcpResponseBody(
    [": heartbeat", "event: message", 'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}', ""].join("\n"),
  );
  assert.deepEqual(envelope, { jsonrpc: "2.0", id: 1, result: { ok: true } });
});

test("parseSseDataEnvelope extracts the final JSON event", () => {
  const envelope = parseSseDataEnvelope(["event: message", 'data: {"step":1}', "", 'data: {"final":true}'].join("\n"));
  assert.deepEqual(envelope, { step: 1 });
});

test("parseToolResultEnvelope parses tool content text", () => {
  const payload = parseToolResultEnvelope({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify({ ok: true, operation: "ping" }) }] },
  });
  assert.deepEqual(payload, { ok: true, operation: "ping" });
});

test("parseToolResultEnvelope surfaces MCP JSON-RPC errors as stable codes", async () => {
  let error;
  try {
    parseToolResultEnvelope({
      jsonrpc: "2.0",
      id: 1,
      error: { code: "MCP_ERROR" },
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.equal(error.message, "MCP_ERROR");
  assert.equal(error.code, "MCP_ERROR");
});

test("parseToolResultEnvelope rejects public payload ok:false with stable error code only", () => {
  let error;
  try {
    parseToolResultEnvelope({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: { code: "VALIDATION", message: "Invalid tool request", details: "user-supplied payload" },
            }),
          },
        ],
      },
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.equal(error.code, "VALIDATION");
  assert.equal(error.message, "VALIDATION");
});

test("callTool unwraps a full JSON-RPC tool envelope payload", async () => {
  const runner = createCompatibilityRunner({
    fetchImpl: async (_url, options) => {
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({ ok: true, payload: "pong" }) }] },
      });
    },
  });

  const payload = await runner.callTool("nodel.ping", { input: 1 });
  assert.deepEqual(payload, { ok: true, payload: "pong" });
});

test("tools/list result is validated and passed through assertRequiredTools", () => {
  const valid = {
    tools: [
      { name: "nodel.list_local_nodes" },
      { name: "nodel.create_node" },
      { name: "nodel.set_node_parameter" },
      { name: "nodel.get_node_parameters" },
      { name: "nodel.verify_node_ready" },
      { name: "nodel.delete_node" },
    ],
  };
  assert.doesNotThrow(() => assertRequiredTools(valid));

  let missingError;
  try {
    assertRequiredTools({
      tools: [{ name: "nodel.list_local_nodes" }, { name: "nodel.create_node" }],
    });
  } catch (caught) {
    missingError = caught;
  }

  assert.ok(missingError);
  assert.equal(missingError.code, "MCP_TOOLS_LIST_MISSING");
});

test("version mismatch in initialize envelope fails with stable code", () => {
  let mismatch;
  try {
    assertCompatibleServer(
      {
        serverInfo: {
          name: "nodel-ai",
          version: "0.0.0",
        },
      },
      {
        name: "nodel-ai",
        version: "0.1.0",
      },
    );
  } catch (caught) {
    mismatch = caught;
  }

  assert.ok(mismatch);
  assert.equal(mismatch.code, "INITIALIZE_VERSION_MISMATCH");
});

test("waitFor tolerates transient tool errors then succeeds", async () => {
  let attempts = 0;
  const runner = createCompatibilityRunner({
    pollTimeoutMs: 200,
    pollIntervalMs: 5,
    fetchImpl: async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
  });

  const result = await runner.waitFor(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new CompatibilityToolError("MCP_TOOL_FAILURE");
      }

      return true;
    },
    200,
    5,
  );

  assert.equal(result, true);
  assert.equal(attempts, 3);
});

test("waitFor does not retry non-retriable errors", async () => {
  const runner = createCompatibilityRunner({
    pollTimeoutMs: 120,
    pollIntervalMs: 5,
    fetchImpl: async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
  });

  let error;
  try {
    await runner.waitFor(
      () => {
        throw new CompatibilityToolError("UNRETRYABLE");
      },
      120,
      5,
      () => false,
    );
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof CompatibilityToolError);
  assert.equal(error.code, "UNRETRYABLE");
});

test("isRetryablePollError returns true for transient stable tool errors", () => {
  const transient = new CompatibilityToolError("MCP_TOOL_FAILURE");
  const hard = new CompatibilityToolError("UNRECOVERABLE");
  assert.equal(isRetryablePollError(transient), true);
  assert.equal(isRetryablePollError(hard), false);
});

test("safeLogMessage redacts credentials before truncation", () => {
  const logged = safeLogMessage(
    'Authorization=Bearer topsecret-token token="x-api-key" password: supersecret secret: shhh api_key=myapikey key=12345 https://user:pass@host/path',
    4_000,
  );

  assert.equal(logged.includes("topsecret-token"), false);
  assert.equal(logged.includes("x-api-key"), false);
  assert.equal(logged.includes("supersecret"), false);
  assert.equal(logged.includes("shhh"), false);
  assert.equal(logged.includes("myapikey"), false);
  assert.equal(logged.includes("12345"), false);
  assert.equal(logged.includes("https://user:pass@"), false);
});

test("safeLogMessage redaction still truncates", () => {
  const logged = safeLogMessage("token=" + "a".repeat(2000), 50);
  assert.equal(logged.length <= 50, true);
  assert.equal(logged.includes("a".repeat(1000)), false);
});

test("compatibility supervisor keeps FIFO stdin open and cleans up owned processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodel-compat-supervisor-"));
  const nodelPort = await allocatePort();
  const sidecarPort = await allocatePort();
  const nodelServer = join(root, "nodel-server.mjs");
  const sidecarServer = join(root, "sidecar-server.mjs");
  const fakeJava = join(root, "fake-java.sh");
  const fakeNode = join(root, "fake-node.sh");
  const stdinResult = join(root, "stdin-result");
  const childPidPath = join(root, "sidecar-child.pid");

  try {
    await writeFile(
      nodelServer,
      'import http from "node:http"; http.createServer((_, res) => res.end("ok")).listen(Number(process.argv[2]), "127.0.0.1");\n',
    );
    await writeFile(
      sidecarServer,
      'import http from "node:http"; http.createServer((_, res) => res.end("ok")).listen(Number(process.argv[2]), "127.0.0.1");\n',
    );
    await writeFile(
      fakeJava,
      `#!/usr/bin/env bash
test -z "\${NODEL_MCP_TOKEN+x}" || exit 92
read -r -t 1 ignored
status=$?
test "$status" -eq 142 || exit 91
printf 'open\\n' > "$COMPAT_TEST_STDIN_RESULT"
exec "$COMPAT_TEST_NODE_BINARY" "$COMPAT_TEST_NODEL_SERVER" "$4"
`,
    );
    await writeFile(
      fakeNode,
      `#!/usr/bin/env bash
test -z "\${NODEL_MCP_TOKEN+x}" || exit 93
sleep 60 &
printf '%s\\n' "$!" > "$COMPAT_TEST_CHILD_PID"
exec "$COMPAT_TEST_NODE_BINARY" "$COMPAT_TEST_SIDECAR_SERVER" "$MCP_PORT"
`,
    );
    await chmod(fakeJava, 0o755);
    await chmod(fakeNode, 0o755);

    const environment = {
      ...process.env,
      NODEL_COMPAT_DIR: root,
      NODEL_COMPAT_JAR: join(root, "nodel.jar"),
      NODEL_COMPAT_JAVA: fakeJava,
      NODEL_COMPAT_NODE: fakeNode,
      NODEL_COMPAT_NODEL_PORT: String(nodelPort),
      NODEL_COMPAT_SIDECAR_PORT: String(sidecarPort),
      NODEL_COMPAT_SIDECAR_ENTRY: "ignored",
      NODEL_MCP_TOKEN: "inherited-token-must-not-protect-loopback-readiness",
      COMPAT_TEST_NODE_BINARY: process.execPath,
      COMPAT_TEST_NODEL_SERVER: nodelServer,
      COMPAT_TEST_SIDECAR_SERVER: sidecarServer,
      COMPAT_TEST_STDIN_RESULT: stdinResult,
      COMPAT_TEST_CHILD_PID: childPidPath,
    };
    const started = await run("bash", [supervisorPath, "start"], { cwd: projectRoot, env: environment });
    assert.equal(started.code, 0, started.output);
    assert.equal((await lstat(join(root, "nodel.stdin"))).isFIFO(), true);
    assert.equal(await readFile(stdinResult, "utf8"), "open\n");
    const nodelPid = Number((await readFile(join(root, "nodel.pid"), "utf8")).split(" ")[0]);
    const sidecarPid = Number((await readFile(join(root, "sidecar.pid"), "utf8")).split(" ")[0]);
    const holderPid = Number((await readFile(join(root, "fifo-holder.pid"), "utf8")).split(" ")[0]);
    const sidecarChildPid = Number(await readFile(childPidPath, "utf8"));
    assert.equal(Number.isInteger(nodelPid), true);
    assert.equal(Number.isInteger(sidecarPid), true);
    assert.equal(Number.isInteger(holderPid), true);
    assert.equal(Number.isInteger(sidecarChildPid), true);

    const stopped = await run("bash", [supervisorPath, "cleanup"], { cwd: projectRoot, env: environment });
    assert.equal(stopped.code, 0, stopped.output);
    await assertNotLive(nodelPid);
    await assertNotLive(sidecarPid);
    await assertNotLive(holderPid);
    await assertNotLive(sidecarChildPid);
    const statuses = (await readFile(join(root, "startup-status.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      statuses.some((status) => status.component === "nodel" && status.outcome === "ready"),
      true,
    );
    assert.equal(
      statuses.some((status) => status.component === "sidecar" && status.phase === "cleanup"),
      true,
    );
  } finally {
    await run("bash", [supervisorPath, "cleanup"], {
      cwd: projectRoot,
      env: { ...process.env, NODEL_COMPAT_DIR: root, NODEL_COMPAT_JAR: join(root, "nodel.jar") },
    });
    await rm(root, { recursive: true, force: true });
  }
});

test("compatibility cleanup rejects stale process-group metadata without signaling another session", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodel-compat-stale-metadata-"));
  const unrelated = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  try {
    await writeFile(join(root, "startup-status.jsonl"), "");
    await writeFile(join(root, "nodel.pid"), `${unrelated.pid} ${unrelated.pid} 0\n`);
    await writeFile(join(root, "sidecar.pid"), "malformed process metadata\n");
    const result = await run("bash", [supervisorPath, "cleanup"], {
      cwd: projectRoot,
      env: { ...process.env, NODEL_COMPAT_DIR: root, NODEL_COMPAT_JAR: join(root, "nodel.jar") },
    });
    assert.notEqual(result.code, 0);
    await lstat(`/proc/${unrelated.pid}`);
    const status = await readFile(join(root, "startup-status.jsonl"), "utf8");
    assert.equal(status.includes('"exitClassification":"cleanup_failed"'), true);
  } finally {
    process.kill(-unrelated.pid, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("compatibility supervisor cleans up process groups on TERM and preserves signal status", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodel-compat-signal-"));
  const fakeJava = join(root, "fake-java.sh");
  try {
    await writeFile(
      fakeJava,
      `#!/usr/bin/env bash
test -z "\${NODEL_MCP_TOKEN+x}" || exit 92
sleep 60 &
printf '%s\\n' "$!" > "$COMPAT_TEST_CHILD_PID"
exec sleep 60
`,
    );
    await chmod(fakeJava, 0o755);
    const environment = {
      ...process.env,
      NODEL_COMPAT_DIR: root,
      NODEL_COMPAT_JAR: join(root, "nodel.jar"),
      NODEL_COMPAT_JAVA: fakeJava,
      NODEL_COMPAT_NODEL_PORT: String(await allocatePort()),
      NODEL_MCP_TOKEN: "inherited-token-must-not-reach-java",
      COMPAT_TEST_CHILD_PID: join(root, "nodel-child.pid"),
    };
    const child = spawn("bash", [supervisorPath, "start"], { cwd: projectRoot, env: environment, stdio: "pipe" });
    await waitForFile(join(root, "nodel.pid"));
    const nodelPid = Number((await readFile(join(root, "nodel.pid"), "utf8")).split(" ")[0]);
    await waitForFile(join(root, "nodel-child.pid"));
    const descendantPid = Number(await readFile(join(root, "nodel-child.pid"), "utf8"));
    child.kill("SIGTERM");
    const exited = await waitForExit(child);
    assert.equal(exited.code, 143);
    await assertNotLive(nodelPid);
    await assertNotLive(descendantPid);
  } finally {
    await run("bash", [supervisorPath, "cleanup"], {
      cwd: projectRoot,
      env: { ...process.env, NODEL_COMPAT_DIR: root, NODEL_COMPAT_JAR: join(root, "nodel.jar") },
    });
    await rm(root, { recursive: true, force: true });
  }
});

test("compatibility cleanup kills trusted descendants after the session leader exits on TERM", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodel-compat-leader-exit-"));
  const nodelPort = await allocatePort();
  const sidecarPort = await allocatePort();
  const nodelServer = join(root, "nodel-server.mjs");
  const sidecarServer = join(root, "sidecar-server.mjs");
  const fakeJava = join(root, "fake-java.sh");
  const fakeNode = join(root, "fake-node.sh");
  const childPidPath = join(root, "term-ignoring-child.pid");
  try {
    await writeFile(
      nodelServer,
      'import http from "node:http"; http.createServer((_, res) => res.end("ok")).listen(Number(process.argv[2]), "127.0.0.1");\n',
    );
    await writeFile(
      sidecarServer,
      'import http from "node:http"; http.createServer((_, res) => res.end("ok")).listen(Number(process.argv[2]), "127.0.0.1");\n',
    );
    await writeFile(
      fakeJava,
      `#!/usr/bin/env bash
exec "$COMPAT_TEST_NODE_BINARY" "$COMPAT_TEST_NODEL_SERVER" "$4"
`,
    );
    await writeFile(
      fakeNode,
      `#!/usr/bin/env bash
trap 'exit 0' TERM
"$COMPAT_TEST_NODE_BINARY" "$COMPAT_TEST_SIDECAR_SERVER" "$MCP_PORT" &
server=$!
sh -c 'trap "" TERM; printf "%s\\n" "$$" > "$1"; exec sleep 60' sh "$COMPAT_TEST_CHILD_PID" &
wait "$server"
`,
    );
    await chmod(fakeJava, 0o755);
    await chmod(fakeNode, 0o755);
    const environment = {
      ...process.env,
      NODEL_COMPAT_DIR: root,
      NODEL_COMPAT_JAR: join(root, "nodel.jar"),
      NODEL_COMPAT_JAVA: fakeJava,
      NODEL_COMPAT_NODE: fakeNode,
      NODEL_COMPAT_NODEL_PORT: String(nodelPort),
      NODEL_COMPAT_SIDECAR_PORT: String(sidecarPort),
      NODEL_COMPAT_SIDECAR_ENTRY: "ignored",
      COMPAT_TEST_NODE_BINARY: process.execPath,
      COMPAT_TEST_NODEL_SERVER: nodelServer,
      COMPAT_TEST_SIDECAR_SERVER: sidecarServer,
      COMPAT_TEST_CHILD_PID: childPidPath,
    };
    const started = await run("bash", [supervisorPath, "start"], { cwd: projectRoot, env: environment });
    assert.equal(started.code, 0, started.output);
    const sidecarPid = Number((await readFile(join(root, "sidecar.pid"), "utf8")).split(" ")[0]);
    await waitForFile(childPidPath);
    const descendantPid = Number(await readFile(childPidPath, "utf8"));
    const stopped = await run("bash", [supervisorPath, "cleanup"], { cwd: projectRoot, env: environment });
    assert.equal(stopped.code, 0, stopped.output);
    await assertNotLive(sidecarPid);
    await assertNotLive(descendantPid);
  } finally {
    await run("bash", [supervisorPath, "cleanup"], {
      cwd: projectRoot,
      env: { ...process.env, NODEL_COMPAT_DIR: root, NODEL_COMPAT_JAR: join(root, "nodel.jar") },
    });
    await rm(root, { recursive: true, force: true });
  }
});

test("compatibility sanitizer uploads only allowlisted startup status fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodel-compat-sanitizer-"));
  const destination = join(root, "sanitized");
  try {
    /** @type {Record<string, unknown>} */
    let deeplyNested = { password: "deep-secret" };
    for (let depth = 0; depth < 12; depth += 1) deeplyNested = { nested: deeplyNested };
    await writeFile(
      join(root, "startup-status.jsonl"),
      [
        '{"component":"nodel","phase":"readiness","outcome":"failed","exitClassification":"exited"}',
        '{"component":"nodel","phase":"readiness","outcome":"failed","exitClassification":"/private/raw exception"}',
        "x".repeat(1024 * 1024),
      ].join("\n"),
    );
    await writeFile(
      join(root, "sidecar.log"),
      JSON.stringify({
        level: "error",
        message: JSON.stringify({
          nested: { accessToken: 'json "escaped quote" secret', password: 'nested "quote" secret' },
          deeplyNested,
          plain: 'token=outer-plain-secret "token":"json-secret" "password": "quoted-secret" Bearer bearer-secret',
        }),
      }) + "\n",
    );
    const sanitized = await run(process.execPath, [sanitizerPath, root, destination], { cwd: projectRoot });
    assert.equal(sanitized.code, 0, sanitized.output);
    assert.equal(
      await readFile(join(destination, "startup-status.jsonl"), "utf8"),
      '{"component":"nodel","phase":"readiness","outcome":"failed","exitClassification":"exited"}\n',
    );
    const sidecar = await readFile(join(destination, "sidecar-sanitized.jsonl"), "utf8");
    assert.equal(sidecar.includes("outer-plain-secret"), false);
    assert.equal(sidecar.includes("json-secret"), false);
    assert.equal(sidecar.includes("quoted-secret"), false);
    assert.equal(sidecar.includes("bearer-secret"), false);
    assert.equal(sidecar.includes("escaped quote"), false);
    assert.equal(sidecar.includes("deep-secret"), false);
    assert.equal(sidecar.includes("[withheld]"), true);
    assert.equal(sidecar.includes("nested"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
