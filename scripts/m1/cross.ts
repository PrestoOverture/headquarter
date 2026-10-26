// M1.2 cross-check (roadmap M1 实施计划): each M1 task's hidden tests on M0's version of the
// task, the commit M0's task ended at (its recorded size end). The version sits in a fresh
// one-commit repository under ~/.hq-m1/cross/, graded exactly as an M1 answer is (grade.ts).
// What fails is a candidate M0 escape, to be classified by hand (D37): only behaviour wrong in
// the code counts; test errors, ambiguous requirements, environment problems and interface
// names or shapes M1's list fixed differently from M0 do not.
//
//   bun scripts/m1/cross.ts [<m0-task> ...]

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, M1_HOME, repo, sh } from "./common";
import { grade } from "./grade";

const rows = sh([join(process.env.HOME!, ".hq/bin/hq"), "stats", "--tasks", "--arm", "m0"], repo).out.trim().split("\n").map((l) => JSON.parse(l));
const wanted = process.argv.slice(2);
const results: object[] = [];
for (const r of rows) {
  if (wanted.length && !wanted.includes(r.task)) continue;
  const task = `m1-${r.task}`;
  if (r.status !== "merged") {
    results.push({ task: r.task, skipped: `M0 status ${r.status}: nothing merged to check` });
    continue;
  }
  const end: string = r.size?.end;
  if (!end) throw new Error(`${r.task}: no end commit recorded`);
  const dir = join(M1_HOME, "cross", task);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const a = sh(["bash", "-c", `git archive "${end}" | tar -x -C "${dir}"`], repo);
  if (a.code !== 0) throw new Error(`git archive ${end}: ${a.out}`);
  git(["init", "-q", "-b", "main"], dir);
  git(["add", "-A"], dir);
  git(["-c", "user.name=m1", "-c", "user.email=m1@hq.invalid", "commit", "-q", "-m", `M0's ${r.task} at ${end.slice(0, 12)}`], dir);
  for (const d of ["hq", "eval"]) if (existsSync(join(repo, d, "node_modules")) && existsSync(join(dir, d))) cpSync(join(repo, d, "node_modules"), join(dir, d, "node_modules"), { recursive: true, verbatimSymlinks: true });
  const g = await grade(task, dir, git(["rev-parse", "HEAD"], dir));
  const res = { task: r.task, m0_end: end, passed: g.passed, flaky: g.flaky, tests: g.tests, sealed: g.sealed, kind: g.kind, failing: g.failing, log: g.log };
  results.push(res);
  console.log(`${r.task}: ${g.passed ? "all pass" : `${g.tests.fail} fail of ${g.tests.pass + g.tests.fail}${g.flaky ? " (flaky)" : ""}`}`);
}
const out = join(M1_HOME, "cross", `results-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
console.log(`results: ${out}`);
