// The sanitized repository an M1 task works in (D34, D37): the M0 task's starting tree as one
// fresh commit, with the task's goal file (title, acceptance criteria, scope and check from the
// original goal file at that commit), and the dependencies copied in. Nothing in it leads to M0's
// history or to the real repository.

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, repo, repoDir, sh } from "./common";

export type Spec = { title: string; acceptance: (string | { text: string })[]; scope?: string; check?: string };

/** The M0 task's spec as it was at its starting commit: tasks.<task> of a multi-task goal, else the top level. */
export function specAt(base: string, goal: string, m0: string): Spec {
  const file = JSON.parse(git(["show", `${base}:goals/${goal}.json`], repo));
  const own = file.tasks?.[m0];
  const s = own ?? file;
  return { title: s.title ?? file.title, acceptance: s.acceptance, scope: s.scope, check: s.check };
}

export function prepare(task: string, m0: string, base: string, goal: string): string {
  const dir = repoDir(task);
  if (existsSync(join(dir, ".git"))) return dir;
  mkdirSync(dir, { recursive: true });
  const r = sh(["bash", "-c", `git archive "${base}" | tar -x -C "${dir}"`], repo);
  if (r.code !== 0) throw new Error(`git archive ${base}: ${r.out}`);
  const spec = specAt(base, goal, m0);
  writeFileSync(join(dir, "goals", `${task}.json`), JSON.stringify({ ...spec, replay_of: m0, shelved: [], known_issues: [] }, null, 2) + "\n");
  git(["init", "-q", "-b", "main"], dir);
  git(["add", "-A"], dir);
  git(["-c", "user.name=m1", "-c", "user.email=m1@hq.invalid", "commit", "-q", "-m", `${task}: starting point of ${m0}`], dir);
  // The work happens on branch "answer"; main stays at the starting point (its ref is write-denied
  // in the executor sandbox, as in M0).
  git(["checkout", "-q", "-b", "answer"], dir);
  // gitignored, so not in the archive; tests need them.
  for (const d of ["hq", "eval"]) if (existsSync(join(repo, d, "node_modules")) && existsSync(join(dir, d))) cpSync(join(repo, d, "node_modules"), join(dir, d, "node_modules"), { recursive: true, verbatimSymlinks: true });
  return dir;
}
