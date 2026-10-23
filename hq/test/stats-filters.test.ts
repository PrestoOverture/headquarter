// hq stats --goal / --since / --until / --csv: what each filter keeps, how they combine, and the CSV.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statsCommand } from "../src/cli";
import { git } from "../src/git";
import { append, type NewEvent } from "../src/ledger";

Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

const day = (d: number, h = 0) => new Date(Date.UTC(2026, 9, 1 + d, h));
const CLI = join(import.meta.dir, "../src/cli.ts");

let repo: string;
const put = (at: Date, e: NewEvent) => append(repo, e, at);
const start = (task: string, goal: string, at: Date, title = task) =>
  put(at, { type: "task.start", task, goal, title, base: "b0", difficulty: "medium", model: "claude-sonnet-5-5" });
const json = (...args: string[]) => JSON.parse(statsCommand(repo, ["--json", ...args]));
const tasks = (...args: string[]): string[] =>
  statsCommand(repo, ["--tasks", ...args]).split("\n").filter(Boolean).map((l) => JSON.parse(l).task);

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hq-statsf-")));
  process.env.HQ_HOME = join(root, "hq-home");
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  git(["commit", "-q", "--allow-empty", "-m", "base"], repo);
  // a1 (day 0) and a2 (day 5) in goal a; b1 (day 1) in goal b. Each goal is escalated, approved and merged.
  start("a1", "a", day(0));
  put(day(0, 1), { type: "task.cost", task: "a1", usd: 1 });
  put(day(0, 2), { type: "task.gate", task: "a1", gate: "self_test", result: "fail", claimed_done: true });
  start("b1", "b", day(1));
  put(day(1, 1), { type: "task.cost", task: "b1", usd: 2 });
  start("a2", "a", day(5));
  put(day(5, 1), { type: "task.cost", task: "a2", usd: 4 });
  put(day(6), { type: "escalate", goal: "a", why: "unclear", minutes: 1 });
  put(day(6), { type: "escalate", goal: "b", why: "unclear", minutes: 2 });
  put(day(7), { type: "report.shown", goal: "a", commit: "ca" });
  put(day(7, 1), { type: "approve", goal: "a", commit: "ca", active_s: 60 });
  put(day(7, 2), { type: "merge", goal: "a", commit: "ca", merge_commit: "ma" });
  put(day(8), { type: "approve", goal: "b", commit: "cb", active_s: 600 });
  put(day(8, 1), { type: "merge", goal: "b", commit: "cb", merge_commit: "mb" });
  put(day(9), { type: "escape", task: "a1", note: "regressed" });
});

describe("--goal", () => {
  test("keeps the tasks and the goal-level events of that goal only", () => {
    expect(tasks("--goal", "a")).toEqual(["a1", "a2"]);
    const s = json("--goal", "a");
    expect(s.tasks).toBe(2);
    expect(s.total_cost_usd).toBe(5);
    expect(s.total_active_s).toBe(60 + 60); // approve 60 s + 1 minute escalated; goal b's 600 s and 2 minutes are gone
    expect(s.escalation_rate).toMatchObject({ n: 1, of: 2 });
    expect(s.pass_rate).toMatchObject({ n: 2, of: 2 });
  });

  test("is repeatable", () => {
    expect(tasks("--goal", "a", "--goal", "b")).toEqual(["a1", "b1", "a2"]);
    expect(json("--goal", "a", "--goal", "b").escalation_rate).toMatchObject({ n: 2, of: 3 });
  });

  test("a goal with no tasks leaves nothing", () => {
    expect(tasks("--goal", "nope")).toEqual([]);
  });
});

describe("--since / --until", () => {
  test("since is inclusive, until is exclusive", () => {
    expect(tasks("--since", "2026-10-03")).toEqual(["a2"]);
    expect(tasks("--since", "2026-10-03", "--until", "2026-10-06")).toEqual([]); // a2 started exactly at until
    expect(tasks("--since", "2026-10-03", "--until", "2026-10-07")).toEqual(["a2"]);
    expect(tasks("--since", "2026-10-02")).toEqual(["b1", "a2"]);
    expect(tasks("--until", "2026-10-02")).toEqual(["a1"]);
    expect(tasks("--until", "2026-10-03")).toEqual(["a1", "b1"]);
    expect(tasks("--since", "2026-10-03T00:00:00Z")).toEqual(["a2"]);
    expect(tasks("--since", "2026-10-06T00:00:00Z", "--until", "2026-10-06T00:00:00Z")).toEqual([]);
    expect(tasks("--since", "2026-10-06T01:00:00Z")).toEqual([]);
    expect(tasks("--since", "2026-10-06T00:00:00Z")).toEqual(["a2"]);
    expect(tasks("--until", "2026-10-06T00:00:00Z")).toEqual(["a1", "b1"]);
  });

  test("keeps all events of the kept tasks and the goal-level events of their goals", () => {
    const s = json("--since", "2026-10-03");
    expect(s.tasks).toBe(1);
    expect(s.total_cost_usd).toBe(4);
    // goal a's merge and approve are outside the window but belong to a2's goal; goal b has no kept task
    expect(s.total_active_s).toBe(60 + 60);
    expect(s.pass_rate).toMatchObject({ n: 1, of: 1 });
    const early = json("--until", "2026-10-02");
    expect(early.tasks).toBe(1);
    expect(early.escape_rate).toMatchObject({ n: 1, of: 1 }); // a1's escape, dated after the window, still counts
    expect(early.caught_by_gate.self_test).toMatchObject({ n: 1, of: 1 });
  });

  test("goal-level events from before the window or of tasks outside it are not counted", () => {
    start("r1", "r", day(40));
    put(day(40, 1), { type: "escalate", goal: "r", task: "r1", why: "unclear", minutes: 30 });
    put(day(41), { type: "approve", goal: "r", commit: "c1", active_s: 600 });
    put(day(42), { type: "merge", goal: "r", commit: "c1", merge_commit: "m1" });
    start("r2", "r", day(45));
    put(day(46), { type: "approve", goal: "r", commit: "c2", active_s: 60 });
    put(day(47), { type: "merge", goal: "r", commit: "c2", merge_commit: "m2" });

    const s = json("--goal", "r", "--since", "2026-11-13"); // day 43: r1 (day 40) is out, r2 (day 45) is in
    expect(s.tasks).toBe(1);
    expect(s.escalation_rate).toMatchObject({ n: 0, of: 1 }); // r1's escalation names a task that is not kept
    expect(s.total_active_s).toBe(60); // r1's 600 s approve predates r2's start
    expect(s.pass_rate).toMatchObject({ n: 1, of: 1 });
    expect(s.active_s_per_merged).toBe(60);

    const all = json("--goal", "r"); // no time window: everything of the goal
    expect(all.escalation_rate).toMatchObject({ n: 1, of: 2 });
    expect(all.total_active_s).toBe(600 + 1800 + 60);
  });

  test("a goal-level event belongs to the tasks open when it happened, not to later tasks of the goal", () => {
    start("u1", "u", day(60));
    put(day(60, 1), { type: "escalate", goal: "u", task: "u1", why: "unclear", minutes: 30 });
    put(day(60, 2), { type: "report.shown", goal: "u", commit: "c1" });
    put(day(60, 3), { type: "approve", goal: "u", commit: "c1", active_s: 600 });
    put(day(62), { type: "merge", goal: "u", commit: "c1", merge_commit: "m1" });
    start("u2", "u", day(65));
    put(day(66), { type: "approve", goal: "u", commit: "c2", active_s: 60 });
    put(day(67), { type: "merge", goal: "u", commit: "c2", merge_commit: "m2" });

    const early = json("--goal", "u", "--until", "2026-12-03"); // day 63: only u1 is in
    expect(early.tasks).toBe(1);
    expect(early.escalation_rate).toMatchObject({ n: 1, of: 1 });
    expect(early.total_active_s).toBe(600 + 1800); // u2's 60 s approve is not u1's
    expect(early.pass_rate).toMatchObject({ n: 1, of: 1 });

    const late = json("--goal", "u", "--since", "2026-12-03");
    expect(late.tasks).toBe(1);
    expect(late.escalation_rate).toMatchObject({ n: 0, of: 1 });
    expect(late.total_active_s).toBe(60);

    const both = json("--goal", "u");
    expect(both.escalation_rate).toMatchObject({ n: 1, of: 2 });
    expect(both.total_active_s).toBe(600 + 1800 + 60);
  });

  test("an event of a task shelved before it does not follow that task", () => {
    start("s1", "s", day(70));
    put(day(71), { type: "task.shelve", task: "s1", why: "dropped" });
    start("s2", "s", day(72));
    put(day(73), { type: "approve", goal: "s", commit: "c1", active_s: 60 });
    expect(json("--goal", "s", "--until", "2026-12-12").total_active_s).toBe(0); // day 71: only s1, shelved by day 73
    expect(json("--goal", "s", "--since", "2026-12-12").total_active_s).toBe(60);
  });

  test("an event that belongs to no task is dropped under any filter", () => {
    put(day(-5), { type: "approve", goal: "a", commit: "c0", active_s: 9000 });
    put(day(-4), { type: "escalate", goal: "a", why: "early", minutes: 100 });
    const all = json();
    expect(all.total_active_s).toBe(9000 + 6000 + 60 + 600 + 60 + 120); // unfiltered keeps every event
    for (const args of [["--goal", "a"], ["--since", "2026-09-01"], ["--until", "2027-01-01"], ["--goal", "a", "--since", "2026-09-01"]]) {
      const s = json(...args);
      expect(s.total_active_s).toBe(args.includes("--goal") ? 120 : 60 + 120 + 600 + 60);
      expect(s.escalation_rate.n).toBe(args.includes("--goal") ? 1 : 2);
    }
  });

  test("a time zone offset moves the bound", () => {
    expect(tasks("--since", "2026-10-03T08:00:00+08:00")).toEqual(["a2"]); // = 2026-10-03T00:00Z
    expect(tasks("--since", "2026-10-03T09:00:00+08:00")).toEqual(["a2"]);
    expect(tasks("--until", "2026-10-03T07:59:00+08:00")).toEqual(["a1", "b1"]);
  });

  test("a date that does not parse is refused", () => {
    for (const bad of ["yesterday", "2026-13-01", "2026-02-30", "2026-10-03T25:00", "10/03/2026", ""]) {
      expect(() => statsCommand(repo, ["--since", bad])).toThrow("--since");
      expect(() => statsCommand(repo, ["--until", bad])).toThrow("--until");
    }
  });

  test("the command line exits non-zero for a bad date and zero for no match", () => {
    const run = (...args: string[]) =>
      Bun.spawnSync(["bun", CLI, "stats", ...args], { cwd: repo, env: process.env, stdout: "pipe", stderr: "pipe" });
    const bad = run("--since", "soon");
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain("--since");
    expect(bad.stdout.toString()).toBe("");
    const none = run("--goal", "nope", "--csv");
    expect(none.exitCode).toBe(0);
    expect(none.stdout.toString().split("\r\n")[0]).toStartWith("task,goal,title");
  });
});

describe("combining", () => {
  test("goal and window together", () => {
    expect(tasks("--goal", "a", "--since", "2026-10-02")).toEqual(["a2"]);
    expect(tasks("--goal", "b", "--since", "2026-10-03")).toEqual([]);
    const s = json("--goal", "a", "--since", "2026-10-02", "--until", "2026-10-08");
    expect(s.tasks).toBe(1);
    expect(s.total_active_s).toBe(120); // goal a only, not b
    expect(s.escalation_rate).toMatchObject({ n: 1, of: 1 });
  });

  test("every output honours the filters", () => {
    const args = ["--goal", "b"];
    expect(tasks(...args)).toEqual(["b1"]);
    expect(json(...args).tasks).toBe(1);
    expect(statsCommand(repo, ["--csv", ...args]).trimEnd().split("\r\n")).toHaveLength(2);
    expect(statsCommand(repo, args)).toContain("1 个任务");
  });

  test("the table heading names the filters", () => {
    const out = statsCommand(repo, ["--goal", "a", "--goal", "b", "--since", "2026-10-02", "--until", "2026-10-08"]);
    const heading = out.split("\n")[0]!;
    expect(heading).toContain("目标 a、b");
    expect(heading).toContain("自 2026-10-02T00:00:00.000Z 起");
    expect(heading).toContain("至 2026-10-08T00:00:00.000Z 前");
    expect(statsCommand(repo, []).split("\n")[0]).toBe("# M0 记账：3 个任务");
  });

  test("the output formats are exclusive", () => {
    expect(() => statsCommand(repo, ["--csv", "--json"])).toThrow("only one");
  });
});

describe("--csv", () => {
  test("a header and one row per task, with gate counts, size and merge time", () => {
    put(day(0, 3), { type: "task.gate", task: "a1", gate: "codex_review", result: "pass", claimed_done: true });
    put(day(0, 4), { type: "task.lines", task: "a1", added: 10, deleted: 5, end: "e1" });
    const lines = statsCommand(repo, ["--csv", "--goal", "a"]).split("\r\n");
    expect(lines[0]).toBe(
      "task,goal,title,difficulty,model,status,started_at,merged_at,lines,cost_usd," +
        "self_test_pass,self_test_fail,full_tests_pass,full_tests_fail,codex_review_pass,codex_review_fail,claude_diff_pass,claude_diff_fail,escaped",
    );
    expect(lines[1]).toBe(
      `a1,a,a1,medium,claude-sonnet-5-5,merged,${day(0).toISOString()},${day(7, 2).toISOString()},15,1,0,1,0,0,1,0,0,0,true`,
    );
    expect(lines[2]).toStartWith("a2,a,a2,medium,claude-sonnet-5-5,merged,");
    expect(lines[2]).toContain(",,4,"); // no size recorded: empty lines field; cost 4
    expect(lines[2]).toEndWith(",0,0,false"); // a2 never needed rework
    expect(lines[3]).toBe(""); // every record, the last included, ends with CRLF
    expect(lines).toHaveLength(4);
  });

  test("commas, quotes and newlines in a title survive", () => {
    const titles = ['Add "stats", filters', "two\nlines", "carriage\r\nreturn", "plain", '"'];
    titles.forEach((t, i) => start(`q${i}`, "q", day(20 + i), t));
    const out = statsCommand(repo, ["--csv", "--goal", "q"]);
    expect(out).toContain('"Add ""stats"", filters"');
    expect(out).toContain('"two\nlines"');
    expect(parseCsv(out).slice(1).map((r) => r[2])).toEqual(titles);
    expect(parseCsv(out).every((r) => r.length === 19)).toBe(true);
  });
});

describe("no match", () => {
  test("the table says so, JSON has zero tasks, CSV is only the header", () => {
    const args = ["--goal", "a", "--since", "2027-01-01"];
    const table = statsCommand(repo, args);
    expect(table).toContain("没有符合条件的任务");
    expect(table).toContain("0 个任务");
    expect(json(...args).tasks).toBe(0);
    expect(tasks(...args)).toEqual([]);
    const csv = statsCommand(repo, ["--csv", ...args]);
    expect(csv.split("\r\n")).toHaveLength(2);
    expect(csv).toStartWith("task,goal,title,");
  });
});

/** A small RFC 4180 reader, to check the output the way a spreadsheet would. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(field), (field = ""));
    else if (c === "\r" && text[i + 1] === "\n") (row.push(field), rows.push(row), (row = []), (field = ""), i++);
    else field += c;
  }
  return rows;
}
