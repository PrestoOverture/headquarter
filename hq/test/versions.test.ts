// Installed versions (roadmap M0.4): the hq that runs comes from a commit on main, not
// from any working tree; the previous one is kept for rollback.

import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, revParse, run } from "../src/git";
import { installHook } from "../src/guard";
import { sandboxed } from "../src/sandbox";
import { install, installed, launcherPath, reinstallIfChanged, rollback, versionsDir } from "../src/versions";

const withSandbox = test.skipIf(process.env.SANDBOX_RUNTIME === "1"); // see lock.test.ts
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

let root: string, repo: string;

function put(cwd: string, file: string, text: string) {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), text);
}
function commit(cwd: string, files: Record<string, string>, msg: string): string {
  for (const [f, t] of Object.entries(files)) put(cwd, f, t);
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", msg], cwd);
  return git(["rev-parse", "HEAD"], cwd);
}
const cli = (v: string) => ({ "hq/src/cli.ts": `console.log("${v}", process.argv.slice(2).join(" "));\n` });
const launch = (...args: string[]) => run([launcherPath(), ...args], repo).out.trim();

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hq-versions-")));
  process.env.HQ_HOME = join(root, "hq-home");
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  put(repo, "hq/package.json", JSON.stringify({ name: "hq-fixture", private: true }));
  run([process.execPath, "install"], join(repo, "hq")); // writes hq/bun.lock for --frozen-lockfile
  commit(repo, { ...cli("v1"), "README": "r\n" }, "v1");
});

test("the launcher runs the installed commit, not the working tree", () => {
  const v1 = install(repo);
  expect(installed("current")).toBe(v1.slice(0, 12));
  expect(launch("guard")).toBe("v1 guard"); // arguments pass through
  // a task edits hq in its worktree and even commits it on its goal branch
  const wt = join(root, "wt");
  git(["worktree", "add", "-q", "-b", "goal/x", wt, "main"], repo);
  commit(wt, cli("v2-unmerged"), "change hq");
  put(repo, "hq/src/cli.ts", 'console.log("dirty");\n');
  expect(launch()).toBe("v1");
});

test("install keeps the previous version; rollback swaps them; older ones are pruned", () => {
  const v1 = install(repo).slice(0, 12);
  const v2 = commit(repo, cli("v2"), "v2").slice(0, 12);
  install(repo);
  expect([installed("current"), installed("previous")]).toEqual([v2, v1]);
  expect(launch()).toBe("v2");
  expect(rollback()).toBe(v1);
  expect([installed("current"), installed("previous")]).toEqual([v1, v2]);
  expect(launch()).toBe("v1");
  const v3 = commit(repo, cli("v3"), "v3").slice(0, 12);
  install(repo);
  expect([installed("current"), installed("previous")]).toEqual([v3, v1]);
  expect(readdirSync(versionsDir()).sort()).toEqual([v1, v3].sort());
  install(repo); // same commit again: nothing moves
  expect([installed("current"), installed("previous")]).toEqual([v3, v1]);
});

test("after a merge, reinstall only when hq/ changed", () => {
  const base = revParse("main", repo)!;
  expect(reinstallIfChanged(repo, base, base)).toBeNull(); // nothing installed yet
  install(repo);
  const docs = commit(repo, { README: "r2\n" }, "docs only");
  expect(reinstallIfChanged(repo, base, docs)).toBeNull();
  const hq = commit(repo, cli("v2"), "hq change");
  expect(reinstallIfChanged(repo, docs, hq)).toBe(hq);
  expect(launch()).toBe("v2");
});

test("install refuses a commit without hq/, and the hook needs the launcher", () => {
  const empty = join(root, "empty");
  mkdirSync(empty);
  git(["init", "-q", "-b", "main"], empty);
  git(["commit", "-q", "--allow-empty", "-m", "x"], empty);
  expect(() => install(empty)).toThrow("no hq/");
  expect(() => installHook(repo, launcherPath())).toThrow("hq install");
  install(repo);
  expect(installHook(repo, launcherPath())).toContain("reference-transaction");
});

withSandbox("executors cannot change the installed version", () => {
  install(repo);
  const target = join(versionsDir(), installed("current")!, "hq", "src", "cli.ts");
  const r = sandboxed(`echo 'console.log("pwned")' > '${target}'`, repo, { writable: [repo], commonDir: join(repo, ".git") });
  expect(r.code).not.toBe(0);
  expect(launch()).toBe("v1");
  expect(existsSync(target)).toBe(true);
});
