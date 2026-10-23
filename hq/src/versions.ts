// The running hq is separate from the hq being changed (roadmap M0.4, D44). `hq install`
// takes hq/ from a commit on main (never from a working tree) into
// $HQ_HOME/versions/<commit>, and points $HQ_HOME/current at it; the version it replaces
// becomes $HQ_HOME/previous, for `hq rollback`. The launcher $HQ_HOME/bin/hq and the git
// hook run whatever `current` is, so a task editing hq/src in its worktree changes nothing
// that judges it. $HQ_HOME is write-denied to executors.

import { chmodSync, existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { hqHome, MAIN } from "./approval";
import { git, revParse, run } from "./git";

const KEEP = new Set(["current", "previous"]);

export const versionsDir = () => join(hqHome(), "versions");
export const launcherPath = () => join(hqHome(), "bin", "hq");
const link = (name: string) => join(hqHome(), name);

/** The installed commit a link points at, or null. */
export function installed(name: "current" | "previous"): string | null {
  try {
    return basename(readlinkSync(link(name)));
  } catch {
    return null;
  }
}

function pointAt(name: string, target: string) {
  const tmp = `${link(name)}.tmp`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link(name)); // atomic swap
}

export function launcherScript(bun: string): string {
  return `#!/bin/bash\n# installed by hq install: runs the current installed version\nexec "${bun}" "${join(hqHome(), "current", "hq", "src", "cli.ts")}" "$@"\n`;
}

/** Installs hq/ as of `rev` (default main) and makes it current. Returns the commit. */
export function install(cwd: string, rev = MAIN, bun = process.execPath): string {
  const commit = revParse(rev, cwd);
  if (!commit) throw new Error(`no commit ${rev}`);
  const id = commit.slice(0, 12);
  const dir = join(versionsDir(), id);
  if (!existsSync(join(dir, "hq", "src", "cli.ts"))) {
    const tmp = `${dir}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const archive = run(["bash", "-c", `git archive "${commit}" hq | tar -x -C "${tmp}"`], cwd);
    if (archive.code !== 0 || !existsSync(join(tmp, "hq", "src", "cli.ts"))) throw new Error(`no hq/ at ${id}: ${archive.err.trim()}`);
    // Dependencies from the lockfile, preferring bun's local cache.
    const deps = run([bun, "install", "--frozen-lockfile", "--production", "--prefer-offline"], join(tmp, "hq"));
    if (deps.code !== 0) throw new Error(`bun install failed in ${id}:\n${(deps.out + deps.err).trim()}`);
    renameSync(tmp, dir);
  }
  const current = installed("current");
  if (current !== id) {
    if (current) pointAt("previous", join(versionsDir(), current));
    pointAt("current", dir);
  }
  mkdirSync(join(hqHome(), "bin"), { recursive: true });
  writeFileSync(launcherPath(), launcherScript(bun));
  chmodSync(launcherPath(), 0o755);
  prune();
  return commit;
}

/** Swaps current and previous. */
export function rollback(): string {
  const current = installed("current");
  const previous = installed("previous");
  if (!previous) throw new Error("no previous version to roll back to");
  pointAt("current", join(versionsDir(), previous));
  if (current) pointAt("previous", join(versionsDir(), current));
  return previous;
}

/** Only current and previous are kept. */
function prune() {
  const keep = new Set([...KEEP].map((n) => installed(n as "current" | "previous")).filter(Boolean));
  for (const d of readdirSync(versionsDir())) if (!keep.has(d)) rmSync(join(versionsDir(), d), { recursive: true, force: true });
}

/** After a merge: reinstall when the goal changed hq/ and an installed version exists. */
export function reinstallIfChanged(cwd: string, base: string, merged: string): string | null {
  if (!installed("current")) return null;
  const changed = git(["diff", "--name-only", base, merged, "--", "hq"], cwd);
  return changed ? install(cwd, merged) : null;
}
