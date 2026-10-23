// End-to-end tests of `hq status`: the real CLI against a real git repository and a temporary $HQ_HOME.

import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeApproval } from "../src/approval";
import { git, revParse, run } from "../src/git";
import { newGoal } from "../src/goal";
import { append } from "../src/ledger";
import { writeReport } from "../src/report";
import type { GoalStatus } from "../src/status";

const CLI = join(import.meta.dir, "../src/cli.ts");
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

let root: string, repo: string, home: string;

const hq = (...args: string[]) => run([process.execPath, CLI, ...args], repo);
const day = (d: number) => new Date(Date.UTC(2026, 9, 1 + d));

function commit(cwd: string, file: string, text: string, msg: string): string {
  writeFileSync(join(cwd, file), text);
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", msg], cwd);
  return git(["rev-parse", "HEAD"], cwd);
}

function goal(name: string): string {
  const path = newGoal(repo, name, { title: `Title of ${name}` }).path;
  commit(path, `${name}.txt`, "x\n", `${name}: work`);
  return path;
}

const meta = (name: string, commitId: string, test_code: number) => ({ goal: name, commit: commitId, base: "b", trial_merge: "m", test_code, generated_at: "now" });
const approval = (name: string, commitId: string) => writeApproval(repo, { goal: name, branch: `goal/${name}`, commit: commitId, approved_at: "now" });
const task = (id: string, g: string, at: Date) =>
  append(repo, { type: "task.start", task: id, goal: g, title: `task ${id}`, base: "b0", difficulty: "medium", model: "m" }, at);
const gate = (id: string, name: "self_test" | "full_tests" | "codex_review" | "claude_diff", result: "pass" | "fail") =>
  append(repo, { type: "task.gate", task: id, gate: name, result, claimed_done: false });

/** Every file under `dir` with its mtime and bytes: if hq status touches anything, this differs. */
function tree(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else out.push(`${p} ${s.mtimeMs} ${readFileSync(p).toString("base64")}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

const snapshot = () => JSON.stringify([tree(root), git(["for-each-ref"], repo), git(["worktree", "list", "--porcelain"], repo), git(["status", "--porcelain"], repo, { GIT_OPTIONAL_LOCKS: "0" })]);

function statusJson(): Record<string, GoalStatus> {
  const r = hq("status", "--json");
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return Object.fromEntries((JSON.parse(r.out).goals as GoalStatus[]).map((g) => [g.goal, g]));
}

let paths: Record<string, string>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hq-status-")));
  home = join(root, "hq-home");
  process.env.HQ_HOME = home;
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  commit(repo, "app.txt", "v1\n", "base");
  // none: no report, no approval. green: green report, approved head. red: failing report.
  // stale: a report and an approval for an older commit only. bare: no goal file, no worktree.
  paths = { none: goal("none"), green: goal("green"), red: goal("red"), stale: goal("stale") };
  const old = revParse("goal/stale", repo)!;
  commit(paths.stale!, "more.txt", "y\n", "stale: after the report");
  writeReport(repo, meta("stale", old, 0), "# r", "ok");
  approval("stale", old);
  writeReport(repo, meta("green", revParse("goal/green", repo)!, 0), "# r", "ok");
  approval("green", revParse("goal/green", repo)!);
  writeReport(repo, meta("red", revParse("goal/red", repo)!, 1), "# r", "not ok");
  git(["branch", "goal/bare", "main"], repo);
  commit(repo, "app.txt", "v2\n", "main moves on");
});

test("every goal branch with title, head, ahead/behind, worktree", () => {
  const s = statusJson();
  expect(Object.keys(s).sort()).toEqual(["bare", "green", "none", "red", "stale"]);
  const n = s.none!;
  expect(n.title).toBe("Title of none");
  expect(n.branch).toBe("goal/none");
  expect(n.commit).toBe(revParse("goal/none", repo)!);
  expect(n.subject).toBe("none: work");
  expect(n.ahead).toBe(2);
  expect(n.behind).toBe(1);
  expect(n.worktree).toBe(paths.none!);
  expect(s.stale!.ahead).toBe(3);
  expect(s.bare!.title).toBe("bare");
  expect(s.bare!.subject).toBe("base");
  expect([s.bare!.ahead, s.bare!.behind, s.bare!.worktree]).toEqual([0, 1, null]);
});

test("report state: none, green, red, stale", () => {
  const s = statusJson();
  expect(Object.fromEntries(Object.values(s).map((g) => [g.goal, g.report]))).toEqual({ none: "none", green: "green", red: "red", stale: "stale", bare: "none" });
});

test("approval state: none, approved, void", () => {
  const s = statusJson();
  expect(Object.fromEntries(Object.values(s).map((g) => [g.goal, g.approval]))).toEqual({ none: "none", green: "approved", red: "none", stale: "void", bare: "none" });
});

test("a report for another goal, even one whose name extends this one, is not a stale report", () => {
  git(["branch", "goal/none-more", "goal/none"], repo);
  writeReport(repo, meta("none-more", revParse("goal/none", repo)!, 0), "# r", "ok");
  const s = statusJson();
  expect(s["none-more"]!.report).toBe("green");
  expect(s.none!.report).toBe("none");
});

test("open tasks: started on the goal, not shelved, goal not merged since; latest result per gate", () => {
  task("t1", "none", day(0));
  gate("t1", "self_test", "fail");
  gate("t1", "self_test", "pass");
  gate("t1", "full_tests", "fail");
  task("t2", "none", day(0));
  append(repo, { type: "task.shelve", task: "t2", why: "later" });
  task("t3", "green", day(0));
  append(repo, { type: "merge", goal: "green", commit: "c", merge_commit: "m" }, day(1));
  task("t4", "green", day(2)); // started after the merge: open again
  task("t5", "red", day(0));
  const s = statusJson();
  const ts = s.none!.open_tasks;
  expect(ts.map((t) => t.task)).toEqual(["t1"]);
  expect(ts[0]!.title).toBe("task t1");
  expect(ts[0]!.gates).toEqual({ self_test: "pass", full_tests: "fail", codex_review: null, claude_diff: null });
  expect(s.green!.open_tasks.map((t) => t.task)).toEqual(["t4"]);
  expect(s.red!.open_tasks.map((t) => t.task)).toEqual(["t5"]);
  expect(s.stale!.open_tasks).toEqual([]);
});

test("text output shows each goal's state, worktree and tasks", () => {
  task("t1", "none", day(0));
  gate("t1", "claude_diff", "pass");
  const r = hq("status");
  expect(r.code).toBe(0);
  expect(r.err).toBe("");
  const block = r.out.split("\n\n").find((b) => b.startsWith("green:"))!;
  expect(block).toContain("green: Title of green");
  expect(block).toContain(`goal/green  ${revParse("goal/green", repo)!.slice(0, 12)} green: work`);
  expect(block).toContain(`2 ahead, 1 behind main; worktree ${paths.green}`);
  expect(block).toContain("report: green; approval: approved");
  expect(r.out).toContain("t1  task t1  [self_test -, full_tests -, codex_review -, claude_diff pass]");
  expect(r.out).toContain("report: red; approval: none");
  expect(r.out).toContain("report: stale; approval: void");
  expect(r.out).toContain("bare: bare");
});

test("no goal branches: says so and exits 0, in text and in JSON", () => {
  const empty = join(root, "empty");
  mkdirSync(empty);
  git(["init", "-q", "-b", "main"], empty);
  commit(empty, "a.txt", "a\n", "base");
  const text = run([process.execPath, CLI, "status"], empty);
  const json = run([process.execPath, CLI, "status", "--json"], empty);
  for (const r of [text, json]) {
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  }
  expect(text.out).toContain("no goals");
  expect(JSON.parse(json.out)).toEqual({ goals: [] });
});

test("read-only: no refs, repository files or $HQ_HOME contents change, and a missing $HQ_HOME stays missing", () => {
  task("t1", "none", day(0));
  gate("t1", "self_test", "pass");
  const before = snapshot();
  for (const args of [["status"], ["status", "--json"]]) expect(hq(...args).code).toBe(0);
  expect(snapshot()).toBe(before);

  const fresh = join(root, "fresh-home");
  process.env.HQ_HOME = fresh;
  const beforeFresh = snapshot();
  expect(hq("status").code).toBe(0);
  expect(hq("status", "--json").code).toBe(0);
  expect(existsSync(fresh)).toBe(false);
  expect(snapshot()).toBe(beforeFresh);
});

test("an unknown option is refused", () => {
  const r = hq("status", "--bogus");
  expect(r.code).toBe(1);
  expect(r.err).toContain("hq:");
});
