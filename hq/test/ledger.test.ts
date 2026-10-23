// Bookkeeping (roadmap M0.3): the ledger, the commands that write it, and the metrics.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve, record } from "../src/cli";
import { git, revParse } from "../src/git";
import { append, type Event, ledgerPath, readEvents } from "../src/ledger";
import { writeReport } from "../src/report";
import { render, rows, stats } from "../src/stats";

Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
const quiet = () => {}; // approve shows the report and the prompt through this

const day = (d: number, h = 0) => new Date(Date.UTC(2026, 9, 1 + d, h)).toISOString();
const start = (task: string, goal: string, at: string, difficulty: "easy" | "medium" | "hard" = "medium"): Event => ({
  at, type: "task.start", task, goal, title: task, base: "b0", difficulty, model: "claude-sonnet-5-5",
});

describe("stats", () => {
  // a1, a2: goal a, merged day 2; a2 needs rework on day 5 (an escape).
  // b1: goal b, merged day 3; rework found on day 20, outside the 14-day window.
  // c1: shelved. d1: goal d, never merged.
  const events: Event[] = [
    start("a1", "a", day(0), "easy"),
    { at: day(0, 1), type: "task.gate", task: "a1", gate: "self_test", result: "pass", claimed_done: true },
    { at: day(0, 2), type: "task.gate", task: "a1", gate: "codex_review", result: "fail", claimed_done: true, note: "missing null check" },
    { at: day(0, 3), type: "task.gate", task: "a1", gate: "codex_review", result: "pass", claimed_done: true },
    { at: day(0, 4), type: "task.cost", task: "a1", usd: 1.5 },
    { at: day(0, 5), type: "task.cause", task: "a1", cause: "misunderstanding" },
    start("a2", "a", day(0), "hard"),
    { at: day(0, 6), type: "task.gate", task: "a2", gate: "full_tests", result: "fail", claimed_done: false },
    { at: day(0, 7), type: "task.false_reject", task: "a2", gate: "full_tests", note: "flaky clock test" },
    { at: day(0, 8), type: "task.cost", task: "a2", usd: 0.5 },
    start("b1", "b", day(1)),
    { at: day(1, 1), type: "task.cost", task: "b1", usd: 1 },
    start("c1", "c", day(1), "hard"),
    { at: day(1, 2), type: "task.cost", task: "c1", usd: 2 },
    { at: day(1, 3), type: "task.shelve", task: "c1", why: "needs a database" },
    start("d1", "d", day(1)),
    { at: day(1, 4), type: "escalate", goal: "a", task: "a1", why: "acceptance criterion is ambiguous", minutes: 3 },
    { at: day(2), type: "approve", goal: "a", commit: "ca", active_s: 120 },
    { at: day(2, 1), type: "merge", goal: "a", commit: "ca", merge_commit: "ma" },
    { at: day(3), type: "approve", goal: "b", commit: "cb", active_s: 60 },
    { at: day(3, 1), type: "merge", goal: "b", commit: "cb", merge_commit: "mb" },
    { at: day(5), type: "escape", task: "a2", note: "regression in parser" },
    { at: day(20), type: "escape", task: "b1", note: "found late" },
  ];

  test("one row per task", () => {
    const rs = rows(events, new Date(day(30)));
    expect(rs.map((r) => [r.task, r.status])).toEqual([["a1", "merged"], ["a2", "merged"], ["b1", "merged"], ["c1", "shelved"], ["d1", "open"]]);
    const a1 = rs[0]!;
    expect(a1.gates.codex_review).toEqual({ pass: 1, fail: 1, claimed_done_fail: 1 });
    expect(a1.cost_usd).toBe(1.5);
    expect(a1.causes).toEqual(["misunderstanding"]);
    expect(rs[1]!.escaped).toBe(true);
    expect(rs[2]!.escaped).toBe(false); // outside the window
    expect(rs[3]!.shelved_why).toBe("needs a database");
  });

  test("every metric with its denominator", () => {
    const s = stats(events, new Date(day(30)));
    expect(s.tasks).toBe(5);
    expect(s.conclusive).toBe(false);
    expect(s.models).toEqual(["claude-sonnet-5-5"]);
    expect(s.caught_by_gate.codex_review).toEqual({ n: 1, of: 2, rate: 0.5 });
    expect(s.caught_by_gate.full_tests).toEqual({ n: 0, of: 1, rate: 0 }); // failed, but not after claiming done
    expect(s.caught_by_gate.claude_diff).toEqual({ n: 0, of: 0, rate: null });
    expect(s.escalation_rate).toEqual({ n: 1, of: 5, rate: 0.2 });
    expect(s.escape_rate).toEqual({ n: 1, of: 3, rate: 1 / 3 });
    expect(s.escape_windows_open).toBe(0);
    expect(s.pass_rate).toEqual({ n: 3, of: 5, rate: 0.6 });
    expect(s.shelve_rate).toEqual({ n: 1, of: 5, rate: 0.2 });
    expect(s.total_cost_usd).toBe(5);
    expect(s.cost_per_merged_usd).toBeCloseTo(5 / 3); // shelved and open tasks' cost is spread over the merged ones
    expect(s.total_active_s).toBe(120 + 60 + 180);
    expect(s.active_s_per_merged).toBe(120);
    expect(s.false_rejects).toEqual({ n: 1, of: 2, rate: 0.5 });
    expect(s.failure_causes).toEqual({ misunderstanding: 1 });
    expect(s.by_difficulty).toEqual({ easy: { started: 1, merged: 1, shelved: 0 }, medium: { started: 2, merged: 1, shelved: 0 }, hard: { started: 2, merged: 1, shelved: 1 } });
    const md = render(s);
    expect(md).toContain("不满 50 个任务，不下结论");
    expect(md).toContain("| 合格率 | 60%（3/5） |");
    expect(md).toContain("| 自报完成但没过关：codex_review | 50%（1/2） |");
  });

  test("escape windows still open are counted, not assumed clean", () => {
    const s = stats(events.filter((e) => e.type !== "escape"), new Date(day(4)));
    expect(s.escape_rate).toEqual({ n: 0, of: 3, rate: 0 });
    expect(s.escape_windows_open).toBe(3);
  });

  test("a merge before a task started does not count for it", () => {
    const rs = rows([{ at: day(0), type: "merge", goal: "a", commit: "c", merge_commit: "m" }, start("late", "a", day(1))]);
    expect(rs[0]!.status).toBe("open");
  });
});

describe("recording", () => {
  let repo: string;
  beforeEach(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hq-ledger-")));
    process.env.HQ_HOME = join(root, "hq-home");
    process.env.HQ_TTY = join(root, "tty");
    writeFileSync(process.env.HQ_TTY, "x\n");
    repo = join(root, "repo");
    mkdirSync(repo);
    git(["init", "-q", "-b", "main"], repo);
    git(["commit", "-q", "--allow-empty", "-m", "base"], repo);
    git(["branch", "goal/x"], repo);
  });

  test("hq task / escalate / escape append to the ledger outside the repo", () => {
    expect(() => record(repo, ["task", "gate", "t1", "self_test", "pass"])).toThrow("no task t1");
    record(repo, ["task", "start", "t1", "--goal", "x", "--title", "Add stats", "--difficulty", "hard", "--model", "claude-opus-5-5"]);
    record(repo, ["task", "gate", "t1", "codex_review", "fail", "--claimed-done", "--note", "off by one"]);
    record(repo, ["task", "cost", "t1", "0.75"]);
    record(repo, ["task", "cause", "t1", "cheat", "--note", "edited the test"]);
    record(repo, ["task", "false-reject", "t1", "full_tests"]);
    record(repo, ["escalate", "--goal", "x", "--task", "t1", "--why", "blocked", "--minutes", "4"]);
    record(repo, ["escape", "t1", "--note", "broke main"]);
    const ev = readEvents(repo);
    expect(ev.map((e) => e.type)).toEqual(["task.start", "task.gate", "task.cost", "task.cause", "task.false_reject", "escalate", "escape"]);
    expect(ev[0]).toMatchObject({ task: "t1", goal: "x", difficulty: "hard", base: revParse("goal/x", repo) });
    expect(ev[1]).toMatchObject({ gate: "codex_review", result: "fail", claimed_done: true });
    expect(ledgerPath(repo).startsWith(process.env.HQ_HOME!)).toBe(true);
  });

  test("bad input is refused, not recorded", () => {
    expect(() => record(repo, ["task", "start", "t1", "--goal", "x", "--title", "y", "--difficulty", "extreme", "--model", "m"])).toThrow("--difficulty");
    expect(() => record(repo, ["task", "start", "t1", "--goal", "x", "--title", "y"])).toThrow("--model");
    record(repo, ["task", "start", "t1", "--goal", "x", "--title", "y", "--model", "m"]);
    expect(() => record(repo, ["task", "gate", "t1", "lint", "pass"])).toThrow("gate");
    expect(() => record(repo, ["task", "cost", "t1", "lots"])).toThrow("<usd>");
    expect(() => record(repo, ["escalate", "--goal", "x"])).toThrow("--why");
    expect(readEvents(repo)).toHaveLength(1);
  });

  test("approve records the report being shown and the active time to the answer", () => {
    const head = revParse("goal/x", repo)!;
    writeReport(repo, { goal: "x", commit: head, base: head, trial_merge: head, test_code: 0, generated_at: "now" }, "# REPORT BODY", "ok");
    approve(repo, "x", quiet);
    const ev = readEvents(repo);
    expect(ev.map((e) => e.type)).toEqual(["report.shown", "approve"]);
    const a = ev[1]!;
    expect(a.type === "approve" && a.active_s).toBeGreaterThanOrEqual(0);
    expect(a).toMatchObject({ goal: "x", commit: head });
  });

  test("append stamps the time", () => {
    const e = append(repo, { type: "escape", task: "t", note: "n" }, new Date(day(3)));
    expect(e.at).toBe(day(3));
  });
});
