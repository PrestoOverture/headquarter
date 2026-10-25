// M1 for one task, from its M0 starting point (roadmap M1 实施计划): sanitized repository →
// interface list → writer (hidden tests + stubs, fails-first on assertions) → answers judged by
// the hidden tests, at most 3 in all (D43) → falsifiability check. Every gate and every session's
// cost goes into the ledger under arm m1, including sessions that fail. The two reviews and the
// full tests come after, as in M0 (scripts/m1/review-gates.ts).
//
//   bun scripts/m1/run-task.ts <m0-task> [--notes <file>]
// Resumable from ~/.hq-m1/runs/m1-<task>/state.json; --notes passes review findings into the next
// answer (a rework round, which counts toward the 3).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { claude, examDir, git, repo, runDir, sh, usageLimited } from "./common";
import { falsify } from "./falsify";
import { grade } from "./grade";
import { criteriaOf, interfaces } from "./interfaces";
import { answererOf, configTouched } from "./sessions";
import { prepare } from "./workspace";
import { write } from "./writer";

const MAX_ANSWERS = 3; // D43
const ANSWERER = "claude-sonnet-5-5";
const hq = join(process.env.HOME!, ".hq/bin/hq");

function hqRun(...args: string[]) {
  const r = sh([hq, ...args], repo);
  if (r.code !== 0) throw new Error(`hq ${args.join(" ")}: ${r.out.trim()}`);
  return r.out.trim();
}

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { notes: { type: "string" } } });
const m0 = positionals[0];
if (!m0) throw new Error("usage: run-task.ts <m0-task> [--notes <file>]");
const task = `m1-${m0}`;
const out = runDir(task);
const stateFile = join(out, "state.json");
const s: any = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { answers: [] };
const save = () => writeFileSync(stateFile, JSON.stringify(s, null, 2) + "\n");
const finish = (result: string, extra: object = {}, code = 0) => {
  console.log(JSON.stringify({ task, result, ...extra }));
  process.exit(code);
};
/** Records a session's cost whatever happened to it; a usage limit stops the run (resume later). */
function spent(log: string, model: string, usd: number, result: any) {
  if (usd > 0) hqRun("task", "cost", task, String(Math.round(usd * 1e4) / 1e4), "--model", model);
  // Only the session's final result says whether it hit the limit; the log can quote that text.
  if (usageLimited(result)) { save(); finish("usage_limit", { log }, 6); }
}

// 1. The task's sanitized repository; the M1 task in the ledger.
if (!s.dir) {
  const row = hqRun("stats", "--tasks", "--arm", "m0").split("\n").map((l) => JSON.parse(l)).find((r) => r.task === m0);
  if (!row) throw new Error(`no M0 task ${m0} in the ledger`);
  s.dir = prepare(task, m0, row.base, row.goal);
  hqRun("task", "start", task, "--goal", task, "--title", row.title, "--difficulty", row.difficulty, "--model", ANSWERER, "--arm", "m1", "--base", row.base);
  save();
}
const dir: string = s.dir;

// 2. Interface list, by a session that cannot see M0's code.
if (!s.interfaces) {
  const log = join(out, `interfaces-${Date.now()}.jsonl`);
  try {
    const r = interfaces(dir, task, log);
    spent(log, "claude-sonnet-5-5", r.cost, null);
  } catch (e: any) {
    spent(log, "claude-sonnet-5-5", e.cost ?? 0, e.result);
    throw e;
  }
  s.interfaces = git(["rev-parse", "HEAD"], dir);
  save();
}

// 3. Writer: hidden tests and stubs; every test must fail first, on an assertion. One retry.
if (!s.stubCommit) {
  let notes: string = s.writerNotes ?? ""; // kept in the state, so a resumed run still passes them on
  // An attempt counts once its session finished; one cut off by a usage limit is rerun.
  for (let attempt = (s.writerDone ?? 0) + 1; attempt <= 2 && !s.stubCommit; attempt++) {
    let w;
    try {
      w = write(dir, task, attempt, notes);
    } catch (e: any) {
      spent(join(out, `writer-${attempt}.jsonl`), "claude-sonnet-5-5", e.cost ?? 0, e.result);
      throw e;
    }
    spent(join(out, `writer-${attempt}.jsonl`), "claude-sonnet-5-5", w.cost, null);
    s.writerDone = attempt;
    const problems = [...w.problems];
    let first;
    if (!problems.length) {
      first = await grade(task, w.clone, w.stubCommit, Infinity);
      if (first.flaky) problems.push("the tests are flaky on the stubs");
      else if (first.tests.pass > 0) problems.push(`${first.tests.pass} tests pass on the stubs`);
      else if (first.timedOut) problems.push("the tests did not finish within 20 minutes");
      else if (first.tests.fail === 0) problems.push("no test failure was counted: the run stopped before bun test's summary (a stub that exits or hangs?)");
      else if (first.tests.skip > 0) problems.push(`${first.tests.skip} tests are skipped in the grader (SANDBOX_RUNTIME=1 is set there): no test may skip itself`);
      else if (first.kind !== "assertion") problems.push("tests fail, but not all on assertions (a missing export, a compile error, a throw or a timeout): fix the stubs or wrap the calls so every test fails on an expect");
      else if (new Set(first.failing).size !== first.tests.fail) problems.push("every test needs its own name: the failing test names do not match the count");
      else if (first.sealed !== first.tests.fail) problems.push("the grader could not see your tests run: run.sh must run bun test from the repository root, once");
    }
    if (!problems.length) {
      git(["fetch", "-q", w.clone, w.stubCommit], dir); // only the stub commit enters the answerer's repository
      git(["merge", "--ff-only", "-q", "FETCH_HEAD"], dir);
      s.stubCommit = w.stubCommit;
      writeFileSync(join(examDir(task), "count"), String(first!.tests.fail));
      writeFileSync(join(examDir(task), "names.json"), JSON.stringify(first!.failing));
      s.hiddenTests = first!.tests.fail;
      s.writerTests = w.reply;
    } else {
      notes = s.writerNotes = `A check of your previous attempt failed: ${problems.join("; ")}. Fix it.`;
      console.error(`writer attempt ${attempt}: ${notes}`);
    }
    save();
  }
  if (!s.stubCommit) {
    hqRun("escalate", "--goal", task, "--task", task, "--why", "M1 writer could not produce hidden tests that all fail first on assertions (D33)");
    finish("writer_failed", {}, 2);
  }
}

// 4. Answers judged by the hidden tests: at most 3 in all (D43).
const c = criteriaOf(dir, task);
const g = JSON.parse(readFileSync(join(dir, "goals", `${task}.json`), "utf8"));
const scope: string = g.scope ?? "hq";
const check: string = g.check ?? `cd ${scope} && bun test --timeout 30000 && bunx tsc --noEmit`;
// What the last answer was told comes back on resume (s.notes); --notes adds review findings.
let notes: string = [s.notes ?? "", o.notes ? readFileSync(o.notes, "utf8") : ""].filter(Boolean).join("\n\n");
s.notes = notes; // a resumed rework run keeps its review findings
save();
while (s.answers.length < MAX_ANSWERS) {
  const n = s.answers.length + 1;
  const prompt = `You are working in ${dir}, a git repository, on branch answer. Implement this task:

${c.title}

Acceptance criteria:
${c.text}

How to work:
- The interface list is goals/${task}.interfaces.md, and stubs for its new interfaces are already committed: implement them, keeping the names and signatures exactly.
- The task is judged by hidden tests you cannot see. When they fail you get the names of the failing tests and their assertion messages only.
- Read docs/architecture.md and the existing code under ${scope}/ first; match its style, naming, comment density and test style.
- Run \`${check}\` and make it pass. Tests that need the sandbox runtime are skipped when SANDBOX_RUNTIME=1; that is expected.
- Do not change files outside ${scope}/ except docs/architecture.md if a new module needs a line there. Do not change goals/, .hq.json, .github/, package.json or bunfig.toml files.
- Commit your work on the current branch with a clear message.
- When done, say in two or three sentences what you built and how you tested it.${notes ? `\n\n${notes}` : ""}`;
  const log = join(out, `answer-${n}.jsonl`);
  const r = claude(["--model", ANSWERER, "--effort", "high", "--settings", JSON.stringify(answererOf(task, dir)), "--permission-mode", "acceptEdits", "--disallowedTools", "WebFetch", "WebSearch"], prompt, dir);
  writeFileSync(log, r.log);
  spent(log, ANSWERER, r.result?.total_cost_usd ?? 0, r.result);
  if (!r.result || r.result.is_error) {
    s.answers.push({ n, error: String(r.result?.result ?? "no result").slice(0, 500) });
    save();
    finish("answerer_error", { detail: r.result?.result }, 3);
  }
  hqRun("task", "gate", task, "self_test", "pass", "--claimed-done", "--note", `answer ${n}`);
  const head = git(["rev-parse", "HEAD"], dir);
  // The graded commit must be the one the reviews see (review-gates.ts reviews branch answer).
  const branch = sh(["git", "symbolic-ref", "--short", "-q", "HEAD"], dir).out.trim();
  if (branch !== "answer") {
    s.answers.push({ n, head, passed: false, offBranch: branch || "detached" });
    s.notes = notes = `Your answer was not graded: the repository is on ${branch || "a detached HEAD"}, not on branch answer. Check out branch answer and commit your work there.`;
    save();
    hqRun("task", "gate", task, "hidden_tests", "fail", "--claimed-done", "--note", `answer ${n}: not on branch answer; not graded`);
    continue;
  }
  // D30 holds in git too: an answer that commits test configuration or goal files (for example by
  // git plumbing, past the working-tree sandbox) is not graded.
  const touched = configTouched(dir, s.stubCommit, head);
  if (touched.length) {
    s.answers.push({ n, head, passed: false, configTouched: touched });
    save();
    hqRun("task", "gate", task, "hidden_tests", "fail", "--claimed-done", "--note", `answer ${n}: commits test configuration ${touched.join(", ")}; not graded (D30)`);
    s.notes = notes = `Your answer was not graded: it changes ${touched.join(", ")}, which you may not change. Take those changes out (a new commit) and keep to the task.`;
    save();
    continue;
  }
  const gr = await grade(task, dir, head);
  s.answers.push({ n, head, passed: gr.passed, flaky: gr.flaky, kind: gr.kind, tests: gr.tests, sealed: gr.sealed, suspect: gr.suspect, log: gr.log, feedback: gr.feedback });
  save();
  if (gr.flaky) {
    hqRun("task", "gate", task, "hidden_tests", "fail", "--note", `answer ${n}: hidden tests flaky on the same code (D36): the run stops for a decision`);
    finish("flaky", { log: gr.log }, 4);
  }
  hqRun("task", "gate", task, "hidden_tests", gr.passed ? "pass" : "fail", "--claimed-done", "--note", `answer ${n}: ${gr.tests.pass} pass, ${gr.tests.fail} fail${gr.passed ? "" : `, ${gr.kind}`}${gr.sealed !== gr.tests.pass + gr.tests.fail ? `, seal counted ${gr.sealed}` : ""}${gr.suspect ? ", output carries hidden test code" : ""}`);
  if (gr.passed) {
    const f = await falsify(task, dir, s.stubCommit, head, s.hiddenTests);
    hqRun("task", "gate", task, "falsify", f.ok ? "pass" : "fail", "--note", f.ok ? `reverted ${f.reverted.length} files: all hidden tests fail on assertions` : f.reason);
    s.falsify = f;
    s.notes = ""; // passed: nothing carries over to a later rework run
    save();
    if (!f.ok) finish("falsify_failed", { head, reason: f.reason, log: f.log }, 7);
    finish("passed", { head, answers: n, dir, base: git(["rev-list", "--max-parents=0", "HEAD"], dir) });
  }
  // No totals: the answerer gets which tests failed and why, not the size of the exam.
  s.notes = notes = `Hidden tests failed on your answer. The failing tests and their assertion messages:\n${gr.feedback}`;
  save();
}
finish("out_of_answers", { answers: s.answers.length }, 5);
