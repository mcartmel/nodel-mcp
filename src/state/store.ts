import {
  appendFileSync,
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type PathLike,
} from "node:fs";
import { dirname, join } from "node:path";
import { PublicError, publicError } from "../shared/publicErrors.js";

export type StateClock = { now(): Date };
export type StateUuid = () => string;

export type StateFilesystem = Pick<
  typeof import("node:fs"),
  | "appendFileSync"
  | "chmodSync"
  | "closeSync"
  | "existsSync"
  | "fsyncSync"
  | "mkdirSync"
  | "openSync"
  | "readFileSync"
  | "readdirSync"
  | "renameSync"
  | "statSync"
  | "unlinkSync"
  | "writeFileSync"
>;

export type StateRuntime = {
  pid: number;
  uuid(): string;
  isProcessAlive(pid: number): boolean;
};

const nativeFs: StateFilesystem = {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
};
const nativeRuntime: StateRuntime = {
  pid: process.pid,
  uuid: () => crypto.randomUUID(),
  isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  },
};
const MALFORMED_LOCK_GRACE_MS = 5 * 60 * 1000;

export class StateStore {
  private lockFd: number | undefined;

  constructor(
    readonly dir: string,
    readonly fs: StateFilesystem = nativeFs,
    readonly clock: StateClock = { now: () => new Date() },
    readonly runtime: StateRuntime = nativeRuntime,
  ) {}

  initialize() {
    try {
      this.fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.fs.chmodSync(this.dir, 0o700);
    } catch (error) {
      throw error instanceof PublicError
        ? error
        : publicError("STATE", `Unable to initialize state directory: ${this.dir}.`, { cause: error });
    }
  }

  acquireStartupLock() {
    this.initialize();
    if (this.lockFd !== undefined) return;
    const lockPath = join(this.dir, ".instance.lock");
    this.recoverStaleLock(lockPath);
    let fd: number | undefined;
    let created = false;
    try {
      fd = this.fs.openSync(lockPath, "wx", 0o600);
      created = true;
      const record = {
        version: 1,
        pid: this.runtime.pid,
        createdAt: this.clock.now().toISOString(),
        instanceId: this.runtime.uuid(),
      };
      this.fs.writeFileSync(fd as unknown as PathLike, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      this.fs.fsyncSync(fd);
      this.fs.chmodSync(lockPath, 0o600);
      this.lockFd = fd;
    } catch (error) {
      if (fd !== undefined) this.fs.closeSync(fd);
      if (created) {
        try {
          this.fs.unlinkSync(lockPath);
        } catch {
          /* do not mask the startup failure */
        }
      }
      throw publicError(
        "STATE",
        `State directory is already in use or cannot be locked: ${this.dir}. Stop the other sidecar instance or recover the stale .instance.lock.`,
        { cause: error },
      );
    }
  }

  close() {
    if (this.lockFd === undefined) return;
    const lockPath = join(this.dir, ".instance.lock");
    this.fs.closeSync(this.lockFd);
    this.lockFd = undefined;
    try {
      this.fs.unlinkSync(lockPath);
    } catch {
      /* shutdown best effort */
    }
  }

  ensureDirectory(path: string) {
    this.fs.mkdirSync(path, { recursive: true, mode: 0o700 });
    this.fs.chmodSync(path, 0o700);
    return path;
  }

  atomicWrite(path: string, contents: string | Uint8Array) {
    this.ensureDirectory(dirname(path));
    const temporary = `${path}.tmp-${process.pid}-${this.clock.now().getTime()}-${Math.random().toString(16).slice(2)}`;
    let fd: number | undefined;
    try {
      fd = this.fs.openSync(temporary, "wx", 0o600);
      this.fs.writeFileSync(fd as unknown as PathLike, contents, { mode: 0o600 });
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = undefined;
      this.fs.renameSync(temporary, path);
      this.fs.chmodSync(path, 0o600);
      const directoryFd = this.fs.openSync(dirname(path), "r");
      try {
        this.fs.fsyncSync(directoryFd);
      } finally {
        this.fs.closeSync(directoryFd);
      }
    } catch (error) {
      if (fd !== undefined) this.fs.closeSync(fd);
      try {
        this.fs.unlinkSync(temporary);
      } catch {
        /* preserve original file */
      }
      throw error instanceof PublicError
        ? error
        : publicError("STATE", `Unable to persist state file: ${path}.`, { cause: error });
    }
  }

  durableRename(source: string, target: string) {
    this.fs.renameSync(source, target);
    const directoryFd = this.fs.openSync(dirname(target), "r");
    try {
      this.fs.fsyncSync(directoryFd);
    } finally {
      this.fs.closeSync(directoryFd);
    }
  }

  private recoverStaleLock(lockPath: string) {
    if (!this.fs.existsSync(lockPath)) return;
    const parsed = this.readLock(lockPath);
    if (parsed.kind === "valid" && this.runtime.isProcessAlive(parsed.pid)) {
      throw publicError("STATE", `State directory is already in use by live PID ${parsed.pid}: ${this.dir}.`);
    }
    if (
      parsed.kind === "malformed" &&
      this.clock.now().getTime() - this.fs.statSync(lockPath).mtimeMs < MALFORMED_LOCK_GRACE_MS
    ) {
      throw publicError(
        "STATE",
        `State directory has a recent malformed startup lock: ${lockPath}. Refusing to remove it; inspect it after the grace period.`,
      );
    }
    const reason = parsed.kind === "valid" ? "stale" : "malformed";
    const quarantine = `${lockPath}.${reason}-${this.clock.now().getTime()}-${this.runtime.uuid()}`;
    try {
      this.durableRename(lockPath, quarantine);
      this.fs.chmodSync(quarantine, 0o600);
    } catch (error) {
      throw publicError("STATE", `Unable to quarantine ${reason} startup lock ${lockPath}; refusing startup.`, {
        cause: error,
      });
    }
  }

  private readLock(lockPath: string): { kind: "valid"; pid: number } | { kind: "malformed" } {
    try {
      const text = this.fs.readFileSync(lockPath, "utf8").trim();
      const rawPid = /^\d+$/u.test(text) ? Number(text) : (JSON.parse(text) as { pid?: unknown }).pid;
      return typeof rawPid === "number" && Number.isSafeInteger(rawPid) && rawPid > 0
        ? { kind: "valid", pid: rawPid }
        : { kind: "malformed" };
    } catch {
      return { kind: "malformed" };
    }
  }
}

const stores = new Map<string, StateStore>();

export function stateStore(stateDir: string) {
  let store = stores.get(stateDir);
  if (!store) {
    store = new StateStore(stateDir);
    store.initialize();
    stores.set(stateDir, store);
  }
  return store;
}
