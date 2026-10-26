// M1.2, step 2: the hidden tests adapted to M0's interfaces, so they reach M0's behaviour.
// M1's interface list (D34) was written without M0's code, so names, modules, flags and message
// texts the criteria leave open differ, and the tests stop on those before they check anything.
// A fresh session, in a copy of M0's version (cross.ts) with the hidden tests in it, changes only
// that glue; every behaviour assertion stays. The diff of the test files is kept for review, and
// the adapted tests are graded on M0's version exactly as cross.ts grades the originals (the
// adapted exam is m1-<task>-adapted). Costs are M1.2's, not the task's: not in the ledger.
//
//   bun scripts/m1/adapt.ts <m0-task> ...

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxSettings } from "../sandbox/check";
import { claude, examDir, git, M1_HOME, repoDir, usageLimited } from "./common";
import { grade } from "./grade";
import { criteriaOf } from "./interfaces";
import { hiddenFiles } from "./writer";

const results: object[] = [];
for (const m0 of process.argv.slice(2)) {
  const task = `m1-${m0}`;
  const cross = join(M1_HOME, "cross", task);
  if (!existsSync(join(cross, ".git"))) throw new Error(`${m0}: no cross-check repository; run cross.ts first`);
  const exam = examDir(task);
  const files = hiddenFiles(task);
  const count = Number(readFileSync(join(exam, "count"), "utf8"));
  const work = join(M1_HOME, "adapt", task);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(dirname(work), { recursive: true });
  git(["clone", "-q", "--no-hardlinks", cross, work], cross);
  for (const d of ["hq", "eval"]) if (existsSync(join(cross, d, "node_modules"))) cpSync(join(cross, d, "node_modules"), join(work, d, "node_modules"), { recursive: true, verbatimSymlinks: true });
  for (const f of files) {
    mkdirSync(dirname(join(work, f)), { recursive: true });
    copyFileSync(join(exam, "files", f), join(work, f));
  }
  git(["add", "-f", ...files], work);
  git(["-c", "user.name=m1", "-c", "user.email=m1@hq.invalid", "commit", "-q", "-m", "hidden tests as written"], work);
  const { title, text } = criteriaOf(repoDir(task), task);
  const prompt = `This repository holds an implementation of the task below, and a test file written for the same task by someone who never saw this implementation. The test author used an interface list that was agreed beforehand; this implementation chose its own names. Your job is to adapt the tests to this implementation's interfaces so that they test its behaviour, and nothing else.

Task: ${title}

Acceptance criteria:
${text}

Interface list the tests were written against:
${readFileSync(join(exam, "interfaces.md"), "utf8")}

Test files: ${files.join(", ")}. Run them with \`${readFileSync(join(exam, "run.sh"), "utf8").trim().split("\n").filter((l) => !l.startsWith("#")).join("; ")}\` from the repository root.

You may change, in the test files only:
- imports, module paths, function, type and field names, call signatures, CLI commands and flags, to the ones this implementation has for the same thing;
- exact message texts, output formats and wording the acceptance criteria do not fix, to what this implementation prints for the same case. Keep the check that the case is reported (for example still require a refusal to exit non-zero and to name the problem);
- test setup that only exists to reach the code (fixtures, helpers), when this implementation needs it differently.
You may not:
- change or remove any expectation about behaviour the acceptance criteria describe, however the implementation behaves: a test that fails because the implementation does something else than the criteria say must keep failing;
- delete, skip or merge tests, or weaken an assertion (toEqual to toMatchObject, exact values to "anything", fewer cases);
- change any file other than the test files. Do not fix the implementation.
When the criteria do not settle whether a difference is behaviour or wording, leave the assertion as it is and say so.

When done, reply with one line per change: test name, what changed and why it is glue, not behaviour; then one line per test you left failing on purpose, with the criterion it holds the implementation to.`;
  const s = sandboxSettings(join(work, ".git"), process.env.HOME!);
  const r = claude(["--model", "claude-sonnet-5-5", "--effort", "high", "--settings", JSON.stringify(s), "--permission-mode", "acceptEdits", "--disallowedTools", "WebFetch", "WebSearch"], prompt, work);
  writeFileSync(join(work, "..", `${task}.jsonl`), r.log);
  const cost = r.result?.total_cost_usd ?? 0;
  if (usageLimited(r.result)) {
    console.log(`${m0}: usage limit; stopped`);
    break;
  }
  const diff = git(["diff", "HEAD", "--", ...files], work);
  const others = git(["status", "--porcelain"], work).split("\n").filter((l) => l && !files.some((f) => l.endsWith(f)));
  writeFileSync(join(work, "..", `${task}.diff`), diff + "\n");
  // the adapted exam: same run.sh and count, adapted test files
  const alias = `${task}-adapted`;
  const ad = examDir(alias);
  rmSync(join(ad, "files"), { recursive: true, force: true });
  for (const f of files) {
    mkdirSync(dirname(join(ad, "files", f)), { recursive: true });
    copyFileSync(join(work, f), join(ad, "files", f));
  }
  copyFileSync(join(exam, "run.sh"), join(ad, "run.sh"));
  writeFileSync(join(ad, "count"), String(count));
  const g = await grade(alias, cross, git(["rev-parse", "HEAD"], cross));
  const res = {
    task: m0, cost, passed: g.passed, tests: g.tests, count, kind: g.kind, failing: g.failing, log: g.log,
    diff: join(work, "..", `${task}.diff`), changedOutsideTests: others, reply: String(r.result?.result ?? "").slice(0, 4000),
  };
  results.push(res);
  writeFileSync(join(work, "..", `${task}.json`), JSON.stringify(res, null, 2) + "\n");
  console.log(`${m0}: ${g.tests.pass} pass, ${g.tests.fail} fail of ${count}${g.tests.pass + g.tests.fail !== count ? " (COUNT CHANGED)" : ""}${others.length ? ` (changed outside tests: ${others.join(", ")})` : ""}, $${cost.toFixed(2)}`);
}
