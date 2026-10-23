// Approvals (D29): only from a channel you operate by hand, bound to one commit, stored
// where an executor cannot write. The store is $HQ_HOME (default ~/.hq), outside every
// worktree; the executor sandbox (sandbox.ts) denies writes there.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { commonDir } from "./git";

export const MAIN = "main";
export const goalBranch = (goal: string) => `goal/${goal}`;

export type Approval = { goal: string; branch: string; commit: string; approved_at: string };

export function hqHome(): string {
  return process.env.HQ_HOME ?? join(homedir(), ".hq");
}

/** One approvals dir per repository, keyed by its .git path. */
export function approvalsDir(cwd: string): string {
  const dir = commonDir(cwd);
  const id = `${basename(dir.replace(/\/\.git$/, ""))}-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
  return join(hqHome(), "approvals", id);
}

export function validGoal(goal: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(goal);
}

export function writeApproval(cwd: string, a: Approval) {
  const dir = approvalsDir(cwd);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${a.goal}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(a, null, 2) + "\n");
  renameSync(tmp, join(dir, `${a.goal}.json`));
}

export function readApproval(cwd: string, goal: string): Approval | null {
  const p = join(approvalsDir(cwd), `${goal}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

/** Open approvals (not yet merged), for the main-ref guard. */
export function openApprovals(cwd: string): Approval[] {
  const dir = approvalsDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

/** An approval is spent once its goal is merged; keep it for the record. */
export function consumeApproval(cwd: string, goal: string, mergeCommit: string) {
  const dir = approvalsDir(cwd);
  const merged = join(dir, "merged");
  mkdirSync(merged, { recursive: true });
  const a = readApproval(cwd, goal)!;
  writeFileSync(join(merged, `${goal}-${mergeCommit.slice(0, 12)}.json`), JSON.stringify({ ...a, merge_commit: mergeCommit }, null, 2) + "\n");
  renameSync(join(dir, `${goal}.json`), join(merged, `.${goal}-${mergeCommit.slice(0, 12)}.consumed`));
}
