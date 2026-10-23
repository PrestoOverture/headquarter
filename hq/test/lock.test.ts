// End-to-end tests of the merge lock (roadmap M0.1) with a fake executor: real git, real
// worktrees, real srt sandbox; the "agent" is a shell script run in the executor sandbox.

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalsDir, readApproval } from "../src/approval";
import { approve } from "../src/cli";
import { git, revParse, run } from "../src/git";
import { installHook, refusal } from "../src/guard";
import { readEvents } from "../src/ledger";
import { merge } from "../src/merge";
import { writeReport } from "../src/report";
import { sandboxed } from "../src/sandbox";

const CLI = join(import.meta.dir, "../src/cli.ts");
/** The hook runs a launcher; here one that runs this checkout's source. */
function launcher(): string {
  const p = join(root, "hq-launcher");
  writeFileSync(p, `#!/bin/bash\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
  return p;
}
// srt cannot start inside srt, so tests that run the executor sandbox are skipped when
// this suite itself runs in one (hq merge's pre-merge run). Changes to the lock are
// reviewed by hand anyway (roadmap D44); run `bun test` here outside the sandbox.
const NESTED = process.env.SANDBOX_RUNTIME === "1";
const withSandbox = test.skipIf(NESTED);
const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
Object.assign(process.env, ID);
const quiet = () => {}; // approve shows the report and the prompt through this

let root: string, repo: string, wt: string;

function commit(cwd: string, file: string, text: string, msg: string) {
  writeFileSync(join(cwd, file), text);
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", msg], cwd);
}

/** The fake executor: a shell command run in its worktree under the executor sandbox. */
function agent(cmd: string) {
  return sandboxed(cmd, wt, { writable: [wt], commonDir: join(repo, ".git") });
}

/** Stands in for `hq report` (whose trial run needs the sandbox): a green report for goal/x's head. */
function greenReport() {
  const head = revParse("goal/x", repo)!;
  writeReport(repo, { goal: "x", commit: head, base: revParse("main", repo)!, trial_merge: head, test_code: 0, generated_at: "now" }, "# report", "ok");
}

function typeAtTerminal(text: string) {
  greenReport();
  const f = join(root, "tty");
  writeFileSync(f, text + "\n");
  process.env.HQ_TTY = f;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hq-lock-")));
  process.env.HQ_HOME = join(root, "hq-home");
  delete process.env.HQ_TTY;
  delete process.env.HQ_ALLOW_MAIN;
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, ".hq.json"), JSON.stringify({ test: "! grep -q BROKEN app.txt" }));
  commit(repo, "app.txt", "v1\n", "base");
  wt = join(root, "wt-x");
  git(["worktree", "add", "-q", "-b", "goal/x", wt, "main"], repo);
  commit(wt, "app.txt", "v2\n", "task 1");
});

describe("refused", () => {
  test("not approved", () => {
    const main = revParse("main", repo);
    const r = merge(repo, "x");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("not approved");
    expect(revParse("main", repo)).toBe(main);
  });

  test("a commit after the approval voids it", () => {
    typeAtTerminal("x");
    approve(repo, "x", quiet);
    commit(wt, "app.txt", "v3\n", "sneaked in after approval");
    const r = merge(repo, "x");
    expect(!r.ok && r.reason).toContain("new commits void an approval");
  });

  withSandbox("tests fail on the merge", () => {
    commit(wt, "app.txt", "BROKEN\n", "breaks the tests");
    typeAtTerminal("x");
    approve(repo, "x", quiet);
    const main = revParse("main", repo);
    const r = merge(repo, "x");
    expect(!r.ok && r.reason).toContain("tests failed");
    expect(revParse("main", repo)).toBe(main);
    expect(git(["worktree", "list"], repo).split("\n")).toHaveLength(2); // scratch worktree removed
  });

  withSandbox("the test command comes from main, not from the goal", () => {
    commit(wt, ".hq.json", JSON.stringify({ test: "true" }), "weaken the tests");
    commit(wt, "app.txt", "BROKEN\n", "and break the app");
    typeAtTerminal("x");
    approve(repo, "x", quiet);
    expect(merge(repo, "x").ok).toBe(false);
  });

  test("approval needs the goal name typed at a terminal", () => {
    typeAtTerminal("yes");
    expect(() => approve(repo, "x", quiet)).toThrow("not approved");
    process.env.HQ_TTY = join(root, "no-such-tty");
    expect(() => approve(repo, "x", quiet)).toThrow("needs a terminal");
    expect(readApproval(repo, "x")).toBeNull();
  });
});

describe("the agent cannot get around the lock", () => {
  withSandbox("from the executor sandbox: no forged approval, no write to main", () => {
    const main = revParse("main", repo)!;
    const head = revParse("goal/x", repo)!;
    const dir = approvalsDir(repo);
    const forged = JSON.stringify({ goal: "x", branch: "goal/x", commit: head, approved_at: "now" });
    expect(agent(`mkdir -p '${dir}' && echo '${forged}' > '${dir}/x.json'`).code).not.toBe(0);
    expect(agent("git update-ref refs/heads/main HEAD").code).not.toBe(0);
    expect(agent(`echo ${head} > '${join(repo, ".git/refs/heads/main")}'`).code).not.toBe(0);
    expect(agent("git push -q . HEAD:main").code).not.toBe(0);
    expect(agent(`echo x > '${join(repo, ".git/hooks/reference-transaction")}'`).code).not.toBe(0);
    expect(readApproval(repo, "x")).toBeNull();
    expect(revParse("main", repo)).toBe(main);
    // ...while the work it is there for still runs
    expect(agent("echo v4 > app.txt && git commit -qam 'task 2'").code).toBe(0);
  });

  test("outside the sandbox: the guard hook refuses main updates that are not approved merges", () => {
    installHook(repo, launcher());
    const main = revParse("main", repo);
    const r = run(["git", "update-ref", "refs/heads/main", "goal/x"], repo);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("hq guard: refused");
    expect(revParse("main", repo)).toBe(main);
    // a human doing it on purpose
    expect(run(["git", "update-ref", "refs/heads/main", "goal/x"], repo, { HQ_ALLOW_MAIN: "1" }).code).toBe(0);
  });
});

withSandbox("approved and green: one merge commit on main, revertible in one command", () => {
  installHook(repo, launcher());
  commit(wt, "notes.txt", "n\n", "task 2");
  const base = revParse("main", repo)!;
  typeAtTerminal("x");
  const head = approve(repo, "x", quiet);
  const r = merge(repo, "x");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(revParse("main", repo)).toBe(r.mergeCommit);
  expect(git(["rev-list", "--parents", "-n", "1", r.mergeCommit], repo).split(" ").slice(1)).toEqual([base, head]);
  expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("v2\n"); // the checked-out main followed
  expect(readApproval(repo, "x")).toBeNull(); // spent
  expect(readEvents(repo).filter((e) => e.type === "merge")).toMatchObject([{ goal: "x", commit: head, merge_commit: r.mergeCommit }]);
  expect(existsSync(join(approvalsDir(repo), "merged"))).toBe(true);
  run(["bash", "-c", `HQ_ALLOW_MAIN=1 ${r.revert} --no-edit`], repo);
  expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("v1\n");
  expect(existsSync(join(repo, "notes.txt"))).toBe(false);
});

test("guard rules", () => {
  const parents = (c: string) => ({ m: ["base", "ok"], f: ["base"] })[c] ?? [];
  const u = (n: string, ref = "refs/heads/main") => ({ old: "base", new: n, ref });
  expect(refusal(u("m"), parents, ["ok"])).toBeNull();
  expect(refusal(u("m"), parents, [])).toContain("approved goal");
  expect(refusal(u("f"), parents, ["ok"])).toContain("approved goal"); // fast-forward to an unapproved commit
  expect(refusal(u("0000"), parents, ["ok"])).toContain("deleting");
  expect(refusal(u("anything", "refs/heads/goal/x"), parents, [])).toBeNull();
});
