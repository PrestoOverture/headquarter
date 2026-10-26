// A goal commit that is already merged cannot be approved or merged again; a new commit can.
// Real git and a real ledger; the tests run as plain shell commands, not in srt.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readApproval } from "../src/approval";
import { approve } from "../src/cli";
import { git, revParse, run } from "../src/git";
import { ledgerPath, readEvents } from "../src/ledger";
import { merge } from "../src/merge";
import { writeReport } from "../src/report";
import type { sandboxed } from "../src/sandbox";

const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
Object.assign(process.env, ID);
const quiet = () => {};
const CLI = join(import.meta.dir, "../src/cli.ts");
const shell: typeof sandboxed = (cmd, cwd) => run(["bash", "-c", cmd], cwd);

let root: string, repo: string, wt: string;

function commit(cwd: string, file: string, text: string, msg: string) {
  writeFileSync(join(cwd, file), text);
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", msg], cwd);
}

/** Reports the goal's current head as green and approves it, typing the goal name on a fake terminal. */
function approveHead(goal: string): string {
  const head = revParse(`goal/${goal}`, repo)!;
  writeReport(repo, { goal, commit: head, base: revParse("main", repo)!, trial_merge: head, test_code: 0, generated_at: "now" }, "# report", "ok");
  const tty = join(root, "tty");
  writeFileSync(tty, goal + "\n");
  process.env.HQ_TTY = tty;
  approve(repo, goal, quiet);
  return head;
}

/** The hq CLI as its own process in the repository, typing the goal name on the fake terminal. */
function cli(...args: string[]) {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: repo, env: { ...process.env } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const ledger = () => readFileSync(ledgerPath(repo), "utf8");

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hq-remerge-")));
  process.env.HQ_HOME = join(root, "hq-home");
  delete process.env.HQ_ALLOW_MAIN;
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, ".hq.json"), JSON.stringify({ test: "true" }));
  commit(repo, "app.txt", "v1\n", "base");
  wt = join(root, "wt-x");
  git(["worktree", "add", "-q", "-b", "goal/x", wt, "main"], repo);
  commit(wt, "x.txt", "x\n", "x task");
});

describe("a goal commit that was already merged", () => {
  test("approve refuses with the merge commit, appends no event and writes no approval", () => {
    const head = approveHead("x");
    const r = merge(repo, "x", { runTests: shell });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const before = ledger();

    // the report is green and the terminal would say yes: only the earlier merge stands in the way
    const out = cli("approve", "x");
    expect(out.code).not.toBe(0);
    expect(out.err).toContain(r.mergeCommit);
    expect(() => approve(repo, "x", quiet)).toThrow(`already merged as ${r.mergeCommit}`);
    expect(readApproval(repo, "x")).toBeNull();
    expect(ledger()).toBe(before);
    expect(readEvents(repo).filter((e) => e.type === "approve")).toHaveLength(1);
    expect(revParse("goal/x", repo)).toBe(head);
  });

  test("merge exits non-zero with `already merged as <sha>`, moves no ref and appends no event", () => {
    approveHead("x");
    const r = merge(repo, "x", { runTests: shell });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const main = revParse("main", repo);
    const before = ledger();

    const second = merge(repo, "x", { runTests: shell });
    expect(!second.ok && second.reason).toBe(`already merged as ${r.mergeCommit}`);
    const out = cli("merge", "x");
    expect(out.code).not.toBe(0);
    expect(out.err).toContain(`already merged as ${r.mergeCommit}`);
    expect(revParse("main", repo)).toBe(main);
    expect(ledger()).toBe(before);
  });

  test("the merge check runs before the approval check", () => {
    approveHead("x");
    const r = merge(repo, "x", { runTests: shell });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readApproval(repo, "x")).toBeNull(); // consumed by the merge, so nothing is approved now
    const second = merge(repo, "x", { runTests: shell });
    expect(!second.ok && second.reason).toContain("already merged");
    expect(!second.ok && second.reason).not.toContain("not approved");
  });
});

describe("a goal with a new commit after its merge", () => {
  test("can be approved and merged again as usual", () => {
    approveHead("x");
    const first = merge(repo, "x", { runTests: shell });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    commit(wt, "x2.txt", "x2\n", "x follow-up");
    const head = approveHead("x");
    expect(readApproval(repo, "x")?.commit).toBe(head);
    const second = merge(repo, "x", { runTests: shell });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.mergeCommit).not.toBe(first.mergeCommit);
    expect(revParse("main", repo)).toBe(second.mergeCommit);
    expect(readFileSync(join(repo, "x2.txt"), "utf8")).toBe("x2\n");
    expect(readEvents(repo).filter((e) => e.type === "merge")).toHaveLength(2);
  });
});
