import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCommands } from "../src/git-cache";
import { originEvidence, Repos, run, sameLanding } from "../src/git";
import { buildTasks } from "../src/link";
import { emptySession } from "../src/types";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "crewmeter-git-cache-"));
  dirs.push(dir);
  const top = join(dir, "repo"), cacheDir = join(dir, "cache");
  mkdirSync(top);
  const git = (...args: string[]) => {
    const result = run(["git", ...args], top);
    if (result.code !== 0) throw new Error(`git ${args}: ${result.code}`);
    return result.out.trim();
  };
  git("init", "-b", "main");
  git("config", "user.name", "Cache Test");
  git("config", "user.email", "cache@example.test");
  git("config", "commit.gpgsign", "false");
  const commit = (text: string, subject: string) => {
    writeFileSync(join(top, "file.txt"), text);
    git("add", "file.txt");
    git("commit", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  const a = commit("original substantive line\nother substantive line\n", "feature");
  const fix = commit("corrected substantive line\nother substantive line\n", "fix bug");
  git("update-ref", "refs/remotes/origin/main", fix);
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const calls: string[][] = [];
  const exec: typeof run = (cmd, cwd) => { calls.push(cmd); return run(cmd, cwd); };
  const read = (cache = true) => {
    calls.length = 0;
    const repos = new Repos(dir, cache ? cacheDir : undefined, exec);
    const repo = repos.of(top)!;
    const evidence = originEvidence(repo, fix);
    const landing = sameLanding(repo, a, fix);
    const session = emptySession("claude", "fixture", "fixture");
    Object.assign(session, { cwd: top, start: 0, end: Date.parse("2030-01-01"), times: [0], commitShas: [a, fix] });
    const tasks = buildTasks([session], repos, Date.parse("2030-01-01"));
    return { commits: [...repo.commits], main: repo.main, evidence, landing, tasks };
  };
  return { dir, top, cacheDir, git, commit, a, fix, calls, exec, read };
}
const expensive = (calls: string[][]) => calls.filter(c => c[1] === "diff" || c[1] === "blame" || c[1] === "log" || c[1] === "rev-list");

test("warm collection reuses raw git work; ref changes refresh repo entries and preserve immutable entries", () => {
  const r = fixture();
  const cold = r.read();
  expect(r.calls.some(c => c[1] === "diff")).toBe(true);
  expect(r.calls.some(c => c[1] === "blame")).toBe(true);
  expect(r.calls.some(c => c[1] === "log" && c.includes("--all"))).toBe(true);
  expect(cold.evidence.has(r.a)).toBe(true);
  expect(r.read()).toStrictEqual(cold);
  expect(expensive(r.calls)).toEqual([]);
  expect(r.calls.filter(c => c[1] === "rev-parse" && c.includes("--verify"))).toEqual([]);
  expect(r.read(false)).toStrictEqual(cold);
  expect(r.calls.some(c => c[1] === "diff")).toBe(true);
  expect(r.calls.some(c => c[1] === "blame")).toBe(true);
  expect(r.calls.some(c => c[1] === "log")).toBe(true);

  const next = r.commit("corrected substantive line\nanother substantive line\n", "new commit");
  const changed = r.read();
  expect(changed.commits.some(([sha]) => sha === next)).toBe(true);
  expect(r.calls.some(c => c[1] === "log")).toBe(true);
  expect(r.calls.some(c => c[1] === "rev-list")).toBe(true);
  expect(r.calls.filter(c => c[1] === "diff" || c[1] === "blame")).toEqual([]);
  expect(r.read(false)).toStrictEqual(changed);
});

test("HEAD, packed refs, attributes, config and replacement objects invalidate relevant inputs", () => {
  const r = fixture();
  r.read();
  r.git("checkout", "--detach", r.a);
  const detached = r.read();
  expect(r.calls.some(c => c[1] === "log")).toBe(true);
  expect(r.read(false)).toStrictEqual(detached);
  r.git("checkout", "main");
  r.git("pack-refs", "--all");
  r.read();
  expect(r.calls.some(c => c[1] === "log")).toBe(true);
  writeFileSync(join(r.top, ".gitattributes"), "file.txt -diff\n");
  const binary = r.read();
  expect(r.calls.some(c => c[1] === "diff")).toBe(true);
  expect(binary.commits.every(([, c]) => c.added === 0)).toBe(true);
  expect(r.read(false)).toStrictEqual(binary);
  r.git("config", "diff.noprefix", "true");
  const configured = r.read();
  expect(r.calls.some(c => c[1] === "diff")).toBe(true);
  expect(r.read(false)).toStrictEqual(configured);
  r.git("replace", r.fix, r.a);
  const replaced = r.read();
  expect(r.calls.some(c => c[1] === "diff")).toBe(true);
  expect(r.read(false)).toStrictEqual(replaced);
});

test("raw stdout is preserved, blame ranges/files are distinct, corrupt entries and failed writes run fresh", () => {
  const r = fixture();
  const commands = () => new GitCommands(join(r.top, ".git"), r.top, join(r.top, ".git"), r.exec, r.cacheDir);
  const args = ["blame", "--porcelain", "-L", "1,+1", `${r.fix}^`, "--", "file.txt"];
  const expected = run(["git", ...args], r.top);
  expect(commands().read(args, true)).toStrictEqual(expected);
  r.calls.length = 0;
  expect(commands().read(args, true)).toStrictEqual(expected);
  expect(r.calls.some(c => c[1] === "blame")).toBe(false);
  const different = [...args]; different[3] = "2,+1";
  expect(commands().read(different, true)).toStrictEqual(run(["git", ...different], r.top));
  expect(r.calls.some(c => c[1] === "blame")).toBe(true);
  const missing = [...args]; missing[6] = "missing.txt";
  expect(commands().read(missing, true).code).not.toBe(0);
  r.calls.length = 0;
  expect(commands().read(missing, true).code).not.toBe(0);
  expect(r.calls.some(c => c[1] === "blame")).toBe(true);
  const entries = join(r.cacheDir, "git-v2");
  for (const file of readdirSync(entries)) writeFileSync(join(entries, file), "{");
  r.calls.length = 0;
  expect(commands().read(args, true)).toStrictEqual(expected);
  expect(r.calls.some(c => c[1] === "blame")).toBe(true);
  const entry = readdirSync(entries).find(file => readFileSync(join(entries, file), "utf8") !== "{")!;
  const bad = JSON.parse(readFileSync(join(entries, entry), "utf8"));
  bad.data = JSON.stringify({ code: 0, out: "corrupt" });
  writeFileSync(join(entries, entry), JSON.stringify(bad));
  expect(commands().read(args, true)).toStrictEqual(expected);
  expect(readdirSync(entries).every(file => file.endsWith(".json"))).toBe(true);
  const blocked = join(r.dir, "blocked"); writeFileSync(blocked, "file");
  expect(new GitCommands(join(r.top, ".git"), r.top, join(r.top, ".git"), r.exec, blocked).read(args, true)).toStrictEqual(expected);
});

test("external diff/textconv configurations bypass caching and --no-cache leaves cache untouched", () => {
  const r = fixture();
  r.read(false);
  expect(existsSync(r.cacheDir)).toBe(false);
  r.read();
  const entries = join(r.cacheDir, "git-v2");
  const before = readdirSync(entries).map(file => [file, readFileSync(join(entries, file), "utf8")]);
  r.read(false);
  expect(readdirSync(entries).map(file => [file, readFileSync(join(entries, file), "utf8")])).toStrictEqual(before);
  r.git("config", "diff.custom.textconv", "cat");
  const first = r.read();
  expect(r.read()).toStrictEqual(first);
  expect(r.calls.some(c => c[1] === "log")).toBe(true);
  expect(r.calls.some(c => c[1] === "diff")).toBe(true);
  expect(r.calls.some(c => c[1] === "blame")).toBe(true);
});

test("nested untracked attributes and deleted attributes using the index invalidate raw diffs", () => {
  const r = fixture();
  mkdirSync(join(r.top, "nested"));
  writeFileSync(join(r.top, "nested/file.txt"), "before substantive line\n");
  r.git("add", "nested/file.txt"); r.git("commit", "-m", "nested feature");
  writeFileSync(join(r.top, "nested/file.txt"), "after substantive line\n");
  r.git("add", "nested/file.txt"); r.git("commit", "-m", "fix nested");
  const sha = r.git("rev-parse", "HEAD");
  const args = ["diff", "-U0", "--no-renames", "--no-color", `${sha}^`, sha];
  const read = () => new GitCommands(join(r.top, ".git"), r.top, join(r.top, ".git"), r.exec, r.cacheDir).read(args, true);
  const text = read();
  writeFileSync(join(r.top, "nested/.gitattributes"), "file.txt -diff\n");
  const binary = read();
  expect(binary).not.toStrictEqual(text);
  expect(binary).toStrictEqual(run(["git", ...args], r.top));
  r.git("add", "nested/.gitattributes");
  rmSync(join(r.top, "nested/.gitattributes"));
  expect(read()).toStrictEqual(run(["git", ...args], r.top));
  r.calls.length = 0;
  read();
  expect(r.calls.some(c => c[1] === "diff")).toBe(false);
});

test("discovery reuse still finds nested repositories and linked worktrees", () => {
  const r = fixture();
  mkdirSync(join(r.top, "subdir"));
  const nested = join(r.top, "subdir/nested");
  mkdirSync(nested);
  const repos = new Repos(r.dir, r.cacheDir, r.exec);
  const original = repos.of(r.top)!;
  r.calls.length = 0;
  expect(repos.of(join(r.top, "subdir"))).toBe(original);
  expect(r.calls).toEqual([]);
  r.git("init", "-b", "main", nested);
  expect(repos.of(nested)!.key).toBe(realpathSync(join(nested, ".git")));
  const worktree = join(r.dir, "worktree");
  r.git("worktree", "add", "--detach", worktree, r.a);
  expect(repos.of(worktree)).toBe(original);
  const next = new Repos(r.dir, r.cacheDir, r.exec).of(worktree)!;
  expect(next.key).toBe(original.key);
  expect(next.top).toBe(realpathSync(worktree));
  expect([...next.commits]).toStrictEqual([...new Repos(r.dir).of(worktree)!.commits]);
});
