// M1 grader: runs a task's hidden tests on a commit of the task's repository, in a scratch
// worktree, inside srt (D35) with writes allowed only to that scratch worktree (no shared temp
// directory, so code under test cannot leave the tests anywhere the answerer can read later) and
// reads denied as for every M1 session (deniedReads). The sandbox settings, run.sh and the seal
// sit beside the worktree, outside what the tests can write, so a first run cannot change the
// rerun. The answerer's working tree is never touched and never holds the test files.
//
// A run passes only when every bun test summary adds up to the exam's test count, with no
// failing or skipped test, and the seal agrees: a preload (bunfig.toml in the scratch worktree)
// counts the tests that actually ran and prints the count with a per-run secret the code under
// test never sees, so printing a fake summary and exiting does not pass. A failing run is rerun
// once on the same code; runs that disagree on the result or on which tests fail are flaky (D36).

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deniedReads, examDir, failing, failureKind, feedback, git, repo, runDir, scratchDir, sh, sourceLines, summary, unescaped } from "./common";
import { hiddenFiles } from "./writer";

const SRT = join(repo, "hq/node_modules/.bin/srt");
const RUN_TIMEOUT = 20 * 60 * 1000;
const SEAL = `import { afterAll, afterEach } from "bun:test";
import { writeSync } from "node:fs";
const seal = process.env.M1_SEAL;
delete process.env.M1_SEAL;
let ran = 0;
afterEach(() => { ran++; });
afterAll(() => { writeSync(1, "\\nm1-seal " + seal + " " + ran + "\\n"); });
`;

type Run = { code: number; out: string; timedOut: boolean };
export type Graded = { commit: string; passed: boolean; runs: number[]; flaky: boolean; kind: "assertion" | "other" | null; tests: { pass: number; fail: number; skip: number }; sealed: number; suspect: boolean; feedback: string; log: string };

/**
 * A scratch worktree of `commit` (node_modules linked from the task's repository) under M1's
 * sandbox: `use` gets `run(script, env)`, which runs a bash script from outside the worktree.
 * Also used for the full tests of an M1 answer (review-gates.ts).
 */
export async function inScratch<T>(task: string, dir: string, commit: string, use: (s: { scratch: string; cfg: string; run: (script: string, env?: Record<string, string>) => Run }) => T): Promise<T> {
  const outer = mkdtempSync(join(scratchDir(), `${task}-`));
  const scratch = join(outer, "wt");
  const cfg = join(outer, "cfg");
  mkdirSync(cfg);
  try {
    git(["worktree", "add", "--detach", "-q", scratch, commit], dir);
    for (const d of ["hq", "eval"]) if (existsSync(join(dir, d, "node_modules")) && existsSync(join(scratch, d))) symlinkSync(join(dir, d, "node_modules"), join(scratch, d, "node_modules"));
    const { srtSettings } = await import(join(repo, "hq/src/sandbox.ts"));
    const settings = srtSettings({ writable: [scratch], commonDir: join(dir, ".git") });
    settings.filesystem.allowWrite = [scratch]; // not the shared temp directory
    settings.filesystem.denyRead = [...(settings.filesystem.denyRead ?? []), ...deniedReads(task, { exam: true, scratch: false })];
    const settingsFile = join(cfg, "srt.json");
    writeFileSync(settingsFile, JSON.stringify(settings));
    let n = 0;
    const run = (script: string, env: Record<string, string> = {}) => {
      const file = join(cfg, `run-${++n}.sh`);
      writeFileSync(file, script);
      return sh([SRT, "-s", settingsFile, "-c", `export TMPDIR="$PWD/.m1-tmp"; mkdir -p "$TMPDIR" && bash ${JSON.stringify(file)}`], scratch, env, RUN_TIMEOUT);
    };
    return use({ scratch, cfg, run });
  } finally {
    sh(["git", "worktree", "remove", "--force", scratch], dir);
    rmSync(outer, { recursive: true, force: true });
  }
}

export async function grade(task: string, dir: string, commit: string, expected?: number): Promise<Graded> {
  const exam = examDir(task);
  const files = hiddenFiles(task);
  if (!existsSync(join(exam, "run.sh")) || !files.length) throw new Error(`no exam for ${task}`);
  const count = expected ?? (existsSync(join(exam, "count")) ? Number(readFileSync(join(exam, "count"), "utf8")) : undefined);
  const sources = files.map((f) => readFileSync(join(exam, "files", f), "utf8"));
  const script = readFileSync(join(exam, "run.sh"), "utf8");
  return inScratch(task, dir, commit, ({ scratch, cfg, run }) => {
    cpSync(join(exam, "files"), scratch, { recursive: true });
    writeFileSync(join(cfg, "seal.ts"), SEAL);
    for (const d of ["", "hq", "eval"]) {
      if (!existsSync(join(scratch, d))) continue;
      if (existsSync(join(scratch, d, "bunfig.toml"))) throw new Error(`${join(d, "bunfig.toml")} exists: the grader's preload cannot be added`);
      writeFileSync(join(scratch, d, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(join(cfg, "seal.ts"))}]\n`);
    }
    const sealed = (out: string, secret: string) => [...out.matchAll(/^m1-seal (\S+) (\d+)$/gm)].filter((m) => m[1] === secret).reduce((a, m) => a + Number(m[2]), 0);
    const once = () => {
      const secret = crypto.randomUUID();
      const r = run(script, { M1_SEAL: secret });
      return { ...r, sealed: sealed(r.out, secret), out: r.out.replaceAll(secret, "<seal>") };
    };
    const ok = (r: Run & { sealed: number }) => {
      const s = summary(r.out);
      return r.code === 0 && s.fail === 0 && s.skip === 0 && s.pass > 0 && failing(r.out).length === 0 && r.sealed === s.pass && (count === undefined || s.pass === count);
    };
    const runs = [once()];
    if (!ok(runs[0]!)) runs.push(once());
    const passes = runs.map(ok);
    const flaky = new Set(passes).size > 1 || new Set(runs.map((r) => failing(r.out).join("\n"))).size > 1;
    const output = runs.map((r) => r.out).join("\n--- rerun ---\n");
    const log = join(runDir(task), `grade-${commit.slice(0, 12)}-${Date.now()}.log`);
    writeFileSync(log, output);
    const passed = passes.every(Boolean);
    const last = runs.at(-1)!;
    const lines = sourceLines(sources);
    // Code under test that prints the hidden tests (it can read them in the scratch worktree).
    const suspect = last.out.split("\n").some((l) => /^\s*(Received|Expected|[-+] )/.test(l) && lines.some((s) => unescaped(l).includes(s)));
    return {
      commit, passed, runs: runs.map((r) => r.code), flaky, kind: passed ? null : failureKind(last.out), tests: summary(last.out), sealed: last.sealed, suspect,
      feedback: passed ? "" : feedback(last.out, files, sources), log,
    };
  });
}
