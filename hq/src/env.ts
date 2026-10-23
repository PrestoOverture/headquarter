// `hq env <task>`: ports, temp dir and database name that no other task on this machine uses.
// Ports, database names and $TMPDIR are machine-wide, so all repositories share one allocation file,
// $HQ_HOME/env/allocations.json, keyed by repository id and task; every change is made under one lock
// file created with O_EXCL, so concurrent runs never read the same free block.

import { closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hqHome, repoId } from "./approval";

export const PORT_MIN = 20000;
export const PORT_MAX = 29999;
export const BLOCK = 10;
export const LOCK_STALE_MS = 60_000;

export type Env = { port_base: number; tmpdir: string; db_name: string };
// A Map, so a task named `constructor` is an ordinary key.
type Allocations = Map<string, Env>;

// The database name is hq_<8 hex of the repository>_<task> with dashes as underscores; 51 chars of
// task keep it inside Postgres's 63.
export const validTask = (task: string) => /^[a-z0-9][a-z0-9-]{0,50}$/.test(task);

export const envPath = () => join(hqHome(), "env", "allocations.json");
export const lockPath = () => join(hqHome(), "env", "allocations.lock");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The holder's pid is the first line of a lock file; undefined if the file does not (yet) have one. */
function holderPid(content: string): number | undefined {
  const m = /^(\d+)\n/.exec(content);
  return m ? Number(m[1]) : undefined;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH"; // EPERM: it exists, it is someone else's
  }
}

/** A lock is stale if its holder is gone; one without a readable pid (its writer may be mid-write) only after LOCK_STALE_MS. */
function stale(path: string, content: string): boolean {
  const pid = holderPid(content);
  if (pid !== undefined) return !running(pid);
  return Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS;
}

/** Takes the lock, or takes it over once its holder is gone; returns the release. */
export async function lock(path: string): Promise<() => void> {
  const token = `${process.pid}\n${Math.random()}\n`;
  mkdirSync(join(path, ".."), { recursive: true });
  const release = () => {
    // The lock may have been taken over as stale and be someone else's meanwhile.
    try {
      if (readFileSync(path, "utf8") === token) unlinkSync(path);
    } catch {}
  };
  for (;;) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      writeFileSync(fd, token);
      closeSync(fd);
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (takeOver(path, token)) return release;
    await sleep(10 + Math.random() * 20);
  }
}

/**
 * Replaces a stale lock with ours by renaming our file over it. Waiters do this one at a time under
 * a second lock file and re-read the lock under it, so a lock another waiter has just taken is never replaced.
 */
function takeOver(path: string, token: string): boolean {
  const guard = `${path}.takeover`;
  const mine = `${path}.${process.pid}.${Math.random()}`;
  try {
    if (!stale(path, readFileSync(path, "utf8"))) return false;
    try {
      closeSync(openSync(guard, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL));
    } catch (e) {
      // A waiter that died holding the guard must not block everyone for good.
      if ((e as NodeJS.ErrnoException).code === "EEXIST" && Date.now() - statSync(guard).mtimeMs > LOCK_STALE_MS) unlinkSync(guard);
      return false;
    }
    try {
      if (!stale(path, readFileSync(path, "utf8"))) return false;
      writeFileSync(mine, token);
      renameSync(mine, path);
      return true;
    } finally {
      rmSync(mine, { force: true });
      unlinkSync(guard);
    }
  } catch {
    return false;
  }
}

function read(path: string): Allocations {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(path, "utf8"))));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
}

function write(path: string, all: Allocations) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(all), null, 2) + "\n");
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
  if (!validTask(task)) throw new Error(`bad task name ${task}: lowercase letters, digits and dashes, up to 51`);
  const repo = repoId(cwd);
  const key = `${repo}/${task}`;
  const path = envPath();
  const unlock = await lock(lockPath());
  try {
    const all = read(path);
    const have = all.get(key);
    if (have) {
      mkdirSync(have.tmpdir, { recursive: true });
      return have;
    }
    const taken = new Set([...all.values()].map((e) => e.port_base));
    let base = PORT_MIN;
    for (; base + BLOCK - 1 <= PORT_MAX; base += BLOCK) {
      if (!taken.has(base) && (await freeBlock(base))) break;
    }
    if (base + BLOCK - 1 > PORT_MAX) throw new Error(`no free block of ${BLOCK} ports in ${PORT_MIN}-${PORT_MAX}`);
    const dir = join(tmpdir(), "hq-env", repo, task);
    mkdirSync(dir, { recursive: true });
    const env = { port_base: base, tmpdir: dir, db_name: `hq_${repo.slice(-8)}_${task.replaceAll("-", "_")}` };
    write(path, all.set(key, env));
    return env;
  } finally {
    unlock();
  }
}

/** Frees the task's ports and database name and removes its temp dir; false if it had none. */
export async function release(cwd: string, task: string): Promise<boolean> {
  const key = `${repoId(cwd)}/${task}`;
  const path = envPath();
  const unlock = await lock(lockPath());
  try {
    const all = read(path);
    const env = all.get(key);
    if (!env) return false;
    all.delete(key);
    write(path, all);
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
