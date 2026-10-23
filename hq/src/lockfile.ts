// Lock files shared by `hq env` and `hq merge`: created with O_EXCL, holding the owner's pid in the
// first line, and taken over once that pid is gone.

import { closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const LOCK_STALE_MS = 60_000;

/** The holder's pid is the first line of a lock file; undefined if the file does not (yet) have one. */
function holderPid(content: string): number | undefined {
  const m = /^(\d+)\n/.exec(content);
  return m ? Number(m[1]) : undefined;
}

/** The pid holding the lock at `path`; undefined if there is no lock or it has no pid yet. */
export function holder(path: string): number | undefined {
  try {
    return holderPid(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
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

/** One attempt to take the lock, or to take it over if its holder is gone; returns the release, or null if someone holds it. */
export function tryLock(path: string): (() => void) | null {
  const token = `${process.pid}\n${Math.random()}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const release = () => {
    // The lock may have been taken over as stale and be someone else's meanwhile.
    try {
      if (readFileSync(path, "utf8") === token) unlinkSync(path);
    } catch {}
  };
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    writeFileSync(fd, token);
    closeSync(fd);
    return release;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return takeOver(path, token) ? release : null;
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
