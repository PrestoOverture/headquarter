// End-to-end tests of `hq sync`: the real CLI against a real repository and goal worktree in a temp dir.

import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readApproval, writeApproval } from "../src/approval";
import { git, run } from "../src/git";
import { readReportMeta, writeReport } from "../src/report";

const CLI = join(import.meta.dir, "../src/cli.ts");
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

let root: string, repo: string, wt: string;

const hq = (cwd: string, ...args: string[]) => run([process.execPath, CLI, ...args], cwd);

function commit(cwd: string, file: string, text: string, msg: string): string {
  writeFileSync(join(cwd, file), text);
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", msg], cwd);
  return git(["rev-parse", "HEAD"], cwd);
}

/** Every file under `dir` with its content and mtime. */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort()
    .map((p) => `${p} ${statSync(p).mtimeMs} ${readFileSync(p, "utf8")}`);
}

/** The goal's refs, index, worktree state and files: what a refused or aborted sync must not change. */
function state(): string {
  return JSON.stringify([
    git(["for-each-ref"], repo),
    git(["status", "--porcelain", "--ignored"], wt),
    readFileSync(join(wt, "app.txt"), "utf8"),
    existsSync(join(git(["rev-parse", "--absolute-git-dir"], wt), "MERGE_HEAD")),
  ]);
}

/** A green report and an approval for goal/g's current head, as `hq report` and `hq approve` leave them. */
function approveHead(): string {
  const head = git(["rev-parse", "goal/g"], repo);
  writeReport(repo, { goal: "g", commit: head, base: git(["rev-parse", "main"], repo), trial_merge: head, test_code: 0, generated_at: "now" }, "# report", "ok");
  writeApproval(repo, { goal: "g", branch: "goal/g", commit: head, approved_at: "now" });
  return head;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hq-sync-")));
  process.env.HQ_HOME = join(root, "hq-home");
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "other.txt"), "o1\n");
  commit(repo, "app.txt", "v1\n", "base");
  expect(hq(repo, "goal", "new", "g").code).toBe(0);
  wt = join(root, "repo.goals", "g");
  commit(wt, "goal.txt", "mine\n", "task 1");
});

test("merges the latest main into the goal branch with a merge commit, in the goal's worktree", () => {
  const before = git(["rev-parse", "goal/g"], repo);
  const main = commit(repo, "other.txt", "o2\n", "main moves");
  const r = hq(repo, "sync", "g");
  expect(r.code).toBe(0);
  const head = git(["rev-parse", "goal/g"], repo);
  expect(git(["rev-parse", "HEAD"], wt)).toBe(head);
  expect(git(["rev-list", "--parents", "-1", head], repo).split(" ").slice(1)).toEqual([before, main]);
  expect(git(["log", "-1", "--format=%s", head], repo)).toBe("Merge main into goal/g");
  expect(readFileSync(join(wt, "other.txt"), "utf8")).toBe("o2\n");
  expect(readFileSync(join(wt, "goal.txt"), "utf8")).toBe("mine\n");
  expect(git(["status", "--porcelain"], wt)).toBe("");
  expect(git(["rev-parse", "main"], repo)).toBe(main);
  expect(r.out).toContain(before.slice(0, 12));
  expect(r.out).toContain(head.slice(0, 12));
});

test("works from the repository or from the worktree, and keeps the earlier commits as they were", () => {
  const before = git(["rev-parse", "goal/g"], repo);
  commit(repo, "other.txt", "o2\n", "main moves");
  expect(hq(wt, "sync", "g").code).toBe(0);
  expect(git(["merge-base", "--is-ancestor", before, "goal/g"], repo)).toBe("");
});

test("a conflict aborts the merge, lists the files, and leaves the branch and worktree as they were", () => {
  commit(wt, "app.txt", "goal\n", "task 2");
  commit(wt, "second.txt", "goal\n", "task 3");
  commit(repo, "app.txt", "main\n", "main edits app");
  commit(repo, "second.txt", "main\n", "main adds second");
  commit(repo, "other.txt", "o2\n", "main edits other");
  const before = state();
  const r = hq(repo, "sync", "g");
  expect(r.code).toBe(1);
  expect(r.err).toContain("app.txt");
  expect(r.err).toContain("second.txt");
  expect(r.err).not.toContain("other.txt");
  expect(r.err).toContain("aborted");
  expect(r.out).toBe("");
  expect(state()).toBe(before);
  expect(git(["status", "--porcelain"], wt)).toBe("");
});

test("a dirty worktree is refused and not touched", () => {
  commit(repo, "other.txt", "o2\n", "main moves");
  for (const dirty of ["modified", "untracked"]) {
    if (dirty === "modified") writeFileSync(join(wt, "goal.txt"), "edited\n");
    else writeFileSync(join(wt, "new.txt"), "new\n");
    const before = state();
    const r = hq(repo, "sync", "g");
    expect(r.code).toBe(1);
    expect(r.err).toContain("uncommitted changes");
    expect(r.out).toBe("");
    expect(state()).toBe(before);
    git(["checkout", "--", "."], wt);
    run(["rm", "-f", join(wt, "new.txt")], wt);
  }
  expect(hq(repo, "sync", "g").code).toBe(0);
});

test("nothing to sync when main is already in the goal branch", () => {
  const before = state();
  const r = hq(repo, "sync", "g");
  expect(r.code).toBe(0);
  expect(r.out).toContain("nothing to sync");
  expect(r.out).not.toContain("hq report");
  expect(state()).toBe(before);
  commit(repo, "other.txt", "o2\n", "main moves");
  expect(hq(repo, "sync", "g").code).toBe(0);
  const synced = state();
  expect(hq(repo, "sync", "g").out).toContain("nothing to sync");
  expect(state()).toBe(synced);
});

test("says the approval and report no longer match, leaves $HQ_HOME alone, and hq merge refuses the old approval", () => {
  const old = approveHead();
  commit(repo, "other.txt", "o2\n", "main moves");
  const home = tree(process.env.HQ_HOME!);
  expect(home.length).toBeGreaterThan(0);
  const r = hq(repo, "sync", "g");
  expect(r.code).toBe(0);
  expect(r.out).toContain("no longer match");
  expect(r.out).toContain(old.slice(0, 12));
  expect(r.out).toContain("hq report g");
  expect(tree(process.env.HQ_HOME!)).toEqual(home);
  const head = git(["rev-parse", "goal/g"], repo);
  expect(readApproval(repo, "g")!.commit).toBe(old);
  expect(readReportMeta(repo, "g", head)).toBeNull();
  const main = git(["rev-parse", "main"], repo);
  const m = hq(repo, "merge", "g");
  expect(m.code).toBe(1);
  expect(m.err).toContain("new commits void an approval");
  expect(git(["rev-parse", "main"], repo)).toBe(main);
});

test("refuses a bad goal name, a missing goal, and a goal without a worktree", () => {
  expect(hq(repo, "sync", "Bad").err).toContain("bad goal name");
  expect(hq(repo, "sync", "nope").err).toContain("no branch goal/nope");
  git(["branch", "goal/loose", "main"], repo);
  commit(repo, "other.txt", "o2\n", "main moves");
  const r = hq(repo, "sync", "loose");
  expect(r.code).toBe(1);
  expect(r.err).toContain("not checked out");
  expect(git(["rev-parse", "goal/loose"], repo)).not.toBe(git(["rev-parse", "main"], repo));
});

test("main adding a tracked file where the worktree has an ignored one fails and keeps the ignored file", () => {
  commit(wt, ".gitignore", "secret.txt\n", "ignore secret");
  writeFileSync(join(wt, "secret.txt"), "local only\n");
  commit(repo, "secret.txt", "from main\n", "main tracks secret");
  const before = state();
  const r = hq(repo, "sync", "g");
  expect(r.code).toBe(1);
  expect(r.err).toContain("secret.txt");
  expect(r.out).toBe("");
  expect(readFileSync(join(wt, "secret.txt"), "utf8")).toBe("local only\n");
  expect(state()).toBe(before);
});

test("main adding a directory where the worktree has an ignored file fails too", () => {
  commit(wt, ".gitignore", "cache\n", "ignore cache");
  writeFileSync(join(wt, "cache"), "local only\n");
  mkdirSync(join(repo, "cache"));
  commit(repo, "cache/x.txt", "from main\n", "main adds cache dir");
  const before = state();
  const r = hq(repo, "sync", "g");
  expect(r.code).toBe(1);
  expect(r.err).toContain("cache/x.txt");
  expect(readFileSync(join(wt, "cache"), "utf8")).toBe("local only\n");
  expect(state()).toBe(before);
});

test("a merge the user left uncommitted, with a clean status, is refused and not aborted", () => {
  git(["checkout", "-q", "-b", "side", "main"], repo);
  commit(repo, "side.txt", "side\n", "side work");
  git(["checkout", "-q", "main"], repo);
  commit(repo, "other.txt", "o2\n", "main moves");
  git(["merge", "-s", "ours", "--no-commit", "side"], wt);
  const mergeHead = join(git(["rev-parse", "--absolute-git-dir"], wt), "MERGE_HEAD");
  const pending = readFileSync(mergeHead, "utf8");
  expect(git(["status", "--porcelain"], wt)).toBe("");
  const before = state();
  const r = hq(repo, "sync", "g");
  expect(r.code).toBe(1);
  expect(r.err).toContain("merge in progress");
  expect(r.out).toBe("");
  expect(readFileSync(mergeHead, "utf8")).toBe(pending);
  expect(state()).toBe(before);
});

test("a cherry-pick, revert or rebase under way in the worktree is refused and left alone", () => {
  commit(repo, "other.txt", "o2\n", "main moves");
  const gitDir = git(["rev-parse", "--absolute-git-dir"], wt);
  const head = git(["rev-parse", "HEAD"], wt);
  for (const [marker, what] of [["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"], ["rebase-merge", "rebase"], ["rebase-apply", "rebase"]]) {
    const path = join(gitDir, marker);
    if (marker.startsWith("rebase")) mkdirSync(path);
    else writeFileSync(path, `${head}\n`);
    const before = state();
    const r = hq(repo, "sync", "g");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${what} in progress`);
    expect(existsSync(path)).toBe(true);
    expect(state()).toBe(before);
    run(["rm", "-rf", path], wt);
  }
  expect(hq(repo, "sync", "g").code).toBe(0);
});

test("main modifying a file the goal deleted and now ignores locally is refused and the local file survives", () => {
  git(["rm", "-q", "app.txt"], wt);
  writeFileSync(join(wt, ".gitignore"), "app.txt\n");
  git(["add", ".gitignore"], wt);
  git(["commit", "-q", "-m", "goal drops app.txt and ignores it"], wt);
  writeFileSync(join(wt, "app.txt"), "local only\n");
  commit(repo, "app.txt", "v2 from main\n", "main edits app");
  const before = state();
  const r = hq(repo, "sync", "g");
  expect(r.code).toBe(1);
  expect(r.err).toContain("app.txt");
  expect(r.out).toBe("");
  expect(readFileSync(join(wt, "app.txt"), "utf8")).toBe("local only\n");
  expect(state()).toBe(before);
});

test("main renaming onto a path the worktree ignores is refused and the local file survives", () => {
  commit(wt, ".gitignore", "renamed.txt\n", "ignore renamed");
  writeFileSync(join(wt, "renamed.txt"), "local only\n");
  git(["mv", "other.txt", "renamed.txt"], repo);
  git(["commit", "-q", "-m", "main renames other"], repo);
  const before = state();
  const r = hq(repo, "sync", "g");
  expect(r.code).toBe(1);
  expect(r.err).toContain("renamed.txt");
  expect(readFileSync(join(wt, "renamed.txt"), "utf8")).toBe("local only\n");
  expect(state()).toBe(before);
});

test("main modifying a file the goal deleted and the worktree has untracked (status hides it) is refused too", () => {
  git(["rm", "-q", "app.txt"], wt);
  git(["commit", "-q", "-m", "goal drops app.txt"], wt);
  git(["config", "status.showUntrackedFiles", "no"], wt);
  writeFileSync(join(wt, "app.txt"), "local only\n");
  expect(git(["status", "--porcelain"], wt)).toBe("");
  commit(repo, "app.txt", "v2 from main\n", "main edits app");
  const before = state();
  const r = hq(repo, "sync", "g");
  expect(r.code).toBe(1);
  expect(r.err).toContain("app.txt");
  expect(readFileSync(join(wt, "app.txt"), "utf8")).toBe("local only\n");
  expect(state()).toBe(before);
});
