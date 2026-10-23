// `hq env <task>`: ports, temp dir and database name that no other task on this machine uses.
// Allocations live in $HQ_HOME/env/<repo>.json; every change is made under a lock file
// created with O_EXCL, so concurrent runs never read the same free block.

import { closeSync, constants, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hqHome, repoId } from "./approval";

export const PORT_MIN = 20000;
export const PORT_MAX = 29999;
export const BLOCK = 10;
export const LOCK_STALE_MS = 60_000;

export type Env = { port_base: number; tmpdir: string; db_name: string };
type Allocations = Record<string, Env>;

// The database name is hq_<task> with dashes as underscores; 60 chars keeps it inside Postgres's 63.
export const validTask = (task: string) => /^[a-z0-9][a-z0-9-]{0,59}$/.test(task);

export function envPath(cwd: string): string {
  return join(hqHome(), "env", `${repoId(cwd)}.json`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Takes the lock, or breaks it once its file is older than LOCK_STALE_MS; returns the release. */
async function lock(path: string): Promise<() => void> {
  const lockPath = `${path}.lock`;
  const token = `${process.pid}.${Math.random()}`;
  mkdirSync(join(path, ".."), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      writeFileSync(fd, token);
      closeSync(fd);
      return () => {
        // The lock may have been broken as stale and taken by someone else meanwhile.
        try {
          if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
        } catch {}
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    breakIfStale(lockPath);
    await sleep(10 + Math.random() * 20);
  }
}

function breakIfStale(lockPath: string) {
  const age = (p: string) => Date.now() - statSync(p).mtimeMs;
  try {
    if (age(lockPath) <= LOCK_STALE_MS) return;
    // Rename first, so of several waiters only one gets the file; if it turns out fresh
    // (the holder changed since we looked), put it back.
    const moved = `${lockPath}.stale.${process.pid}.${Math.random()}`;
    renameSync(lockPath, moved);
    if (age(moved) <= LOCK_STALE_MS) {
      try {
        linkSync(moved, lockPath);
      } catch {}
    }
    unlinkSync(moved);
  } catch {}
}

function read(path: string): Allocations {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
}

function write(path: string, all: Allocations) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
  renameSync(tmp, path);
}

/** True if nothing is listening on this port of 127.0.0.1 and we can bind it. */
function free(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

async function freeBlock(base: number): Promise<boolean> {
  for (let p = base; p < base + BLOCK; p++) if (!(await free(p))) return false;
  return true;
}

/** The task's allocation: the same one on every call until released. */
export async function allocate(cwd: string, task: string): Promise<Env> {
  if (!validTask(task)) throw new Error(`bad task name ${task}: lowercase letters, digits and dashes, up to 60`);
  const path = envPath(cwd);
  const unlock = await lock(path);
  try {
    const all = read(path);
    if (all[task]) {
      mkdirSync(all[task].tmpdir, { recursive: true });
      return all[task];
    }
    const taken = new Set(Object.values(all).map((e) => e.port_base));
    let base = PORT_MIN;
    for (; base + BLOCK - 1 <= PORT_MAX; base += BLOCK) {
      if (!taken.has(base) && (await freeBlock(base))) break;
    }
    if (base + BLOCK - 1 > PORT_MAX) throw new Error(`no free block of ${BLOCK} ports in ${PORT_MIN}-${PORT_MAX}`);
    const dir = join(tmpdir(), "hq-env", task);
    mkdirSync(dir, { recursive: true });
    const env = { port_base: base, tmpdir: dir, db_name: `hq_${task.replaceAll("-", "_")}` };
    write(path, { ...all, [task]: env });
    return env;
  } finally {
    unlock();
  }
}

/** Frees the task's ports and database name and removes its temp dir; false if it had none. */
export async function release(cwd: string, task: string): Promise<boolean> {
  const path = envPath(cwd);
  const unlock = await lock(path);
  try {
    const { [task]: env, ...rest } = read(path);
    if (!env) return false;
    write(path, rest);
    rmSync(env.tmpdir, { recursive: true, force: true });
    return true;
  } finally {
    unlock();
  }
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function render(e: Env): string {
  return [`export HQ_PORT_BASE=${e.port_base}`, `export HQ_TMPDIR=${quote(e.tmpdir)}`, `export HQ_DB_NAME=${quote(e.db_name)}`].join("\n");
}
