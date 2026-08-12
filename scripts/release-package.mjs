import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  assertSafeArchiveMember,
  assertSafeRelative,
  collectRegularFiles,
  parseArchiveMembers,
} from "./release-safety.mjs";
import { compareUtf8 } from "./public-candidate-policy.mjs";
import { cyclonedxComponents } from "./sbom.mjs";
import { releaseMode } from "./release-modes.mjs";
import { validateReleaseStaging } from "./release-package-policy.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = packageJson.version;
const artifactDir = resolve(process.env.RELEASE_ARTIFACT_DIR || join(root, "artifacts"));
const archiveName = `nodel-ai-v${version}.tar.gz`;
const epoch = Number(
  process.env.SOURCE_DATE_EPOCH ||
    execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
);
if (process.env.RELEASE_UMASK) process.umask(Number.parseInt(process.env.RELEASE_UMASK, 8));
if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer");

const staging = await mkdtemp(join(tmpdir(), "nodel-ai-package-"));
const tree = join(staging, `nodel-ai-v${version}`);
const copy = async (source, destination = source) => {
  const safeDestination = assertSafeRelative(destination);
  const sourcePath = join(root, assertSafeRelative(source));
  const destinationPath = resolve(tree, safeDestination);
  if (destinationPath !== tree && !destinationPath.startsWith(`${tree}${sep}`))
    throw new Error("Release copy escaped root");
  const sourceInfo = await lstat(sourcePath);
  if (sourceInfo.isSymbolicLink()) throw new Error(`Symlink is not allowed in release input: ${source}`);
  if (sourceInfo.isDirectory()) {
    await mkdir(destinationPath, { recursive: true });
    for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error(`Symlink is not allowed in release input: ${join(source, entry.name)}`);
      await copy(join(source, entry.name), join(safeDestination, entry.name));
    }
  } else if (sourceInfo.isFile()) {
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  } else {
    throw new Error(`Unsupported release input: ${source}`);
  }
};
const normalizeModes = async (directory) => {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await chmod(path, releaseMode(relative(tree, path), true));
      await normalizeModes(path);
    } else if (entry.isFile()) {
      const relativePath = relative(tree, path);
      await chmod(path, releaseMode(relativePath, false));
    }
  }
};
const allowlisted = [
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CHANGELOG.md",
  ".env.example",
  "package-lock.json",
  "docs",
  "systemd",
  "scripts/install-systemd-user.sh",
  "scripts/install-systemd-system.sh",
  "scripts/systemd-render.mjs",
  "deploy/caddy/nodel-mcp.Caddyfile.in",
  "scripts/caddy-render.mjs",
  "scripts/caddy-check.mjs",
];
try {
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await mkdir(tree, { recursive: true });
  await rm(join(root, "dist"), { recursive: true, force: true });
  const build = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (build.status !== 0) throw new Error("Build failed");
  for (const script of ["docs:generate", "license:report"]) {
    const result = spawnSync("npm", ["run", script], { cwd: root, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`${script} failed`);
  }
  for (const item of allowlisted) await copy(item);
  await copy("dist");
  const productionPackage = {
    ...packageJson,
    scripts: {
      start: packageJson.scripts.start,
      "caddy:render": packageJson.scripts["caddy:render"],
      "caddy:check": packageJson.scripts["caddy:check"],
    },
    devDependencies: undefined,
  };
  delete productionPackage.devDependencies;
  await writeFile(join(tree, "package.json"), `${JSON.stringify(productionPackage, null, 2)}\n`);
  await mkdir(join(tree, "reports"), { recursive: true });
  await copy("reports/dependency-licenses.json");
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const components = cyclonedxComponents(lock.packages ?? {});
  await writeFile(
    join(tree, "SBOM.cdx.json"),
    `${JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", version: 1, metadata: { component: { type: "application", name: packageJson.name, version } }, components }, null, 2)}\n`,
  );
  const files = await collectRegularFiles(tree);
  files.forEach(assertSafeArchiveMember);
  const absolute = /(?:\/(?:home|Users|tmp|workspace|build)\/|[A-Z]:\\)/u;
  for (const file of files.filter((item) => item.endsWith(".map") || /\.(?:js|json|md|service|sh|in)$/u.test(item))) {
    if (absolute.test(await readFile(join(tree, file), "utf8"))) throw new Error(`Absolute build path in ${file}`);
  }
  const manifest = { name: packageJson.name, version, root: `nodel-ai-v${version}`, sourceDateEpoch: epoch, files: [] };
  for (const file of files.sort(compareUtf8)) {
    const data = await readFile(join(tree, file));
    manifest.files.push({
      path: file,
      bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  await writeFile(join(tree, "ARTIFACT-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await normalizeModes(tree);
  await validateReleaseStaging(tree);
  const tarPath = join(staging, `${archiveName}.tar`);
  execFileSync(
    "tar",
    [
      "--sort=name",
      `--mtime=@${epoch}`,
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-cf",
      tarPath,
      `nodel-ai-v${version}`,
    ],
    { cwd: staging },
  );
  execFileSync("gzip", ["-n", "-f", tarPath]);
  const archivePath = join(artifactDir, archiveName);
  await copyFile(`${tarPath}.gz`, archivePath);
  const archiveMembers = parseArchiveMembers(
    execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" }).toString(),
  );
  const verboseMembers = execFileSync("tar", ["-tvzf", archivePath], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  if (verboseMembers.some((member) => !/^[d-]/u.test(member)))
    throw new Error("Release archive contains a non-regular member");
  const evidence = [
    ["SBOM.cdx.json", join(tree, "SBOM.cdx.json")],
    ["dependency-licenses.json", join(tree, "reports/dependency-licenses.json")],
    ["ARTIFACT-MANIFEST.json", join(tree, "ARTIFACT-MANIFEST.json")],
  ];
  for (const [name, source] of evidence) await copyFile(source, join(artifactDir, name));
  const assets = [archiveName, ...evidence.map(([name]) => name)];
  const sums = [];
  for (const asset of assets)
    sums.push(
      `${createHash("sha256")
        .update(await readFile(join(artifactDir, asset)))
        .digest("hex")}  ${asset}`,
    );
  await writeFile(join(artifactDir, "SHA256SUMS"), `${sums.sort().join("\n")}\n`);
  console.log(`Created artifacts/${archiveName}\n${sums.join("\n")}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
