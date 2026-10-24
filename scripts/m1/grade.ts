// M1 grader: runs a task's hidden tests on a commit, in a scratch worktree, inside the executor
// sandbox (D35). The answerer's worktree is never touched and never sees the test files.
//
//   bun scripts/m1/grade.ts <task> <commit> [--expect-fail]
//
// Prints JSON: passed, runs (exit codes), flaky, kind (assertion | other), feedback (what the
// answerer may see) and the raw output's path. A failing run is rerun once on the same code;
// runs that disagree are flaky (D36). --expect-fail is the writer's "fails first" check.

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { examDir, failureKind, feedback, git, repo, sh } from "./common";

export async function grade(task: string, commit: string) {
  const exam = await examDir(task);
  if (!existsSync(join(exam, "run.sh")) || !readdirSync(join(exam, "files")).length) throw new Error(`no exam for ${task} at ${exam}`);
  const scratch = mkdtempSync(join(tmpdir(), `m1-grade-${task}-`));
  try {
    git(["worktree", "add", "--detach", "-q", scratch, commit]);
    // Dependencies come from the main checkout (git keeps node_modules out of worktrees).
    for (const d of ["hq", "eval"]) if (existsSync(join(repo, d, "node_modules")) && existsSync(join(scratch, d))) symlinkSync(join(repo, d, "node_modules"), join(scratch, d, "node_modules"));
    cpSync(join(exam, "files"), scratch, { recursive: true });
    cpSync(join(exam, "run.sh"), join(scratch, ".m1-run.sh"));
    const { sandboxed } = await import(join(repo, "hq/src/sandbox.ts"));
    const once = () => sandboxed("bash .m1-run.sh", scratch, { writable: [scratch], commonDir: join(repo, ".git") }) as { code: number; out: string; err: string };
    const runs = [once()];
    if (runs[0]!.code !== 0) runs.push(once());
    const codes = runs.map((r) => r.code);
    const flaky = new Set(codes.map((c) => c === 0)).size > 1;
    const output = runs.map((r) => r.out + r.err).join("\n--- rerun ---\n");
    const log = join(exam, `grade-${commit.slice(0, 12)}-${Date.now()}.log`);
    writeFileSync(log, output);
    const passed = codes.every((c) => c === 0);
    return { task, commit, passed, runs: codes, flaky, kind: passed ? null : failureKind(output), feedback: passed ? "" : feedback(runs.at(-1)!.out + runs.at(-1)!.err), log };
  } finally {
    sh(["git", "worktree", "remove", "--force", scratch], repo);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [task, commit, flag] = process.argv.slice(2);
  if (!task || !commit) throw new Error("usage: grade.ts <task> <commit> [--expect-fail]");
  const r = await grade(task, git(["rev-parse", commit]));
  console.log(JSON.stringify(r, null, 2));
  if (flag === "--expect-fail") process.exit(!r.passed && !r.flaky && r.kind === "assertion" ? 0 : 1);
  process.exit(r.passed ? 0 : 1);
}
