// `hq sync`: bring the latest main into a goal branch with a merge commit, in the goal's
// worktree. Never a rebase: the commits an approval and a report name stay in the history.
// $HQ_HOME is not touched; the old approval and report simply stop matching the new head.

import { goalBranch, MAIN, validGoal } from "./approval";
import { git, revParse, run, worktreeOf } from "./git";

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
  if (run(["git", "merge-base", "--is-ancestor", main, before], cwd).code === 0) return { ok: true, upToDate: true, head: before };

  const m = run(["git", "merge", "--no-ff", "--no-edit", "-m", `Merge ${MAIN} into ${branch}`, main], wt);
  if (m.code === 0) return { ok: true, upToDate: false, before, head: git(["rev-parse", "HEAD"], wt), main };
  // Only undo a merge this command started; anything else that failed changed nothing.
  if (run(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], wt).code !== 0) throw new Error(`git merge ${MAIN}: ${(m.err || m.out).trim()}`);
  const conflicts = git(["diff", "--name-only", "--diff-filter=U"], wt).split("\n").filter(Boolean);
  git(["merge", "--abort"], wt);
  if (!conflicts.length) throw new Error(`git merge ${MAIN} failed and was aborted: ${(m.err || m.out).trim()}`);
  return { ok: false, conflicts };
}
