// `hq work <goal>`: one task of a goal in a separate `claude -p` session, under the executor
// sandbox (settings.ts), in the goal's worktree. The prompt comes from goals/<goal>.json.
// The full stream-json log is kept in $HQ_HOME/work, the cost goes to the ledger like
// `hq task cost --from`, and a session that ends on an error or a usage limit fails the command.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { goalBranch, hqHome, repoId, validGoal } from "./approval";
import { recordCostFrom } from "./cost";
import { commonDir, revParse, worktreeOf } from "./git";
import { append, DIFFICULTIES, readEvents } from "./ledger";
import { executorSettings } from "./settings";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const TIMEOUT_MS = 60 * 60 * 1000;

type Criterion = string | { text: string };
type Spec = { title: string; acceptance: Criterion[]; scope: string; check: string; difficulty?: string };
export type Work = {
  goal: string; task: string; model: string; base: string; log: string; exit: number | null;
  usd?: number; turns?: number; result?: string; ok: boolean; why?: string;
};

export function workDir(cwd: string): string {
  return join(hqHome(), "work", repoId(cwd));
}

/** The task's title, criteria, scope and check from the goal file: tasks.<task> when a task is named, else the file itself. */
function readSpec(wt: string, goal: string, task?: string): Spec {
  const rel = `goals/${goal}.json`;
  let file: any;
  try {
    file = JSON.parse(readFileSync(join(wt, rel), "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${rel} in ${wt}: ${(e as Error).message}`);
  }
  const g = task === undefined ? file : file?.tasks?.[task];
  if (!g || typeof g !== "object") throw new Error(`no task ${task} in ${rel}`);
  const where = task === undefined ? rel : `${rel} task ${task}`;
  if (typeof g.title !== "string" || !g.title) throw new Error(`${where} has no title`);
  if (!Array.isArray(g.acceptance) || !g.acceptance.every((a: any) => typeof a === "string" || typeof a?.text === "string")) {
    throw new Error(`${where} has no acceptance list of strings or {"text": string} objects`);
  }
  const scope = String(g.scope ?? ".").replace(/\/+$/, "") || ".";
  const check = g.check ?? `${scope === "." ? "" : `cd ${scope} && `}bun test && bunx tsc --noEmit`;
  return { title: g.title, acceptance: g.acceptance, scope, check, difficulty: g.difficulty };
}

export function buildPrompt(wt: string, goal: string, hasTask: boolean, spec: Spec, notes?: string): string {
  const area = spec.scope === "." ? "the repository" : `${spec.scope}/`;
  const tests = spec.scope === "." ? "" : ` (${spec.scope}/test/*.test.ts)`;
  const lines = [
    `You are working in ${wt}, a git worktree of this repository on branch ${goalBranch(goal)}. Implement this ${hasTask ? "task (earlier tasks of the same goal are already committed on this branch)" : "goal"}:`,
    "",
    spec.title,
    "",
    "Acceptance criteria:",
    ...spec.acceptance.map((a, i) => `${i + 1}. ${typeof a === "string" ? a : a.text}`),
    "",
    "How to work:",
    `- Read docs/architecture.md and the existing code under ${area} first; match its style, naming, comment density and test style${tests}.`,
    `- Run \`${spec.check}\` and make it pass. Tests that need the sandbox runtime are skipped when SANDBOX_RUNTIME=1; that is expected.`,
    ...(spec.scope === "." ? [] : [`- Do not change files outside ${spec.scope}/ except docs/architecture.md if a new module needs a line there.`]),
    "- Commit your work on the current branch with a clear message. Do not touch main.",
    "- When done, say in two or three sentences what you built and how you tested it.",
  ];
  return lines.join("\n") + (notes ? `\n\n${notes}` : "");
}

/** The caller's environment without Claude Code's own variables, so the session does not look like a child of the one that launched it. */
function sessionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE") env[k] = v;
  return env;
}

/** The last `result` message of a stream-json log. */
function lastResult(text: string): any {
  let result: any = null;
  for (const l of text.split("\n")) {
    try {
      const m = JSON.parse(l);
      if (m?.type === "result") result = m;
    } catch {}
  }
  return result;
}

/**
 * Runs the task in the goal's worktree; refuses, starting nothing, when the branch, the
 * worktree, the task or the notes file is missing. After the session, nothing throws: the
 * returned Work says whether it succeeded and why not.
 */
export async function work(cwd: string, goal: string, opts: { task?: string; model?: string; notes?: string } = {}): Promise<Work> {
  if (!validGoal(goal)) throw new Error(`bad goal name ${goal}: lowercase letters, digits and dashes`);
  if (opts.task !== undefined && !/^[A-Za-z0-9][\w.-]*$/.test(opts.task)) throw new Error(`bad task name ${opts.task}`);
  const base = revParse(goalBranch(goal), cwd);
  if (!base) throw new Error(`no branch ${goalBranch(goal)}`);
  const wt = worktreeOf(goalBranch(goal), cwd);
  if (!wt || !existsSync(wt)) throw new Error(`${goalBranch(goal)} has no worktree: hq goal new makes one`);
  const spec = readSpec(wt, goal, opts.task);
  const notes = opts.notes === undefined ? undefined : readFileSync(resolve(cwd, opts.notes), "utf8");
  const task = opts.task ?? goal;
  const model = opts.model ?? DEFAULT_MODEL;
  const started = readEvents(cwd).find((e) => e.type === "task.start" && e.task === task);
  if (started?.type === "task.start" && started.goal !== goal) throw new Error(`task ${task} belongs to goal ${started.goal}, not ${goal}`);

  const settings = executorSettings(commonDir(cwd), homedir());
  const prompt = buildPrompt(wt, goal, opts.task !== undefined, spec, notes);
  const dir = workDir(cwd);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${goal}-${task}-${new Date().toISOString().replace(/\D/g, "")}.jsonl`);
  const proc = Bun.spawn(
    [
      "claude", "-p", "--model", model, "--effort", "high", "--settings", JSON.stringify(settings), "--setting-sources", "",
      "--strict-mcp-config", "--permission-mode", "acceptEdits", "--output-format", "stream-json", "--verbose",
      "--disallowedTools", "WebFetch", "WebSearch",
    ],
    { cwd: wt, env: sessionEnv(), stdin: Buffer.from(prompt), stdout: Bun.file(log), stderr: "pipe", timeout: TIMEOUT_MS },
  );
  if (!started) {
    const difficulty = DIFFICULTIES.find((d) => d === spec.difficulty) ?? "medium";
    append(cwd, { type: "task.start", task, goal, title: spec.title, base, difficulty, model, arm: "m0" });
  }
  const [exit, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

  const result = lastResult(readFileSync(log, "utf8"));
  const out: Work = { goal, task, model, base, log, exit, turns: result?.num_turns, result: result?.result, usd: result?.total_cost_usd, ok: true };
  const problems: string[] = [];
  try {
    out.usd = recordCostFrom(cwd, task, log).event.usd;
  } catch (e) {
    problems.push(`cost not recorded: ${(e as Error).message}`);
  }
  if (!result) problems.push(`the session left no result message (claude exited ${exit}${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""})`);
  else if (result.is_error || (result.subtype !== undefined && result.subtype !== "success")) problems.push(`the session ended on an error (${result.subtype ?? "no subtype"}): ${String(result.result ?? "").slice(0, 300)}`);
  else if (exit !== 0) problems.push(`claude exited ${exit}`);
  if (problems.length) Object.assign(out, { ok: false, why: problems.join("; ") });
  return out;
}

export function render(w: Work): string {
  const lines = [
    `${w.model} on goal ${w.goal}, task ${w.task}: cost ${w.usd === undefined ? "unknown" : `$${w.usd.toFixed(4)}`}, ${w.turns ?? "unknown"} turns`,
    `log ${w.log}`,
  ];
  if (w.result) lines.push("", w.result.trimEnd());
  return lines.join("\n");
}
