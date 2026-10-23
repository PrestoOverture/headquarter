// `hq sync`: bring the latest main into a goal branch with a merge commit, in the goal's
// worktree. Never a rebase: the commits an approval and a report name stay in the history.
// $HQ_HOME is not touched; the old approval and report simply stop matching the new head.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { goalBranch, MAIN, validGoal } from "./approval";
import { git, revParse, run, worktreeOf } from "./git";

/** NUL-separated path list from a git command that must succeed (git() would trim a leading space off the first path). */
function paths(args: string[], wt: string): string[] {
  const r = run(["git", ...args], wt);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${(r.err || r.out).trim()}`);
  return r.out.split("\0").filter(Boolean);
}

/** Paths main changes that are, or sit under or over, a file the worktree has untracked or ignored. A clean status hides those; the merge overwrites them (--no-overwrite-ignore does nothing in ort) or, on a conflict, loses them in the abort. */
function untrackedInTheWay(wt: string, base: string, main: string): string[] {
  // --no-renames lists a rename as its deleted source and its added target, so every touched path appears.
  const changed = paths(["diff", "--name-only", "--no-renames", "-z", base, main], wt);
  const local = [
    ...new Set([
      ...paths(["ls-files", "--others", "-z"], wt),
      ...paths(["ls-files", "--others", "--exclude-standard", "-z"], wt),
      ...paths(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], wt),
    ]),
  ];
  // On a case-insensitive file system Notes.md from main lands on a local notes.md.
  const fold = run(["git", "config", "--type=bool", "core.ignorecase"], wt).out.trim() === "true" ? (p: string) => p.toLowerCase() : (p: string) => p;
  const changedKeys = new Set(changed.map(fold));
  const localKeys = new Set(local.map(fold));
  const parents = (p: string) => {
    const out: string[] = [];
    for (let d = dirname(p); d !== "."; d = dirname(d)) out.push(fold(d));
    return out;
  };
  const clash = new Set<string>();
  for (const c of changed) if (localKeys.has(fold(c)) || parents(c).some((d) => localKeys.has(d))) clash.add(c);
  for (const l of local) if (parents(l).some((d) => changedKeys.has(d))) clash.add(l);
  return [...clash].sort();
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

  const clash = untrackedInTheWay(wt, git(["merge-base", main, before], cwd), main);
  if (clash.length) throw new Error(`${MAIN} changes paths where the worktree has untracked or ignored files, which the merge would overwrite or lose: ${clash.join(", ")}; move them away first`);

  // No rename detection of either kind: a rename must not move a file to a path `git diff <base> main` does not list, which the clash check above relies on. --commit overrides a configured branch.<goal>.mergeOptions=--no-commit.
  const m = run(["git", "-c", "merge.directoryRenames=false", "merge", "--no-ff", "--commit", "-X", "no-renames", "--no-edit", "-m", `Merge ${MAIN} into ${branch}`, main], wt);
  const mergeInProgress = () => run(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], wt).code === 0;
  if (m.code === 0) {
    const [head, ...parents] = git(["rev-list", "--parents", "-1", "HEAD"], wt).split(" ");
    if (!mergeInProgress() && parents.length === 2 && parents[0] === before && parents[1] === main) return { ok: true, upToDate: false, before, head, main };
    // The worktree was clean and idle when sync started, so putting it back to `before` loses nothing.
    if (mergeInProgress()) git(["merge", "--abort"], wt);
    else git(["reset", "--hard", before], wt);
    throw new Error(`git merge ${MAIN} did not make a merge commit of ${before.slice(0, 12)} and ${main.slice(0, 12)}; it was undone`);
  }
  // Only undo a merge this command started; anything else that failed changed nothing.
  if (!mergeInProgress()) throw new Error(`git merge ${MAIN}: ${(m.err || m.out).trim()}`);
  const conflicts = git(["diff", "--name-only", "--diff-filter=U"], wt).split("\n").filter(Boolean);
  git(["merge", "--abort"], wt);
  if (!conflicts.length) throw new Error(`git merge ${MAIN} failed and was aborted: ${(m.err || m.out).trim()}`);
  return { ok: false, conflicts };
}
