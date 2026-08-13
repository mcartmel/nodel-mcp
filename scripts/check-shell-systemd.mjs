import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { renderUnit } from "./systemd-render.mjs";
import { realpathSync } from "node:fs";

const run = (command, args) => spawnSync(command, args, { stdio: "inherit" });
const isEnoentError = (error) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const markFailure = (status, signal, fallback = 1) => {
  if (status === 0 || process.exitCode) return;

  const exitCode = status && Number.isInteger(status) && status !== 0 ? status : signal ? 1 : fallback;

  process.exitCode = exitCode;
};

const activeNodePath = realpathSync(process.execPath);

const checkShellcheck = () => {
  const shellcheck = run("shellcheck", ["--version"]);
  if (isEnoentError(shellcheck.error)) {
    console.warn("shellcheck is not installed; shell validation skipped locally (CI installs it).");
    return;
  }

  markFailure(shellcheck.status, shellcheck.signal);
  if (process.exitCode) return;

  const result = run("shellcheck", [
    "scripts/install-systemd-user.sh",
    "scripts/install-systemd-system.sh",
    "scripts/nodel-compatibility-supervisor.sh",
  ]);
  markFailure(result.status, result.signal);
};

const checkSystemd = async () => {
  const systemd = run("systemd-analyze", ["--version"]);
  if (isEnoentError(systemd.error)) {
    console.warn("systemd-analyze is not installed; unit validation skipped locally (CI installs it).");
    return;
  }

  markFailure(systemd.status, systemd.signal);
  if (systemd.status !== 0) return;

  let directory;
  try {
    const source = await readFile("systemd/nodel-ai.system.service.in", "utf8");
    const rendered = renderUnit(source, {
      SERVICE_USER: "nodel-ai",
      INSTALL_DIR: "/opt/nodel-ai",
      ENV_FILE: "/etc/nodel-ai.env",
      STATE_DIR: "/var/lib/nodel-ai",
      NODE_BIN: activeNodePath,
    });
    directory = await mkdtemp(`${tmpdir()}/nodel-ai-unit-`);
    const path = `${directory}/nodel-ai.service`;
    await writeFile(path, rendered);
    const result = run("systemd-analyze", ["verify", path]);
    markFailure(result.status, result.signal);
    const userSource = await readFile("systemd/nodel-ai.service", "utf8");
    await writeFile(
      `${directory}/nodel-ai-user.service`,
      renderUnit(userSource, {
        INSTALL_DIR: "/home/example/nodel-ai",
        ENV_FILE: "/home/example/nodel-ai/.env",
        STATE_DIR: "/home/example/nodel-ai/.state",
        NODE_BIN: activeNodePath,
      }),
    );
    const userResult = run("systemd-analyze", ["verify", `${directory}/nodel-ai-user.service`]);
    markFailure(userResult.status, userResult.signal);
    await writeFile(
      `${directory}/nodel-ai-special.service`,
      renderUnit(userSource, {
        INSTALL_DIR: "/tmp/nodel-ai space/#&%\\path",
        ENV_FILE: "/tmp/nodel-ai space/#&%\\path/.env",
        STATE_DIR: "/tmp/nodel-ai space/#&%\\path/.state",
        NODE_BIN: activeNodePath,
      }),
    );
    const specialResult = run("systemd-analyze", ["verify", `${directory}/nodel-ai-special.service`]);
    markFailure(specialResult.status, specialResult.signal);
  } finally {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
};

const runChecks = async () => {
  checkShellcheck();
  await checkSystemd();
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runChecks();
}

export { markFailure, runChecks };
