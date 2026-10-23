// Grade job: runs the writer's tests on the buggy code (the task image at base_commit)
// and on the fixed code (base + gold patch), each in a fresh container from the original
// image, which the writer never saw. The script runs RERUNS times per side so a flaky
// test shows up as "flaky" instead of a false catch or miss.
//
//   bun src/grade.ts --tasks tasks/tasks.json.gz --id <instance_id> --results results
//
// Reads <results>/<id>/writer.patch, writes report.json (with graded_at, for merge-runs)
// and buggy.log / fixed.log.
//
// With --mutants, a caught task also gets its gold patch graded minus one hunk at a time
// (mutants.ts): the same run on each mutant, logged to mutant-<n>.log. report.json is
// written with the verdict first and rewritten after each mutant.
//
// An image that does not fit on the runner (disk.ts) gets the verdict excluded_disk; the
// write job may already have recorded that, in which case there is no write.json and the
// report stays as it is.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { excludedForDisk, excludedReport, gb } from "./disk";
import { SCRIPT, type Side, verdict } from "./judge";
import { gradeMutants } from "./mutants";
import { run, sh, tail } from "./sh";
import { findTask, readTasks, type Task } from "./tasks";

const RERUNS = 2;
const CMD_TIMEOUT_MS = 30 * 60 * 1000;
const REBUILD_TIMEOUT_MS = 90 * 60 * 1000; // a full duckdb rebuild after the gold patch took over 30 minutes
const SCRIPT_TIMEOUT_S = 25 * 60; // the prompt promises 20 minutes

// NuGet's vulnerability audit reads advisories published after the dataset was built and
// turns them into restore errors (wolverine: NU1902), so the task's own rebuild fails.
// MSBuild reads environment variables as properties; this is a no-op for other projects.
const GRADE_ENV = ["-e", "NuGetAudit=false"];

function exec(ctr: string, cmd: string, input?: string, timeoutMs = CMD_TIMEOUT_MS) {
  return run(["docker", "exec", "-i", ...GRADE_ENV, "-w", "/testbed", ctr, "bash", "-c", cmd], { input, timeoutMs });
}

/** git apply, falling back to a fuzzy `patch` like the SWE-bench harness. */
function applyPatch(ctr: string, patch: string, name: string): { ok: boolean; out: string } {
  const path = `/tmp/${name}.diff`;
  exec(ctr, `cat > ${path}`, patch);
  let out = "";
  for (const cmd of [`git apply -v ${path}`, `patch --batch --fuzz=5 -p1 -i ${path}`]) {
    const r = exec(ctr, cmd);
    out += `$ ${cmd}\n${r.out}`;
    if (r.code === 0) return { ok: true, out };
  }
  return { ok: false, out };
}

type Graded = Side & { rebuild: number[]; log_tail: string };

/** Fresh container from the task image, the patches applied in order, rebuild, then the writer's script RERUNS times. */
function gradeRun(task: Task, ctr: string, patches: [string, string][], logPath: string): Graded {
  const lines: string[] = [];
  const side: Side & { rebuild: number[] } = { applied: false, runs: [], rebuild: [] };
  run(["docker", "rm", "-f", ctr]);
  sh(["docker", "run", "-d", "--platform", task.platform, "--name", ctr, task.image, "sleep", "infinity"]);
  try {
    for (const [name, patch] of patches) {
      const r = applyPatch(ctr, patch, name);
      lines.push(`## ${name} patch\n${r.out}`);
      if (!r.ok) return { ...side, log_tail: tail(lines.join("\n")) };
    }
    side.applied = true;
    for (const cmd of task.rebuild_cmds) {
      const r = exec(ctr, cmd, undefined, REBUILD_TIMEOUT_MS);
      if (r.timedOut) side.rebuild_timed_out = true;
      side.rebuild.push(r.timedOut ? -1 : r.code);
      lines.push(`## rebuild\n$ ${cmd}\n[exit ${r.code}${r.timedOut ? ", timeout" : ""}]\n${r.out}`);
    }
    // The writer ran its tests with no network; so do we. With network, NuGet's
    // vulnerability audit turned warnings into errors that the writer never saw.
    const net = run(["docker", "network", "disconnect", "bridge", ctr]);
    lines.push(`## network disconnect\n[exit ${net.code}]\n${net.out}`);
    for (let i = 1; i <= RERUNS; i++) {
      const r = exec(ctr, `${task.env_activate} && timeout ${SCRIPT_TIMEOUT_S} bash ${SCRIPT}`);
      const code = r.timedOut || r.code === 124 ? -1 : r.code;
      side.runs.push(code);
      lines.push(`## run ${i}\n[exit ${code}]\n${r.out}`);
    }
    return { ...side, log_tail: tail(lines.at(-1)!) };
  } finally {
    run(["docker", "rm", "-f", ctr]);
    writeFileSync(logPath, lines.join("\n"));
  }
}

function gradeSide(task: Task, writerPatch: string, fixed: boolean, logPath: string): Graded {
  const ctr = `step0-${fixed ? "fixed" : "buggy"}-${task.instance_id}`.toLowerCase();
  return gradeRun(task, ctr, fixed ? [["gold", task.patch], ["writer", writerPatch]] : [["writer", writerPatch]], logPath);
}

function main() {
  const { values } = parseArgs({
    options: { tasks: { type: "string" }, id: { type: "string" }, results: { type: "string" }, mutants: { type: "boolean", default: false } },
  });
  if (!values.tasks || !values.id || !values.results) throw new Error("usage: --tasks <file> --id <instance_id> --results <dir> [--mutants]");
  const task = findTask(readTasks(values.tasks), values.id);
  const runDir = join(values.results, task.instance_id);
  const patchPath = join(runDir, "writer.patch");
  const writerPatch = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
  const reportPath = join(runDir, "report.json");
  if (!existsSync(join(runDir, "write.json")) && existsSync(reportPath) && JSON.parse(readFileSync(reportPath, "utf8")).verdict === "excluded_disk")
    return console.log(`${task.instance_id}: excluded_disk (recorded by the write job)`);

  let buggy: ReturnType<typeof gradeSide> | null = null;
  let fixed: ReturnType<typeof gradeSide> | null = null;
  // Without sides, the verdict stops at the first submission problem; "patch_failed"
  // means the submission itself is fine and only running it can tell.
  if (verdict(writerPatch, task.patch, null, null) === "patch_failed") {
    const excluded = excludedForDisk(task.image, task.platform);
    if (excluded) {
      writeFileSync(reportPath, JSON.stringify(excludedReport(task, excluded), null, 2) + "\n");
      return console.log(`${task.instance_id}: excluded_disk (needs ${gb(excluded.needed_bytes)} GB, ${gb(excluded.free_bytes)} GB free)`);
    }
    sh(["docker", "pull", "--platform", task.platform, task.image], { timeoutMs: 60 * 60 * 1000 });
    buggy = gradeSide(task, writerPatch, false, join(runDir, "buggy.log"));
    fixed = gradeSide(task, writerPatch, true, join(runDir, "fixed.log"));
  }
  const final = verdict(writerPatch, task.patch, buggy, fixed);
  const report = {
    instance_id: task.instance_id,
    language: task.language,
    verdict: final,
    graded_at: new Date().toISOString(),
    buggy,
    fixed,
  };
  // The verdict is on disk before any mutant runs; each mutant rewrites the report.
  const save = (mutation?: object) => writeFileSync(reportPath, JSON.stringify({ ...report, ...mutation }, null, 2) + "\n");
  save();
  const mutation =
    values.mutants && final === "caught"
      ? gradeMutants(task.patch, fixed!.rebuild, (m, i) => {
          const ctr = `step0-mutant-${i + 1}-${task.instance_id}`.toLowerCase();
          return gradeRun(task, ctr, [["mutant", m.patch], ["writer", writerPatch]], join(runDir, `mutant-${i + 1}.log`));
        }, save)
      : null;
  console.log(`${task.instance_id}: ${final} (buggy ${buggy?.runs ?? "-"}, fixed ${fixed?.runs ?? "-"})${mutation ? `, mutants: ${mutation.mutants.map((m) => m.result).join(" ") || "none"}` : ""}`);
}

if (import.meta.main) main();
