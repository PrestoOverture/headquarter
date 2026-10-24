// M1 falsifiability check (可证伪检查, D11): put the answer's implementation back to the stubs
// (its source files as they were at the stub commit; files it added are removed; its own test
// files stay) and run the hidden tests: they must fail, on an assertion. The answer itself has
// already passed them.
//
//   bun scripts/m1/falsify.ts <task> <stub-commit> <answer-commit>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repo, sh } from "./common";
import { grade } from "./grade";

const TEST_PATH = /(^|\/)(test|tests|__tests__)\/|\.test\.[cm]?[jt]sx?$/;

export async function falsify(task: string, stubCommit: string, answer: string) {
  const changed = git(["diff", "--name-status", "--no-renames", `${stubCommit}..${answer}`]).split("\n").filter(Boolean)
    .map((l) => l.split("\t") as [string, string]).filter(([, f]) => !TEST_PATH.test(f) && !f.startsWith("goals/"));
  if (!changed.length) return { ok: false, reason: "the answer changed no source files", reverted: [] as string[] };
  // A throwaway commit: the answer with its source changes put back to the stubs.
  const scratch = mkdtempSync(join(tmpdir(), `m1-falsify-${task}-`));
  let reverted: string;
  try {
    git(["worktree", "add", "--detach", "-q", scratch, answer]);
    for (const [status, f] of changed) {
      if (status === "A") git(["rm", "-q", "--", f], scratch);
      else git(["checkout", stubCommit, "--", f], scratch);
    }
    git(["-c", "user.name=m1-falsify", "-c", "user.email=m1@hq.invalid", "commit", "-q", "-m", `falsify ${task}`], scratch);
    reverted = git(["rev-parse", "HEAD"], scratch);
  } finally {
    sh(["git", "worktree", "remove", "--force", scratch], repo);
    rmSync(scratch, { recursive: true, force: true });
  }
  const g = await grade(task, reverted);
  const ok = !g.passed && !g.flaky && g.kind === "assertion";
  return { ok, reason: ok ? "" : g.passed ? "hidden tests still pass with the implementation reverted" : g.flaky ? "flaky" : "fails, but not on an assertion", reverted: changed.map(([, f]) => f), log: g.log };
}

if (import.meta.main) {
  const [task, stub, answer] = process.argv.slice(2);
  if (!task || !stub || !answer) throw new Error("usage: falsify.ts <task> <stub-commit> <answer-commit>");
  const r = await falsify(task, git(["rev-parse", stub]), git(["rev-parse", answer]));
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
