// The M0 gates for an M1 task (the two reviews are in both arms, P13): the full tests (main's
// .hq.json, inside srt, on the answer), Codex review and the claude_diff review of the answer's
// commits since the starting point. Same shape of output as scripts/m0/gates.ts.
//
//   bun scripts/m1/review-gates.ts <m0-task> <round> [<focus-notes>]

import { mkdtempSync, readFileSync, rmSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repo, repoDir, runDir, sh } from "./common";

const [m0, round, focus] = process.argv.slice(2);
if (!m0 || !round) throw new Error("usage: review-gates.ts <m0-task> <round> [<focus>]");
const task = `m1-${m0}`;
const dir = repoDir(task);
const out = runDir(task);
const stem = join(out, `r${round}`);
const base = git(["rev-parse", "main"], dir); // the starting point; the answer is on branch answer
const head = git(["rev-parse", "answer"], dir);

async function bg(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: o + e };
}

async function fullTests() {
  const scratch = mkdtempSync(join(tmpdir(), `m1-full-${task}-`));
  try {
    git(["worktree", "add", "--detach", "-q", scratch, head], dir);
    for (const d of ["hq", "eval"]) if (existsSync(join(dir, d, "node_modules")) && existsSync(join(scratch, d))) symlinkSync(join(dir, d, "node_modules"), join(scratch, d, "node_modules"));
    const cmd = JSON.parse(git(["show", "main:.hq.json"], repo)).test; // the real main's, not the answer's
    const { sandboxed } = await import(join(repo, "hq/src/sandbox.ts"));
    const r = sandboxed(cmd, scratch, { writable: [scratch], commonDir: join(dir, ".git") });
    return { code: r.code as number, out: (r.out + r.err) as string };
  } finally {
    sh(["git", "worktree", "remove", "--force", scratch], dir);
    rmSync(scratch, { recursive: true, force: true });
  }
}

const [full, codex, claude] = await Promise.all([
  fullTests(),
  bg(["codex", "review", "--base", "main"], dir),
  bg(["bun", join(repo, "scripts/m0/review.ts"), dir, task, "claude-opus-5-5", `${stem}-review.json`, ...(focus ? [focus] : [])], repo, { BASE: base }),
]);
writeFileSync(`${stem}-full.log`, full.out);
writeFileSync(`${stem}-codex.txt`, codex.out);
const review = JSON.parse(readFileSync(`${stem}-review.json`, "utf8") || "{}");
const verdict = /VERDICT: (PASS|FAIL)\s*$/.exec(review.result ?? "")?.[1] ?? "NONE";
const codexLines = codex.out.split("\n").filter((l) => l.trim());
console.log(JSON.stringify({ task, round, head: head.slice(0, 12), full_tests_exit: full.code, claude_verdict: verdict, claude_cost: review.total_cost_usd, size: git(["diff", "--shortstat", `${base}..${head}`], dir) }, null, 2));
console.log("--- codex\n" + codexLines.slice(codexLines.lastIndexOf("codex") + 1).slice(0, 8).join("\n").slice(0, 1500));
console.log("--- claude 重要\n" + ((review.result ?? "").split("\n").filter((l: string) => l.includes("重要") && !l.includes("No 重要")).slice(0, 6).join("\n").slice(0, 2000) || "(none)"));
