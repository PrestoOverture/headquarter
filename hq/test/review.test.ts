// hq review: the real CLI and a real git repository with a goal worktree; `codex` is a fake
// executable first on PATH that logs how it was called and prints a canned review (no network).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, run } from "../src/git";
import { append, readEvents } from "../src/ledger";
import { parseFindings, reviewsDir, verdict } from "../src/review";

const CLI = join(import.meta.dir, "../src/cli.ts");
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

let root: string, repo: string, wt: string, base: string, head: string, savedPath: string | undefined;

const hq = (...args: string[]) => run([process.execPath, CLI, ...args], repo);

/** Installs a fake codex that logs "<cwd> <args> <base commit>" to codex.log, prints `body` and exits with `code`. */
function fakeCodex(body: string, code = 0) {
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "body.txt"), body);
  const script = `#!/bin/sh\necho "$PWD $* $(git rev-parse "$3")" >> "${root}/codex.log"\ncat "${root}/body.txt"\nexit ${code}\n`;
  writeFileSync(join(root, "bin/codex"), script);
  chmodSync(join(root, "bin/codex"), 0o755);
}

/** The saved review files of this repo, newest last. */
const saved = () => (existsSync(reviewsDir(repo)) ? readdirSync(reviewsDir(repo)).sort().map((f) => join(reviewsDir(repo), f)) : []);
const stem = () => `g-${head.slice(0, 12)}-t1-`;

const gates = () => readEvents(repo).filter((e) => e.type === "task.gate");

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hq-review-")));
  process.env.HQ_HOME = join(root, "hq-home");
  savedPath = process.env.PATH;
  process.env.PATH = `${join(root, "bin")}:${savedPath}`;
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "app.txt"), "v1\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "base"], repo);
  base = git(["rev-parse", "HEAD"], repo);
  wt = join(root, "repo.goals/g");
  git(["worktree", "add", "-q", "-b", "goal/g", wt, "main"], repo);
  writeFileSync(join(wt, "app.txt"), "v2\n");
  git(["commit", "-qam", "change"], wt);
  head = git(["rev-parse", "HEAD"], wt);
  append(repo, { type: "task.start", task: "t1", goal: "g", title: "t", base, difficulty: "medium", model: "m" });
});

afterEach(() => {
  process.env.PATH = savedPath;
});

describe("parsing", () => {
  test("each priority, with title, file and line", () => {
    const out = [
      "- [P0] Drops all data — src/db.ts:10",
      "- [P1] Race in startup — src/boot.ts:7-20",
      "- [P2] Missing check — /abs/path/a.ts:3",
      "- [P3] Naming — x.ts:1",
    ].join("\n");
    expect(parseFindings(out)).toEqual([
      { priority: 0, title: "Drops all data", file: "src/db.ts", line: 10 },
      { priority: 1, title: "Race in startup", file: "src/boot.ts", line: 7, endLine: 20 },
      { priority: 2, title: "Missing check", file: "/abs/path/a.ts", line: 3 },
      { priority: 3, title: "Naming", file: "x.ts", line: 1 },
    ]);
  });

  test("a finding without a location, other bullets ignored, a list printed twice counted once", () => {
    const list = "- [P2] No location here\n- not a finding\n  - [P5] bad priority — a.ts:1\n- [P1] Real — a.ts:2";
    expect(parseFindings(`${list}\ncodex\n${list}`)).toEqual([{ priority: 2, title: "No location here" }, { priority: 1, title: "Real", file: "a.ts", line: 2 }]);
  });

  test("a real Codex review with a line range", () => {
    const out = readFileSync(join(import.meta.dir, "fixtures/codex-range.txt"), "utf8");
    expect(parseFindings(out)).toEqual([
      {
        priority: 2,
        title: "Roll back partial failures from worktree creation",
        file: "/Users/kwang/projects/headquarter.goals/goal-new/hq/src/goal.ts",
        line: 23,
        endLine: 24,
      },
    ]);
  });

  test("only the final review counts, not a [P1] line in the transcript before it", () => {
    const out = "reading the file:\n- [P1] quoted from a source file — a.ts:1\ncodex\nsome prose\n- [P3] Real — b.ts:2\n";
    expect(parseFindings(out)).toEqual([{ priority: 3, title: "Real", file: "b.ts", line: 2 }]);
    expect(verdict(parseFindings(out))).toBe("pass");
    expect(parseFindings("codex\nfirst\ncodex\n- [P0] Only after the last marker — c.ts:3")).toEqual([{ priority: 0, title: "Only after the last marker", file: "c.ts", line: 3 }]);
  });

  test("a finding whose location does not parse is kept, with no file", () => {
    expect(parseFindings("- [P1] Broken thing — somewhere in the parser\n- [P0] Spaces — /a b/c.ts:4")).toEqual([
      { priority: 1, title: "Broken thing — somewhere in the parser" },
      { priority: 0, title: "Spaces — /a b/c.ts:4" },
    ]);
    expect(verdict(parseFindings("- [P1] Broken thing — somewhere"))).toBe("fail");
  });

  test("P0 and P1 fail, P2 and P3 and nothing pass", () => {
    expect(verdict(parseFindings("- [P0] a — f:1"))).toBe("fail");
    expect(verdict(parseFindings("- [P1] a — f:1"))).toBe("fail");
    expect(verdict(parseFindings("- [P2] a — f:1\n- [P3] b — f:2"))).toBe("pass");
    expect(verdict([])).toBe("pass");
  });
});

describe("hq review", () => {
  test("reviews against the task's base from the goal worktree, saves and prints the output, records the gate", () => {
    const body = "thinking...\n- [P1] Race in startup — src/boot.ts:7\n- [P3] Naming — x.ts:1\n";
    fakeCodex(body);
    const r = hq("review", "g", "--task", "t1", "--claimed-done");
    expect(r.code).toBe(1);
    expect(r.out).toContain(body.trimEnd());
    const [path] = saved() as [string];
    expect(path).toMatch(new RegExp(`${stem()}\\d+\\.txt$`));
    expect(readFileSync(path, "utf8")).toBe(body);
    const [cwd, review, flag, branch, sha] = readFileSync(join(root, "codex.log"), "utf8").trim().split(" ");
    expect([cwd, review, flag, sha]).toEqual([wt, "review", "--base", base]);
    expect(git(["branch", "--list", branch!], repo)).toBe(""); // the throwaway branch is gone
    expect(git(["branch", "--format=%(refname:short)"], repo).split("\n").sort()).toEqual(["goal/g", "main"]);
    expect(gates()).toMatchObject([{ task: "t1", gate: "codex_review", result: "fail", claimed_done: true }]);
    const note = (gates()[0] as { note: string }).note;
    expect(note).toContain("[P1] Race in startup (src/boot.ts:7)");
    expect(note).toContain("[P3] Naming (x.ts:1)");
    expect(note).toContain(path);
  });

  test("P2 and P3 findings pass the gate", () => {
    fakeCodex("- [P2] Minor — a.ts:1\n");
    const r = hq("review", "g", "--task", "t1");
    expect(r.code).toBe(0);
    expect(gates()).toMatchObject([{ gate: "codex_review", result: "pass", claimed_done: false }]);
  });

  test("an empty review passes", () => {
    fakeCodex("The change looks correct.\n");
    const r = hq("review", "g", "--task", "t1");
    expect(r.code).toBe(0);
    expect(r.out).toContain("no findings");
    expect(gates()).toMatchObject([{ result: "pass", note: expect.stringContaining("no findings") }]);
  });

  test("every invocation keeps its own file and the recorded note names the one it ran", () => {
    fakeCodex("- [P3] First — a.ts:1\n");
    hq("review", "g", "--task", "t1");
    fakeCodex("- [P2] Second — a.ts:2\n");
    hq("review", "g", "--task", "t1");
    const files = saved();
    expect(files).toHaveLength(2);
    expect(readFileSync(files[0]!, "utf8")).toContain("First");
    expect(readFileSync(files[1]!, "utf8")).toContain("Second");
    const notes = gates().map((g) => (g as { note: string }).note);
    expect(notes[0]).toContain(files[0]!);
    expect(notes[1]).toContain(files[1]!);
  });

  test("--no-record saves and prints but records nothing", () => {
    fakeCodex("- [P0] Bad — a.ts:1\n");
    const r = hq("review", "g", "--task", "t1", "--no-record");
    expect(r.code).toBe(1);
    expect(r.out).toContain("not recorded");
    expect(saved()).toHaveLength(1);
    expect(gates()).toEqual([]);
  });

  test("a codex that exits non-zero fails the command, records nothing and leaves no branch", () => {
    fakeCodex("- [P3] looks fine — a.ts:1\nauth error\n", 3);
    const r = hq("review", "g", "--task", "t1");
    expect(r.code).toBe(1);
    expect(r.err).toContain("codex review exited 3");
    expect(gates()).toEqual([]);
    expect(git(["branch", "--format=%(refname:short)"], repo).split("\n").sort()).toEqual(["goal/g", "main"]);
  });

  test("refuses an unknown task, a task of another goal, a missing --task", () => {
    fakeCodex("");
    expect(hq("review", "g", "--task", "nope").err).toContain("no task nope");
    append(repo, { type: "task.start", task: "t2", goal: "other", title: "t", base, difficulty: "medium", model: "m" });
    expect(hq("review", "g", "--task", "t2").err).toContain("belongs to goal other");
    expect(hq("review", "g").err).toContain("missing --task");
    expect(existsSync(join(root, "codex.log"))).toBe(false);
  });
});
