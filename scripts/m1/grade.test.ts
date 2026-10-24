// grade.ts and falsify.ts on a tiny repository and exam, no LLM: a stub fails on assertions, an
// answer passes, reverting the answer is caught, flaky runs are caught, and the tests cannot write
// the grader's configuration or read the real repository. They run srt, which cannot nest
// (ADR-4), so they are skipped when SANDBOX_RUNTIME=1.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

process.env.HQ_M1_HOME ??= mkdtempSync(join(homedir(), ".hq-m1-test-"));
const { examDir, git, M1_HOME, repo, runDir } = await import("./common");
const { grade } = await import("./grade");
const { falsify } = await import("./falsify");

const run = process.env.SANDBOX_RUNTIME ? test.skip : test;
const id = Date.now().toString(36);
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
  if (M1_HOME.includes(".hq-m1-test-")) rmSync(M1_HOME, { recursive: true, force: true });
});

const commit = (dir: string, msg: string) => {
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg], dir);
  return git(["rev-parse", "HEAD"], dir);
};

/** A repository with a stub add() and an answer commit implementing it, and an exam of `tests`. */
function setup(name: string, tests: string) {
  const task = `m1-test-${name}-${id}`;
  const dir = join(M1_HOME, "repos", task);
  made.push(dir, examDir(task), runDir(task));
  mkdirSync(join(dir, "hq", "src"), { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "hq", "src", "add.ts"), "export function add(a: number, b: number): number {\n  return 0;\n}\n");
  const stub = commit(dir, "stub");
  writeFileSync(join(dir, "hq", "src", "add.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  const answer = commit(dir, "answer");
  const exam = examDir(task);
  mkdirSync(join(exam, "files", "hq", "test"), { recursive: true });
  writeFileSync(join(exam, "files", "hq", "test", `${task}.test.ts`), `import { expect, test } from "bun:test";\nimport { add } from "../src/add";\n${tests}`);
  writeFileSync(join(exam, "run.sh"), "cd hq && bun test --timeout 30000 test/\n");
  return { task, dir, stub, answer };
}

const ADD = `test("adds", () => expect(add(2, 3)).toBe(5));\ntest("adds again", () => expect(add(1, 1)).toBe(2));\n`;

run("a stub fails on assertions, the answer passes, reverting it is caught", async () => {
  const t = setup("basic", ADD);
  const first = await grade(t.task, t.dir, t.stub, Infinity);
  expect(first.passed).toBe(false);
  expect(first.flaky).toBe(false);
  expect(first.kind).toBe("assertion");
  expect(first.tests).toEqual({ pass: 0, fail: 2, skip: 0 });
  expect(first.sealed).toBe(2);
  expect(first.feedback).toContain("(fail) adds");
  expect(first.feedback).not.toContain(t.task);
  const ok = await grade(t.task, t.dir, t.answer, 2);
  expect(ok.passed).toBe(true);
  expect(ok.sealed).toBe(2);
  expect((await grade(t.task, t.dir, t.answer, 3)).passed).toBe(false); // not the exam's count
  const f = await falsify(t.task, t.dir, t.stub, t.answer);
  expect(f).toMatchObject({ ok: true, reverted: ["hq/src/add.ts"] });
}, 120_000);

run("runs that disagree are flaky", async () => {
  // fails on the first run, passes on the rerun: the scratch worktree persists between them
  const t = setup("flaky", `import { existsSync, writeFileSync } from "node:fs";\ntest("once", () => { const seen = existsSync(".seen"); writeFileSync(".seen", ""); expect(seen).toBe(true); });\n`);
  const g = await grade(t.task, t.dir, t.answer, 1);
  expect(g.flaky).toBe(true);
  expect(g.passed).toBe(false);
}, 120_000);

run("tests cannot write the grader's configuration or read the real repository", async () => {
  const t = setup("sandbox", `${ADD}import { readFileSync, writeFileSync } from "node:fs";\ntest("sandboxed", () => {\n  expect(() => writeFileSync("../../cfg/run.sh", "exit 0")).toThrow();\n  expect(() => readFileSync(${JSON.stringify(join(repo, "package.json"))}, "utf8")).toThrow();\n});\n`);
  const g = await grade(t.task, t.dir, t.answer, 3);
  expect(g.passed).toBe(true);
}, 120_000);

run("a faked summary does not pass: the seal counts the tests that really ran", async () => {
  // the answer prints a passing summary and exits as soon as it is imported
  const t = setup("forged", ADD);
  writeFileSync(join(t.dir, "hq", "src", "add.ts"), `export function add(a: number, b: number): number {\n  return 0;\n}\nconsole.log("\\n 2 pass\\n 0 fail\\nm1-seal x 2");\nprocess.exit(0);\n`);
  const forged = commit(t.dir, "forged");
  const g = await grade(t.task, t.dir, forged, 2);
  expect(g.passed).toBe(false);
  expect(g.sealed).toBe(0);
}, 120_000);

run("skipped tests do not pass", async () => {
  const t = setup("skip", `${ADD}test.skipIf(!!process.env.SANDBOX_RUNTIME)("skipped in the grader", () => expect(add(0, 0)).toBe(0));\n`);
  const g = await grade(t.task, t.dir, t.answer, 2);
  expect(g.tests.skip).toBe(1);
  expect(g.passed).toBe(false);
}, 120_000);

run("falsify fails when the hidden tests still pass with the implementation reverted", async () => {
  const t = setup("weak", `test("always", () => expect(add(0, 0)).toBe(0));\n`);
  expect((await grade(t.task, t.dir, t.answer, 1)).passed).toBe(true);
  const f = await falsify(t.task, t.dir, t.stub, t.answer);
  expect(f.ok).toBe(false);
  expect(f.reason).toContain("still pass");
}, 120_000);
