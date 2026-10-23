// Bookkeeping for M0 (roadmap M0.3, prd 测评): an append-only event log per repository in
// $HQ_HOME/ledger, outside every worktree and write-denied to executors. hq writes the
// events it witnesses itself (report shown, approval with its active time, merge); the
// rest comes from `hq task …`, `hq escalate` and `hq escape`, run by you or the
// orchestrating session. `hq stats` folds the log into one row per task.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hqHome, repoId } from "./approval";

// claude_diff: a fresh Claude session, not the author, reads the diff (you do not; 2026-10-23).
export const GATES = ["self_test", "full_tests", "codex_review", "claude_diff"] as const;
export type Gate = (typeof GATES)[number];
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export const CAUSES = ["cheat", "misunderstanding", "other"] as const;

export type Event = { at: string } & (
  | { type: "task.start"; task: string; goal: string; title: string; base: string; difficulty: (typeof DIFFICULTIES)[number]; model: string }
  | { type: "task.gate"; task: string; gate: Gate; result: "pass" | "fail"; claimed_done: boolean; note?: string }
  | { type: "task.cost"; task: string; usd: number; model?: string }
  | { type: "task.lines"; task: string; added: number; deleted: number; end: string }
  | { type: "task.shelve"; task: string; why: string }
  | { type: "task.cause"; task: string; cause: (typeof CAUSES)[number]; note?: string }
  | { type: "task.false_reject"; task: string; gate: Gate; note?: string }
  | { type: "escalate"; goal: string; task?: string; why: string; minutes?: number }
  | { type: "escape"; task: string; note: string }
  | { type: "report.shown"; goal: string; commit: string }
  | { type: "approve"; goal: string; commit: string; active_s: number }
  | { type: "merge"; goal: string; commit: string; merge_commit: string }
);

/** An event as written: the `at` stamp is added by append. */
export type NewEvent = Event extends infer E ? (E extends Event ? Omit<E, "at"> : never) : never;

export function ledgerPath(cwd: string): string {
  return join(hqHome(), "ledger", repoId(cwd), "events.jsonl");
}

export function append(cwd: string, e: NewEvent, at = new Date()): Event {
  const event = { at: at.toISOString(), ...e } as Event;
  const p = ledgerPath(cwd);
  mkdirSync(join(p, ".."), { recursive: true });
  appendFileSync(p, JSON.stringify(event) + "\n");
  return event;
}

export function readEvents(cwd: string): Event[] {
  const p = ledgerPath(cwd);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
