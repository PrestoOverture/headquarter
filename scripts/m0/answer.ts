// M0 answerer (roadmap M0.5, native tools): a sandboxed `claude -p` session in a goal's
// worktree that implements goals/<goal>.json and commits on the goal branch.
//
//   bun scripts/m0/answer.ts <worktree> <goal> <model> <out.jsonl> [<rework-notes.txt>]
//
// Sandbox: the executor settings from M0.0 (scripts/sandbox/check.ts). File tools may not
// read credential files. Do not deny reads of ~/.hq: Claude Code folds Read denials into
// the sandbox, and the guard hook every commit runs lives there (task 1). Prints the
// session's cost, turns and final message as JSON. goals/<goal>.json may set "scope" (the
// directory the task works in, default hq) and "check" (the command the answerer must pass).

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { answererSettings } from "./settings";

const [wt, goal, model, out, notes] = process.argv.slice(2);
if (!wt || !goal || !model || !out) throw new Error("usage: answer.ts <worktree> <goal> <model> <out.jsonl> [<rework-notes>]");
const commonDir = resolve(wt, Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd: wt }).stdout.toString().trim());
const home = process.env.HOME!;
// M1 (D30): HQ_DENY_READ and HQ_DENY_WRITE (JSON lists of absolute paths) add the exam, which the
// answerer may neither read nor write, and the test configuration it may not change.
const settings = answererSettings(commonDir, home, JSON.parse(process.env.HQ_DENY_READ ?? "[]"), JSON.parse(process.env.HQ_DENY_WRITE ?? "[]"));
// A goal with several tasks keeps them under "tasks"; TASK=<id> picks one (title, acceptance,
// scope, check), otherwise the goal file itself is the task.
const goalFile = JSON.parse(readFileSync(join(wt, "goals", `${goal}.json`), "utf8"));
const g = process.env.TASK ? goalFile.tasks?.[process.env.TASK] : goalFile;
if (!g) throw new Error(`no task ${process.env.TASK} in goals/${goal}.json`);
const rework = notes ? `\n\n${readFileSync(notes, "utf8")}` : "";
// A goal may name its own area and checks; hq/ is the default (tasks 1–5).
const scope: string = g.scope ?? "hq";
const check: string = g.check ?? `cd ${scope} && bun test && bunx tsc --noEmit`;
const prompt = `You are working in ${wt}, a git worktree of this repository on branch goal/${goal}. Implement this ${process.env.TASK ? "task (earlier tasks of the same goal are already committed on this branch)" : "goal"}:

${g.title}

Acceptance criteria:
${g.acceptance.map((a: string | { text: string }, i: number) => `${i + 1}. ${typeof a === "string" ? a : a.text}`).join("\n")}

How to work:
- Read docs/architecture.md and the existing code under ${scope}/ first; match its style, naming, comment density and test style (${scope}/test/*.test.ts).
- Run \`${check}\` and make it pass. Tests that need the sandbox runtime are skipped when SANDBOX_RUNTIME=1; that is expected.
- Do not change files outside ${scope}/ except docs/architecture.md if a new module needs a line there.
- Commit your work on the current branch with a clear message. Do not touch main.
- When done, say in two or three sentences what you built and how you tested it.${rework}`;
// A nested session must not look like a child of the one that launched it.
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE") env[k] = v;
const p = Bun.spawnSync(
  [
    "claude", "-p", "--model", model, "--effort", "high", "--settings", JSON.stringify(settings), "--setting-sources", "",
    "--strict-mcp-config", "--permission-mode", "acceptEdits", "--output-format", "stream-json", "--verbose",
    "--disallowedTools", "WebFetch", "WebSearch",
  ],
  { cwd: wt, env, stdin: Buffer.from(prompt), timeout: 60 * 60 * 1000 },
);
writeFileSync(out, p.stdout.toString());
let result: any = null;
for (const l of p.stdout.toString().split("\n")) {
  try {
    const m = JSON.parse(l);
    if (m.type === "result") result = m;
  } catch {}
}
console.log(JSON.stringify({ exit: p.exitCode, cost: result?.total_cost_usd, turns: result?.num_turns, is_error: result?.is_error, result: result?.result }, null, 2));
