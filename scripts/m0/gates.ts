// One round of the M0 gates for one task of a goal (roadmap M0.5), run in parallel:
// full tests (hq report: trial merge with the latest main, sandboxed), Codex review of the
// task's commits, and the claude_diff review. Prints a short summary; full outputs go to
// <out-dir>/<task>-r<round>-*. Recording gates in the ledger stays with the orchestrator.
//
//   bun scripts/m0/gates.ts <worktree> <goal> <task> <base> <round> <out-dir> [<focus-notes>]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [wt, goal, task, base, round, out, focus] = process.argv.slice(2);
if (!wt || !goal || !task || !base || !round || !out) throw new Error("usage: gates.ts <worktree> <goal> <task> <base> <round> <out-dir> [<focus>]");
const stem = join(out, `${task}-r${round}`);
const repo = join(import.meta.dir, "../..");
const hq = join(process.env.HOME!, ".hq/bin/hq");
const reviewBase = `review-base/${task}`;

async function sh(cmd: string[], cwd: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: o + e };
}

// Codex reviews against a branch: point a throwaway one at the task's base.
await sh(["git", "branch", "-f", reviewBase, base], repo);
const [report, codex, claude, size] = await Promise.all([
  sh([hq, "report", goal], repo),
  sh(["codex", "review", "--base", reviewBase], wt),
  sh(["bun", join(repo, "scripts/m0/review.ts"), wt, goal, "claude-opus-5-5", `${stem}-review.json`, ...(focus ? [focus] : [])], repo, { TASK: task, BASE: base }),
  sh(["git", "diff", "--shortstat", `${base}..HEAD`], wt),
]);
await sh(["git", "branch", "-D", reviewBase], repo);
writeFileSync(`${stem}-report.md`, report.out);
writeFileSync(`${stem}-codex.txt`, codex.out);
writeFileSync(`${stem}-review.txt`, claude.out);

const exitLine = /退出码 (-?\d+)/.exec(report.out)?.[1] ?? "?";
const codexTail = codex.out.split("\n").filter((l) => l.trim());
const codexSummary = codexTail.slice(codexTail.lastIndexOf("codex") + 1).slice(0, 8).join("\n");
const review = JSON.parse(readFileSync(`${stem}-review.json`, "utf8") || "{}");
const verdict = /VERDICT: (PASS|FAIL)\s*$/.exec(review.result ?? "")?.[1] ?? "NONE";
const important = (review.result ?? "").split("\n").filter((l: string) => l.includes("重要") && !l.includes("No 重要")).slice(0, 6);
console.log(JSON.stringify({ task, round, full_tests_exit: exitLine, claude_verdict: verdict, claude_cost: review.total_cost_usd, size: size.out.trim() }, null, 2));
console.log("--- codex\n" + codexSummary.slice(0, 1500));
console.log("--- claude 重要\n" + (important.join("\n").slice(0, 2000) || "(none)"));
