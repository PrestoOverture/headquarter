// M1 writer (出题者): a fresh Claude session writes the hidden tests into the exam and stub code
// for new interfaces (D34). It works in a throwaway clone of the task's repository, so nothing it
// does reaches the answerer's repository except the stub commit, fetched only when it passes the
// checks. The orchestrator then checks the tests fail first, on assertions (D7).

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claude, examDir, git, runDir, sh, writersDir } from "./common";
import { criteriaOf } from "./interfaces";
import { writerOf } from "./sessions";

export const TEST_PATH = /(^|\/)(test|tests|__tests__)\/|\.test\.[cm]?[jt]sx?$/;

/** The hidden test files, relative to the exam's files/ (they are copied to the same repository paths). */
export function hiddenFiles(task: string): string[] {
  const root = join(examDir(task), "files");
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true, withFileTypes: true }) as any[])
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? e.path, e.name).slice(root.length + 1));
}

export type Written = { clone: string; stubCommit: string; stubFiles: string[]; problems: string[]; cost: number; reply: string };

export function write(dir: string, task: string, attempt: number, notes = ""): Written {
  const exam = examDir(task);
  rmSync(join(exam, "files"), { recursive: true, force: true });
  rmSync(join(exam, "run.sh"), { force: true });
  const { title, text } = criteriaOf(dir, task);
  const ifaces = readFileSync(join(exam, "interfaces.md"), "utf8");
  // Tries the tests: copy them in, run them, always take them out again.
  writeFileSync(join(exam, "try.sh"), `#!/bin/bash\n# copy the hidden tests into the current checkout, run them, remove them\nset -u\nfiles=$(cd "${exam}/files" && find . -type f)\ncleanup() { for f in $files; do rm -f "$f"; done; }\ntrap cleanup EXIT INT TERM\ncp -R "${exam}/files/." .\nbash "${exam}/run.sh"\n`);
  const clone = join(writersDir(), `${task}-${attempt}`);
  rmSync(clone, { recursive: true, force: true });
  git(["clone", "-q", "--no-hardlinks", dir, clone], dir);
  for (const d of ["hq", "eval"]) if (existsSync(join(dir, d, "node_modules"))) sh(["ln", "-s", join(dir, d, "node_modules"), join(clone, d, "node_modules")], dir);
  const start = git(["rev-parse", "HEAD"], clone);
  const prompt = `You are the test writer for a task in this repository (the working directory, at the task's starting point). Someone else will implement the task without ever seeing your tests; they only get the names and assertion messages of the tests that fail. Your tests are the evidence the task is done.

Task: ${title}

Acceptance criteria:
${text}

Interface list (fixed; use exactly these names, signatures and outputs):
${ifaces}

Write:
1. Hidden tests in ${exam}/files/, laid out at the repository-relative paths they run from (for example ${exam}/files/hq/test/m1-${task}.test.ts). Use bun test and the repository's existing test style. At least one assertion per acceptance criterion; assert the business result the criterion describes, not implementation details; no smoke tests. Name the files m1-*.test.ts.
2. ${exam}/run.sh: a bash script that, run from the repository root, runs only your tests (\`bun test --timeout 30000 <paths>\`, one call) and exits 0 only if all of them pass.
3. Stubs: for every interface marked new, the smallest code in this checkout that makes it exist with the listed name and signature but no behavior (functions that throw or return a placeholder, a command that exits with an error). Commit the stubs on the current branch. Do not implement the task, and commit no test files.

Your tests must fail on this checkout with the stubs, every one of them on an assertion (\`expect(...)\`), not because something is missing, does not compile, throws or times out: a stub that throws makes a test crash, so wrap such calls so the test asserts on the outcome. Check with \`bash ${exam}/try.sh\` until every test fails on an assertion. When done, reply with one line per test: its name and the criterion it covers.${notes ? `\n\n${notes}` : ""}`;
  const r = claude(["--model", "claude-sonnet-5-5", "--effort", "high", "--settings", JSON.stringify(writerOf(task, clone)), "--permission-mode", "acceptEdits", "--add-dir", exam, "--disallowedTools", "WebFetch", "WebSearch"], prompt, clone);
  writeFileSync(join(runDir(task), `writer-${attempt}.jsonl`), r.log);
  const cost = r.result?.total_cost_usd ?? 0;
  if (r.limited || !r.result) throw Object.assign(new Error(`writer session failed: ${r.result?.result ?? "no result"}`), { cost });
  const status = git(["status", "--porcelain"], clone);
  const stubCommit = git(["rev-parse", "HEAD"], clone);
  const stubFiles = stubCommit === start ? [] : git(["diff", "--name-only", `${start}..${stubCommit}`], clone).split("\n").filter(Boolean);
  const files = hiddenFiles(task);
  const problems = [
    ...(existsSync(join(exam, "run.sh")) ? [] : ["no run.sh"]),
    ...(files.some((f) => TEST_PATH.test(f)) ? [] : ["no test files in the exam"]),
    ...stubFiles.filter((f) => TEST_PATH.test(f)).map((f) => `the stub commit contains a test file: ${f}`),
    ...(Number(git(["rev-list", "--count", `${start}..${stubCommit}`], clone)) > 1 ? ["more than one stub commit"] : []),
    ...(status ? [`uncommitted changes left in the writer's checkout:\n${status}`] : []),
  ];
  return { clone, stubCommit, stubFiles, problems, cost, reply: String(r.result.result ?? "") };
}
