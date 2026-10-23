// `hq goal new`: a goal branch, its linked worktree and its goal file, in one step.

import { existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { goalBranch, MAIN, validGoal } from "./approval";
import { commonDir, git, revParse, run } from "./git";

/** Where goal worktrees live: `<repo>.goals/<goal>`, next to the repository directory. */
export function goalWorktreePath(cwd: string, goal: string): string {
  return join(`${dirname(commonDir(cwd))}.goals`, goal);
}

/** Creates goal/<goal> from main (or `from`) with its first commit; refuses before changing anything. */
export function newGoal(cwd: string, goal: string, opts: { title?: string; from?: string } = {}): { path: string; branch: string } {
  if (!validGoal(goal)) throw new Error(`bad goal name ${goal}: lowercase letters, digits and dashes`);
  const branch = goalBranch(goal);
  if (run(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd).code === 0) throw new Error(`branch ${branch} already exists`);
  const path = goalWorktreePath(cwd, goal);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  const from = opts.from ?? MAIN;
  const start = revParse(from, cwd);
  if (!start) throw new Error(`${from} is not a commit`);
  if (run(["git", "cat-file", "-e", `${start}:goals/${goal}.json`], cwd).code === 0) throw new Error(`goals/${goal}.json already exists at ${from}`);

  const parent = dirname(path);
  const parentExisted = existsSync(parent);
  try {
    git(["worktree", "add", "-q", "-b", branch, path, `${from}^{commit}`], cwd);
    mkdirSync(join(path, "goals"), { recursive: true });
    const file = { title: opts.title ?? goal, acceptance: [], shelved: [], known_issues: [] };
    writeFileSync(join(path, "goals", `${goal}.json`), JSON.stringify(file, null, 2) + "\n");
    git(["add", `goals/${goal}.json`], path);
    git(["commit", "-q", "-m", `goal ${goal}: start`], path);
  } catch (e) {
    rollback(cwd, branch, path, parentExisted ? null : parent);
    throw e;
  }
  return { path, branch };
}

/** Undoes whatever `git worktree add` and the commit got to; each step is best effort so the caller's error stays the one reported. */
function rollback(cwd: string, branch: string, path: string, createdParent: string | null) {
  const attempt = (f: () => unknown) => {
    try {
      f();
    } catch {}
  };
  attempt(() => run(["git", "worktree", "remove", "--force", path], cwd));
  attempt(() => rmSync(path, { recursive: true, force: true }));
  attempt(() => run(["git", "worktree", "prune"], cwd));
  attempt(() => run(["git", "branch", "-D", branch], cwd));
  if (createdParent) attempt(() => rmdirSync(createdParent));
}
