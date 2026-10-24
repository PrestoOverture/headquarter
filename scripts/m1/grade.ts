// M1 grader: runs a task's hidden tests on a commit of the task's repository, in a scratch
// worktree, inside srt (D35) with writes allowed only to that scratch worktree (no shared temp
// directory, so code under test cannot leave the tests anywhere the answerer can read later).
// The answerer's working tree is never touched and never holds the test files.
//
// A run passes only when every bun test summary adds up to the exam's test count with no
// failures, not merely when it exits 0. A failing run is rerun once on the same code; runs that
// disagree are flaky (D36).

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { examDir, failureKind, feedback, git, repo, runDir, sh, summary } from "./common";
import { hiddenFiles } from "./writer";

const SRT = join(repo, "hq/node_modules/.bin/srt");

export type Graded = { commit: string; passed: boolean; runs: number[]; flaky: boolean; kind: "assertion" | "other" | null; tests: { pass: number; fail: number }; feedback: string; log: string };

export async function grade(task: string, dir: string, commit: string, expected?: number): Promise<Graded> {
  const exam = examDir(task);
  const files = hiddenFiles(task);
  if (!existsSync(join(exam, "run.sh")) || !files.length) throw new Error(`no exam for ${task}`);
  const count = expected ?? (existsSync(join(exam, "count")) ? Number(readFileSync(join(exam, "count"), "utf8")) : undefined);
  const scratch = mkdtempSync(join(tmpdir(), `m1-grade-${task}-`));
  try {
    git(["worktree", "add", "--detach", "-q", scratch, commit], dir);
    for (const d of ["hq", "eval"]) if (existsSync(join(dir, d, "node_modules")) && existsSync(join(scratch, d))) symlinkSync(join(dir, d, "node_modules"), join(scratch, d, "node_modules"));
    cpSync(join(exam, "files"), scratch, { recursive: true });
    cpSync(join(exam, "run.sh"), join(scratch, ".m1-run.sh"));
    const { srtSettings } = await import(join(repo, "hq/src/sandbox.ts"));
    const settings = srtSettings({ writable: [scratch], commonDir: join(dir, ".git") });
    settings.filesystem.allowWrite = [scratch]; // not the shared temp directory
    const settingsFile = join(scratch, ".m1-srt.json");
    writeFileSync(settingsFile, JSON.stringify(settings));
    const once = () => sh([SRT, "-s", settingsFile, "-c", `export TMPDIR="$PWD/.m1-tmp"; mkdir -p "$TMPDIR" && bash .m1-run.sh`], scratch);
    const runs = [once()];
    const ok = (r: { code: number; out: string }) => {
      const s = summary(r.out);
      return r.code === 0 && s.fail === 0 && s.pass > 0 && (count === undefined || s.pass === count);
    };
    if (!ok(runs[0]!)) runs.push(once());
    const passes = runs.map(ok);
    const flaky = new Set(passes).size > 1;
    const output = runs.map((r) => r.out).join("\n--- rerun ---\n");
    const log = join(runDir(task), `grade-${commit.slice(0, 12)}-${Date.now()}.log`);
    writeFileSync(log, output);
    const passed = passes.every(Boolean);
    const last = runs.at(-1)!.out;
    return { commit, passed, runs: runs.map((r) => r.code), flaky, kind: passed ? null : failureKind(last), tests: summary(last), feedback: passed ? "" : feedback(last, files), log };
  } finally {
    sh(["git", "worktree", "remove", "--force", scratch], dir);
    rmSync(scratch, { recursive: true, force: true });
  }
}
