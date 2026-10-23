// Merging an approved goal into main (D29). The approval must name the goal branch's
// current commit; the merge commit is built on the latest main in a scratch worktree and
// the full tests run on exactly that commit, inside the executor sandbox (D35). main
// then moves to that commit only if it has not moved meanwhile. One --no-ff merge commit
// per goal, so one `git revert -m 1` takes the whole goal back out.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeApproval, goalBranch, MAIN, readApproval } from "./approval";
import { commonDir, git, revParse, run, worktreeOf } from "./git";
import { sandboxed } from "./sandbox";

export type Config = { test: string };
export type MergeResult =
  | { ok: true; mergeCommit: string; revert: string; testOutput: string }
  | { ok: false; reason: string; testOutput?: string };

/** The test command comes from main, so a goal cannot weaken the tests it is judged by. */
export function readConfig(cwd: string): Config {
  const r = run(["git", "show", `${MAIN}:.hq.json`], cwd);
  if (r.code !== 0) throw new Error(`no .hq.json on ${MAIN}: add one with {"test": "<full test command>"}`);
  const c = JSON.parse(r.out);
  if (typeof c.test !== "string" || !c.test.trim()) throw new Error(`.hq.json on ${MAIN} has no "test" command`);
  return c;
}

export function merge(cwd: string, goal: string): MergeResult {
  const approval = readApproval(cwd, goal);
  if (!approval) return { ok: false, reason: `goal ${goal} is not approved: run \`hq approve ${goal}\`` };
  const head = revParse(goalBranch(goal), cwd);
  if (!head) return { ok: false, reason: `no branch ${goalBranch(goal)}` };
  if (head !== approval.commit)
    return {
      ok: false,
      reason: `${goalBranch(goal)} is at ${head.slice(0, 12)} but the approval is for ${approval.commit.slice(0, 12)}: new commits void an approval; approve again`,
    };
  const base = revParse(MAIN, cwd);
  if (!base) return { ok: false, reason: `no branch ${MAIN}` };
  const config = readConfig(cwd);
  const dir = commonDir(cwd);
  const scratch = mkdtempSync(join(tmpdir(), `hq-merge-${goal}-`));
  try {
    git(["worktree", "add", "--detach", "-q", scratch, base], cwd);
    const m = run(["git", "merge", "--no-ff", "--no-edit", "-m", `Merge goal ${goal}\n\nApproved commit: ${head}`, head], scratch);
    if (m.code !== 0) return { ok: false, reason: `goal ${goal} does not merge cleanly into ${MAIN}:\n${(m.out + m.err).trim()}` };
    const merged = git(["rev-parse", "HEAD"], scratch);
    const t = sandboxed(config.test, scratch, { writable: [scratch], commonDir: dir });
    const testOutput = t.out + t.err;
    if (t.code !== 0) return { ok: false, reason: `tests failed on the merge with the latest ${MAIN} (exit ${t.code})`, testOutput };
    if (revParse(MAIN, cwd) !== base) return { ok: false, reason: `${MAIN} moved while the tests ran; run hq merge again`, testOutput };
    // Through git, so the main-ref guard sees the update; the checked-out main follows.
    const wt = worktreeOf(MAIN, cwd);
    if (wt) git(["merge", "--ff-only", "-q", merged], wt);
    else git(["update-ref", `refs/heads/${MAIN}`, merged, base], cwd);
    consumeApproval(cwd, goal, merged);
    return { ok: true, mergeCommit: merged, revert: `git revert -m 1 ${merged}`, testOutput };
  } finally {
    run(["git", "worktree", "remove", "--force", scratch], cwd);
    rmSync(scratch, { recursive: true, force: true });
  }
}
