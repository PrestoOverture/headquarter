// Grade job: runs the writer's tests on the buggy code (the task image at base_commit)
// and on the fixed code (base + gold patch), each in a fresh container from the original
// image, which the writer never saw. The script runs RERUNS times per side so a flaky
// test shows up as "flaky" instead of a false catch or miss.
//
//   bun src/grade.ts --tasks tasks/tasks.json.gz --id <instance_id> --results results
//
// Reads <results>/<id>/writer.patch, writes report.json and buggy.log / fixed.log.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SCRIPT, type Side, verdict } from "./judge";
import { run, sh, tail } from "./sh";
import { findTask, readTasks, type Task } from "./tasks";

const RERUNS = 2;
const CMD_TIMEOUT_MS = 30 * 60 * 1000;
const SCRIPT_TIMEOUT_S = 25 * 60; // the prompt promises 20 minutes

function exec(ctr: string, cmd: string, input?: string) {
  return run(["docker", "exec", "-i", "-w", "/testbed", ctr, "bash", "-c", cmd], { input, timeoutMs: CMD_TIMEOUT_MS });
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

function gradeSide(task: Task, writerPatch: string, fixed: boolean, logPath: string): Side & { log_tail: string } {
  const ctr = `step0-${fixed ? "fixed" : "buggy"}-${task.instance_id}`.toLowerCase();
  const lines: string[] = [];
  const side: Side = { applied: false, runs: [] };
  run(["docker", "rm", "-f", ctr]);
  sh(["docker", "run", "-d", "--platform", task.platform, "--name", ctr, task.image, "sleep", "infinity"]);
  try {
    const patches: [string, string][] = fixed ? [["gold", task.patch], ["writer", writerPatch]] : [["writer", writerPatch]];
    for (const [name, patch] of patches) {
      const r = applyPatch(ctr, patch, name);
      lines.push(`## ${name} patch\n${r.out}`);
      if (!r.ok) return { ...side, log_tail: tail(lines.join("\n")) };
    }
    side.applied = true;
    for (const cmd of task.rebuild_cmds) {
      const r = exec(ctr, cmd);
      lines.push(`## rebuild\n$ ${cmd}\n[exit ${r.code}${r.timedOut ? ", timeout" : ""}]\n${r.out}`);
    }
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

function main() {
  const { values } = parseArgs({ options: { tasks: { type: "string" }, id: { type: "string" }, results: { type: "string" } } });
  if (!values.tasks || !values.id || !values.results) throw new Error("usage: --tasks <file> --id <instance_id> --results <dir>");
  const task = findTask(readTasks(values.tasks), values.id);
  const runDir = join(values.results, task.instance_id);
  const patchPath = join(runDir, "writer.patch");
  const writerPatch = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";

  let buggy: ReturnType<typeof gradeSide> | null = null;
  let fixed: ReturnType<typeof gradeSide> | null = null;
  // Without sides, the verdict stops at the first submission problem; "patch_failed"
  // means the submission itself is fine and only running it can tell.
  if (verdict(writerPatch, task.patch, null, null) === "patch_failed") {
    sh(["docker", "pull", "--platform", task.platform, task.image], { timeoutMs: 60 * 60 * 1000 });
    buggy = gradeSide(task, writerPatch, false, join(runDir, "buggy.log"));
    fixed = gradeSide(task, writerPatch, true, join(runDir, "fixed.log"));
  }
  const report = {
    instance_id: task.instance_id,
    language: task.language,
    verdict: verdict(writerPatch, task.patch, buggy, fixed),
    buggy,
    fixed,
  };
  writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`${task.instance_id}: ${report.verdict} (buggy ${buggy?.runs ?? "-"}, fixed ${fixed?.runs ?? "-"})`);
}

if (import.meta.main) main();
