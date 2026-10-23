// hq trace: the real CLI and a real git repository with a goal branch; the checker is a fake
// executable that logs the prompt it was given on stdin and answers from the text of the criteria.

import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, run } from "../src/git";
import { parseAnswer, prompt } from "../src/trace";

const CLI = join(import.meta.dir, "../src/cli.ts");
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

let root: string, repo: string;

const hq = (...args: string[]) => run([process.execPath, CLI, ...args], repo);

/** Commits goals/g.json on goal/g. */
function goalFile(file: object) {
  const wt = join(root, "repo.goals/g");
  git(["worktree", "add", "-q", "-b", "goal/g", wt, "main"], repo);
  mkdirSync(join(wt, "goals"));
  writeFileSync(join(wt, "goals/g.json"), JSON.stringify(file));
  git(["add", "-A"], wt);
  git(["commit", "-qm", "goal file"], wt);
}

/** A checker that logs each prompt (separated by ---) and says DOES-NOT-SERVE when the prompt contains "unrelated", else SERVES. */
function fakeChecker(): string {
  const path = join(root, "checker.sh");
  writeFileSync(path, `#!/bin/sh\ninput=$(cat)\nprintf '%s\\n---\\n' "$input" >> "${root}/checker.log"\npwd >> "${root}/checker.cwd"\ncase "$input" in *unrelated*) echo "DOES-NOT-SERVE: no link";; *) echo SERVES;; esac\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hq-trace-test-")));
  process.env.HQ_HOME = join(root, "hq-home");
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "app.txt"), "v1\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "base"], repo);
});

const clean = {
  title: "t",
  criteria: ["first goal criterion", "second goal criterion"],
  tasks: {
    t1: { acceptance: [{ text: "does the first thing", traces: "g1" }, { text: "also the first", traces: "g1" }] },
    t2: { acceptance: [{ text: "does the second thing", traces: "g2" }] },
  },
};

describe("parseAnswer", () => {
  test("each answer, with surrounding words, and the unclear cases", () => {
    expect(parseAnswer("SERVES\n")).toBe("SERVES");
    expect(parseAnswer("DOES-NOT-SERVE: it is about something else")).toBe("DOES-NOT-SERVE");
    expect(parseAnswer("I think it SERVES the goal")).toBe("SERVES");
    expect(parseAnswer("SERVES... no, DOES-NOT-SERVE")).toBe("NO-ANSWER");
    expect(parseAnswer("serves")).toBe("NO-ANSWER");
    expect(parseAnswer("")).toBe("NO-ANSWER");
  });
});

describe("hq trace", () => {
  test("all traced and every goal criterion covered: exit 0", () => {
    goalFile(clean);
    const r = hq("trace", "g");
    expect(r.code).toBe(0);
    expect(r.out).toContain("trace ok: 2 goal criteria");
  });

  test("a task criterion with no trace, plain string or object without traces", () => {
    goalFile({ ...clean, tasks: { ...clean.tasks, t3: { acceptance: ["a bare string", { text: "an object without traces" }] } } });
    const r = hq("trace", "g");
    expect(r.code).toBe(1);
    expect(r.out).toContain("task criteria with no trace:");
    expect(r.out).toContain("t3#1: a bare string");
    expect(r.out).toContain("t3#2: an object without traces");
    expect(r.out).not.toContain("t1#1");
    expect(r.out).toContain("trace failed");
  });

  test("a trace to a goal criterion that does not exist", () => {
    goalFile({ ...clean, tasks: { ...clean.tasks, t3: { acceptance: [{ text: "points nowhere", traces: "g9" }] } } });
    const r = hq("trace", "g");
    expect(r.code).toBe(1);
    expect(r.out).toContain("t3#1 -> g9: points nowhere");
    expect(r.out).not.toContain("no trace:");
  });

  test("a goal criterion no task traces to; a dangling trace does not cover it", () => {
    goalFile({ title: "t", criteria: ["one", "two", "three"], tasks: { t1: { acceptance: [{ text: "x", traces: "g1" }, { text: "y", traces: "g4" }] } } });
    const r = hq("trace", "g");
    expect(r.code).toBe(1);
    expect(r.out).toContain("goal criteria no task traces to:");
    expect(r.out).toContain("g2: two");
    expect(r.out).toContain("g3: three");
    expect(r.out).not.toContain("g1: one");
  });

  test("a goal with no criteria and no tasks is clean", () => {
    goalFile({ title: "t" });
    expect(hq("trace", "g").code).toBe(0);
  });

  test("a malformed criteria list is an error, not an empty one", () => {
    goalFile({ criteria: "nope" });
    const r = hq("trace", "g");
    expect(r.code).toBe(1);
    expect(r.err).toContain("criteria must be a list of strings");
  });

  test("no such goal", () => {
    const r = hq("trace", "nope");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no branch goal/nope");
  });
});

describe("hq trace --check-with", () => {
  test("every trace is put to the checker with only the two texts, in an empty directory; all SERVES passes", () => {
    goalFile(clean);
    const r = hq("trace", "g", "--check-with", fakeChecker());
    expect(r.code).toBe(0);
    expect(r.out).toContain("t1#1 -> g1: SERVES");
    expect(r.out).toContain("t1#2 -> g1: SERVES");
    expect(r.out).toContain("t2#1 -> g2: SERVES");
    const log = readFileSync(join(root, "checker.log"), "utf8");
    expect(log.split("---\n").filter(Boolean)).toEqual([
      prompt("first goal criterion", "does the first thing") + "\n",
      prompt("first goal criterion", "also the first") + "\n",
      prompt("second goal criterion", "does the second thing") + "\n",
    ]);
    for (const cwd of readFileSync(join(root, "checker.cwd"), "utf8").trim().split("\n")) expect(cwd).not.toContain(root);
  });

  test("a DOES-NOT-SERVE answer is printed and fails the check", () => {
    goalFile({ ...clean, tasks: { ...clean.tasks, t2: { acceptance: [{ text: "something unrelated", traces: "g2" }] } } });
    const r = hq("trace", "g", "--check-with", fakeChecker());
    expect(r.code).toBe(1);
    expect(r.out).toContain("t1#1 -> g1: SERVES");
    expect(r.out).toContain("t2#1 -> g2: DOES-NOT-SERVE");
    expect(r.out).toContain("trace failed");
  });

  test("a checker that fails or gives no clear answer fails the check", () => {
    goalFile(clean);
    const r = hq("trace", "g", "--check-with", "echo boom >&2; exit 3");
    expect(r.code).toBe(1);
    expect(r.out).toContain("t1#1 -> g1: NO-ANSWER (checker exited 3: boom)");
    const r2 = hq("trace", "g", "--check-with", "echo maybe");
    expect(r2.code).toBe(1);
    expect(r2.out).toContain("NO-ANSWER (maybe)");
  });

  test("structural problems are reported alongside, and untraceable criteria are not sent to the checker", () => {
    goalFile({ title: "t", criteria: ["one", "two"], tasks: { t1: { acceptance: [{ text: "x", traces: "g1" }, "bare", { text: "z", traces: "g7" }] } } });
    const r = hq("trace", "g", "--check-with", fakeChecker());
    expect(r.code).toBe(1);
    expect(r.out).toContain("t1#2: bare");
    expect(r.out).toContain("t1#3 -> g7: z");
    expect(r.out).toContain("g2: two");
    expect(readFileSync(join(root, "checker.log"), "utf8").split("---\n").filter(Boolean)).toHaveLength(1);
  });

  test("without --check-with no checker runs", () => {
    goalFile(clean);
    expect(hq("trace", "g").out).not.toContain("checked traces");
  });
});
