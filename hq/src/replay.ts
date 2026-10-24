// `hq replay <task>`: the task's starting point again, to run it a second time and compare.
// It reads the ledger and writes nothing to it, so a replay never counts as a task of its own.

import { validGoal } from "./approval";
import { revParse, run } from "./git";
import { newGoal } from "./goal";
import { GATES, readEvents } from "./ledger";
import { rows, type TaskRow } from "./stats";

/** An acceptance entry is a string, or {"text": ..., "traces": ...} (see trace.ts); replay copies it as it is. */
type Criterion = string | { text: string; [key: string]: unknown };
export type Replay = { path: string; branch: string; base: string; original: TaskRow };

/** The title of the goal file at `base` and the task's acceptance criteria: tasks.<task>, else the top level. */
function readGoalFile(cwd: string, base: string, goal: string, task: string): { title: string; acceptance: Criterion[] } {
  const where = `goals/${goal}.json at ${base.slice(0, 12)}`;
  const r = run(["git", "show", `${base}:goals/${goal}.json`], cwd);
  if (r.code !== 0) throw new Error(`no ${where}: nothing to copy the title and acceptance criteria from`);
  let file: any;
  try {
    file = JSON.parse(r.out);
  } catch {
    throw new Error(`${where} is not valid JSON`);
  }
  const own = file?.tasks?.[task];
  const acceptance = own && typeof own === "object" && "acceptance" in own ? own.acceptance : (file?.acceptance ?? []);
  if (typeof file?.title !== "string" || !Array.isArray(acceptance) || !acceptance.every((a: any) => typeof a === "string" || typeof a?.text === "string")) {
    throw new Error(`${where} has no title, or its acceptance criteria are not a list of strings or {"text": string} objects`);
  }
  return { title: file.title, acceptance };
}

/** Creates goal/<name> (default replay-<task>) at the task's recorded base; refuses before changing anything. */
export function replay(cwd: string, task: string, name = `replay-${task}`): Replay {
  if (!validGoal(name)) throw new Error(`bad goal name ${name}: lowercase letters, digits and dashes`);
  const original = rows(readEvents(cwd)).find((r) => r.task === task);
  if (!original) throw new Error(`no task ${task} in the ledger`);
  const base = revParse(original.base, cwd);
  if (!base) throw new Error(`base commit ${original.base} of task ${task} is not in this repository`);
  const { title, acceptance } = readGoalFile(cwd, base, original.goal, task);
  const file = { title, acceptance, shelved: [], known_issues: [], replay_of: task };
  const made = newGoal(cwd, name, { from: base, file, message: `goal ${name}: replay of ${task}` });
  return { ...made, base, original };
}

export function render(r: Replay): string {
  const o = r.original;
  const verdicts = GATES.filter((g) => o.gates[g]).map((g) => `${g} ${o.gates[g]!.pass} pass ${o.gates[g]!.fail} fail`);
  return [
    `worktree ${r.path}`,
    `branch ${r.branch}`,
    `base ${r.base}`,
    `original ${o.task} (${o.status}): size ${o.size ? `${o.size.lines} lines (+${o.size.added} -${o.size.deleted})` : "not recorded"}`,
    `verdicts ${verdicts.join(", ") || "none recorded"}`,
  ].join("\n");
}
