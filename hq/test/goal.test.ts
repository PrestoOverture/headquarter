// End-to-end tests of `hq goal new`: the real CLI against a real git repository in a temp dir.

import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, run } from "../src/git";

const CLI = join(import.meta.dir, "../src/cli.ts");
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

let root: string, repo: string, goals: string;

const hq = (cwd: string, ...args: string[]) => run([process.execPath, CLI, ...args], cwd);

function commit(cwd: string, file: string, text: string, msg: string): string {
  writeFileSync(join(cwd, file), text);
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", msg], cwd);
  return git(["rev-parse", "HEAD"], cwd);
}

/** Everything `hq goal new` could change: refs, registered worktrees, the goals directory. */
function snapshot(): string {
  return JSON.stringify([
    git(["for-each-ref"], repo),
    git(["worktree", "list", "--porcelain"], repo),
    existsSync(goals) ? readdirSync(goals) : null,
    git(["status", "--porcelain"], repo),
  ]);
}

function refuses(args: string[], why: RegExp) {
  const before = snapshot();
  const r = hq(repo, "goal", "new", ...args);
  expect(r.code).not.toBe(0);
  expect(r.err).toMatch(why);
  expect(r.out).toBe("");
  expect(snapshot()).toBe(before);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hq-goal-")));
  repo = join(root, "repo");
  goals = join(root, "repo.goals");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  commit(repo, "app.txt", "v1\n", "base");
});

test("creates goal/<name> from main with a linked worktree next to the repository", () => {
  const base = git(["rev-parse", "main"], repo);
  const r = hq(repo, "goal", "new", "my-goal-2", "--title", "Do the thing");
  expect(r.code).toBe(0);
  const path = join(goals, "my-goal-2");
  expect(r.out).toContain(path);
  expect(r.out).toContain("goal/my-goal-2");
  expect(git(["rev-parse", "--abbrev-ref", "HEAD"], path)).toBe("goal/my-goal-2");
  expect(git(["worktree", "list", "--porcelain"], repo)).toContain(`worktree ${path}`);
  expect(git(["rev-parse", "goal/my-goal-2~1"], repo)).toBe(base);
  expect(git(["rev-parse", "main"], repo)).toBe(base);
  expect(git(["status", "--porcelain"], path)).toBe("");
});

test("the first commit adds goals/<name>.json and is titled 'goal <name>: start'", () => {
  hq(repo, "goal", "new", "g1", "--title", "Do the thing");
  expect(git(["log", "-1", "--format=%s", "goal/g1"], repo)).toBe("goal g1: start");
  expect(git(["diff", "--name-status", "main", "goal/g1"], repo)).toBe("A\tgoals/g1.json");
  const file = JSON.parse(git(["show", "goal/g1:goals/g1.json"], repo));
  expect(file).toEqual({ title: "Do the thing", acceptance: [], shelved: [], known_issues: [] });
  expect(readFileSync(join(goals, "g1", "goals", "g1.json"), "utf8")).toBe(git(["show", "goal/g1:goals/g1.json"], repo) + "\n");
});

test("the title defaults to the name", () => {
  hq(repo, "goal", "new", "plain");
  expect(JSON.parse(git(["show", "goal/plain:goals/plain.json"], repo)).title).toBe("plain");
});

test("--from starts the goal at another commit, from a branch or a hash", () => {
  const base = git(["rev-parse", "main"], repo);
  const second = commit(repo, "app.txt", "v2\n", "second");
  expect(hq(repo, "goal", "new", "old", "--from", base).code).toBe(0);
  expect(git(["rev-parse", "goal/old~1"], repo)).toBe(base);
  git(["branch", "side", base], repo);
  expect(hq(repo, "goal", "new", "sided", "--from", "side").code).toBe(0);
  expect(git(["rev-parse", "goal/sided~1"], repo)).toBe(base);
  expect(git(["rev-parse", "main"], repo)).toBe(second);
});

test("works from inside another goal's worktree and still lands beside the repository", () => {
  hq(repo, "goal", "new", "first");
  const r = hq(join(goals, "first"), "goal", "new", "second");
  expect(r.code).toBe(0);
  expect(r.out).toContain(join(goals, "second"));
  expect(git(["rev-parse", "goal/second~1"], repo)).toBe(git(["rev-parse", "main"], repo));
});

test("refuses a name that is not lowercase letters, digits and dashes", () => {
  for (const bad of ["Bad", "has_underscore", "has space", "a/b", "-lead", ".dot", ".."]) refuses(["--", bad], /bad goal name/);
  refuses(["--", ""], /bad goal name/);
});

test("refuses an existing goal/<name> branch", () => {
  git(["branch", "goal/taken", "main"], repo);
  refuses(["taken"], /branch goal\/taken already exists/);
});

test("refuses an existing worktree path", () => {
  mkdirSync(join(goals, "there"), { recursive: true });
  writeFileSync(join(goals, "there", "keep.txt"), "mine\n");
  refuses(["there"], /already exists/);
  expect(readFileSync(join(goals, "there", "keep.txt"), "utf8")).toBe("mine\n");
});

test("refuses a --from that is not a commit", () => {
  refuses(["nofrom", "--from", "no-such-rev"], /no-such-rev is not a commit/);
  const tree = git(["rev-parse", "main^{tree}"], repo);
  refuses(["nofrom", "--from", tree], /is not a commit/);
});

test("a second run with the same name refuses and leaves the first goal alone", () => {
  hq(repo, "goal", "new", "twice");
  const head = git(["rev-parse", "goal/twice"], repo);
  const r = hq(repo, "goal", "new", "twice");
  expect(r.code).not.toBe(0);
  expect(git(["rev-parse", "goal/twice"], repo)).toBe(head);
});

test("a missing name is a usage error", () => {
  const r = hq(repo, "goal", "new");
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("usage: hq goal new");
});
