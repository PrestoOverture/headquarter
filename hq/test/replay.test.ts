// End-to-end tests of `hq replay`: the real CLI against a real git repository and a temporary $HQ_HOME ledger.

import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, run } from "../src/git";
import { append, ledgerPath } from "../src/ledger";

const CLI = join(import.meta.dir, "../src/cli.ts");
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

let root: string, repo: string, goals: string;

const hq = (...args: string[]) => run([process.execPath, CLI, ...args], repo);

function commit(file: string, text: string, msg: string): string {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), text);
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", msg], repo);
  return git(["rev-parse", "HEAD"], repo);
}

const start = (task: string, goal: string, base: string) =>
  append(repo, { type: "task.start", task, goal, title: `task ${task}`, base, difficulty: "medium", model: "m" });

/** Everything a refused replay must leave alone: refs, worktrees, the goals directory, the ledger. */
function snapshot(): string {
  return JSON.stringify([
    git(["for-each-ref"], repo),
    git(["worktree", "list", "--porcelain"], repo),
    existsSync(goals) ? readdirSync(goals) : null,
    git(["status", "--porcelain"], repo),
    existsSync(ledgerPath(repo)) ? readFileSync(ledgerPath(repo), "utf8") : null,
  ]);
}

function refuses(args: string[], why: RegExp) {
  const before = snapshot();
  const r = hq("replay", ...args);
  expect(r.code).not.toBe(0);
  expect(r.err).toMatch(why);
  expect(r.out).toBe("");
  expect(snapshot()).toBe(before);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hq-replay-")));
  process.env.HQ_HOME = join(root, "home");
  repo = join(root, "repo");
  goals = join(root, "repo.goals");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  commit("app.txt", "v1\n", "base");
});

test("replays a task of a top-level goal file: branch, worktree, goal file, and nothing in the ledger", () => {
  const base = commit("goals/g1.json", JSON.stringify({ title: "Do the thing", acceptance: ["it works", "it is tested"], shelved: [], known_issues: [] }), "goal g1: start");
  start("t1", "g1", base);
  commit("app.txt", "v2\n", "later work");
  append(repo, { type: "task.gate", task: "t1", gate: "self_test", result: "pass", claimed_done: true });
  append(repo, { type: "task.gate", task: "t1", gate: "full_tests", result: "fail", claimed_done: true });
  append(repo, { type: "task.gate", task: "t1", gate: "full_tests", result: "pass", claimed_done: false });
  append(repo, { type: "task.lines", task: "t1", added: 30, deleted: 12, end: base });
  const ledger = readFileSync(ledgerPath(repo), "utf8");

  const r = hq("replay", "t1");
  expect(r.code).toBe(0);
  const path = join(goals, "replay-t1");
  expect(r.out).toContain(`worktree ${path}`);
  expect(r.out).toContain("branch goal/replay-t1");
  expect(r.out).toContain(`base ${base}`);
  expect(r.out).toContain("42 lines (+30 -12)");
  expect(r.out).toContain("self_test 1 pass 0 fail");
  expect(r.out).toContain("full_tests 1 pass 1 fail");

  expect(git(["rev-parse", "--abbrev-ref", "HEAD"], path)).toBe("goal/replay-t1");
  expect(git(["worktree", "list", "--porcelain"], repo)).toContain(`worktree ${path}`);
  expect(git(["rev-parse", "goal/replay-t1~1"], repo)).toBe(base);
  expect(git(["status", "--porcelain"], path)).toBe("");
  expect(readFileSync(join(path, "app.txt"), "utf8")).toBe("v1\n");
  expect(JSON.parse(readFileSync(join(path, "goals", "replay-t1.json"), "utf8"))).toEqual({
    title: "Do the thing", acceptance: ["it works", "it is tested"], shelved: [], known_issues: [], replay_of: "t1",
  });
  expect(readFileSync(ledgerPath(repo), "utf8")).toBe(ledger);
});

test("a multi-task goal file gives the task's own acceptance criteria and the goal's title", () => {
  const file = {
    title: "Big goal", acceptance: [],
    tasks: { t1: { title: "one", acceptance: ["one a"] }, t2: { title: "two", acceptance: ["two a", "two b"] } },
  };
  const base = commit("goals/big.json", JSON.stringify(file), "goal big: start");
  start("t1", "big", base);
  start("t2", "big", base);
  const r = hq("replay", "t2", "--as", "again");
  expect(r.code).toBe(0);
  const made = JSON.parse(readFileSync(join(goals, "again", "goals", "again.json"), "utf8"));
  expect(made.title).toBe("Big goal");
  expect(made.acceptance).toEqual(["two a", "two b"]);
  expect(made.replay_of).toBe("t2");
  expect(made.tasks).toBeUndefined();
  expect(git(["rev-parse", "goal/again~1"], repo)).toBe(base);
  expect(r.out).toContain("size not recorded");
  expect(r.out).toContain("verdicts none recorded");
});

test("traced acceptance entries are accepted and copied as they are", () => {
  const acceptance = ["plain", { text: "traced", traces: "g1" }];
  const base = commit("goals/tr.json", JSON.stringify({ title: "Traced", criteria: ["goal one"], tasks: { t1: { title: "one", acceptance } } }), "goal tr: start");
  start("t1", "tr", base);
  const r = hq("replay", "t1", "--as", "again2");
  expect(r.code).toBe(0);
  const made = JSON.parse(readFileSync(join(goals, "again2", "goals", "again2.json"), "utf8"));
  expect(made.acceptance).toEqual(acceptance);
});

test("refuses an acceptance entry that has no text", () => {
  const base = commit("goals/bad.json", JSON.stringify({ title: "Bad", acceptance: [{ traces: "g1" }] }), "goal bad: start");
  start("t1", "bad", base);
  const r = hq("replay", "t1");
  expect(r.code).toBe(1);
  expect(r.err).toContain("acceptance criteria are not a list");
});

test("reads the goal file as it was at the task's base, not as it is now", () => {
  const base = commit("goals/g.json", JSON.stringify({ title: "Old title", acceptance: ["old"] }), "goal g: start");
  start("t1", "g", base);
  commit("goals/g.json", JSON.stringify({ title: "New title", acceptance: ["new"] }), "edit goal file");
  expect(hq("replay", "t1").code).toBe(0);
  const made = JSON.parse(readFileSync(join(goals, "replay-t1", "goals", "replay-t1.json"), "utf8"));
  expect(made.title).toBe("Old title");
  expect(made.acceptance).toEqual(["old"]);
});

test("refuses an unknown task", () => {
  const base = commit("goals/g.json", JSON.stringify({ title: "G", acceptance: [] }), "goal g: start");
  start("t1", "g", base);
  refuses(["nope"], /no task nope/);
});

test("refuses an unknown task when there is no ledger at all", () => {
  refuses(["t1"], /no task t1/);
});

test("refuses when the base commit is missing from the repository", () => {
  commit("goals/g.json", JSON.stringify({ title: "G", acceptance: [] }), "goal g: start");
  start("t1", "g", "0123456789abcdef0123456789abcdef01234567");
  refuses(["t1"], /base commit 0123456789abcdef0123456789abcdef01234567 of task t1 is not in this repository/);
});

test("refuses when the goal branch already exists, by default name and by --as", () => {
  const base = commit("goals/g.json", JSON.stringify({ title: "G", acceptance: [] }), "goal g: start");
  start("t1", "g", base);
  git(["branch", "goal/replay-t1", "main"], repo);
  refuses(["t1"], /branch goal\/replay-t1 already exists/);
  git(["branch", "goal/mine", "main"], repo);
  refuses(["t1", "--as", "mine"], /branch goal\/mine already exists/);
});

test("refuses when the worktree path already exists", () => {
  const base = commit("goals/g.json", JSON.stringify({ title: "G", acceptance: [] }), "goal g: start");
  start("t1", "g", base);
  mkdirSync(join(goals, "replay-t1"), { recursive: true });
  writeFileSync(join(goals, "replay-t1", "keep.txt"), "mine\n");
  refuses(["t1"], /already exists/);
  expect(readFileSync(join(goals, "replay-t1", "keep.txt"), "utf8")).toBe("mine\n");
});

test("refuses a bad name and a base with no goal file, creating nothing", () => {
  const base = git(["rev-parse", "HEAD"], repo);
  start("t1", "g", base);
  refuses(["t1", "--as", "Bad_Name"], /bad goal name Bad_Name/);
  refuses(["t1"], /no goals\/g\.json at /);
});

test("a second replay of the same task refuses and leaves the first alone", () => {
  const base = commit("goals/g.json", JSON.stringify({ title: "G", acceptance: ["a"] }), "goal g: start");
  start("t1", "g", base);
  expect(hq("replay", "t1").code).toBe(0);
  const head = git(["rev-parse", "goal/replay-t1"], repo);
  refuses(["t1"], /branch goal\/replay-t1 already exists/);
  expect(git(["rev-parse", "goal/replay-t1"], repo)).toBe(head);
});

test("a missing task is a usage error", () => {
  const r = hq("replay");
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("usage: hq replay");
});
