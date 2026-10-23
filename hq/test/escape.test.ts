// Escape candidates: a real git repository with real --no-ff goal merges, ledger merge events
// stamped by hand (so ages can be set), and the one real `hq merge` that prints them.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve, record } from "../src/cli";
import { escapeCandidates, render } from "../src/escape";
import { git, revParse } from "../src/git";
import { append, readEvents } from "../src/ledger";
import { merge } from "../src/merge";
import { writeReport } from "../src/report";

const NESTED = process.env.SANDBOX_RUNTIME === "1"; // hq merge runs the tests in srt, which cannot nest
const withSandbox = test.skipIf(NESTED);
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
const DAY_MS = 86_400_000;

let root: string, repo: string;

function commit(cwd: string, files: Record<string, string>, msg: string) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(cwd, f, ".."), { recursive: true });
    writeFileSync(join(cwd, f), text);
  }
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", msg], cwd);
}

/** Merges goal/<goal> (one commit per entry of `commits`) into main by hand and stamps the ledger `daysAgo` days back. */
function mergedGoal(goal: string, commits: [string, Record<string, string>][], daysAgo = 1, task = `${goal}-t`) {
  const at = new Date(Date.now() - daysAgo * DAY_MS);
  git(["checkout", "-q", "-b", `goal/${goal}`, "main"], repo);
  append(repo, { type: "task.start", task, goal, title: task, base: revParse("main", repo)!, difficulty: "medium", model: "m" }, new Date(at.getTime() - 1000));
  for (const [msg, files] of commits) commit(repo, files, msg);
  const head = revParse("HEAD", repo)!;
  git(["checkout", "-q", "main"], repo);
  git(["merge", "-q", "--no-ff", "-m", `Merge goal ${goal}`, `goal/${goal}`], repo);
  const merged = revParse("main", repo)!;
  append(repo, { type: "merge", goal, commit: head, merge_commit: merged }, at);
  return merged;
}

const first = (daysAgo = 1) => mergedGoal("a", [["add the app", { "app.txt": "v1\n" }]], daysAgo);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hq-escape-")));
  process.env.HQ_HOME = join(root, "hq-home");
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  commit(repo, { ".hq.json": JSON.stringify({ test: "true" }), "other.txt": "o\n" }, "base");
});

describe("escape candidates", () => {
  test("a later fix touching an earlier goal's file is a candidate, with the tasks to record", () => {
    const a = first();
    mergedGoal("b", [["fix the app", { "app.txt": "v2\n" }]]);
    const found = escapeCandidates(repo);
    expect(found).toMatchObject([{ goal: "a", merge_commit: a, tasks: ["a-t"], fixed_by: "b", commits: [{ subject: "fix the app", reverts: false, files: ["app.txt"] }] }]);
    const text = render(found);
    expect(text).toContain('hq escape a-t --note "..."');
    expect(text).toContain("app.txt");
    expect(readEvents(repo).some((e) => e.type === "escape")).toBe(false); // a suggestion, not a record
  });

  test("the fix words match in any case: bug, regression, revert", () => {
    first();
    mergedGoal("b", [["Squash BUG in parser", { "app.txt": "v2\n" }]]);
    mergedGoal("c", [["Regression: parser", { "app.txt": "v3\n" }]]);
    mergedGoal("d", [["Revert parser tweak", { "app.txt": "v4\n" }]]);
    expect(escapeCandidates(repo).filter((c) => c.goal === "a").map((c) => c.fixed_by)).toEqual(["b", "c", "d"]);
  });

  test("a goal merged more than 14 days ago is not a candidate", () => {
    first(15);
    mergedGoal("b", [["fix the app", { "app.txt": "v2\n" }]]);
    expect(escapeCandidates(repo)).toEqual([]);
  });

  test("a fix touching only other files is not a candidate", () => {
    first();
    mergedGoal("b", [["fix other", { "other.txt": "o2\n" }]]);
    expect(escapeCandidates(repo)).toEqual([]);
  });

  test("a commit that does not look like a fix is not a candidate", () => {
    first();
    mergedGoal("b", [["extend the app", { "app.txt": "v2\n" }]]);
    expect(escapeCandidates(repo)).toEqual([]);
  });

  test("only the fix-looking commit's files count", () => {
    first();
    mergedGoal("b", [["extend the app", { "app.txt": "v2\n" }], ["fix other", { "other.txt": "o2\n" }]]);
    expect(escapeCandidates(repo)).toEqual([]);
  });

  test("a revert of the merge commit is a candidate even when nothing says fix", () => {
    const a = first();
    git(["checkout", "-q", "-b", "goal/b", "main"], repo);
    git(["revert", "--no-commit", "-m", "1", a], repo);
    git(["commit", "-q", "-m", `undo the app\n\nThis reverts commit ${a}.`], repo);
    git(["checkout", "-q", "main"], repo);
    git(["merge", "-q", "--no-ff", "-m", "Merge goal b", "goal/b"], repo);
    append(repo, { type: "merge", goal: "b", commit: revParse("goal/b", repo)!, merge_commit: revParse("main", repo)! });
    expect(escapeCandidates(repo)).toMatchObject([{ goal: "a", fixed_by: "b", commits: [{ subject: "undo the app", reverts: true }] }]);
  });

  test("a task with an escape already recorded is not suggested again", () => {
    first();
    mergedGoal("b", [["fix the app", { "app.txt": "v2\n" }]]);
    record(repo, ["escape", "a-t", "--note", "broke"]);
    expect(escapeCandidates(repo)).toEqual([]);
  });

  withSandbox("hq merge lists them after the merge, records nothing, and hq escapes shows the same", () => {
    const a = first();
    const wt = join(root, "wt-b");
    git(["worktree", "add", "-q", "-b", "goal/b", wt, "main"], repo);
    record(repo, ["task", "start", "b-t", "--goal", "b", "--title", "b", "--model", "m"]);
    commit(wt, { "app.txt": "v2\n" }, "fix the app");
    const head = revParse("goal/b", repo)!;
    writeReport(repo, { goal: "b", commit: head, base: revParse("main", repo)!, trial_merge: head, test_code: 0, generated_at: "now" }, "# report", "ok");
    process.env.HQ_TTY = join(root, "tty");
    writeFileSync(process.env.HQ_TTY, "b\n");
    approve(repo, "b", () => {});
    const before = readEvents(repo).length;
    const r = merge(repo, "b");
    expect(r).toMatchObject({ ok: true, escapes: [{ goal: "a", merge_commit: a, tasks: ["a-t"], fixed_by: "b" }] });
    expect(readEvents(repo).slice(before).map((e) => e.type)).not.toContain("escape");
    expect(escapeCandidates(repo)).toEqual(r.ok ? r.escapes : []);
  });
});
