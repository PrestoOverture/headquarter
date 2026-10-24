// M1 for one task, from its M0 starting point (roadmap M1 实施计划): replay → interface list →
// writer (hidden tests + stubs, fails-first check) → answerer, judged by the hidden tests, at
// most 3 answers (D43) → falsifiability check. Records every gate and cost in the ledger under
// arm m1. The two reviews and the report come after, as in M0 (scripts/m0/gates.ts).
//
//   bun scripts/m1/run-task.ts <m0-task> [--answers-left N] [--notes <file>]
// Resumable: an existing replay worktree and exam are reused; --notes passes review findings
// into the next answer (a rework round).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { examDir, git, hqHome, repo, sh } from "./common";
import { falsify } from "./falsify";
import { grade } from "./grade";
import { interfaces } from "./interfaces";
import { write } from "./writer";

const hq = join(process.env.HOME!, ".hq/bin/hq");
const ANSWERER = "claude-sonnet-5-5";

function hqRun(...args: string[]) {
  const r = sh([hq, ...args], repo);
  if (r.code !== 0) throw new Error(`hq ${args.join(" ")}: ${r.out.trim()}`);
  return r.out.trim();
}

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { "answers-left": { type: "string", default: "3" }, notes: { type: "string" } } });
const m0 = positionals[0];
if (!m0) throw new Error("usage: run-task.ts <m0-task> [--answers-left N] [--notes <file>]");
const task = `m1-${m0}`;
const out = join(hqHome(), "m1-runs", task);
mkdirSync(out, { recursive: true });
const state = join(out, "state.json");
const s: any = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : {};
const save = () => writeFileSync(state, JSON.stringify(s, null, 2) + "\n");
const exam = await examDir(task);

// 1. Replay the M0 task's starting point; start the M1 task in the ledger.
if (!s.worktree) {
  const row = hqRun("stats", "--tasks").split("\n").map((l) => JSON.parse(l)).find((r) => r.task === m0);
  if (!row) throw new Error(`no M0 task ${m0} in the ledger`);
  const replay = hqRun("replay", m0, "--as", task);
  s.worktree = /^worktree (.+)$/m.exec(replay)![1];
  s.base = /^base (\S+)$/m.exec(replay)![1];
  hqRun("task", "start", task, "--goal", task, "--title", row.title, "--difficulty", row.difficulty, "--model", ANSWERER, "--arm", "m1", "--base", s.base);
  save();
}
const wt: string = s.worktree;
const cost = (file: string, model: string) => { try { hqRun("task", "cost", task, "--from", file, "--model", model); } catch (e) { console.error(`cost not recorded: ${(e as Error).message}`); } };

// 2. Interface list, by a session that never saw M0's code.
if (!s.interfaces) {
  await interfaces(wt, task, task, join(out, "interfaces.jsonl"));
  cost(join(out, "interfaces.jsonl"), "claude-sonnet-5-5");
  s.interfaces = git(["rev-parse", "HEAD"], wt);
  save();
}

// 3. Writer: hidden tests and stubs; they must fail first, on assertions. One retry.
if (!s.stubCommit) {
  let notes = "";
  for (let attempt = 1; attempt <= 2 && !s.stubCommit; attempt++) {
    const log = join(out, `writer-${attempt}.jsonl`);
    const w = await write(wt, task, task, log, notes);
    cost(log, "claude-sonnet-5-5");
    const first = w.problems.length ? null : await grade(task, w.stubCommit);
    const failsFirst = first && !first.passed && !first.flaky && first.kind === "assertion";
    if (!w.problems.length && failsFirst) {
      git(["merge", "--ff-only", "-q", w.stubCommit], wt);
      s.stubCommit = w.stubCommit;
      s.writerTests = w.reply;
    } else {
      notes = `A check of your previous attempt failed: ${[...w.problems, ...(first ? [first.passed ? "the tests pass on the stubs" : first.flaky ? "the tests are flaky on the stubs" : "the tests fail, but not on an assertion (a missing export, a compile error or a crash): add or fix the stubs so they fail on assertions"] : [])].join("; ")}. Fix it.`;
      console.error(`writer attempt ${attempt}: ${notes}`);
    }
    save();
  }
  if (!s.stubCommit) {
    hqRun("escalate", "--goal", task, "--task", task, "--why", "M1 writer could not produce hidden tests that fail first on assertions (D33)");
    console.log(JSON.stringify({ task, result: "writer_failed" }));
    process.exit(2);
  }
}

// 4. Answers judged by the hidden tests: at most --answers-left more (D43).
const denyRead = [join(hqHome(), "exams"), join(hqHome(), "m1-runs")];
const denyWrite = [".hq.json", ".github", "goals"].map((p) => join(wt, p));
const brief = `This task is judged by hidden tests you cannot see. The interface list is goals/${task}.interfaces.md and stubs for new interfaces are already committed: keep the names and signatures exactly. When hidden tests fail you get their names and assertion messages only. Do not change goals/, .hq.json or .github/.`;
let left = Number(o["answers-left"]);
let notes = o.notes ? readFileSync(o.notes, "utf8") : "";
s.answers ??= [];
while (left-- > 0) {
  const n = s.answers.length + 1;
  const notesFile = join(out, `answer-${n}-notes.txt`);
  writeFileSync(notesFile, [brief, notes].filter(Boolean).join("\n\n"));
  const log = join(out, `answer-${n}.jsonl`);
  const a = sh(["bun", join(repo, "scripts/m0/answer.ts"), wt, task, ANSWERER, log, notesFile], repo, {
    HQ_DENY_READ: JSON.stringify(denyRead), HQ_DENY_WRITE: JSON.stringify(denyWrite),
  });
  const result = (() => { try { return JSON.parse(a.out.slice(a.out.indexOf("{"))); } catch { return null; } })();
  cost(log, ANSWERER);
  if (!result || result.is_error) {
    s.answers.push({ n, error: result?.result ?? a.out.slice(-500) });
    save();
    console.log(JSON.stringify({ task, result: "answerer_error", detail: result?.result }));
    process.exit(3);
  }
  hqRun("task", "gate", task, "self_test", "pass", "--claimed-done", "--note", `answer ${n}`);
  const head = git(["rev-parse", "HEAD"], wt);
  const g = await grade(task, head);
  s.answers.push({ n, head, passed: g.passed, flaky: g.flaky, kind: g.kind, log: g.log });
  save();
  if (g.flaky) {
    hqRun("task", "gate", task, "hidden_tests", "fail", "--note", `answer ${n}: hidden tests flaky on the same code (D36): back to the writer`);
    console.log(JSON.stringify({ task, result: "flaky", log: g.log }));
    process.exit(4);
  }
  hqRun("task", "gate", task, "hidden_tests", g.passed ? "pass" : "fail", "--claimed-done", "--note", `answer ${n}${g.passed ? "" : `: ${g.kind}`}`);
  if (g.passed) {
    const f = await falsify(task, s.stubCommit, head);
    hqRun("task", "gate", task, "falsify", f.ok ? "pass" : "fail", "--note", f.ok ? `reverted ${f.reverted.length} files` : f.reason);
    s.falsify = f;
    save();
    console.log(JSON.stringify({ task, result: "passed", head, answers: n, falsify: f.ok, worktree: wt, base: s.base }));
    process.exit(0);
  }
  notes = `Hidden tests failed on your answer:\n${g.feedback}`;
}
console.log(JSON.stringify({ task, result: "out_of_answers", answers: s.answers.length }));
process.exit(5);
