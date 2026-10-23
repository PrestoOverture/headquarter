// The 200-line rule: a task's size from real git, the event a real merge writes, the
// manual command and its refusals, and what hq stats shows.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve, record } from "../src/cli";
import { git, revParse } from "../src/git";
import { append, readEvents } from "../src/ledger";
import { diffSize } from "../src/lines";
import { merge } from "../src/merge";
import { writeReport } from "../src/report";
import { render, rows, stats } from "../src/stats";

const NESTED = process.env.SANDBOX_RUNTIME === "1"; // hq merge runs the tests in srt, which cannot nest
const withSandbox = test.skipIf(NESTED);
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

let root: string, repo: string, wt: string;

const nlines = (n: number, tag = "l") => Array.from({ length: n }, (_, i) => `${tag}${i}\n`).join("");

function commit(cwd: string, files: Record<string, string | Buffer>, msg = "c") {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(cwd, f, ".."), { recursive: true });
    writeFileSync(join(cwd, f), text);
  }
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", msg], cwd);
  return git(["rev-parse", "HEAD"], cwd);
}

const startTask = (task: string, goal = "x") => record(repo, ["task", "start", task, "--goal", goal, "--title", task, "--model", "m"]);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hq-lines-")));
  process.env.HQ_HOME = join(root, "hq-home");
  delete process.env.HQ_TTY;
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  commit(repo, { ".hq.json": JSON.stringify({ test: "true" }), "app.txt": nlines(5, "app") }, "base");
  wt = join(root, "wt-x");
  git(["worktree", "add", "-q", "-b", "goal/x", wt, "main"], repo);
});

describe("the size rule", () => {
  test("added plus deleted, text files only, without goal files and lockfiles", () => {
    const base = revParse("main", repo)!;
    const end = commit(wt, {
      "src/a.ts": nlines(10), // +10
      "app.txt": nlines(3, "app") + nlines(2, "new"), // 2 replaced: +2 -2
      "goals/x.json": nlines(30), // goal file: left out
      "bun.lock": nlines(500), // lockfiles, at any depth: left out
      "web/package-lock.json": nlines(500),
      "yarn.lock": nlines(5),
      "pnpm-lock.yaml": nlines(5),
      "Cargo.lock": nlines(5),
      "go.sum": nlines(5),
      "logo.png": Buffer.from([137, 80, 78, 71, 0, 0, 0, 13, 0, 1, 2, 3]), // binary: not text, left out
      "docs/goals/y.json": nlines(3), // only the top-level goals/ directory is exempt: +3
      "locks/bun.lock.md": nlines(1), // a lockfile name only by prefix: +1
    });
    expect(diffSize(wt, base, end)).toEqual({ added: 16, deleted: 2 });
  });

  test("a deleted file counts its lines; a rename counts as delete plus add", () => {
    const base = commit(wt, { "old.txt": nlines(7) });
    git(["mv", "old.txt", "new.txt"], wt);
    git(["rm", "-q", "app.txt"], wt);
    git(["commit", "-q", "-m", "mv"], wt);
    expect(diffSize(wt, base, "HEAD")).toEqual({ added: 7, deleted: 7 + 5 });
  });

  test("nothing changed is zero lines", () => {
    expect(diffSize(repo, "main", "main")).toEqual({ added: 0, deleted: 0 });
  });
});

describe("hq task lines", () => {
  test("defaults to the head of the task's goal branch, measured from the recorded base", () => {
    startTask("t1");
    commit(wt, { "a.ts": nlines(4) });
    const head = commit(wt, { "b.ts": nlines(6), "goals/x.json": nlines(40) });
    const msg = record(repo, ["task", "lines", "t1"]);
    expect(msg).toContain("10 lines");
    expect(readEvents(repo).filter((e) => e.type === "task.lines")).toMatchObject([{ task: "t1", added: 10, deleted: 0, end: head }]);
  });

  test("--rev measures up to another commit", () => {
    startTask("t1");
    const first = commit(wt, { "a.ts": nlines(4) });
    commit(wt, { "b.ts": nlines(6) });
    record(repo, ["task", "lines", "t1", "--rev", first.slice(0, 10)]);
    expect(readEvents(repo).at(-1)).toMatchObject({ type: "task.lines", added: 4, deleted: 0, end: first });
  });

  test("refuses a rev that is not a commit, an unknown task, and a missing goal branch", () => {
    startTask("t1");
    const tree = git(["rev-parse", "HEAD^{tree}"], repo);
    expect(() => record(repo, ["task", "lines", "t1", "--rev", "no-such-rev"])).toThrow("not a commit");
    expect(() => record(repo, ["task", "lines", "t1", "--rev", tree])).toThrow("not a commit");
    expect(() => record(repo, ["task", "lines", "ghost"])).toThrow("no task ghost");
    startTask("t2", "nogoal");
    expect(() => record(repo, ["task", "lines", "t2"])).toThrow("goal/nogoal is not a commit");
    expect(readEvents(repo).some((e) => e.type === "task.lines")).toBe(false);
  });

  test("a later measurement replaces the earlier one", () => {
    startTask("t1");
    commit(wt, { "a.ts": nlines(4) });
    record(repo, ["task", "lines", "t1"]);
    commit(wt, { "b.ts": nlines(6) });
    record(repo, ["task", "lines", "t1"]);
    expect(rows(readEvents(repo))[0]!.size).toMatchObject({ lines: 10 });
  });
});

describe("hq merge", () => {
  function approveGoal() {
    const head = revParse("goal/x", repo)!;
    writeReport(repo, { goal: "x", commit: head, base: revParse("main", repo)!, trial_merge: head, test_code: 0, generated_at: "now" }, "# report", "ok");
    process.env.HQ_TTY = join(root, "tty");
    writeFileSync(process.env.HQ_TTY, "x\n");
    approve(repo, "x");
    return head;
  }

  withSandbox("records a size for every open task of the goal, not for shelved ones or other goals' tasks", () => {
    startTask("open1");
    startTask("shelved1");
    startTask("other", "y");
    record(repo, ["task", "shelve", "shelved1", "--why", "not needed"]);
    commit(wt, { "a.ts": nlines(12), "bun.lock": nlines(300) });
    startTask("open2"); // base is the goal head now: only what comes after counts
    commit(wt, { "b.ts": nlines(3) });
    const head = approveGoal();
    const r = merge(repo, "x");
    expect(r).toMatchObject({ ok: true, linesErrors: [] });
    const sized = readEvents(repo).filter((e) => e.type === "task.lines");
    expect(sized).toMatchObject([
      { task: "open1", added: 15, deleted: 0, end: head },
      { task: "open2", added: 3, deleted: 0, end: head },
    ]);
    const types = readEvents(repo).map((e) => e.type);
    expect(types.lastIndexOf("task.lines")).toBeLessThan(types.indexOf("merge"));
  });

  withSandbox("a task whose base cannot be measured is reported, and the merge still stands", () => {
    startTask("open1");
    append(repo, { type: "task.start", task: "broken", goal: "x", title: "b", base: "0".repeat(40), difficulty: "medium", model: "m" });
    commit(wt, { "a.ts": nlines(2) });
    approveGoal();
    const r = merge(repo, "x");
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.linesErrors).toHaveLength(1);
    expect(r.ok && r.linesErrors[0]).toContain("broken");
    expect(readEvents(repo).filter((e) => e.type === "task.lines")).toMatchObject([{ task: "open1", added: 2 }]);
  });
});

describe("hq stats", () => {
  test("counts tasks with a size and lists those under 200 lines; no size is not checked", () => {
    startTask("small");
    startTask("exact");
    startTask("big");
    startTask("unchecked");
    commit(wt, { "a.ts": nlines(150) });
    record(repo, ["task", "lines", "small"]);
    commit(wt, { "b.ts": nlines(50) });
    record(repo, ["task", "lines", "exact"]); // exactly 200: not under 200
    commit(wt, { "d.ts": nlines(300) });
    record(repo, ["task", "lines", "big"]);

    const events = readEvents(repo);
    const s = stats(events);
    expect(s.size_checked).toEqual({ n: 3, of: 4, rate: 0.75 });
    expect(s.under_limit).toEqual([{ task: "small", lines: 150 }]);
    const md = render(s);
    expect(md).toContain("3/4 个任务有大小，1 个没查");
    expect(md).toContain("不满 200 行：small 150 行");
    expect(md).not.toContain("unchecked 0");

    const byTask = Object.fromEntries(rows(events).map((r) => [r.task, r.size]));
    expect(byTask.small).toMatchObject({ added: 150, deleted: 0, lines: 150 });
    expect(byTask.unchecked).toBeNull();
  });

  test("with no sizes at all, nothing passes", () => {
    startTask("t1");
    const s = stats(readEvents(repo));
    expect(s.size_checked).toEqual({ n: 0, of: 1, rate: 0 });
    expect(s.under_limit).toEqual([]);
    expect(render(s)).toContain("0/1 个任务有大小，1 个没查");
  });
});
