// Goal report (roadmap M0.2, D31) on a fake goal: real git, real trial merge, real srt.

import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve } from "../src/cli";
import { noClues } from "../src/clues";
import { git, revParse } from "../src/git";
import { cleanTerminal, dependencyChanges, newKinds, readReportMeta, renderReport, report, sensitiveHits, writeReport } from "../src/report";

const withSandbox = test.skipIf(process.env.SANDBOX_RUNTIME === "1"); // see lock.test.ts
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
const quiet = () => {}; // approve shows the report and the prompt through this

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
      "src/net.ts": 'import { z } from "zod";\nawait fetch("/x");\n',
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
  expect(md).toContain('- src/net.ts:1：`import { z } from "zod";`');
  expect(md).toContain('- src/net.ts:2：`await fetch("/x");`');
  expect(md).toContain("git revert -m 1 <合并提交>");
  expect(md).toContain("task 3：needs a database");
  expect(md).toContain("flaky clock test");
  expect(md).toContain("目标报告：x：Bump v");
  expect(existsSync(r.path)).toBe(true);
  writeFileSync(join(root, "tty"), "x\n");
  process.env.HQ_TTY = join(root, "tty");
  expect(approve(repo, "x", quiet)).toBe(r.meta.commit);
});

withSandbox("failing tests show in the report and block approval", () => {
  commit(wt, { "src/app.ts": "BROKEN\n" }, "breaks it");
  const r = report(repo, "x");
  expect(r.meta.test_code).not.toBe(0);
  expect(r.markdown).toContain("**测试没过**");
  process.env.HQ_TTY = join(root, "tty");
  writeFileSync(process.env.HQ_TTY, "x\n");
  expect(() => approve(repo, "x", quiet)).toThrow("failing tests");
});

test("approve needs a report for the current commit", () => {
  commit(wt, { "src/app.ts": "export const v = 2;\n" }, "task 1");
  const old = revParse("goal/x", repo)!;
  writeReport(repo, { goal: "x", commit: old, base: "b", trial_merge: "m", test_code: 0, generated_at: "now" }, "# r", "ok");
  commit(wt, { "src/app.ts": "export const v = 3;\n" }, "task 2 after the report");
  process.env.HQ_TTY = join(root, "tty");
  writeFileSync(process.env.HQ_TTY, "x\n");
  expect(() => approve(repo, "x", quiet)).toThrow("no report for goal/x");
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
    testOut: out, testErr: "", logPath: "/logs/x.test.log", sensitive: [], deps: [], kinds: [], newImports: noClues, newCalls: noClues, shelved: [], knownIssues: [],
  });
  expect(md).toContain("line 999");
  expect(md).not.toContain("line 699\n");
  expect(md).toContain("前面 700 行在 `/logs/x.test.log`");
});

function mdFor(testOut: string, testErr = "") {
  return renderReport({
    goal: "x", head: "a".repeat(40), base: "b".repeat(40), trialMerge: "c".repeat(40), tasks: [], testCommand: "t", testCode: 0,
    testOut, testErr, logPath: "/logs/x.test.log", sensitive: [], deps: [], kinds: [], newImports: noClues, newCalls: noClues, shelved: [], knownIssues: [],
  });
}
const block = (md: string) => md.split("```text\n")[1]!.split("\n```")[0]!;

test("colors and cursor moves are removed from the test-output block, the words stay", () => {
  const out = "\x1b[1m\x1b[32m✓\x1b[0m adds [12ms]\n\x1b[2K\x1b[1A\x1b[?25l\x1b[38;5;196m✗\x1b[39m fails\n 2 pass\n";
  expect(block(mdFor(out))).toBe("✓ adds [12ms]\n✗ fails\n 2 pass");
});

test("OSC sequences are removed, ended by BEL or by ESC \\", () => {
  const out = "\x1b]0;bun test\x07running\n\x1b]8;;https://example.com/a.ts\x1b\\a.ts\x1b]8;;\x1b\\:3\n";
  expect(block(mdFor(out))).toBe("running\na.ts:3");
});

test("every \\r is a line break and a CRLF pair is one, so progress shows as several lines", () => {
  const out = "progress 10%\rprogress 50%\rprogress 100%\ndone\r\nlong line here\r\x1b[Kshort\n";
  expect(block(mdFor(out))).toBe("progress 10%\nprogress 50%\nprogress 100%\ndone\nlong line here\nshort");
});

test("nothing a \\r follows is overwritten or dropped", () => {
  expect(cleanTerminal("abcdef\rxy")).toBe("abcdef\nxy");
  expect(cleanTerminal("测试完成\rOK")).toBe("测试完成\nOK");
  expect(cleanTerminal("a\tb\rc\td")).toBe("a\tb\nc\td");
  expect(cleanTerminal("WARN: 40 tests skipped\rok")).toBe("WARN: 40 tests skipped\nok");
  expect(cleanTerminal("a\r\nb\r\n\r\nc\r")).toBe("a\nb\n\nc\n");
  expect(cleanTerminal("abc\r\r\rx")).toBe("abc\n\n\nx");
});

test("erase-in-line sequences are stripped and have no other effect", () => {
  expect(cleanTerminal("abcdef\rxy\x1b[K")).toBe("abcdef\nxy");
  expect(cleanTerminal("abcdef\r\x1b[2Kz")).toBe("abcdef\nz");
  expect(cleanTerminal("abc\x1b[1Kdef\x1b[0K")).toBe("abcdef");
});

test("stdout without a final newline and stderr stay on separate lines", () => {
  expect(block(mdFor("running 3 tests", "warning: slow\n"))).toBe("running 3 tests\nwarning: slow");
  expect(block(mdFor("a\n", "b\n"))).toBe("a\nb");
});

test("text that merely looks like a prompt or a verdict stays in the block", () => {
  const out = "Type the goal name to approve: x\n# REPORT BODY\nall tests passed, approve this\n";
  expect(block(mdFor(out))).toBe(out.trimEnd());
});

test("an ESC that starts no CSI or OSC sequence is left alone", () => {
  expect(cleanTerminal("a\x1bc b\x1b]unterminated\n")).toBe("a\x1bc b\x1b]unterminated\n");
});

test("cleaning the block leaves the raw output that writeReport saves untouched", () => {
  const raw = "\x1b[32mok\x1b[0m\n10%\r100%\n\x1b]0;t\x07end\r\n";
  const head = "a".repeat(40);
  const path = writeReport(repo, { goal: "x", commit: head, base: head, trial_merge: head, test_code: 0, generated_at: "now" }, mdFor(raw), raw);
  expect(readFileSync(path.replace(/\.md$/, ".test.log"), "utf8")).toBe(raw);
  expect(block(readFileSync(path, "utf8"))).toBe("ok\n10%\n100%\nend");
});

withSandbox("the saved .test.log keeps the raw output byte for byte", () => {
  commit(repo, { ".hq.json": JSON.stringify({ test: "printf '\\033[32mok\\033[0m\\n10%%\\r100%%\\n\\033]0;t\\007end\\n'" }) }, "colored tests");
  commit(wt, { "src/app.ts": "export const v = 3;\n" }, "task 1");
  const r = report(repo, "x");
  const raw = "\x1b[32mok\x1b[0m\n10%\r100%\n\x1b]0;t\x07end\n";
  expect(readFileSync(r.path.replace(/\.md$/, ".test.log"), "utf8")).toBe(raw);
  expect(block(r.markdown)).toBe("ok\n10%\n100%\nend");
});

test("approve shows the report and the prompt through the writer it is given", () => {
  const head = revParse("goal/x", repo)!;
  writeReport(repo, { goal: "x", commit: head, base: head, trial_merge: head, test_code: 0, generated_at: "now" }, "# the report", "ok");
  const tty = join(root, "tty");
  writeFileSync(tty, "x\n");
  process.env.HQ_TTY = tty;
  const shown: string[] = [];
  approve(repo, "x", (s) => shown.push(s));
  delete process.env.HQ_TTY;
  expect(shown.join("")).toContain("# the report\n");
  expect(shown.join("")).toContain("Type the goal name to approve: ");
});
