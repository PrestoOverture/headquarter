// The merge queue (roadmap M0): one merge per repository at a time under a lock, a trial merge
// redone once when main moved during the tests. The tests run as plain shell commands or fakes,
// not in srt, so these run inside the pre-merge sandbox too.

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readApproval } from "../src/approval";
import { approve } from "../src/cli";
import { git, revParse, run } from "../src/git";
import { merge, mergeLockPath } from "../src/merge";
import { tryLock } from "../src/lockfile";
import { writeReport } from "../src/report";
import type { sandboxed } from "../src/sandbox";

const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
Object.assign(process.env, ID);
const quiet = () => {};
const CHILD = join(import.meta.dir, "fixtures/merge-child.ts");

let root: string, repo: string;

function commit(cwd: string, file: string, text: string, msg: string) {
  writeFileSync(join(cwd, file), text);
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", msg], cwd);
}

/** goal/<goal> with one commit adding <goal>.txt, approved. */
function approvedGoal(goal: string): string {
  const wt = join(root, `wt-${goal}`);
  git(["worktree", "add", "-q", "-b", `goal/${goal}`, wt, "main"], repo);
  commit(wt, `${goal}.txt`, `${goal}\n`, `${goal} task`);
  const head = revParse(`goal/${goal}`, repo)!;
  writeReport(repo, { goal, commit: head, base: revParse("main", repo)!, trial_merge: head, test_code: 0, generated_at: "now" }, "# report", "ok");
  const tty = join(root, "tty");
  writeFileSync(tty, goal + "\n");
  process.env.HQ_TTY = tty;
  approve(repo, goal, quiet);
  return head;
}

/** Stands in for the sandbox: the test command as a plain shell command, after `before`. */
function shell(before: (n: number) => void = () => {}): { runTests: typeof sandboxed; calls: () => number } {
  let n = 0;
  return { runTests: (cmd, cwd) => (before(++n), run(["bash", "-c", cmd], cwd)), calls: () => n };
}

const parents = (c: string) => git(["rev-list", "--parents", "-n", "1", c], repo).split(" ").slice(1);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hq-queue-")));
  process.env.HQ_HOME = join(root, "hq-home");
  delete process.env.HQ_ALLOW_MAIN;
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, ".hq.json"), JSON.stringify({ test: "! grep -q BROKEN app.txt" }));
  commit(repo, "app.txt", "v1\n", "base");
});

describe("the merge lock", () => {
  test("a held lock refuses at once with the holder's pid, and --wait queues behind it", async () => {
    approvedGoal("x");
    const release = tryLock(mergeLockPath(repo))!;
    const main = revParse("main", repo);
    const t0 = Date.now();
    const r = merge(repo, "x");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(!r.ok && r.reason).toContain(`pid ${process.pid}`);
    expect(revParse("main", repo)).toBe(main);
    expect(readApproval(repo, "x")).not.toBeNull();

    const t1 = Date.now();
    const w = merge(repo, "x", { wait: 0.4 });
    expect(Date.now() - t1).toBeGreaterThanOrEqual(400);
    expect(!w.ok && w.reason).toContain(`pid ${process.pid}`);

    release();
    expect(merge(repo, "x", shell()).ok).toBe(true);
    expect(existsSync(mergeLockPath(repo))).toBe(false); // released
  });

  test("a lock whose pid is gone is taken over", () => {
    approvedGoal("x");
    const dead = Bun.spawnSync(["true"]);
    mkdirSync(join(mergeLockPath(repo), ".."), { recursive: true });
    writeFileSync(mergeLockPath(repo), `${dead.pid}\nold\n`);
    expect(() => process.kill(dead.pid, 0)).toThrow(); // the pid of a finished child
    const r = merge(repo, "x", shell());
    expect(r.ok).toBe(true);
    expect(existsSync(mergeLockPath(repo))).toBe(false);
  });

  test("the lock is released when the merge is refused", () => {
    approvedGoal("x");
    git(["commit", "-q", "--allow-empty", "-m", "late"], join(root, "wt-x"));
    expect(merge(repo, "x", shell()).ok).toBe(false);
    expect(existsSync(mergeLockPath(repo))).toBe(false);
  });

  test("two concurrent merges of different goals end with both merged, one after the other", async () => {
    const hx = approvedGoal("x");
    const hy = approvedGoal("y");
    const base = revParse("main", repo)!;
    const log = join(root, "log");
    writeFileSync(log, "");
    const children = ["x", "y"].map((g) => Bun.spawn([process.execPath, CHILD, repo, g, log], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" }));
    const out = await Promise.all(children.map(async (c) => ({ text: await new Response(c.stdout).text(), err: await new Response(c.stderr).text(), code: await c.exited })));
    for (const o of out) expect(o).toMatchObject({ code: 0, err: "" });
    const results = out.map((o) => JSON.parse(o.text));
    expect(results).toMatchObject([{ ok: true }, { ok: true }]);

    // the second trial started after the first merge had finished, on the main the first one left
    const runs = readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" "));
    expect(runs.map((r) => r[1])).toEqual(["start", "end", "start", "end"]);
    const [first, second] = runs[0]![0] === "x" ? ["x", "y"] : ["y", "x"];
    expect(runs[2]![0]).toBe(second);
    const [m1, m2] = first === "x" ? [results[0].mergeCommit, results[1].mergeCommit] : [results[1].mergeCommit, results[0].mergeCommit];
    expect(parents(m2)[0]).toBe(m1);
    expect(parents(m1)[0]).toBe(base);
    expect(parents(m1)[1]).toBe(first === "x" ? hx : hy);
    expect(parents(m2)[1]).toBe(second === "x" ? hx : hy);
    expect(revParse("main", repo)).toBe(m2);
    expect(existsSync(join(repo, "x.txt")) && existsSync(join(repo, "y.txt"))).toBe(true);
    expect(readApproval(repo, "x")).toBeNull();
    expect(readApproval(repo, "y")).toBeNull();
    expect(existsSync(mergeLockPath(repo))).toBe(false);
  });
});

describe("main moves while the tests run", () => {
  test("once: the trial is redone on the new main and the merge goes through", () => {
    const head = approvedGoal("x");
    let moved = "";
    const t = shell((n) => {
      if (n === 1) {
        commit(repo, "other.txt", "o\n", "someone else merged");
        moved = revParse("main", repo)!;
      }
    });
    const r = merge(repo, "x", t);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(t.calls()).toBe(2);
    expect(revParse("main", repo)).toBe(r.mergeCommit);
    expect(parents(r.mergeCommit)).toEqual([moved, head]);
    expect(readFileSync(join(repo, "other.txt"), "utf8")).toBe("o\n");
    expect(readFileSync(join(repo, "x.txt"), "utf8")).toBe("x\n");
    expect(readApproval(repo, "x")).toBeNull();
  });

  test("twice: refused, main left where it is, approval kept", () => {
    approvedGoal("x");
    let last = "";
    const t = shell((n) => {
      commit(repo, `other${n}.txt`, "o\n", `move ${n}`);
      last = revParse("main", repo)!;
    });
    const r = merge(repo, "x", t);
    expect(!r.ok && r.reason).toContain("moved again");
    expect(t.calls()).toBe(2);
    expect(revParse("main", repo)).toBe(last);
    expect(readApproval(repo, "x")).not.toBeNull();
    expect(git(["worktree", "list"], repo).split("\n")).toHaveLength(2); // x's worktree and the repo, no scratch left
  });

  test("tests that fail on the retried trial refuse the merge", () => {
    approvedGoal("x");
    const t = shell((n) => {
      if (n === 1) commit(repo, "app.txt", "BROKEN\n", "someone broke main");
    });
    const r = merge(repo, "x", t);
    expect(!r.ok && r.reason).toContain("tests failed");
    expect(t.calls()).toBe(2);
  });
});
