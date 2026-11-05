// hq work: the real CLI and a real git repository with a goal worktree; `claude` is a fake
// executable first on PATH that records how it was called and prints a canned stream (no network).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { git, run } from "../src/git";
import { append, readEvents } from "../src/ledger";
import { executorSettings } from "../src/settings";
import { workDir } from "../src/work";

const CLI = join(import.meta.dir, "../src/cli.ts");
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

let root: string, repo: string, wt: string, head: string, savedPath: string | undefined;

const hq = (...args: string[]) =>
  run([process.execPath, CLI, ...args], repo, { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION: "outer", KEEP_ME: "yes" });

const GOAL = {
  title: "Goal title",
  acceptance: ["goal criterion"],
  tasks: {
    t1: {
      title: "Task one", difficulty: "hard", scope: "hq", check: "cd hq && bun test",
      acceptance: ["first criterion", { text: "second criterion", traces: "g1" }],
    },
    t2: { title: "Task two", acceptance: ["only criterion"] },
  },
};

const stream = (result: object) =>
  [
    { type: "system", subtype: "init", model: "claude-sonnet-5-5" },
    { type: "assistant", message: { content: [{ type: "text", text: "working" }] } },
    { type: "result", subtype: "success", is_error: false, uuid: "u-1", session_id: "s-1", total_cost_usd: 0.25, num_turns: 7, result: "Built it.", ...result },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";

/** Installs a fake claude that saves its cwd, arguments (NUL-separated), stdin and environment under fake/, waits up to 5s for the ledger and saves it, prints `body` and exits with `code`. */
function fakeClaude(body = stream({}), code = 0) {
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "fake"), { recursive: true });
  writeFileSync(join(root, "body.txt"), body);
  const f = join(root, "fake");
  const script = `#!/bin/sh
pwd > "${f}/cwd"
cat > "${f}/prompt"
for a in "$@"; do printf '%s\\0' "$a"; done > "${f}/args"
env > "${f}/env"
i=0; while [ $i -lt 50 ] && ! ls "$HQ_HOME"/ledger/*/events.jsonl >/dev/null 2>&1; do i=$((i+1)); sleep 0.1; done
cat "$HQ_HOME"/ledger/*/events.jsonl > "${f}/ledger" 2>/dev/null
cat "${root}/body.txt"
exit ${code}
`;
  writeFileSync(join(root, "bin/claude"), script);
  chmodSync(join(root, "bin/claude"), 0o755);
}

const called = () => existsSync(join(root, "fake/args"));
const args = () => readFileSync(join(root, "fake/args"), "utf8").split("\0").slice(0, -1);
const prompt = () => readFileSync(join(root, "fake/prompt"), "utf8");
const logs = () => (existsSync(workDir(repo)) ? readdirSync(workDir(repo)).sort().map((f) => join(workDir(repo), f)) : []);
const flag = (name: string) => args()[args().indexOf(name) + 1];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hq-work-")));
  process.env.HQ_HOME = join(root, "hq-home");
  savedPath = process.env.PATH;
  process.env.PATH = `${join(root, "bin")}:${savedPath}`;
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "app.txt"), "v1\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "base"], repo);
  wt = join(root, "repo.goals/g");
  git(["worktree", "add", "-q", "-b", "goal/g", wt, "main"], repo);
  mkdirSync(join(wt, "goals"));
  writeFileSync(join(wt, "goals/g.json"), JSON.stringify(GOAL));
  git(["add", "-A"], wt);
  git(["commit", "-q", "-m", "goal g: start"], wt);
  head = git(["rev-parse", "HEAD"], wt);
  fakeClaude();
});

afterEach(() => {
  process.env.PATH = savedPath;
});

describe("hq work", () => {
  test("runs one stream-json session in the goal's worktree with the prompt from the task", () => {
    const r = hq("work", "g", "--task", "t1");
    expect(r.code).toBe(0);
    expect(readFileSync(join(root, "fake/cwd"), "utf8").trim()).toBe(wt);
    const a = args();
    expect(a.slice(0, 2)).toEqual(["-p", "--model"]);
    expect(flag("--model")).toBe("claude-sonnet-5-5");
    expect(flag("--effort")).toBe("high");
    expect(flag("--output-format")).toBe("stream-json");
    expect(a).toContain("--verbose");
    expect(flag("--setting-sources")).toBe("");
    expect(a).toContain("--strict-mcp-config");
    expect(a.slice(a.indexOf("--disallowedTools") + 1)).toEqual(["WebFetch", "WebSearch"]);
    expect(prompt()).toBe(`You are working in ${wt}, a git worktree of this repository on branch goal/g. Implement this task (earlier tasks of the same goal are already committed on this branch):

Task one

Acceptance criteria:
1. first criterion
2. second criterion

How to work:
- Read docs/architecture.md and the existing code under hq/ first; match its style, naming, comment density and test style (hq/test/*.test.ts).
- Run \`cd hq && bun test\` and make it pass. Tests that need the sandbox runtime are skipped when SANDBOX_RUNTIME=1; that is expected.
- Do not change files outside hq/ except docs/architecture.md if a new module needs a line there.
- Commit your work on the current branch with a clear message. Do not touch main.
- When done, say in two or three sentences what you built and how you tested it.`);
  });

  test("the session gets the executor settings and none of the caller's CLAUDE_CODE_* variables", () => {
    hq("work", "g", "--task", "t1");
    expect(JSON.parse(flag("--settings")!)).toEqual(executorSettings(join(realpathSync(repo), ".git"), homedir()));
    const env = readFileSync(join(root, "fake/env"), "utf8");
    expect(env).not.toMatch(/^(CLAUDE_CODE_|CLAUDECODE=)/m);
    expect(env).toContain("KEEP_ME=yes");
  });

  test("saves the log, records the start and the cost, prints cost, turns and the final message", () => {
    const body = stream({});
    fakeClaude(body);
    const r = hq("work", "g", "--task", "t1");
    expect(r.code).toBe(0);
    const [log] = logs() as [string];
    expect(log).toMatch(new RegExp(`/work/repo-[0-9a-f]{8}/g-t1-\\d+\\.jsonl$`));
    expect(readFileSync(log, "utf8")).toBe(body);
    expect(readEvents(repo)).toMatchObject([
      { type: "task.start", task: "t1", goal: "g", title: "Task one", base: head, difficulty: "hard", model: "claude-sonnet-5-5" },
      { type: "task.cost", task: "t1", usd: 0.25, runs: ["u-1"], sessions: ["s-1"], source: { path: log } },
    ]);
    expect(r.out).toContain("$0.2500");
    expect(r.out).toContain("7 turns");
    expect(r.out).toContain("Built it.");
    expect(r.out).toContain(log);
  });

  test("the start is in the ledger while the session runs, not after it ends", () => {
    expect(hq("work", "g", "--task", "t1").code).toBe(0);
    const during = readFileSync(join(root, "fake/ledger"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(during).toMatchObject([{ type: "task.start", task: "t1", goal: "g", base: head }]);
  });

  test("the start records the head from before the session and is not repeated for a task that has one", () => {
    append(repo, { type: "task.start", task: "t1", goal: "g", title: "earlier", base: head, difficulty: "easy", model: "other" });
    fakeClaude(stream({ uuid: "u-a" }));
    expect(hq("work", "g", "--task", "t1", "--model", "claude-haiku-5-5").code).toBe(0);
    expect(flag("--model")).toBe("claude-haiku-5-5");
    fakeClaude(stream({ uuid: "u-b" }));
    expect(hq("work", "g", "--task", "t1").code).toBe(0);
    const events = readEvents(repo);
    expect(events.filter((e) => e.type === "task.start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "task.cost")).toHaveLength(2);
    expect(logs()).toHaveLength(2);
  });

  test("without --task the goal file itself is the task: scope is the repository root, the task is named after the goal", () => {
    const r = hq("work", "g");
    expect(r.code).toBe(0);
    const p = prompt();
    expect(p).toContain("Implement this goal:\n\nGoal title\n\nAcceptance criteria:\n1. goal criterion\n");
    expect(p).toContain("existing code under the repository first");
    expect(p).toContain("Run `bun test && bunx tsc --noEmit` and make it pass.");
    expect(p).not.toContain("Do not change files outside");
    expect(readEvents(repo)).toMatchObject([{ type: "task.start", task: "g", goal: "g", difficulty: "medium" }, { type: "task.cost", task: "g" }]);
    expect(logs()[0]).toMatch(/\/g-g-\d+\.jsonl$/);
  });

  test("a task without scope or check defaults to the repository root", () => {
    hq("work", "g", "--task", "t2");
    expect(prompt()).toContain("Run `bun test && bunx tsc --noEmit` and make it pass.");
    expect(prompt()).toContain("Implement this task");
  });

  test("the notes file's text ends the prompt", () => {
    writeFileSync(join(root, "notes.txt"), "Rework: the second criterion is not met.\n");
    expect(hq("work", "g", "--task", "t1", "--notes", join(root, "notes.txt")).code).toBe(0);
    expect(prompt().endsWith("how you tested it.\n\nRework: the second criterion is not met.\n")).toBe(true);
  });

  test("a session that ends on an error exits non-zero after recording its cost", () => {
    fakeClaude(stream({ subtype: "error_during_execution", is_error: true, result: "Something broke", total_cost_usd: 0.5 }));
    const r = hq("work", "g", "--task", "t1");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Something broke");
    expect(r.err).toContain("the session ended on an error");
    expect(readEvents(repo)).toMatchObject([{ type: "task.start" }, { type: "task.cost", task: "t1", usd: 0.5 }]);
  });

  test("a usage limit counts as an error", () => {
    fakeClaude(stream({ is_error: true, result: "You've hit your limit", total_cost_usd: 0 }));
    const r = hq("work", "g", "--task", "t1");
    expect(r.code).toBe(1);
    expect(r.err).toContain("You've hit your limit");
    expect(readEvents(repo).map((e) => e.type)).toEqual(["task.start", "task.cost"]);
  });

  test("a session with no result message fails, keeps its log and records no cost", () => {
    fakeClaude('{"type":"system","subtype":"init"}\n', 1);
    const r = hq("work", "g", "--task", "t1");
    expect(r.code).toBe(1);
    expect(r.err).toContain("left no result message");
    expect(logs()).toHaveLength(1);
    expect(readEvents(repo).map((e) => e.type)).toEqual(["task.start"]);
  });

  test("a non-zero exit after a successful result still fails", () => {
    fakeClaude(stream({}), 3);
    const r = hq("work", "g", "--task", "t1");
    expect(r.code).toBe(1);
    expect(r.err).toContain("claude exited 3");
    expect(readEvents(repo).map((e) => e.type)).toEqual(["task.start", "task.cost"]);
  });
});

describe("refusals start nothing", () => {
  function refused(r: { code: number; err: string }, message: string) {
    expect(r.code).toBe(1);
    expect(r.err).toContain(message);
    expect(called()).toBe(false);
    expect(logs()).toEqual([]);
    expect(readEvents(repo)).toEqual([]);
  }

  test("no goal branch", () => {
    refused(hq("work", "nope"), "no branch goal/nope");
  });

  test("a bad goal name", () => {
    refused(hq("work", "Bad Name"), "bad goal name");
  });

  test("the branch has no worktree", () => {
    git(["worktree", "remove", "--force", wt], repo);
    refused(hq("work", "g", "--task", "t1"), "goal/g has no worktree");
  });

  test("the worktree directory is gone", () => {
    run(["rm", "-rf", wt], repo);
    refused(hq("work", "g", "--task", "t1"), "goal/g has no worktree");
  });

  test("the task is not in the goal file", () => {
    refused(hq("work", "g", "--task", "t9"), "no task t9 in goals/g.json");
  });

  test("a task name with a path in it", () => {
    refused(hq("work", "g", "--task", "../x"), "bad task name");
  });

  test("a task that belongs to another goal", () => {
    append(repo, { type: "task.start", task: "t1", goal: "other", title: "t", base: head, difficulty: "medium", model: "m" });
    const r = hq("work", "g", "--task", "t1");
    expect(r.code).toBe(1);
    expect(r.err).toContain("belongs to goal other");
    expect(called()).toBe(false);
    expect(readEvents(repo)).toHaveLength(1);
  });

  test("a notes file that does not exist", () => {
    const r = hq("work", "g", "--task", "t1", "--notes", join(root, "missing.txt"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("missing.txt");
    expect(called()).toBe(false);
    expect(readEvents(repo)).toEqual([]);
  });

  test("a task without acceptance criteria", () => {
    writeFileSync(join(wt, "goals/g.json"), JSON.stringify({ title: "g", tasks: { t1: { title: "x" } } }));
    refused(hq("work", "g", "--task", "t1"), "has no acceptance list");
  });
});

test("executor settings: strict sandbox, main's ref, packed-refs, hooks and config unwritable, credentials unreadable, no network but local", () => {
  const s = executorSettings("/repo/.git", "/home/me");
  expect(s.sandbox).toMatchObject({
    enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
    network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: true },
  });
  expect(s.sandbox.filesystem.denyWrite).toEqual(["/repo/.git/refs/heads/main", "/repo/.git/packed-refs", "/repo/.git/hooks", "/repo/.git/config"]);
  expect(s.sandbox.credentials.files).toContainEqual({ path: "/home/me/.ssh", mode: "deny" });
  expect(s.sandbox.credentials.files).toContainEqual({ path: "/home/me/.netrc", mode: "deny" });
  expect(s.permissions.deny).toContain("Read(//home/me/.ssh/**)");
  expect(s.permissions.deny).toContain("Read(//home/me/.netrc)");
  expect(s.permissions.deny).not.toContain("Read(//home/me/.hq/**)");
});
