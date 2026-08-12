import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithTimeout } from "../dist/nodel/client.js";
import { decodeBase64Strict, sha256 } from "../dist/mcp/tools/common.js";
import { actionRequest } from "../dist/mcp/tools/nodeWrites.js";

test("actionRequest omits body and serializes primitive GET args", () => {
  const request = actionRequest("Set Input", "GET", "HDMI 1");

  assert.equal(request.method, "GET");
  assert.equal(request.body, undefined);
  assert.equal(request.restPath, "actions/Set%20Input/call?arg=HDMI+1");
});

test("actionRequest rejects non-primitive GET arg", () => {
  assert.throws(() => actionRequest("Play", "GET", ["x"]), /primitive arg value/u);
  assert.throws(() => actionRequest("Play", "GET", { value: "x" }), /primitive arg value/u);
});

test("actionRequest keeps POST body behavior", () => {
  const args = { value: "x" };
  const request = actionRequest("Play", "POST", args);

  assert.equal(request.method, "POST");
  assert.equal(request.restPath, "actions/Play/call");
  assert.deepEqual(request.body, { arg: args });
});

test("fetchWithTimeout aborts stalled requests", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });

    await assert.rejects(
      () => fetchWithTimeout("http://127.0.0.1:8085/REST", {}, 1, "Nodel request"),
      /timed out after 1ms/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decodeBase64Strict accepts valid base64 and hashes bytes", () => {
  const bytes = decodeBase64Strict("AAECAw==");

  assert.deepEqual([...bytes], [0, 1, 2, 3]);
  assert.equal(sha256(bytes), "054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8");
  assert.equal(decodeBase64Strict("").byteLength, 0);
});

test("decodeBase64Strict rejects malformed base64", () => {
  assert.throws(() => decodeBase64Strict("not base64"), /valid standard base64/u);
  assert.throws(() => decodeBase64Strict("abcd="), /valid standard base64/u);
});
