// `hq trace <goal>`: does every task-level acceptance criterion serve a goal-level one, and is every
// goal-level one served? goals/<goal>.json (at the branch head) has a top-level `criteria` list, whose
// entries are g1, g2, ... by position; a task criterion in tasks.<task>.acceptance is a string, or
// {"text": ..., "traces": "g2"} to say which goal criterion it serves. With a checker command, each
// trace is also put to a session that did not write it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goalBranch, validGoal } from "./approval";
import { revParse, run } from "./git";

export type TaskCriterion = { task: string; n: number; text: string; traces?: string };
export type GoalCriterion = { id: string; text: string };
export type Answer = "SERVES" | "DOES-NOT-SERVE" | "NO-ANSWER";
export type Check = { criterion: TaskCriterion; goal: GoalCriterion; answer: Answer; output: string };
export type Trace = {
  goal: string;
  goalCriteria: GoalCriterion[];
  untraced: TaskCriterion[];
  dangling: TaskCriterion[];
  uncovered: GoalCriterion[];
  checks: Check[];
  ok: boolean;
};

/** Run in an empty directory with the prompt on stdin, so the session sees the two criteria and nothing else. */
export const DEFAULT_CHECKER = 'claude -p --tools "" --no-session-persistence';

export const prompt = (goal: string, task: string) =>
  [
    "A goal has this acceptance criterion:",
    `  ${goal}`,
    "A task of that goal has this acceptance criterion:",
    `  ${task}`,
    "Does meeting the task criterion help meet the goal criterion? Answer with exactly one word: SERVES or DOES-NOT-SERVE.",
  ].join("\n");

/** Reads the criteria of goals/<goal>.json at the branch head; a malformed list is an error, not an empty one. */
export function readCriteria(cwd: string, goal: string): { goal: GoalCriterion[]; tasks: TaskCriterion[] } {
  if (!validGoal(goal)) throw new Error(`bad goal name ${goal}: lowercase letters, digits and dashes`);
  const head = revParse(goalBranch(goal), cwd);
  if (!head) throw new Error(`no branch ${goalBranch(goal)}`);
  const where = `goals/${goal}.json at ${head.slice(0, 12)}`;
  const r = run(["git", "show", `${head}:goals/${goal}.json`], cwd);
  if (r.code !== 0) throw new Error(`no ${where}`);
  let file: any;
  try {
    file = JSON.parse(r.out);
  } catch {
    throw new Error(`${where} is not valid JSON`);
  }
  const list = file?.criteria ?? [];
  if (!Array.isArray(list) || !list.every((c: unknown) => typeof c === "string")) throw new Error(`${where}: criteria must be a list of strings`);
  const tasks: TaskCriterion[] = [];
  for (const [task, t] of Object.entries<any>(file?.tasks ?? {})) {
    const acceptance = t?.acceptance ?? [];
    if (!Array.isArray(acceptance)) throw new Error(`${where}: tasks.${task}.acceptance must be a list`);
    acceptance.forEach((a: any, i: number) => {
      const text = typeof a === "string" ? a : a?.text;
      const traces = typeof a === "string" ? undefined : a?.traces;
      if (typeof text !== "string" || (traces !== undefined && typeof traces !== "string")) {
        throw new Error(`${where}: tasks.${task}.acceptance[${i}] must be a string or {"text": string, "traces": string}`);
      }
      tasks.push({ task, n: i + 1, text, traces });
    });
  }
  return { goal: list.map((text: string, i: number) => ({ id: `g${i + 1}`, text })), tasks };
}

/** SERVES or DOES-NOT-SERVE if that is the whole answer (bold, backticks and a final period aside); anything else is no answer. */
export function parseAnswer(output: string): Answer {
  const word = output.trim().replace(/^[*`]+/, "").replace(/[*`]*\.?[*`]*$/, "");
  return word === "SERVES" || word === "DOES-NOT-SERVE" ? word : "NO-ANSWER";
}

/** Runs the checker through `sh -c` with the prompt on stdin; a checker that fails or says nothing clear has not said SERVES. */
function ask(command: string, c: TaskCriterion, g: GoalCriterion): Check {
  const dir = mkdtempSync(join(tmpdir(), "hq-trace-"));
  try {
    const p = Bun.spawnSync(["sh", "-c", command], { cwd: dir, env: process.env, stdin: Buffer.from(prompt(g.text, c.text)), timeout: 300_000 });
    const output = p.stdout.toString().trim();
    if (p.exitCode !== 0) {
      const why = p.stderr.toString().trim() || output;
      return { criterion: c, goal: g, answer: "NO-ANSWER", output: `checker exited ${p.exitCode ?? "without a status"}: ${why}` };
    }
    return { criterion: c, goal: g, answer: parseAnswer(output), output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function trace(cwd: string, goal: string, opts: { checkWith?: string } = {}): Trace {
  const { goal: goalCriteria, tasks } = readCriteria(cwd, goal);
  const byId = new Map(goalCriteria.map((g) => [g.id, g]));
  const untraced = tasks.filter((t) => t.traces === undefined);
  const dangling = tasks.filter((t) => t.traces !== undefined && !byId.has(t.traces));
  const traced = tasks.filter((t) => t.traces !== undefined && byId.has(t.traces));
  const served = new Set(traced.map((t) => t.traces));
  const uncovered = goalCriteria.filter((g) => !served.has(g.id));
  const checks = opts.checkWith === undefined ? [] : traced.map((t) => ask(opts.checkWith!, t, byId.get(t.traces!)!));
  const ok = !untraced.length && !dangling.length && !uncovered.length && checks.every((c) => c.answer === "SERVES");
  return { goal, goalCriteria, untraced, dangling, uncovered, checks, ok };
}

const short = (s: string) => (s.length > 100 ? s.slice(0, 97) + "..." : s);
const label = (c: TaskCriterion) => `${c.task}#${c.n}`;

export function render(t: Trace): string {
  const lines: string[] = [];
  const section = (title: string, items: string[]) => {
    if (items.length) lines.push(`${title}:`, ...items.map((i) => `  ${i}`));
  };
  section("task criteria with no trace", t.untraced.map((c) => `${label(c)}: ${short(c.text)}`));
  section("task criteria tracing to a goal criterion that does not exist", t.dangling.map((c) => `${label(c)} -> ${c.traces}: ${short(c.text)}`));
  section("goal criteria no task traces to", t.uncovered.map((g) => `${g.id}: ${short(g.text)}`));
  if (t.checks.length) {
    lines.push("checked traces:");
    for (const c of t.checks) {
      const detail = c.answer === "NO-ANSWER" ? ` (${short(c.output.replace(/\s+/g, " ")) || "empty output"})` : "";
      lines.push(`  ${label(c.criterion)} -> ${c.goal.id}: ${c.answer}${detail}`);
    }
  }
  lines.push(t.ok ? `trace ok: ${t.goalCriteria.length} goal criteria` : "trace failed");
  return lines.join("\n");
}
