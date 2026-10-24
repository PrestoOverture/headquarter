// M1 writer (出题者): a fresh Claude session writes the hidden tests into the exam and stub code
// for new interfaces (D34), in a scratch worktree at the task's starting point. It never sees an
// answer. The orchestrator then checks that the tests fail first, on assertions (D7).
//
//   bun scripts/m1/writer.ts <worktree> <goal> <task> <out.jsonl> [<notes>]
// Prints JSON with the stub commit (on branch m1-stubs/<task>) and the session's cost.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxSettings } from "../sandbox/check";
import { claude, examDir, git, repo, sh } from "./common";

const TEST_PATH = /(^|\/)(test|tests|__tests__)\/|\.test\.[cm]?[jt]sx?$/;

export async function write(wt: string, goal: string, task: string, out: string, notes = "") {
  const exam = await examDir(task);
  rmSync(join(exam, "files"), { recursive: true, force: true });
  rmSync(join(exam, "run.sh"), { force: true });
  const g = JSON.parse(readFileSync(join(wt, "goals", `${goal}.json`), "utf8"));
  const criteria = (g.acceptance as (string | { text: string })[]).map((a, i) => `${i + 1}. ${typeof a === "string" ? a : a.text}`).join("\n");
  const ifaces = readFileSync(join(exam, "interfaces.md"), "utf8");
  // A helper the writer runs to try its tests: copies them in, runs them, takes them out again.
  writeFileSync(join(exam, "try.sh"), `#!/bin/bash\n# copy the hidden tests into the current checkout, run them, remove them\nset -u\nfiles=$(cd "${exam}/files" && find . -type f)\ncp -R "${exam}/files/." .\nbash "${exam}/run.sh"; code=$?\nfor f in $files; do rm -f "$f"; done\nexit $code\n`);
  const branch = `m1-stubs/${task}`;
  const scratch = mkdtempSync(join(tmpdir(), `m1-writer-${task}-`));
  git(["worktree", "add", "-q", "-B", branch, scratch, git(["rev-parse", "HEAD"], wt)]);
  for (const d of ["hq", "eval"]) if (existsSync(join(repo, d, "node_modules")) && existsSync(join(scratch, d))) sh(["ln", "-s", join(repo, d, "node_modules"), join(scratch, d, "node_modules")], repo);
  try {
    const prompt = `You are the test writer for a task in this repository (the working directory, a git checkout at the task's starting point). Someone else will implement the task without ever seeing your tests; they only get the names and assertion messages of the tests that fail. Your tests are the evidence the task is done.

Task: ${g.title}

Acceptance criteria:
${criteria}

Interface list (fixed; use exactly these names, signatures and outputs):
${ifaces}

Write:
1. Hidden tests in ${exam}/files/, laid out at the repository-relative paths they run from (for example ${exam}/files/hq/test/m1-${task}.test.ts). Use the repository's test framework (bun test) and its existing test style. At least one assertion per acceptance criterion; assert the business result the criterion describes, not implementation details; no smoke tests.
2. ${exam}/run.sh: a bash script that, run from the repository root, runs only your tests (use \`bun test --timeout 30000 <paths>\`) and exits 0 only if all of them pass.
3. Stubs: for every interface marked new, add the smallest code in this checkout that makes it exist with the listed name and signature but no behavior (functions that throw or return a placeholder, a command that exits with an error). Commit the stubs on the current branch. Do not implement the task, and commit no test files.

Your tests must fail on this checkout with the stubs, and fail because an assertion does not hold, not because something is missing or does not compile. Check it with \`bash ${exam}/try.sh\` and fix the tests or stubs until every test fails on an assertion. When done, reply with one line per test: its name and the criterion it covers.${notes ? `\n\n${notes}` : ""}`;
    const base = sandboxSettings(join(repo, ".git"), process.env.HOME!);
    const settings = { ...base, sandbox: { ...base.sandbox, filesystem: { ...base.sandbox.filesystem, allowWrite: [exam] } } };
    const r = claude(["--model", "claude-sonnet-5-5", "--effort", "high", "--settings", JSON.stringify(settings), "--permission-mode", "acceptEdits", "--add-dir", exam, "--disallowedTools", "WebFetch", "WebSearch"], prompt, scratch);
    writeFileSync(out, r.log);
    if (r.limited || !r.result) throw new Error(`writer session failed: ${r.result?.result ?? "no result"}`);
    const status = git(["status", "--porcelain"], scratch);
    const stubCommit = git(["rev-parse", "HEAD"], scratch);
    const changed = git(["diff", "--name-only", `${git(["rev-parse", "HEAD"], wt)}..${stubCommit}`], scratch).split("\n").filter(Boolean);
    const problems = [
      ...(existsSync(join(exam, "run.sh")) ? [] : ["no run.sh"]),
      ...(existsSync(join(exam, "files")) && readdirSync(join(exam, "files")).length ? [] : ["no test files"]),
      ...changed.filter((f) => TEST_PATH.test(f)).map((f) => `stub commit contains a test file: ${f}`),
      ...(status ? [`uncommitted changes left in the writer's checkout:\n${status}`] : []),
    ];
    return { stubCommit, stubFiles: changed, problems, cost: r.result.total_cost_usd as number, reply: String(r.result.result ?? "") };
  } finally {
    sh(["git", "worktree", "remove", "--force", scratch], repo);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [wt, goal, task, out, notes] = process.argv.slice(2);
  if (!wt || !goal || !task || !out) throw new Error("usage: writer.ts <worktree> <goal> <task> <out.jsonl> [<notes>]");
  console.log(JSON.stringify(await write(wt, goal, task, out, notes ? readFileSync(notes, "utf8") : ""), null, 2));
}
