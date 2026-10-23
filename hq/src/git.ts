import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export type Run = { code: number; out: string; err: string };

export function run(cmd: string[], cwd: string, env?: Record<string, string | undefined>): Run {
  // Always pass the env: Bun's default for a child is the environment the process started
  // with, not later changes to process.env (HQ_HOME set by a caller would be lost).
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdin: "ignore" });
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}

export function git(args: string[], cwd: string, env?: Record<string, string | undefined>): string {
  const r = run(["git", ...args], cwd, env);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${(r.err || r.out).trim()}`);
  return r.out.trim();
}

/** The repository's shared .git directory, real path (the same for every worktree). */
export function commonDir(cwd: string): string {
  return realpathSync(resolve(cwd, git(["rev-parse", "--git-common-dir"], cwd)));
}

export function revParse(ref: string, cwd: string): string | null {
  const r = run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  return r.code === 0 ? r.out.trim() : null;
}

/** The worktree that has `branch` checked out, if any. */
export function worktreeOf(branch: string, cwd: string): string | null {
  let path: string | null = null;
  for (const line of git(["worktree", "list", "--porcelain"], cwd).split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}
