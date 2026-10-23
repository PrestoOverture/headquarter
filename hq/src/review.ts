// Codex review as a recorded gate (D28): `codex review` over a task's changes, the findings
// parsed into priorities, P0 and P1 fail the gate. The full output is kept in
// $HQ_HOME/reviews, keyed by the goal commit it reviewed, so the gate result can be checked
// against what Codex actually said.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { goalBranch, hqHome, repoId, validGoal } from "./approval";
import { git, revParse, run, worktreeOf } from "./git";
import { append, readEvents } from "./ledger";

export type Finding = { priority: 0 | 1 | 2 | 3; title: string; file?: string; line?: number };
export type Review = { goal: string; task: string; commit: string; path: string; output: string; findings: Finding[]; result: "pass" | "fail"; recorded: boolean };

const FINDING = /^\s*- \[P([0-3])\]\s+(.+?)(?:\s+[—–-]+\s+(\S+?):(\d+)(?:-\d+)?)?\s*$/;

export function reviewsDir(cwd: string): string {
  return join(hqHome(), "reviews", repoId(cwd));
}

/** The `- [P1] title — path:line` lines of a review; Codex prints the list twice, so repeats collapse. */
export function parseFindings(output: string): Finding[] {
  const seen = new Set<string>();
  const found: Finding[] = [];
  for (const text of output.split("\n")) {
    const m = FINDING.exec(text);
    if (!m) continue;
    const f: Finding = { priority: Number(m[1]) as Finding["priority"], title: m[2]! };
    if (m[3]) Object.assign(f, { file: m[3], line: Number(m[4]) });
    const key = JSON.stringify(f);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(f);
  }
  return found;
}

export const verdict = (findings: Finding[]): "pass" | "fail" => (findings.some((f) => f.priority <= 1) ? "fail" : "pass");

const where = (f: Finding) => (f.file ? ` (${f.file}${f.line === undefined ? "" : `:${f.line}`})` : "");

function note(findings: Finding[], path: string): string {
  if (!findings.length) return `codex review: no findings; ${path}`;
  return `codex review: ${findings.map((f) => `[P${f.priority}] ${f.title}${where(f)}`).join("; ")}; ${path}`;
}

/**
 * Runs `codex review --base <the task's base>` in the goal's worktree. Codex reviews against a
 * branch, so a throwaway one points at the recorded base and is deleted afterwards. A codex
 * that fails records nothing: no result is not a pass.
 */
export function review(cwd: string, goal: string, task: string, opts: { claimedDone?: boolean; record?: boolean } = {}): Review {
  if (!validGoal(goal)) throw new Error(`bad goal name ${goal}: lowercase letters, digits and dashes`);
  if (!/^[A-Za-z0-9][\w.-]*$/.test(task)) throw new Error(`bad task name ${task}`);
  const start = readEvents(cwd).filter((e) => e.type === "task.start" && e.task === task).pop();
  if (start?.type !== "task.start") throw new Error(`no task ${task}: hq task start it first`);
  if (start.goal !== goal) throw new Error(`task ${task} belongs to goal ${start.goal}, not ${goal}`);
  const commit = revParse(goalBranch(goal), cwd);
  if (!commit) throw new Error(`no branch ${goalBranch(goal)}`);
  const wt = worktreeOf(goalBranch(goal), cwd);
  if (!wt) throw new Error(`${goalBranch(goal)} is not checked out in any worktree`);

  const tmp = `hq-review/${task}-${process.pid}`;
  git(["branch", "-f", tmp, start.base], cwd);
  let r;
  try {
    r = run(["codex", "review", "--base", tmp], wt);
  } finally {
    run(["git", "branch", "-D", tmp], cwd);
  }
  const output = r.out + r.err;
  const dir = reviewsDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${goal}-${commit.slice(0, 12)}-${task}.txt`);
  writeFileSync(path, output);
  if (r.code !== 0) throw new Error(`codex review exited ${r.code}; nothing recorded, output in ${path}\n${output.trim().split("\n").slice(-5).join("\n")}`);

  const findings = parseFindings(output);
  const result = verdict(findings);
  const record = opts.record ?? true;
  if (record) append(cwd, { type: "task.gate", task, gate: "codex_review", result, claimed_done: opts.claimedDone ?? false, note: note(findings, path) });
  return { goal, task, commit, path, output, findings, result, recorded: record };
}

export function render(r: Review): string {
  const lines = [r.findings.length ? `${r.findings.length} finding(s):` : "no findings:"];
  for (const f of r.findings) lines.push(`  [P${f.priority}] ${f.title}${where(f)}`);
  lines.push(`codex_review ${r.result} (P0 and P1 fail it); ${r.recorded ? "recorded" : "not recorded"}; full output ${r.path}`);
  return lines.join("\n");
}
