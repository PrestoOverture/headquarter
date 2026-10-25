// M1.1 (roadmap M1 实施计划): every M0 task through run-task.ts and, when its answer passed the
// hidden tests, review-gates.ts round 1, one task at a time. A task already finished is skipped;
// a usage limit stops the batch (run it again later: run-task.ts resumes). Gate verdicts are
// recorded afterwards, as in M0; this only runs things and keeps their output.
//
//   bun scripts/m1/batch.ts [<m0-task> ...]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repo, runDir } from "./common";

const ALL = Array.from({ length: 20 }, (_, i) => `t${String(i + 1).padStart(2, "0")}`);
const tasks = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const RESULTS: Record<number, string> = { 0: "passed", 2: "writer_failed", 3: "answerer_error", 4: "flaky", 5: "out_of_answers", 6: "usage_limit", 7: "falsify_failed" };

function step(args: string[], log: string) {
  const p = Bun.spawnSync(["bun", ...args], { cwd: repo, env: process.env, stdin: "ignore" });
  const out = p.stdout.toString() + p.stderr.toString();
  writeFileSync(log, out);
  return { code: p.exitCode ?? -1, out };
}

for (const m0 of tasks) {
  const out = runDir(`m1-${m0}`);
  const done = join(out, "batch.json");
  if (existsSync(done)) {
    console.log(`${m0}: done before (${JSON.parse(readFileSync(done, "utf8")).result})`);
    continue;
  }
  const started = Date.now();
  const r = step([join(repo, "scripts/m1/run-task.ts"), m0], join(out, `run-task-${started}.log`));
  const result = RESULTS[r.code] ?? `exit ${r.code}`;
  console.log(`${m0}: ${result} (${Math.round((Date.now() - started) / 60000)} min)`);
  if (result === "usage_limit") {
    console.log("usage limit: batch stopped; run it again once the limit resets");
    process.exit(6);
  }
  if (result === "answerer_error" || r.code < 0 || !(r.code in RESULTS)) {
    // not a result of the task: stop for a look rather than mark it done
    console.log(`${m0}: stopped for a look; see ${out}`);
    process.exit(r.code || 1);
  }
  let gates = "";
  if (result === "passed") {
    const g = step([join(repo, "scripts/m1/review-gates.ts"), m0, "1"], join(out, "r1-summary.txt"));
    gates = g.out;
    console.log(g.out.split("\n").slice(0, 12).join("\n"));
  }
  writeFileSync(done, JSON.stringify({ task: m0, result, code: r.code, minutes: Math.round((Date.now() - started) / 60000), gates: !!gates }, null, 2) + "\n");
}
console.log("batch finished");
