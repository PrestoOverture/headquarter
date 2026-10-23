// `hq sync`: bring the latest main into a goal branch with a merge commit, in the goal's
// worktree. Never a rebase: the commits an approval and a report name stay in the history.
// $HQ_HOME is not touched; the old approval and report simply stop matching the new head.

import { existsSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { goalBranch, MAIN, validGoal } from "./approval";
import { git, revParse, run, worktreeOf } from "./git";

/** Paths main adds that land on something the worktree already has untracked. With a clean status that is an ignored file, and git's merge overwrites those silently (--no-overwrite-ignore does nothing in ort). */
function ignoredInTheWay(wt: string, base: string, main: string): string[] {
  const added = git(["diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", base, main], wt).split("\0").filter(Boolean);
  const tracked = (p: string) => git(["ls-files", "-z", "--", p], wt) !== "";
  const clash = (p: string) => {
    for (let d = p; d !== "." && d !== "/"; d = dirname(d)) {
      if (!existsSync(resolve(wt, d))) continue;
      if (d === p || !lstatSync(resolve(wt, d)).isDirectory()) return !tracked(d);
    }
    return false;
  };
  return added.filter(clash);
}

export type SyncResult =
  | { ok: true; upToDate: true; head: string }
  | { ok: true; upToDate: false; before: string; head: string; main: string }
  | { ok: false; conflicts: string[] };

/** Merges main into goal/<goal>; refuses before changing anything, and a conflict is aborted back to the starting state. */
export function sync(cwd: string, goal: string): SyncResult {
  if (!validGoal(goal)) throw new Error(`bad goal name ${goal}: lowercase letters, digits and dashes`);
  const branch = goalBranch(goal);
  const before = revParse(branch, cwd);
  if (!before) throw new Error(`no branch ${branch}`);
  const main = revParse(MAIN, cwd);
  if (!main) throw new Error(`no branch ${MAIN}`);
  const wt = worktreeOf(branch, cwd);
  if (!wt) throw new Error(`${branch} is not checked out in any worktree: hq goal new makes one`);
  if (git(["status", "--porcelain"], wt)) throw new Error(`the worktree ${wt} has uncommitted changes: commit or discard them first`);
  // Clean porcelain does not mean idle: `merge --no-commit` and a finished pick leave nothing dirty. The abort below must never reach one of those.
  for (const [what, path] of [["a merge", "MERGE_HEAD"], ["a cherry-pick", "CHERRY_PICK_HEAD"], ["a revert", "REVERT_HEAD"], ["a rebase", "rebase-merge"], ["a rebase", "rebase-apply"]]) {
    if (existsSync(resolve(wt, git(["rev-parse", "--git-path", path], wt)))) throw new Error(`the worktree ${wt} has ${what} in progress: finish or abort it first`);
  }
  if (run(["git", "merge-base", "--is-ancestor", main, before], cwd).code === 0) return { ok: true, upToDate: true, head: before };

  const clash = ignoredInTheWay(wt, git(["merge-base", main, before], cwd), main);
  if (clash.length) throw new Error(`${MAIN} adds files where the worktree has ignored ones, which the merge would overwrite: ${clash.join(", ")}; move them away first`);

  const m = run(["git", "merge", "--no-ff", "--no-edit","-m", `Merge ${MAIN} into ${branch}`, main], wt);
  if (m.code === 0) return { ok: true, upToDate: false, before, head: git(["rev-parse", "HEAD"], wt), main };
  // Only undo a merge this command started; anything else that failed changed nothing.
  if (run(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], wt).code !== 0) throw new Error(`git merge ${MAIN}: ${(m.err || m.out).trim()}`);
  const conflicts = git(["diff", "--name-only", "--diff-filter=U"], wt).split("\n").filter(Boolean);
  git(["merge", "--abort"], wt);
  if (!conflicts.length) throw new Error(`git merge ${MAIN} failed and was aborted: ${(m.err || m.out).trim()}`);
  return { ok: false, conflicts };
}
