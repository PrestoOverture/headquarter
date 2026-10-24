// M1 falsifiability check (可证伪检查, D11): put the answer's implementation back to the stubs (its
// source files as they were at the stub commit; files it added are removed; its own test files
// stay) and run the hidden tests: every one must fail, on an assertion. The answer itself has just
// passed them on the same exam.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, sh } from "./common";
import { grade } from "./grade";
import { TEST_PATH } from "./writer";

export async function falsify(task: string, dir: string, stubCommit: string, answer: string) {
  const changed = git(["diff", "--name-status", "--no-renames", `${stubCommit}..${answer}`], dir).split("\n").filter(Boolean)
    .map((l) => l.split("\t") as [string, string]).filter(([, f]) => !TEST_PATH.test(f) && !f.startsWith("goals/"));
  if (!changed.length) return { ok: false, reason: "the answer changed no source files", reverted: [] as string[], log: "" };
  const scratch = mkdtempSync(join(tmpdir(), `m1-falsify-${task}-`));
  let reverted: string;
  try {
    git(["worktree", "add", "--detach", "-q", scratch, answer], dir);
    for (const [status, f] of changed) {
      if (status === "A") git(["rm", "-q", "--", f], scratch);
      else git(["checkout", stubCommit, "--", f], scratch);
    }
    git(["-c", "user.name=m1-falsify", "-c", "user.email=m1@hq.invalid", "commit", "-q", "-m", `falsify ${task}`], scratch);
    reverted = git(["rev-parse", "HEAD"], scratch);
  } finally {
    sh(["git", "worktree", "remove", "--force", scratch], dir);
    rmSync(scratch, { recursive: true, force: true });
  }
  const g = await grade(task, dir, reverted);
  const ok = !g.passed && !g.flaky && g.kind === "assertion" && g.tests.pass === 0;
  const reason = ok ? "" : g.passed ? "hidden tests still pass with the implementation reverted"
    : g.flaky ? "flaky" : g.tests.pass > 0 ? `${g.tests.pass} hidden tests still pass with the implementation reverted` : "fails, but not only on assertions";
  return { ok, reason, reverted: changed.map(([, f]) => f), log: g.log };
}
