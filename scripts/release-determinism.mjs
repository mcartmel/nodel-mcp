import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync, execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const epoch =
  process.env.SOURCE_DATE_EPOCH ||
  execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const temp = await mkdtemp(join(tmpdir(), "nodel-ai-determinism-"));

async function hashes(directory) {
  const names = (await readdir(directory)).sort();
  return Promise.all(
    names.map(
      async (name) =>
        `${name}:${createHash("sha256")
          .update(await readFile(join(directory, name)))
          .digest("hex")}`,
    ),
  );
}

function packageTo(directory, umask) {
  const result = spawnSync("npm", ["run", "release:package"], {
    cwd: root,
    env: { ...process.env, SOURCE_DATE_EPOCH: epoch, RELEASE_ARTIFACT_DIR: directory, RELEASE_UMASK: umask },
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("release:package failed during determinism check");
}

try {
  const first = join(temp, "first");
  const second = join(temp, "second");
  packageTo(first, "022");
  packageTo(second, "077");
  const [firstHashes, secondHashes] = await Promise.all([hashes(first), hashes(second)]);
  if (firstHashes.join("\n") !== secondHashes.join("\n")) {
    throw new Error(
      `Release evidence is not deterministic:\n${firstHashes.join("\n")}\n---\n${secondHashes.join("\n")}`,
    );
  }
  packageTo(resolve(root, "artifacts"));
  console.log(`Deterministic release evidence verified with SOURCE_DATE_EPOCH=${epoch}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
