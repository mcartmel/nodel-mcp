import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { accessSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const userInstaller = fileURLToPath(new URL("../scripts/install-systemd-user.sh", import.meta.url));
const systemInstaller = fileURLToPath(new URL("../scripts/install-systemd-system.sh", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const rootDist = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const canRunSystemInstallTest = (() => {
  try {
    accessSync(rootDist);
    return true;
  } catch {
    return false;
  }
})();

function run(script, env) {
  return spawnSync("sh", [script], {
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
  });
}

function requireSafeNode() {
  return process.execPath;
}

test("user installer refuses symlink component in INSTALL_DIR", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodel-install-user-"));
  try {
    const target = join(root, "target");
    await mkdir(target);
    const link = join(root, "linked");
    await symlink(target, link);

    const result = run(userInstaller, {
      NODE_BIN: requireSafeNode(),
      INSTALL_DIR: join(link, "app"),
      ENV_FILE: join(root, "env").concat("/.env"),
      STATE_DIR: join(root, "state"),
      NODL_INSTALL_DRY_RUN: "1",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to use INSTALL_DIR/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user installer refuses existing state directory with wrong mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodel-install-user-state-"));
  try {
    const installDir = join(root, "app");
    await mkdir(join(installDir, "dist"), { recursive: true });
    await writeFile(join(installDir, "dist/index.js"), "module.exports = {};\n");

    const stateDir = join(root, "bad-state");
    await mkdir(stateDir);
    await chmod(stateDir, 0o755);

    const result = run(userInstaller, {
      NODE_BIN: requireSafeNode(),
      INSTALL_DIR: installDir,
      ENV_FILE: join(root, ".env"),
      STATE_DIR: stateDir,
      NODL_INSTALL_DRY_RUN: "1",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /state directory/);
    assert.match(result.stderr, /expected mode 700/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user installer refuses ENV_FILE that is a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodel-install-user-env-link-"));
  try {
    const installDir = join(root, "app");
    await mkdir(join(installDir, "dist"), { recursive: true });
    await writeFile(join(installDir, "dist/index.js"), "module.exports = {};\n");

    const target = join(root, "env-target");
    await writeFile(target, "NODEL_STATE_DIR=test\nMCP_PORT=0\n", { mode: 0o600 });
    const envFile = join(root, "env-link");
    await symlink(target, envFile);

    const result = run(userInstaller, {
      NODE_BIN: requireSafeNode(),
      INSTALL_DIR: installDir,
      ENV_FILE: envFile,
      STATE_DIR: join(root, "state"),
      NODL_INSTALL_DRY_RUN: "1",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to use ENV_FILE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user installer refuses ENV_FILE with wrong mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodel-install-user-env-mode-"));
  try {
    const installDir = join(root, "app");
    await mkdir(join(installDir, "dist"), { recursive: true });
    await writeFile(join(installDir, "dist/index.js"), "module.exports = {};\n");

    const envFile = join(root, ".env");
    await writeFile(envFile, "NODEL_STATE_DIR=test\nMCP_PORT=0\n", { mode: 0o644 });

    const result = run(userInstaller, {
      NODE_BIN: requireSafeNode(),
      INSTALL_DIR: installDir,
      ENV_FILE: envFile,
      STATE_DIR: join(root, "state"),
      NODL_INSTALL_DRY_RUN: "1",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /environment file/);
    assert.match(result.stderr, /expected mode 600/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "system installer refuses existing state directory with wrong mode",
  { skip: !canRunSystemInstallTest },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nodel-install-system-state-"));
    try {
      const installDir = repositoryRoot;
      const stateDir = join(root, "bad-state");
      await mkdir(stateDir);
      await chmod(stateDir, 0o755);

      const serviceUser = process.env.SUDO_USER || process.env.USER || process.env.LOGNAME || "root";

      const result = run(systemInstaller, {
        NODE_BIN: requireSafeNode(),
        INSTALL_DIR: installDir,
        ENV_FILE: join(root, "nodel-ai.env"),
        STATE_DIR: stateDir,
        SERVICE_USER: serviceUser,
        NODL_INSTALL_DRY_RUN: "1",
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /state directory/);
      assert.match(result.stderr, /expected mode 700/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("system installer refuses ENV_FILE that is a symlink", { skip: !canRunSystemInstallTest }, async () => {
  const root = await mkdtemp(join(tmpdir(), "nodel-install-system-env-link-"));
  try {
    const installDir = repositoryRoot;
    const target = join(root, "env-target");
    await writeFile(target, "NODEL_STATE_DIR=test\nMCP_PORT=0\n", { mode: 0o600 });
    const envFile = join(root, "env-link");
    await symlink(target, envFile);

    const serviceUser = process.env.SUDO_USER || process.env.USER || process.env.LOGNAME || "root";

    const result = run(systemInstaller, {
      NODE_BIN: requireSafeNode(),
      INSTALL_DIR: installDir,
      ENV_FILE: envFile,
      STATE_DIR: join(root, "state"),
      SERVICE_USER: serviceUser,
      NODL_INSTALL_DRY_RUN: "1",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to use ENV_FILE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("system installer refuses ENV_FILE with wrong mode", { skip: !canRunSystemInstallTest }, async () => {
  const root = await mkdtemp(join(tmpdir(), "nodel-install-system-env-mode-"));
  try {
    const installDir = repositoryRoot;
    const envFile = join(root, "nodel-ai.env");
    await writeFile(envFile, "NODEL_STATE_DIR=test\nMCP_PORT=0\n", { mode: 0o644 });

    const serviceUser = process.env.SUDO_USER || process.env.USER || process.env.LOGNAME || "root";

    const result = run(systemInstaller, {
      NODE_BIN: requireSafeNode(),
      INSTALL_DIR: installDir,
      ENV_FILE: envFile,
      STATE_DIR: join(root, "bad-state"),
      SERVICE_USER: serviceUser,
      NODL_INSTALL_DRY_RUN: "1",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /environment file/);
    assert.match(result.stderr, /expected mode 600/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
