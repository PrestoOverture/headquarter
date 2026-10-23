// `hq goal new`: a goal branch, its linked worktree and its goal file, in one step.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  if (!revParse(from, cwd)) throw new Error(`${from} is not a commit`);

  git(["worktree", "add", "-q", "-b", branch, path, `${from}^{commit}`], cwd);
  try {
    mkdirSync(join(path, "goals"), { recursive: true });
    const file = { title: opts.title ?? goal, acceptance: [], shelved: [], known_issues: [] };
    writeFileSync(join(path, "goals", `${goal}.json`), JSON.stringify(file, null, 2) + "\n");
    git(["add", `goals/${goal}.json`], path);
    git(["commit", "-q", "-m", `goal ${goal}: start`], path);
  } catch (e) {
    git(["worktree", "remove", "--force", path], cwd);
    git(["branch", "-D", branch], cwd);
    throw e;
  }
  return { path, branch };
}
