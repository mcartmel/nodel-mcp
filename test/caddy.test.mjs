import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { checkServerIdentity } from "node:tls";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CADDY_ASSET,
  CADDY_CHECKSUM_URL,
  CADDY_DOWNLOAD_URL,
  CADDY_SHA512,
  CADDY_VERSION,
  appendEnvironment,
  environmentLines,
  fetchBytes,
  parseFetcherArgs,
  validateArchiveMembers,
  validateOutputPath,
} from "../scripts/fetch-caddy-validation.mjs";
import {
  classifyListeners,
  diagnose,
  inspectCaddyfile,
  validateComposedConfig,
  parseCheckCliArgs,
  validateWithCaddy,
} from "../scripts/caddy-check.mjs";
import {
  formatCaddyBytes,
  parseBodyLimitBytes,
  parseCliArgs,
  parseUpstream,
  renderCaddyfile,
  writeRenderedOutput,
} from "../scripts/caddy-render.mjs";
import { isForbiddenCaddyReleaseMember } from "../scripts/caddy-release-safety.mjs";

const template = await readFile(
  fileURLToPath(new URL("../deploy/caddy/nodel-mcp.Caddyfile.in", import.meta.url)),
  "utf8",
);
const options = { hostname: "lan.example", bindAddress: "198.51.100.5", allowCidrs: ["198.51.100.0/24", "fd00::/8"] };
const MAX_CADDY_LOCAL_ROOT_BYTES = 1024 * 1024;

test("test sources never disable TLS certificate verification", async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const sources = await Promise.all(
    (await readdir(testDirectory, { recursive: true }))
      .filter((entry) => /\.test\.(?:mjs|ts)$/u.test(entry))
      .map((entry) => readFile(join(testDirectory, entry), "utf8")),
  );
  const disabledCertificateVerification = ["rejectUnauthorized", "\\s*:", "\\s*", "false"].join("");
  const globalTlsBypass = ["NODE_TLS", "_REJECT", "_UNAUTHORIZED"].join("");
  for (const source of sources) {
    assert.doesNotMatch(source, new RegExp(disabledCertificateVerification, "u"));
    assert.doesNotMatch(source, new RegExp(globalTlsBypass, "u"));
  }
});

test("generated Caddyfile detection remains linear for long adversarial basenames", () => {
  const longSuffix = ".artifact".repeat(50_000);
  assert.equal(isForbiddenCaddyReleaseMember(`caddyfile${longSuffix}`), true);
  assert.equal(isForbiddenCaddyReleaseMember(`caddyfile${longSuffix}.`), true);
  assert.equal(isForbiddenCaddyReleaseMember("caddyfile."), false);
  assert.equal(isForbiddenCaddyReleaseMember("caddyfile.."), true);
  assert.equal(isForbiddenCaddyReleaseMember("generated.caddy"), true);
  assert.equal(isForbiddenCaddyReleaseMember(".caddy"), false);
  assert.equal(isForbiddenCaddyReleaseMember(`not-caddyfile${longSuffix}`), false);
});

test("Caddy local root reader rejects unsafe certificate files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nodel-caddy-root-"));
  const rootCertificate = caddyLocalRootPath(directory);
  const parent = dirname(rootCertificate);
  const expectedFailure = /Caddy local root certificate is unavailable/u;
  try {
    await mkdir(parent, { recursive: true });

    const target = join(directory, "root-target.crt");
    await writeFile(target, "certificate");
    await symlink(target, rootCertificate);
    await assert.rejects(() => readCaddyLocalRoot(rootCertificate), expectedFailure);

    await rm(rootCertificate);
    if (process.platform !== "win32") {
      assert.equal(spawnSync("mkfifo", [rootCertificate]).status, 0);
      await assert.rejects(() => readCaddyLocalRoot(rootCertificate), expectedFailure);
      await rm(rootCertificate);
    }

    await mkdir(rootCertificate);
    await assert.rejects(() => readCaddyLocalRoot(rootCertificate), expectedFailure);

    await rm(rootCertificate, { recursive: true });
    await writeFile(rootCertificate, "");
    await assert.rejects(() => readCaddyLocalRoot(rootCertificate), expectedFailure);

    await rm(rootCertificate);
    await writeFile(rootCertificate, Buffer.alloc(MAX_CADDY_LOCAL_ROOT_BYTES + 1));
    await assert.rejects(() => readCaddyLocalRoot(rootCertificate), expectedFailure);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("renderer supports IPv4, IPv6, repeated CIDRs, and deterministic bytes", () => {
  const output = renderCaddyfile(template.replaceAll("\n", "\r\n"), {
    ...options,
    bindAddress: "::1",
    bodyLimitBytes: 2_097_152,
  });
  assert.match(output, /https:\/\/lan\.example/);
  assert.match(output, /bind ::1/);
  assert.match(output, /remote_ip 198\.51\.100\.0\/24 fd00::\/8/);
  assert.match(output, /max_size 2MiB/);
  assert.doesNotMatch(output, /\r/);
  assert.equal(formatCaddyBytes(1024), "1KiB");
});

test("CLI accepts only exact flags and repeatable allow CIDRs", () => {
  assert.deepEqual(
    parseCliArgs([
      "--hostname",
      "x.example",
      "--bind-address",
      "::1",
      "--allow-cidr",
      "203.0.113.0/24",
      "--allow-cidr",
      "fd00::/8",
      "--body-limit-bytes",
      "1048576",
    ]),
    {
      hostname: "x.example",
      bindAddress: "::1",
      allowCidrs: ["203.0.113.0/24", "fd00::/8"],
      bodyLimitBytes: "1048576",
    },
  );
  for (const args of [
    ["--cidr", "203.0.113.0/24"],
    ["--hostname"],
    ["--hostname", "a", "--hostname", "b"],
    ["--hostname", "--bind-address", "::1"],
  ])
    assert.throws(() => parseCliArgs(args));
  assert.throws(() => parseBodyLimitBytes("1023"));
  assert.throws(() => parseBodyLimitBytes("52428801"));
  assert.throws(() => parseBodyLimitBytes(String(Number.MAX_SAFE_INTEGER + 1)));
});

test("caddy-check rejects duplicate flags", () => {
  assert.throws(() => parseCheckCliArgs(["--config", "one", "--config", "two"]), /Duplicate argument/);
  assert.throws(() => parseCheckCliArgs(["--live", "http://one", "--live", "http://two"]), /Duplicate argument/);
});

test("Caddy downloader constants and redirect policy are pinned and bounded", async () => {
  assert.equal(CADDY_VERSION, "2.11.3");
  assert.match(CADDY_ASSET, /linux_amd64\.tar\.gz$/u);
  assert.equal(CADDY_SHA512.length, 128);
  assert.match(CADDY_DOWNLOAD_URL, /https:\/\/github\.com\/caddyserver\/caddy\/releases\/download/u);
  assert.match(CADDY_CHECKSUM_URL, /checksums\.txt$/u);
  const calls = [];
  const response = (status, location, body = "payload") => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name === "location" ? location : null) },
    arrayBuffer: async () => Buffer.from(body),
  });
  const fetched = await fetchBytes("https://github.com/caddyserver/caddy/release", async (url) => {
    calls.push(String(url));
    return calls.length === 1 ? response(302, "https://release-assets.githubusercontent.com/asset") : response(200);
  });
  assert.equal(fetched.toString(), "payload");
  assert.deepEqual(calls, [
    "https://github.com/caddyserver/caddy/release",
    "https://release-assets.githubusercontent.com/asset",
  ]);
  await assert.rejects(
    () =>
      fetchBytes("https://github.com/caddyserver/caddy/release", async () =>
        response(302, "https://evil.example/file"),
      ),
    /trusted GitHub release host/u,
  );
  await assert.rejects(
    () =>
      fetchBytes(
        "https://github.com/caddyserver/caddy/release",
        async () => response(302, "https://github.com/file"),
        0,
      ),
    /redirect limit/u,
  );
  await assert.rejects(
    () => fetchBytes("https://github.com/caddyserver/caddy/release", async () => response(302, null)),
    /location/u,
  );
});

test("Caddy downloader rejects unsafe archive members and output/env injection", async () => {
  const safeMembers = [
    { name: "LICENSE", type: "-" },
    { name: "README.md", type: "-" },
    { name: "caddy", type: "-" },
  ];
  assert.deepEqual(validateArchiveMembers(safeMembers), safeMembers);
  for (const members of [
    [{ name: "../caddy", type: "-" }],
    [{ name: "/caddy", type: "-" }],
    [{ name: "caddy", type: "l" }],
    [{ name: "caddy", type: "h" }],
    [
      { name: "caddy", type: "-" },
      { name: "caddy", type: "-" },
    ],
    [{ name: "other", type: "-" }],
  ])
    assert.throws(() => validateArchiveMembers(members));
  for (const value of ["", "a\nb", "a\rb", "a\u0000b", "./caddy", "../caddy"])
    assert.throws(() => validateOutputPath(value));
  assert.equal(parseFetcherArgs(["--output", "/tmp/caddy"]).output, "/tmp/caddy");
  for (const args of [[], ["--output"], ["--output", "/tmp/a", "--output", "/tmp/b"], ["--other", "/tmp/a"]])
    assert.throws(() => parseFetcherArgs(args));
  assert.equal(environmentLines("/tmp/caddy"), "CADDY_BIN=/tmp/caddy\nCADDY_REQUIRED=true\n");
  assert.throws(() => environmentLines("/tmp/caddy\nCADDY_REQUIRED=false"));
});

test("Caddy resolver uses exact path values and PATH for bare commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nodel-caddy-resolver-"));
  const executable = join(directory, "caddy");
  const originalPath = process.env.PATH;
  const originalCaddy = process.env.CADDY_BIN;
  await writeFile(executable, "#!/bin/sh\nprintf 'v2.11.3'\n");
  await chmod(executable, 0o755);
  try {
    process.env.CADDY_BIN = executable;
    assert.equal(await resolveCaddy(), executable);
    process.env.CADDY_BIN = `.${process.platform === "win32" ? "\\" : "/"}missing-caddy`;
    process.env.PATH = directory;
    assert.equal(await resolveCaddy(), null);
    process.env.CADDY_BIN = "caddy";
    process.env.PATH = directory;
    assert.equal(await resolveCaddy(), executable);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCaddy === undefined) delete process.env.CADDY_BIN;
    else process.env.CADDY_BIN = originalCaddy;
    await rm(directory, { recursive: true, force: true });
  }
});

test("GITHUB_ENV rejects symlinked parent components", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nodel-github-env-"));
  try {
    const real = join(directory, "real");
    const linked = join(directory, "linked");
    await mkdir(real);
    await symlink(real, linked);
    await assert.rejects(
      () => appendEnvironment(join(linked, "env"), "/tmp/caddy"),
      /GITHUB_ENV path must not contain symlinks/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("test sources do not hardcode platform Caddy paths", async () => {
  const forbiddenPlatformPath = ["/usr", "bin", "caddy"].join("/");
  for (const entry of await readdir(dirname(fileURLToPath(import.meta.url)), { withFileTypes: true })) {
    if (!entry.isFile() || !/\.test\.(?:mjs|ts)$/u.test(entry.name)) continue;
    const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), entry.name), "utf8");
    assert.equal(source.includes(forbiddenPlatformPath), false, `${entry.name} hardcodes a platform Caddy path`);
  }
});

test("renderer CLI renders the exact flag contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nodel-caddy-cli-"));
  try {
    const output = join(directory, "Caddyfile");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/caddy-render.mjs",
        "--hostname",
        "cli.example",
        "--bind-address",
        "127.0.0.1",
        "--allow-cidr",
        "203.0.113.0/24",
        "--allow-cidr",
        "fd00::/8",
        "--body-limit-bytes",
        "1048576",
        "--output",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(output, "utf8"), /https:\/\/cli\.example/);
    assert.notEqual(
      spawnSync(process.execPath, ["scripts/caddy-render.mjs", "--cidr", "203.0.113.0/24"], { encoding: "utf8" })
        .status,
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("renderer rejects injection and unsafe network values", () => {
  for (const hostname of ["*.example", "https://x", "x:443", "x{respond 200}", "x;respond 200"])
    assert.throws(() => renderCaddyfile(template, { ...options, hostname }), /Invalid hostname/);
  for (const bindAddress of ["not-an-ip", "127.0.0.1;respond 200"])
    assert.throws(() => renderCaddyfile(template, { ...options, bindAddress }), /Invalid IP/);
  assert.throws(() => renderCaddyfile(template, { ...options, allowCidrs: ["203.0.113.0/99"] }), /valid CIDR/);
  assert.throws(() => renderCaddyfile(template, { ...options, upstream: "192.0.2.1:8765" }), /loopback/);
});

test("output rejects existing, special, traversal, and symlink paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nodel-caddy-test-"));
  try {
    const output = join(directory, "Caddyfile");
    await writeRenderedOutput(output, "safe\n");
    assert.equal((await lstat(output)).mode & 0o777, 0o644);
    await assert.rejects(() => writeRenderedOutput(output, "again\n"), /existing output/);
    const link = join(directory, "link");
    await symlink(directory, link);
    await assert.rejects(() => writeRenderedOutput(join(link, "new"), "unsafe\n"), /symlink/);
    await mkdir(join(directory, "special"));
    await assert.rejects(() => writeRenderedOutput(join(directory, "special"), "unsafe\n"), /regular file/);
    await assert.rejects(() => writeRenderedOutput(`${directory}/../bad`, "unsafe\n"), /traversal/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("renderer permits documented ./output and normalizes loopback upstreams", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nodel-caddy-output-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/caddy-render.mjs", import.meta.url)),
        "--hostname",
        "output.example",
        "--bind-address",
        "127.0.0.1",
        "--allow-cidr",
        "127.0.0.0/8",
        "--output",
        "./output",
      ],
      {
        cwd: directory,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(join(directory, "output"), "utf8"), /output\.example/u);
    assert.equal(parseUpstream("127.0.0.1:9123"), "127.0.0.1:9123");
    assert.equal(parseUpstream("[::1]:9123"), "[::1]:9123");
    assert.throws(() => parseUpstream("::1:9123"));
    const ipv6 = renderCaddyfile(template, { ...options, upstream: "[::1]:9123" });
    assert.match(ipv6, /reverse_proxy \[::1\]:9123/u);
    assert.equal(inspectCaddyfile(ipv6).ok, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspection requires all three proxied routes and rejects auth or proxy violations", () => {
  const rendered = renderCaddyfile(template, options);
  assert.equal(inspectCaddyfile(rendered).ok, true);
  assert.equal(inspectCaddyfile(rendered.replace("tls internal", "basic_auth x y")).ok, false);
  assert.equal(
    inspectCaddyfile(
      rendered.replace("handle @health {\n\t\treverse_proxy 127.0.0.1:8765", "handle @health {\n\t\trespond 200"),
    ).ok,
    false,
  );
  assert.equal(
    inspectCaddyfile(
      rendered.replace("handle @ready {\n\t\treverse_proxy 127.0.0.1:8765", "handle @ready {\n\t\trespond 200"),
    ).ok,
    false,
  );
  assert.equal(
    inspectCaddyfile(rendered.replace("handle @mcp {\n\t\trequest_body", "handle @mcp {\n\t\trespond 200")).ok,
    false,
  );
  assert.equal(
    inspectCaddyfile(
      rendered
        .replace("\t@mcp path /mcp", "\t@mcp path /healthz")
        .replace("\t@health path /healthz", "\t@health path /mcp"),
    ).ok,
    false,
  );
  assert.equal(inspectCaddyfile(rendered.replace("\t@mcp path /mcp", "\t@mcp path /mcp /readyz")).ok, false);
  assert.equal(inspectCaddyfile(moveHandleAfterRoute(rendered, "notAllowed", "mcp")).ok, false);
  assert.equal(inspectCaddyfile(moveHandleAfterRoute(rendered, "notAllowed", "health")).ok, false);
  assert.equal(inspectCaddyfile(moveHandleAfterRoute(rendered, "notAllowed", "ready")).ok, false);
  assert.equal(inspectCaddyfile(moveHandleAfterFinalFallback(rendered, "notAllowed")).ok, false);
  assert.equal(inspectCaddyfile(`${rendered}\nreverse_proxy 127.0.0.1:8765`).ok, false);
});

test("inspection accepts only the canonical rendering", () => {
  const rendered = renderCaddyfile(template, options);
  assert.equal(inspectCaddyfile(rendered).ok, true);
  for (const mutation of [
    (value) => value.replace("not remote_ip", "remote_ip"),
    (value) => value.replace("not remote_ip", "remote_ip").replace("198.51.100.0/24", "203.0.113.0/24"),
    (value) => `${value}\n\theader_up Authorization {http.request.header.Authorization}`,
    (value) => value.replace("reverse_proxy 127.0.0.1:8765", "reverse_proxy to 127.0.0.1:8765"),
    (value) => value.replace("reverse_proxy 127.0.0.1:8765", "reverse_proxy {http.request.host}:8765"),
    (value) =>
      value.replace(
        "\n\trespond 404",
        "\n\thandle /loopback {\n\t\treverse_proxy 127.0.0.1:8765\n\t}\n\n\trespond 404",
      ),
    (value) => `${value}\nimport extra.caddy`,
    (value) => `${value}\nlog`,
    (value) => `${value}\nbasic_auth user secret`,
    (value) => `${value}\nheader X-Api-Key "${"AK" + "IA1234567890ABCDEF"}"`,
  ])
    assert.equal(inspectCaddyfile(mutation(rendered)).ok, false);
});

test("optional missing Caddy is visibly skipped and required absence fails", () => {
  const missing = join(tmpdir(), `nodel-no-caddy-${process.pid}`);
  const optional = spawnSync(process.execPath, ["scripts/caddy-check.mjs"], {
    encoding: "utf8",
    env: { ...process.env, CADDY_BIN: missing, CADDY_REQUIRED: "false" },
  });
  assert.equal(optional.status, 0);
  assert.match(`${optional.stdout}\n${optional.stderr}`, /validation skipped/i);
  const required = spawnSync(process.execPath, ["scripts/caddy-check.mjs"], {
    encoding: "utf8",
    env: { ...process.env, CADDY_BIN: missing, CADDY_REQUIRED: "true" },
  });
  assert.notEqual(required.status, 0);
});

test("listener parser uses ss local-address column and separates warnings from blocks", () => {
  const result = classifyListeners("LISTEN 0 4096 0.0.0.0:8765 0.0.0.0:*\nLISTEN 0 4096 [::]:8080 [::]:*");
  assert.equal(result[0].severity, "blocking");
  assert.equal(result[1].severity, "warning");
  assert.equal(classifyListeners("LISTEN 0 4096 127.0.0.1:8085 0.0.0.0:*")[0].severity, "info");
});

test("missing ss is explicitly skipped without blocking Caddy diagnosis", async () => {
  const missing = join(tmpdir(), `nodel-no-ss-${process.pid}`);
  const result = await diagnose({ caddyBin: "/missing/caddy", ssBin: missing });
  assert.equal(result.listeners.available, false);
  assert.equal(result.listeners.skipped, true);
  assert.equal(result.listeners.message, "Listener diagnostics skipped: ss is unavailable");
  const cli = spawnSync(process.execPath, ["scripts/caddy-check.mjs"], {
    encoding: "utf8",
    env: { ...process.env, CADDY_BIN: "/missing/caddy", CADDY_REQUIRED: "false", SS_BIN: missing },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stderr, /Listener diagnostics skipped: ss is unavailable/u);
});

test("supplied config must be regular and nonsymlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nodel-caddy-config-"));
  try {
    const config = join(directory, "Caddyfile");
    await writeFile(config, renderCaddyfile(template, options));
    const link = join(directory, "link");
    await symlink(config, link);
    await assert.rejects(
      () => diagnose({ configPath: link, caddyBin: "/missing/caddy", ssOutput: "" }),
      /regular nonsymlink/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Caddy v2 detection rejects non-v2 and redacts parser failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nodel-caddy-version-"));
  try {
    const fake = join(directory, "caddy");
    await writeFile(
      fake,
      "#!/bin/sh\nif [ \"$1\" = version ]; then printf 'v1.7.0'; else printf 'sensitive config details'; exit 1; fi\n",
      { mode: 0o755 },
    );
    const config = join(directory, "Caddyfile");
    await writeFile(config, "bad");
    const result = validateWithCaddy(config, fake);
    assert.equal(result.ok, false);
    assert.equal(result.message, "Caddy 2 is required");
    await writeFile(
      fake,
      "#!/bin/sh\nif [ \"$1\" = version ]; then printf 'v2.11.3'; else printf 'sensitive config details'; exit 1; fi\n",
      { mode: 0o755 },
    );
    const failure = validateWithCaddy(config, fake);
    assert.equal(failure.message, "Caddy rejected the Caddyfile");
    assert.doesNotMatch(failure.message, /sensitive|bad/iu);
    await mkdir(join(directory, "nested"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live rollout checks protected and health endpoints without exposing bodies", async () => {
  const server = createServer((request, response) => {
    const status = request.url === "/healthz" ? 200 : 401;
    response.writeHead(status, { "content-type": request.url === "/healthz" ? "application/json" : "text/plain" });
    response.end(request.url === "/healthz" ? JSON.stringify({ ok: true, version: "test" }) : "private body");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const address = server.address();
    const port = typeof address === "string" ? Number(address) : address.port;
    const result = await diagnose({ caddyBin: "/missing/caddy", liveUrl: `http://127.0.0.1:${port}/`, ssOutput: "" });
    assert.equal(result.live.ok, true);
    assert.equal(JSON.stringify(result.live).includes("private body"), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("live rollout rejects redirects and response URL changes", async () => {
  for (const redirectPath of ["mcp", "readyz", "healthz"]) {
    const server = createServer((request, response) => {
      if (request.url === `/${redirectPath}`) {
        response.writeHead(302, { location: "https://other.invalid/" });
        response.end();
      } else if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, version: "test" }));
      } else {
        response.writeHead(401);
        response.end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = server.address();
      const port = typeof address === "string" ? Number(address) : address.port;
      const result = await diagnose({ caddyBin: "/missing/caddy", liveUrl: `http://127.0.0.1:${port}/`, ssOutput: "" });
      assert.equal(result.live.ok, false);
      assert.match(result.live.message, /redirect|response URL/u);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
});

/** @type {Array<[string, Record<string, string>, string]>} */
const healthCases = [
  ["rejects malformed health JSON", { "content-type": "application/json" }, "not-json"],
  ["rejects non-JSON health responses", { "content-type": "text/plain" }, "ok"],
  [
    "rejects oversized health JSON",
    { "content-type": "application/json" },
    `{"ok":true,"version":"${"x".repeat(5000)}"}`,
  ],
];
for (const [name, headers, body] of healthCases) {
  test(name, async () => {
    const server = createServer((request, response) => {
      const health = request.url === "/healthz";
      response.writeHead(health ? 200 : 401, health ? headers : { "content-type": "text/plain" });
      response.end(health ? body : "private");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = server.address();
      const port = typeof address === "string" ? Number(address) : address.port;
      const result = await diagnose({ caddyBin: "/missing/caddy", liveUrl: `http://127.0.0.1:${port}/`, ssOutput: "" });
      assert.equal(result.live.ok, false);
      assert.doesNotMatch(JSON.stringify(result.live), /not-json|private|x{20}/u);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
}

function extractHandleRanges(content, names = ["notAllowed", "mcp", "health", "ready"]) {
  const ranges = [];
  const matcher = new RegExp(`handle\\s+@(${names.join("|")})\\s*\\{`, "gu");
  for (const match of content.matchAll(matcher)) {
    const start = match.index ?? 0;
    let depth = 1;
    let index = start + match[0].length;
    let quoted = false;
    while (index < content.length && depth > 0) {
      const character = content[index];
      if (character === '"' && content[index - 1] !== "\\") quoted = !quoted;
      if (!quoted) {
        if (character === "{") depth += 1;
        if (character === "}") depth -= 1;
      }
      index += 1;
    }
    ranges.push({ name: match[1], start, end: index });
  }
  return ranges;
}

function moveHandleAfterRoute(content, handleName, anchorRoute) {
  const ranges = extractHandleRanges(content);
  const move = ranges.find((item) => item.name === handleName);
  if (!move) return content;
  const withoutMoved = `${content.slice(0, move.start)}${content.slice(move.end)}`;
  const withoutMovedRanges = extractHandleRanges(withoutMoved);
  const anchor = withoutMovedRanges.find((item) => item.name === anchorRoute);
  if (!anchor) return withoutMoved;
  const handle = content.slice(move.start, move.end);
  return `${withoutMoved.slice(0, anchor.end)}\n\n${handle}${withoutMoved.slice(anchor.end)}`;
}

function moveHandleAfterFinalFallback(content, handleName) {
  const ranges = extractHandleRanges(content);
  const move = ranges.find((item) => item.name === handleName);
  if (!move) return content;
  const withoutMoved = `${content.slice(0, move.start)}${content.slice(move.end)}`;
  const fallback = withoutMoved.match(/^\s*respond 404\b.*$/mu);
  if (!fallback) return withoutMoved;
  const handle = content.slice(move.start, move.end);
  const insertion = fallback.index + fallback[0].length;
  return `${withoutMoved.slice(0, insertion)}\n${handle}${withoutMoved.slice(insertion)}`;
}

test("existing config composes with Caddy, permits shared listeners, and resolves relative imports", async (t) => {
  const caddy = await requireCaddy(t);
  if (!caddy) return;
  const directory = await mkdtemp(join(tmpdir(), "nodel-caddy-compose-"));
  try {
    const compatible = join(directory, "compatible.Caddyfile");
    await writeFile(compatible, "https://other.example {\n\tbind 127.0.0.1\n\trespond 204\n}\n");
    const compatibleResult = await diagnose({
      existingConfigPath: compatible,
      caddyBin: caddy,
      ssOutput: "",
    });
    assert.equal(compatibleResult.existing.ok, true);

    const imported = join(directory, "imported.Caddyfile");
    await writeFile(imported, "import routes.caddy\n");
    await writeFile(join(directory, "routes.caddy"), "https://imported.example {\n\trespond 204\n}\n");
    const importedResult = await diagnose({ existingConfigPath: imported, caddyBin: caddy, ssOutput: "" });
    assert.equal(importedResult.existing.ok, true);

    const readonlyDirectory = join(directory, "readonly");
    await mkdir(readonlyDirectory);
    const readonlyExisting = join(readonlyDirectory, "imported.Caddyfile");
    await writeFile(readonlyExisting, "import routes.caddy\n");
    const routeDefinition = join(readonlyDirectory, "routes.caddy");
    await writeFile(routeDefinition, "https://imported.example {\n\trespond 204\n}\n");
    await chmod(readonlyDirectory, 0o555);
    let readonlyResult;
    try {
      readonlyResult = await diagnose({
        existingConfigPath: readonlyExisting,
        caddyBin: caddy,
        ssOutput: "",
      });
    } finally {
      await chmod(readonlyDirectory, 0o755);
    }
    assert.equal(readonlyResult.existing.ok, true);

    const duplicate = join(directory, "duplicate.Caddyfile");
    await writeFile(
      duplicate,
      renderCaddyfile(template, {
        hostname: "nodel-check.example",
        bindAddress: "127.0.0.1",
        allowCidrs: ["198.51.100.0/24", "fd00::/8"],
      }),
    );
    const duplicateResult = await diagnose({ existingConfigPath: duplicate, caddyBin: caddy, ssOutput: "" });
    assert.equal(duplicateResult.existing.ok, false);
    assert.equal(duplicateResult.existing.message, "Caddy rejected composed configuration");
    assert.doesNotMatch(JSON.stringify(duplicateResult.existing), /nodel-check\.example|Caddyfile/iu);

    const alternatePort = join(directory, "alternate-port.Caddyfile");
    await writeFile(alternatePort, "http://nodel-check.example:8080 {\n\trespond 204\n}\n");
    const alternateResult = await diagnose({
      existingConfigPath: alternatePort,
      caddyBin: caddy,
      ssOutput: "",
    });
    assert.equal(alternateResult.existing.ok, true);

    const sharedBind = join(directory, "shared-bind.Caddyfile");
    await writeFile(sharedBind, "https://other.example {\n\tbind 127.0.0.1\n\trespond 204\n}\n");
    const sharedResult = await diagnose({
      existingConfigPath: sharedBind,
      configPath: duplicate,
      caddyBin: caddy,
      ssOutput: "",
    });
    assert.equal(sharedResult.existing.ok, true);

    const globalOptions = join(directory, "global-options.Caddyfile");
    await writeFile(globalOptions, "{\n\tauto_https off\n}\n\nhttps://global.example {\n\trespond 204\n}\n");
    const globalResult = await diagnose({
      existingConfigPath: globalOptions,
      caddyBin: caddy,
      ssOutput: "",
    });
    assert.equal(globalResult.existing.ok, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validateComposedConfig cleans temporary wrapper directory when wrapper write fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nodel-caddy-compose-injected-failure-"));
  const wrapperDirectory = join(directory, "wrapper");
  await mkdir(wrapperDirectory);
  const existing = join(directory, "existing.Caddyfile");
  const candidate = join(directory, "candidate.Caddyfile");
  await writeFile(existing, "import routes.caddy\n");
  await writeFile(candidate, "import routes.caddy\n");
  await writeFile(join(directory, "routes.caddy"), "https://composed.example {\n\trespond 204\n}\n");

  let cleaned = false;
  try {
    await assert.rejects(
      () =>
        validateComposedConfig(existing, candidate, "caddy", {
          mkdtempImpl: /** @type {any} */ (async () => wrapperDirectory),
          writeFileImpl: async () => {
            throw new Error("injected wrapper write failure");
          },
          removeImpl: async (path, options) => {
            if (path === wrapperDirectory) cleaned = true;
            return rm(path, options);
          },
        }),
      /injected wrapper write failure/u,
    );
    assert.equal(cleaned, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real Caddy parser is used through CADDY_BIN when available", async (t) => {
  const caddy = await requireCaddy(t);
  if (!caddy) return;
  const directory = await mkdtemp(join(tmpdir(), "nodel-caddy-parser-"));
  try {
    const path = join(directory, "Caddyfile");
    await writeFile(path, renderCaddyfile(template, options));
    assert.equal(validateWithCaddy(path, caddy).ok, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("optional real Caddy forwards Authorization and Origin to the loopback sidecar", async (t) => {
  const caddy = await requireCaddy(t);
  if (!caddy) return;

  let upstreamCalls = 0;
  const upstream = createServer((request, response) => {
    upstreamCalls += 1;
    response.writeHead(200, { "content-type": "application/json", "x-upstream-seen": "true" });
    response.end(
      JSON.stringify({
        path: request.url,
        authorization: request.headers.authorization,
        origin: request.headers.origin,
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamAddress = upstream.address();
  const upstreamPort = typeof upstreamAddress === "string" ? Number(upstreamAddress) : upstreamAddress.port;
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", () => resolve()));
  const caddyAddress = portProbe.address();
  const caddyPort = typeof caddyAddress === "string" ? Number(caddyAddress) : caddyAddress.port;
  await new Promise((resolve, reject) => portProbe.close((error) => (error ? reject(error) : resolve())));

  const directory = await mkdtemp(join(tmpdir(), "nodel-caddy-runtime-"));
  let processHandle;
  try {
    const config = renderCaddyfile(template, {
      ...options,
      hostname: "localhost",
      bindAddress: "127.0.0.1",
      allowCidrs: ["127.0.0.0/8"],
      upstream: `127.0.0.1:${upstreamPort}`,
    }).replace("https://localhost {", `https://localhost:${caddyPort} {`);
    const configPath = join(directory, "Caddyfile");
    await writeFile(configPath, "{\n\tadmin off\n\tauto_https disable_redirects\n\tskip_install_trust\n}\n\n" + config);
    processHandle = spawn(caddy, ["run", "--config", configPath, "--adapter", "caddyfile"], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_DATA_HOME: join(directory, "data"),
        XDG_CACHE_HOME: join(directory, "cache"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let caddyDiagnostics = "";
    processHandle.stderr.on("data", (chunk) => {
      caddyDiagnostics += chunk.toString();
    });
    const ca = await waitForCaddyLocalRoot(directory);
    const requestOnce = (path, includeOrigin = true, servername = "localhost", verifyIdentity) =>
      new Promise((resolve, reject) => {
        const request = httpsRequest(
          {
            hostname: "127.0.0.1",
            port: caddyPort,
            servername,
            path,
            method: "GET",
            ca,
            ...(verifyIdentity ? { agent: new HttpsAgent({ maxCachedSessions: 0 }) } : {}),
            ...(verifyIdentity ? { checkServerIdentity: verifyIdentity } : {}),
            headers: {
              Host: `localhost:${caddyPort}`,
              Authorization: "Bearer integration-test",
              ...(includeOrigin ? { Origin: "https://caller.invalid" } : {}),
            },
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () =>
              resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
            );
          },
        );
        request.setTimeout(500, () => request.destroy(new Error("timeout")));
        request.on("error", reject).end();
      });

    const paths = ["/mcp", "/healthz", "/readyz"];
    const responses = {};
    const deadline = Date.now() + 8000;
    for (const path of paths) {
      while (Date.now() < deadline) {
        try {
          const result = await requestOnce(path);
          if (result.status === 200) {
            responses[path] = result;
            break;
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      assert.equal(
        typeof responses[path]?.status,
        "number",
        `No successful ${path} response: ${caddyDiagnostics.slice(-1000)}`,
      );
      assert.equal(responses[path].status, 200, caddyDiagnostics.slice(-1000));
      const parsed = JSON.parse(responses[path].body);
      assert.deepEqual(parsed, {
        path,
        authorization: "Bearer integration-test",
        origin: "https://caller.invalid",
      });
    }
    assert.equal(upstreamCalls, paths.length, "Caddy did not forward every exposed route to the sidecar");
    assert.ok(responses["/mcp"], `Caddy response body was empty: ${JSON.stringify(responses)}`);
    assert.ok(responses["/healthz"], `Caddy response body was empty: ${JSON.stringify(responses)}`);
    assert.ok(responses["/readyz"], `Caddy response body was empty: ${JSON.stringify(responses)}`);

    await assert.rejects(
      () =>
        requestOnce("/healthz", true, "localhost", (_servername, certificate) =>
          checkServerIdentity("wrong-hostname.invalid", certificate),
        ),
      (error) => error instanceof Error && "code" in error && error.code === "ERR_TLS_CERT_ALTNAME_INVALID",
    );

    const noOriginResponses = {};
    for (const path of paths) {
      while (Date.now() < deadline) {
        try {
          const result = await requestOnce(path, false);
          if (result.status === 200) {
            noOriginResponses[path] = result;
            break;
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      assert.equal(noOriginResponses[path]?.status, 200, `No successful no-Origin ${path} response`);
      assert.deepEqual(JSON.parse(noOriginResponses[path].body), {
        path,
        authorization: "Bearer integration-test",
      });
    }
    assert.equal(upstreamCalls, paths.length * 2, "Caddy did not forward no-Origin requests for every route");
  } finally {
    if (processHandle && !processHandle.killed) {
      processHandle.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          processHandle.kill("SIGKILL");
          resolve();
        }, 2000);
        processHandle.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await new Promise((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true });
  }
});

async function resolveCaddy() {
  const configured = process.env.CADDY_BIN;
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const pathContainsSeparator = configured && configured.includes(process.platform === "win32" ? "\\" : "/");
  const exact = configured && (isAbsolute(configured) || pathContainsSeparator);
  const names = configured && !exact ? [configured] : ["caddy"];
  const candidates = exact
    ? [configured]
    : (process.env.PATH ?? "")
        .split(pathSeparator)
        .filter(Boolean)
        .flatMap((path) => names.map((name) => join(path, name)));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const version = spawnSync(candidate, ["version"], { encoding: "utf8" });
      if (version.status === 0 && /(?:^|\D)2\./u.test(`${version.stdout}${version.stderr}`)) return candidate;
    } catch {
      // Continue through PATH candidates; required-mode handling is below.
    }
  }
  return null;
}

async function requireCaddy(t) {
  const caddy = await resolveCaddy();
  if (caddy) return caddy;
  if (process.env.CADDY_REQUIRED === "true")
    throw new Error("Caddy 2 is required but unavailable or failed validation");
  t?.skip("optional Caddy 2 unavailable");
  return null;
}

test("real Caddy enforces CIDR denial before every exposed route", async (t) => {
  const caddy = await requireCaddy(t);
  if (!caddy) return;

  let upstreamCalls = 0;
  const upstream = createServer((_request, response) => {
    upstreamCalls += 1;
    response.writeHead(200);
    response.end("unexpected upstream");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamAddress = upstream.address();
  const upstreamPort = typeof upstreamAddress === "string" ? Number(upstreamAddress) : upstreamAddress.port;
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const caddyAddress = probe.address();
  const caddyPort = typeof caddyAddress === "string" ? Number(caddyAddress) : caddyAddress.port;
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  const directory = await mkdtemp(join(tmpdir(), "nodel-caddy-cidr-"));
  let processHandle;
  try {
    const config = renderCaddyfile(template, {
      ...options,
      hostname: "localhost",
      bindAddress: "127.0.0.1",
      allowCidrs: ["198.51.100.0/24"],
      upstream: `127.0.0.1:${upstreamPort}`,
    }).replace("https://localhost {", `https://localhost:${caddyPort} {`);
    const configPath = join(directory, "Caddyfile");
    await writeFile(
      configPath,
      `{
	admin off
	auto_https disable_redirects
	skip_install_trust
}

${config}`,
    );
    processHandle = spawn(caddy, ["run", "--config", configPath, "--adapter", "caddyfile"], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_DATA_HOME: join(directory, "data"),
        XDG_CACHE_HOME: join(directory, "cache"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostics = "";
    processHandle.stderr.on("data", (chunk) => {
      diagnostics += chunk.toString();
    });
    const ca = await waitForCaddyLocalRoot(directory);
    const requestPath = (path) =>
      new Promise((resolve, reject) => {
        const request = httpsRequest(
          {
            hostname: "127.0.0.1",
            port: caddyPort,
            servername: "localhost",
            path,
            ca,
            headers: {
              Host: `localhost:${caddyPort}`,
              Authorization: "Bearer denied-test",
              Origin: "https://caller.invalid",
            },
          },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          },
        );
        request.setTimeout(500, () => request.destroy(new Error("timeout")));
        request.on("error", reject).end();
      });
    const deadline = Date.now() + 8000;
    for (const path of ["/mcp", "/healthz", "/readyz", "/unknown"]) {
      let status;
      while (Date.now() < deadline) {
        try {
          status = await requestPath(path);
          if (status === 403) break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      assert.equal(status, 403, `${path}: ${diagnostics.slice(-1000)}`);
    }
    assert.equal(upstreamCalls, 0, "CIDR-denied requests reached the upstream");
  } finally {
    if (processHandle && !processHandle.killed) {
      processHandle.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          processHandle.kill("SIGKILL");
          resolve();
        }, 2000);
        processHandle.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await new Promise((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true });
  }
});

function caddyLocalRootPath(directory) {
  return join(directory, "data", "caddy", "pki", "authorities", "local", "root.crt");
}

async function readCaddyLocalRoot(rootCertificate) {
  const status = await lstat(rootCertificate);
  if (!status.isFile() || status.isSymbolicLink() || status.size === 0 || status.size > MAX_CADDY_LOCAL_ROOT_BYTES)
    throw new Error("Caddy local root certificate is unavailable");
  const certificate = await readFile(rootCertificate);
  if (certificate.length === 0 || certificate.length > MAX_CADDY_LOCAL_ROOT_BYTES)
    throw new Error("Caddy local root certificate is unavailable");
  return certificate;
}

async function waitForCaddyLocalRoot(directory) {
  const rootCertificate = caddyLocalRootPath(directory);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      return await readCaddyLocalRoot(rootCertificate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error("Caddy local root certificate is unavailable");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Caddy local root certificate is unavailable");
}
