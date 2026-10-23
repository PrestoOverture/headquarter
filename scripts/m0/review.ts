// M0 diff reviewer (the claude_diff gate): a fresh Claude session that did not write the
// code reads the goal's whole diff against main, in place of you (2026-10-23 decision).
// It may only read files; it ends with `VERDICT: PASS` or `VERDICT: FAIL`.
//
//   bun scripts/m0/review.ts <worktree> <goal> <model> <out.json> [<focus-notes.txt>]

import { readFileSync, writeFileSync } from "node:fs";

const [wt, goal, model, out, notes] = process.argv.slice(2);
if (!wt || !goal || !model || !out) throw new Error("usage: review.ts <worktree> <goal> <model> <out.json> [<focus-notes>]");
// BASE=<commit> reviews one task of a multi-task goal: its commits only, against TASK's criteria.
const base = process.env.BASE ?? "main";
const diff = Bun.spawnSync(["git", "diff", process.env.BASE ? `${base}..HEAD` : "main...HEAD"], { cwd: wt }).stdout.toString();
const where = process.env.TASK ? `goals/${goal}.json under "tasks" → "${process.env.TASK}"` : `goals/${goal}.json`;
const focus = notes ? `\n${readFileSync(notes, "utf8")}\n` : "";
const prompt = `You are the diff reviewer for a goal in this repository. You did not write this code. The user will not read the diff: your review replaces theirs, so read every changed line.

The acceptance criteria are in ${where}. The diff ${process.env.BASE ? `of this task (from ${base})` : "against main"} is below. You may Read, Grep and Glob files in this worktree to check context.

Report:
1. Each finding with file:line, a severity — 重要 (blocks the merge: wrong behavior, an unmet acceptance criterion, a missing or vacuous test, a security problem), 细节 (does not block), 既有问题 (pre-existing, not this goal's fault) — and one sentence on why.
2. Explicitly answer: does this change loosen any denial in the merge lock, the guard hook, the sandbox rules or the approval/report checks? Does it send anything over the network or write outside the repository and temp directories (other than what the acceptance criteria require)?
3. For each acceptance criterion, whether the code meets it and which test shows it.
4. A last line that is exactly \`VERDICT: PASS\` (no 重要 findings) or \`VERDICT: FAIL\`.
${focus}
\`\`\`diff
${diff}\`\`\`
`;
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE") env[k] = v;
const p = Bun.spawnSync(
  [
    "claude", "-p", "--model", model, "--effort", "high", "--setting-sources", "", "--strict-mcp-config",
    "--allowedTools", "Read", "Grep", "Glob", "--disallowedTools", "Bash", "Edit", "Write", "WebFetch", "WebSearch",
    "--output-format", "json",
  ],
  { cwd: wt, env, stdin: Buffer.from(prompt), timeout: 30 * 60 * 1000 },
);
writeFileSync(out, p.stdout.toString());
const r = JSON.parse(p.stdout.toString() || "{}");
const verdict = /VERDICT: (PASS|FAIL)\s*$/.exec(r.result ?? "")?.[1] ?? "NONE";
console.log(JSON.stringify({ exit: p.exitCode, cost: r.total_cost_usd, verdict }, null, 2));
console.log(r.result ?? p.stderr.toString());
