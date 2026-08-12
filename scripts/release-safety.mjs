import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { compareUtf8 } from "./public-candidate-policy.mjs";

const windowsDrivePrefix = /^[A-Za-z]:\//u;
const forbiddenArchiveMembers =
  /(?:^|\/)(?:src|test|node_modules|coverage|\.git)(?:\/|$)|(?:^|\/)(?:\.env|\.state)(?:$|\/)/u;

export function assertSafeRelative(value, { context = "path" } = {}) {
  const normalized = String(value).replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    windowsDrivePrefix.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Unsafe ${context}: ${value}`);
  }

  return normalized;
}

export function assertSafeArchiveMember(member, { forbidden = forbiddenArchiveMembers } = {}) {
  const normalized = assertSafeRelative(member, { context: "archive member" }).replace(/\/+$/u, "");
  if (forbidden.test(normalized)) {
    throw new Error(`Forbidden archive member: ${member}`);
  }

  return normalized;
}

export async function collectRegularFiles(root) {
  const files = [];
  const walk = async (directory, prefix = "") => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => compareUtf8(a.name, b.name));
    for (const entry of entries) {
      const childPath = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(childPath);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) {
        throw new Error(`Symlink is not allowed in staging: ${relativePath}`);
      }
      if (info.isDirectory()) {
        await walk(childPath, relativePath);
      } else if (info.isFile()) {
        files.push(assertSafeRelative(relativePath));
      } else {
        throw new Error(`Unsupported staging entry: ${relativePath}`);
      }
    }
  };

  await walk(root);
  return files;
}

export function parseArchiveMembers(rawMembers) {
  return String(rawMembers)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((member) => assertSafeArchiveMember(member));
}

export function validateReleaseArchiveMembers(members) {
  return members.map((member) => assertSafeArchiveMember(member));
}
