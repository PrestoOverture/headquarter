import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repos, run } from "../src/git";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

for (const untracked of [false, true]) {
  test(`commit reading excludes stash commits (untracked: ${untracked})`, () => {
    const dir = mkdtempSync(join(tmpdir(), "crewmeter-git-stash-"));
    dirs.push(dir);
    const top = join(dir, "repo");
    mkdirSync(top);
    const git = (...args: string[]) => {
      const result = run(["git", ...args], top);
      if (result.code !== 0) throw new Error(`git ${args}: ${result.code}`);
      return result.out.trim();
    };
    git("init", "-b", "main");
    git("config", "user.name", "Stash Test");
    git("config", "user.email", "stash@example.test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(top, "file.txt"), "original\n");
    git("add", "file.txt");
    git("commit", "-m", "real commit");
    const real = git("rev-parse", "HEAD");
    writeFileSync(join(top, "file.txt"), "changed\n");
    if (untracked) writeFileSync(join(top, "untracked.txt"), "untracked\n");
    git("stash", "push", ...(untracked ? ["-u"] : []));
    expect(git("log", "--all", "--format=%H").split("\n")).toHaveLength(untracked ? 4 : 3);

    for (const cacheDir of [undefined, join(dir, "cache"), join(dir, "cache")]) {
      const calls: string[][] = [];
      const repos = new Repos(dir, cacheDir, (cmd, cwd) => {
        calls.push(cmd);
        return run(cmd, cwd);
      });
      expect([...repos.of(top)!.commits.keys()]).toEqual([real]);
      for (const cmd of calls.filter(cmd => cmd[1] === "log" && cmd.includes("--all"))) {
        expect(cmd.indexOf("--exclude=refs/stash")).toBeGreaterThan(1);
        expect(cmd.indexOf("--exclude=refs/stash")).toBeLessThan(cmd.indexOf("--all"));
      }
    }

    // Commits referenced only by a branch, remote or tag must remain visible.
    const expected = [real];
    for (const ref of ["refs/heads/feature", "refs/remotes/origin/feature", "refs/tags/feature"]) {
      const sha = git("commit-tree", `${real}^{tree}`, "-p", real, "-m", ref);
      git("update-ref", ref, sha);
      expected.push(sha);
    }
    for (const cacheDir of [undefined, join(dir, "cache")]) {
      expect([...new Repos(dir, cacheDir).of(top)!.commits.keys()].sort()).toEqual([...expected].sort());
    }
  });
}
