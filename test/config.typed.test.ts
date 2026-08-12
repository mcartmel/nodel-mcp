import assert from "node:assert/strict";
import test from "node:test";
import { createTestConfig, loadConfig, redactedConfig, type AppConfig } from "../src/config.js";
import { completeTestConfig } from "./fixtures/config.js";

void test("typed test fixtures provide a complete AppConfig", () => {
  const config = completeTestConfig({ mcpPort: 9876 });
  assert.equal(config.mcpPort, 9876);
  assert.deepEqual(Object.keys(config).sort(), Object.keys(createTestConfig()).sort());
});

void test("redactedConfig reads a complete AppConfig and redacts token value", () => {
  const config: AppConfig = completeTestConfig({
    nodelBaseUrl: "http://example.local:8085",
    mcpPort: 9999,
    mcpBindAddress: "127.0.0.1",
    mcpToken: "secret-token",
    allowedNodePrefixes: ["Room"],
  });
  const redacted = redactedConfig(config);

  assert.equal(redacted.nodelBaseUrl, "http://example.local:8085");
  assert.equal(redacted.mcpPort, 9999);
  assert.equal(redacted.mcpTokenConfigured, true);
  assert.equal(Object.hasOwn(redacted, "mcpToken"), false);
  assert.deepEqual(redacted.allowedNodePrefixes, ["Room"]);
});

void test("loadConfig applies normalized defaults without import-time environment access", () => {
  const config = loadConfig({}, "/tmp/example");
  assert.equal(config.nodelBaseUrl, "http://127.0.0.1:8085");
  assert.equal(config.stateDir, "/tmp/example/.state");
  assert.equal(config.requestBodyLimitBytes, 1024 * 1024);
  assert.deepEqual(config.allowedOrigins, []);
  assert.deepEqual(config.allowedRuntimeOrigins, []);
});

void test("loadConfig parses origins, body size, and boolean aliases", () => {
  const config = loadConfig(
    {
      NODEL_BASE_URL: "https://nodel.example/base/",
      MCP_ALLOWED_ORIGINS: "https://client.example, http://localhost:3000/",
      NODEL_ALLOWED_RUNTIME_ORIGINS: "https://runtime.example",
      MCP_REQUEST_BODY_LIMIT_BYTES: "2097152",
      NODEL_ENABLE_WRITES: "yes",
    },
    "/tmp/example",
  );
  assert.equal(config.nodelBaseUrl, "https://nodel.example/base");
  assert.deepEqual(config.allowedOrigins, ["https://client.example", "http://localhost:3000"]);
  assert.deepEqual(config.allowedRuntimeOrigins, ["https://runtime.example"]);
  assert.equal(config.requestBodyLimitBytes, 2097152);
  assert.equal(config.writesEnabled, true);
});

void test("loadConfig validates safety gates and reports the dependency", () => {
  assert.throws(
    () => loadConfig({ NODEL_ENABLE_NODE_LIFECYCLE: "true" }),
    /NODEL_ENABLE_NODE_LIFECYCLE=true requires NODEL_ENABLE_WRITES=true/u,
  );
  assert.throws(
    () => loadConfig({ NODEL_ENABLE_DELETES: "true" }),
    /NODEL_ENABLE_DELETES=true requires NODEL_ENABLE_NODE_LIFECYCLE=true/u,
  );
});

void test("loadConfig requires a long token for non-loopback binds", () => {
  const validFixture = Array.from({ length: 32 }, (_, index) => String.fromCharCode(33 + index)).join("");
  assert.throws(() => loadConfig({ MCP_BIND_ADDRESS: "0.0.0.0" }), /NODEL_MCP_TOKEN is required/u);
  assert.throws(() => loadConfig({ MCP_BIND_ADDRESS: "0.0.0.0", NODEL_MCP_TOKEN: "short" }), /at least 32 characters/u);
  assert.throws(() => loadConfig({ MCP_BIND_ADDRESS: "0.0.0.0", NODEL_MCP_TOKEN: "a".repeat(32) }), /16 distinct/u);
  assert.equal(loadConfig({ MCP_BIND_ADDRESS: "0.0.0.0", NODEL_MCP_TOKEN: validFixture }).mcpBindAddress, "0.0.0.0");
  assert.equal(loadConfig({ MCP_BIND_ADDRESS: "::1" }).mcpToken, undefined);
});

void test("loadConfig rejects unsafe URLs and invalid origins", () => {
  assert.throws(() => loadConfig({ NODEL_BASE_URL: "ftp://nodel.example" }), /must use http or https/u);
  assert.throws(() => loadConfig({ NODEL_BASE_URL: "http://user:pass@nodel.example" }), /embedded credentials/u);
  assert.throws(() => loadConfig({ MCP_ALLOWED_ORIGINS: "https://client.example/path" }), /origin only/u);
});

void test("writes without approval produce a structured unsafe status", () => {
  const config = loadConfig({ NODEL_ENABLE_WRITES: "true", NODEL_REQUIRE_WRITE_APPROVAL: "false" });
  assert.equal(config.unsafeWriteMode, true);
  assert.equal(config.configWarnings[0]?.code, "UNSAFE_WRITE_MODE");
  assert.equal(redactedConfig(config).unsafeWriteMode, true);
  assert.match(JSON.stringify(redactedConfig(config)), /UNSAFE_WRITE_MODE/u);
  assert.doesNotMatch(JSON.stringify(redactedConfig(config)), /NODEL_MCP_TOKEN/u);
});
