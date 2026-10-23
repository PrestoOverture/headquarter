// Goal report (roadmap M0.2, D31) on a fake goal: real git, real trial merge, real srt.

import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve } from "../src/cli";
import { git, revParse } from "../src/git";
import { dependencyChanges, newKinds, readReportMeta, renderReport, report, sensitiveHits, writeReport } from "../src/report";

const withSandbox = test.skipIf(process.env.SANDBOX_RUNTIME === "1"); // see lock.test.ts
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

let root: string, repo: string, wt: string;

function put(cwd: string, file: string, text: string) {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), text);
}
function commit(cwd: string, files: Record<string, string>, msg: string) {
  for (const [f, t] of Object.entries(files)) put(cwd, f, t);
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", msg], cwd);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hq-report-")));
  process.env.HQ_HOME = join(root, "hq-home");
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  commit(
    repo,
    {
      ".hq.json": JSON.stringify({ test: "echo RAN-THE-TESTS && ! grep -q BROKEN src/app.ts" }),
      "src/app.ts": "export const v = 1;\n",
      "package.json": JSON.stringify({ dependencies: { zod: "3.25.0", old: "1.0.0" } }),
    },
    "base",
  );
  wt = join(root, "wt");
  git(["worktree", "add", "-q", "-b", "goal/x", wt, "main"], repo);
});

withSandbox("five columns from a real trial merge, and approve accepts its commit", () => {
  commit(wt, { "src/app.ts": "export const v = 2;\n" }, "task 1: bump v");
  commit(
    wt,
    {
      ".github/workflows/ci.yml": "on: push\n",
      "package.json": JSON.stringify({ dependencies: { zod: "3.26.0", leftpad: "1.3.0" } }),
      "tools/gen.py": "print(1)\n",
      "goals/x.json": JSON.stringify({ title: "Bump v", shelved: [{ task: "task 3", why: "needs a database" }], known_issues: ["flaky clock test"] }),
    },
    "task 2: CI and deps",
  );
  const r = report(repo, "x");
  const md = r.markdown;
  expect(r.meta.test_code).toBe(0);
  expect(r.meta.commit).toBe(revParse("goal/x", repo)!);
  for (const s of ["## 改了什么", "## 怎么测的", "## 风险", "## 怎么撤回", "## 没做完的"]) expect(md).toContain(s);
  expect(md).toMatch(/[0-9a-f]{7} task 1: bump v\n- [0-9a-f]{7} task 2: CI and deps/);
  expect(md).toContain("RAN-THE-TESTS"); // raw output, not a verdict
  expect(md).toContain("退出码 0");
  expect(md).toContain("- .github/workflows/ci.yml");
  expect(md).toContain("package.json: + leftpad@1.3.0 (dependencies)");
  expect(md).toContain("package.json: ~ zod 3.25.0 → 3.26.0 (dependencies)");
  expect(md).toContain("package.json: - old (dependencies)");
  expect(md).toContain("新目录 tools/");
  expect(md).toContain("新文件类型 .py（tools/gen.py）");
  expect(md).toContain("git revert -m 1 <合并提交>");
  expect(md).toContain("task 3：needs a database");
  expect(md).toContain("flaky clock test");
  expect(md).toContain("目标报告：x：Bump v");
  expect(existsSync(r.path)).toBe(true);
  writeFileSync(join(root, "tty"), "x\n");
  process.env.HQ_TTY = join(root, "tty");
  expect(approve(repo, "x")).toBe(r.meta.commit);
});

withSandbox("failing tests show in the report and block approval", () => {
  commit(wt, { "src/app.ts": "BROKEN\n" }, "breaks it");
  const r = report(repo, "x");
  expect(r.meta.test_code).not.toBe(0);
  expect(r.markdown).toContain("**测试没过**");
  process.env.HQ_TTY = join(root, "tty");
  writeFileSync(process.env.HQ_TTY, "x\n");
  expect(() => approve(repo, "x")).toThrow("failing tests");
});

test("approve needs a report for the current commit", () => {
  commit(wt, { "src/app.ts": "export const v = 2;\n" }, "task 1");
  const old = revParse("goal/x", repo)!;
  writeReport(repo, { goal: "x", commit: old, base: "b", trial_merge: "m", test_code: 0, generated_at: "now" }, "# r", "ok");
  commit(wt, { "src/app.ts": "export const v = 3;\n" }, "task 2 after the report");
  process.env.HQ_TTY = join(root, "tty");
  writeFileSync(process.env.HQ_TTY, "x\n");
  expect(() => approve(repo, "x")).toThrow("no report for goal/x");
  expect(readReportMeta(repo, "x", old)).not.toBeNull();
});

test("risk helpers", () => {
  expect(dependencyChanges({ dependencies: { a: "1" } }, { dependencies: { a: "2", b: "1" }, devDependencies: { c: "1" } })).toEqual([
    "~ a 1 → 2 (dependencies)",
    "+ b@1 (dependencies)",
    "+ c@1 (devDependencies)",
  ]);
  expect(dependencyChanges(null, null)).toEqual([]);
  expect(sensitiveHits(["hq/src/a.ts", "docs/x.md", "a/.env.local", ".hq.json"], ["hq/**", "**/.env*", ".hq.json"])).toEqual([
    "hq/src/a.ts",
    "a/.env.local",
    ".hq.json",
  ]);
  expect(newKinds(repo, ["src/b.ts", "lib/c.rs", "README"])).toEqual(["新目录 lib/", "新文件类型 .rs（lib/c.rs）"]);
});

test("long test output is cut to its tail, with the full log's path", () => {
  const out = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
  const md = renderReport({
    goal: "x", head: "a".repeat(40), base: "b".repeat(40), trialMerge: "c".repeat(40), tasks: [], testCommand: "t", testCode: 0,
    testOutput: out, logPath: "/logs/x.test.log", sensitive: [], deps: [], kinds: [], shelved: [], knownIssues: [],
  });
  expect(md).toContain("line 999");
  expect(md).not.toContain("line 699\n");
  expect(md).toContain("前面 700 行在 `/logs/x.test.log`");
});
