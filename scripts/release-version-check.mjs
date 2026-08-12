import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DEFAULT_PATHS = {
  packageJson: new URL("../package.json", import.meta.url),
  packageLock: new URL("../package-lock.json", import.meta.url),
  mcpServer: new URL("../src/mcp/server.ts", import.meta.url),
};

const MCP_SERVER_VERSION_PATTERN = /version:\s*packageJson\.version\b/u;
const V_TAG_PREFIX = "v";
const V_TAG_PREFIX_LEN = V_TAG_PREFIX.length;

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u;

function toSemverTagVersion(tagReference) {
  if (!tagReference) {
    return undefined;
  }

  const normalized = String(tagReference).trim();
  const withoutRef = normalized.startsWith("refs/tags/") ? normalized.slice("refs/tags/".length) : normalized;
  const withPrefix = withoutRef.startsWith(V_TAG_PREFIX) ? withoutRef : undefined;
  if (!withPrefix) {
    return undefined;
  }

  const semver = withPrefix.slice(V_TAG_PREFIX_LEN);
  if (!SEMVER_PATTERN.test(semver)) {
    return undefined;
  }

  return semver;
}

function detectTagFromEnvironment(environment = process.env) {
  const githubRef = environment.GITHUB_REF_NAME;
  if (githubRef?.startsWith(V_TAG_PREFIX)) {
    return githubRef;
  }

  const ref = environment.GITHUB_REF;
  if (typeof ref === "string" && ref.startsWith(`refs/tags/${V_TAG_PREFIX}`)) {
    return ref;
  }

  return undefined;
}

function detectTagFromGit(cwd = process.cwd()) {
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--exact-match", "--match", "v*", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return tag.trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolveReleaseTag({ explicitTag, environment = process.env, gitTag }) {
  const envTag = explicitTag ?? detectTagFromEnvironment(environment);
  const detected = envTag ?? gitTag;

  if (!detected) {
    return undefined;
  }

  const version = toSemverTagVersion(detected);
  if (!version) {
    return undefined;
  }

  return version;
}

export async function validateReleaseVersions({
  packageJsonPath = DEFAULT_PATHS.packageJson,
  packageLockPath = DEFAULT_PATHS.packageLock,
  mcpServerPath = DEFAULT_PATHS.mcpServer,
  releaseTag = undefined,
  gitTagResolver = undefined,
}) {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const packageLock = JSON.parse(await readFile(packageLockPath, "utf8"));
  const mcpServerSource = await readFile(mcpServerPath, "utf8");

  const packageVersion = packageJson.version;
  const packageLockVersion = packageLock.version;
  const packageLockRootVersion = packageLock.packages?.[""]?.version;
  const tagVersion = resolveReleaseTag({
    explicitTag: releaseTag,
    gitTag: gitTagResolver?.() ?? detectTagFromGit(process.cwd()),
  });

  const mismatches = [];
  if (packageLockVersion !== packageVersion) {
    mismatches.push(
      `package-lock.json version ${packageLockVersion} does not match package.json version ${packageVersion}`,
    );
  }

  if (packageLockRootVersion !== packageVersion) {
    mismatches.push(
      `package-lock root package version ${packageLockRootVersion} does not match package.json version ${packageVersion}`,
    );
  }

  if (!MCP_SERVER_VERSION_PATTERN.test(mcpServerSource)) {
    mismatches.push("src/mcp/server.ts must derive MCP version from packageJson.version");
  }

  if (tagVersion !== undefined && tagVersion !== packageVersion) {
    mismatches.push(`Git tag v${tagVersion} does not match package.json version ${packageVersion}`);
  }

  if (mismatches.length) {
    throw new Error(`Release versions are not aligned:\n- ${mismatches.join("\n- ")}`);
  }

  return {
    packageVersion,
    packageLockVersion,
    packageLockRootVersion,
    tagVersion,
    mcpServerUsesPackageVersion: MCP_SERVER_VERSION_PATTERN.test(mcpServerSource),
  };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await validateReleaseVersions({
      releaseTag: process.env.RELEASE_TAG,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
