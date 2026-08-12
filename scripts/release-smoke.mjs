import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArchiveMembers } from "./release-safety.mjs";
import { assertCaddyReleaseMembers } from "./caddy-release-safety.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const archive = join(root, "artifacts", `nodel-ai-v${pkg.version}.tar.gz`);
const artifactDir = join(root, "artifacts");
const expectedAssets = [
  archive,
  join(artifactDir, "SBOM.cdx.json"),
  join(artifactDir, "dependency-licenses.json"),
  join(artifactDir, "ARTIFACT-MANIFEST.json"),
];
const sums = (await readFile(join(artifactDir, "SHA256SUMS"), "utf8")).trim().split("\n");
const checksums = new Map(
  sums.map((line) => {
    const match = /^(\w{64}) {2}(.+)$/u.exec(line);
    if (!match) throw new Error(`Malformed checksum line: ${line}`);
    return [match[2], match[1]];
  }),
);
const expectedNames = [archive.split("/").pop(), "SBOM.cdx.json", "dependency-licenses.json", "ARTIFACT-MANIFEST.json"];
if (checksums.size !== expectedNames.length || expectedNames.some((name) => !checksums.has(name)))
  throw new Error("SHA256SUMS does not cover every release evidence asset");
for (const asset of expectedAssets) {
  const name = asset.split("/").pop();
  const actual = createHash("sha256")
    .update(await readFile(asset))
    .digest("hex");
  if (actual !== checksums.get(name)) throw new Error(`Checksum mismatch: ${name}`);
}
const temp = await mkdtemp(join(tmpdir(), "nodel-ai-smoke-"));
let child;
try {
  if (spawnSync("tar", ["-xzf", archive, "-C", temp]).status !== 0) throw new Error("Archive extraction failed");
  const app = join(temp, `nodel-ai-v${pkg.version}`);
  const archiveMembers = parseArchiveMembers(spawnSync("tar", ["-tzf", archive], { encoding: "utf8" }).stdout);
  const forbidden = /(?:^|\/)(?:src|test|node_modules|coverage|\.git|\.env|\.state)(?:\/|$)/u;
  for (const member of archiveMembers) {
    if (forbidden.test(member)) throw new Error(`Forbidden archive member: ${member}`);
  }
  const archiveRoot = `nodel-ai-v${pkg.version}`;
  assertCaddyReleaseMembers(archiveMembers, archiveRoot);
  for (const evidenceMember of [
    `${archiveRoot}/SBOM.cdx.json`,
    `${archiveRoot}/reports/dependency-licenses.json`,
    `${archiveRoot}/ARTIFACT-MANIFEST.json`,
  ]) {
    if (!archiveMembers.includes(evidenceMember)) throw new Error(`Missing archive evidence member: ${evidenceMember}`);
  }
  for (const member of [
    `${archiveRoot}/deploy/caddy/nodel-mcp.Caddyfile.in`,
    `${archiveRoot}/scripts/caddy-render.mjs`,
    `${archiveRoot}/scripts/caddy-check.mjs`,
  ]) {
    if (!archiveMembers.includes(member)) throw new Error(`Missing Caddy release member: ${member}`);
  }
  for (const [member, mode] of [
    [`${archiveRoot}/scripts/caddy-render.mjs`, 0o755],
    [`${archiveRoot}/scripts/caddy-check.mjs`, 0o755],
    [`${archiveRoot}/deploy/caddy/nodel-mcp.Caddyfile.in`, 0o644],
  ]) {
    if (((await stat(join(temp, member))).mode & 0o777) !== mode) throw new Error(`Unexpected release mode: ${member}`);
  }
  const verboseMembers = spawnSync("tar", ["-tvzf", archive], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  if (verboseMembers.some((member) => !/^[d-]/u.test(member)))
    throw new Error("Archive contains a symlink or special member");
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const info = await lstat(path);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) throw new Error(`Symlink in extracted archive: ${path}`);
      if (forbidden.test(path.replaceAll("\\", "/"))) throw new Error(`Forbidden path: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (!info.isFile()) throw new Error(`Special extracted entry: ${path}`);
    }
  }
  await walk(app);
  const env = join(temp, ".env");
  await (
    await import("node:fs/promises")
  ).writeFile(env, "NODEL_STATE_DIR=" + join(temp, "state") + "\nMCP_PORT=0\nMCP_BIND_ADDRESS=127.0.0.1\n", {
    mode: 0o600,
  });
  if (spawnSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: app, stdio: "inherit" }).status !== 0)
    throw new Error("Production npm ci failed");
  if (
    await stat(join(app, "node_modules/typescript")).then(
      () => true,
      () => false,
    )
  )
    throw new Error("Development dependency installed");
  const renderedCaddyfile = join(temp, "packaged.Caddyfile");
  const render = spawnSync(
    "node",
    [
      "scripts/caddy-render.mjs",
      "--hostname",
      "packaged.example",
      "--bind-address",
      "127.0.0.1",
      "--allow-cidr",
      "127.0.0.0/8",
      "--output",
      renderedCaddyfile,
    ],
    { cwd: app, encoding: "utf8" },
  );
  if (render.status !== 0) throw new Error(`Packaged Caddy renderer failed: ${render.stderr}`);
  const caddyBin = process.env.CADDY_BIN || "caddy";
  const caddyVersion = spawnSync(caddyBin, ["version"], { encoding: "utf8" });
  const caddyAvailable =
    !caddyVersion.error &&
    caddyVersion.status === 0 &&
    /(?:^|\D)2\./u.test(`${caddyVersion.stdout}${caddyVersion.stderr}`);
  const caddyRequired = process.env.CADDY_REQUIRED === "true";
  if (caddyRequired && !caddyAvailable) throw new Error("Caddy is required for release smoke but unavailable");
  const caddyCheck = spawnSync("node", ["scripts/caddy-check.mjs", "--config", renderedCaddyfile], {
    cwd: app,
    env: { ...process.env, CADDY_BIN: caddyBin, CADDY_REQUIRED: String(caddyRequired) },
    stdio: "inherit",
  });
  if (caddyCheck.status !== 0) throw new Error("Packaged Caddy checker failed");
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
  child = spawn("node", ["dist/index.js"], {
    cwd: app,
    env: {
      ...process.env,
      NODEL_STATE_DIR: join(temp, "state"),
      MCP_PORT: String(port),
      MCP_BIND_ADDRESS: "127.0.0.1",
      NODEL_BASE_URL: "http://127.0.0.1:9",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const health = () =>
    new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path: "/healthz", timeout: 500 }, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, data }));
      });
      req.on("error", reject);
      req.end();
    });
  for (let i = 0; i < 30; i += 1) {
    try {
      const result = await health();
      if (result.status === 200 && JSON.parse(result.data).ok === true) break;
    } catch {
      void 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (i === 29) throw new Error("Health probe failed");
  }
  const mode = (await stat(join(temp, "state"))).mode & 0o777;
  if (mode !== 0o700) throw new Error(`State mode is ${mode.toString(8)}`);
  const envMode = (await stat(env)).mode & 0o777;
  if (envMode !== 0o600) throw new Error(`Environment mode is ${envMode.toString(8)}`);
  console.log(`Smoke passed for ${archive}`);
} finally {
  if (child && !child.killed) child.kill("SIGTERM");
  await new Promise((resolve) => (child ? child.once("exit", resolve) : resolve()));
  await rm(temp, { recursive: true, force: true });
}
