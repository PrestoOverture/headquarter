// M1's minimal script (roadmap M1 实施计划), shared parts. Bootstrapped with plain Claude Code (D44).
//
// Each M1 task works in its own sanitized repository, ~/.hq-m1/repos/<task>: the task's starting
// tree as a single commit, so no session can reach M0's code through git history (D34, D37). The
// exam (D30) is ~/.hq-m1/exams/<task>/: files/ holds the hidden tests at the repository-relative
// paths they run from, run.sh runs them from the repository root, interfaces.md is the interface
// list, count is the number of hidden tests. Run state and logs go to ~/.hq-m1/runs/<task>/.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const repo = resolve(import.meta.dir, "../.."); // the real repository: M1 sessions may not read it
export const M1_HOME = process.env.HQ_M1_HOME ?? join(homedir(), ".hq-m1");
const dir = (kind: string, task: string) => {
  const d = join(M1_HOME, kind, task);
  mkdirSync(d, { recursive: true });
  return d;
};
export const repoDir = (task: string) => join(M1_HOME, "repos", task);
export const examDir = (task: string) => {
  const d = dir("exams", task);
  mkdirSync(join(d, "files"), { recursive: true });
  return d;
};
export const runDir = (task: string) => dir("runs", task);
/** The writers' throwaway clones; only the writer itself works there. */
export const writersDir = () => {
  const d = join(M1_HOME, "writers");
  mkdirSync(d, { recursive: true });
  return d;
};

export function hqHome(): string {
  return process.env.HQ_HOME ?? join(homedir(), ".hq");
}

/**
 * What no M1 session (interfaces, writer, answerer) may read: anything that shows M0's work or
 * another task's exam. The real repository and its goal worktrees, the installed hq and its
 * ledger, Claude's and Codex's own session records, this orchestrator's scratchpad, the M1 run
 * logs, and the other tasks' repositories and exams. `exam` adds every exam, the task's own too
 * (the answerer); without it the task's own exam stays readable (the writer).
 */
export function deniedReads(task: string, opts: { exam: boolean }): string[] {
  const home = homedir();
  const others = (kind: string) =>
    existsSync(join(M1_HOME, kind)) ? readdirSync(join(M1_HOME, kind)).filter((t) => t !== task).map((t) => join(M1_HOME, kind, t)) : [];
  return [
    repo, `${repo}.goals`, hqHome(), join(home, ".claude", "projects"), join(home, ".codex", "sessions"),
    "/private/tmp/claude-501", join(M1_HOME, "runs"), ...others("repos"),
    ...(opts.exam ? [join(M1_HOME, "exams"), join(M1_HOME, "writers")] : others("exams")),
  ];
}

export function sh(cmd: string[], cwd: string, env?: Record<string, string>) {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdin: "ignore" });
  return { code: p.exitCode ?? -1, out: p.stdout.toString() + p.stderr.toString() };
}

export function git(args: string[], cwd: string): string {
  const r = sh(["git", ...args], cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.out.trim()}`);
  return r.out.trim();
}

/** The environment for a nested session: none of this session's CLAUDE_CODE_* variables. */
export function claudeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE") env[k] = v;
  return env;
}

/** Runs `claude -p` with the prompt on stdin; returns the stream-json log and its result. */
export function claude(args: string[], prompt: string, cwd: string, timeoutMs = 60 * 60 * 1000) {
  const p = Bun.spawnSync(["claude", "-p", "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--strict-mcp-config", ...args], {
    cwd, env: claudeEnv(), stdin: Buffer.from(prompt), timeout: timeoutMs,
  });
  const log = p.stdout.toString();
  let result: any = null;
  for (const l of log.split("\n")) {
    try {
      const m = JSON.parse(l);
      if (m.type === "result") result = m;
    } catch {}
  }
  return { log, result, limited: /hit your (session )?limit/i.test(result?.result ?? "") };
}

// ---------- Bun test output ----------

const CRASH = /Cannot find module|Cannot find package|SyntaxError|is not a function|is not a constructor|is not defined|Export named .* not found|ReferenceError|Unexpected token|Could not resolve|timed out/;

/** Counts from every `bun test` summary in the output (a run.sh may call bun test more than once). */
export function summary(output: string): { pass: number; fail: number } {
  let pass = 0, fail = 0;
  for (const m of output.matchAll(/^\s*(\d+) pass\s*$/gm)) pass += Number(m[1]);
  for (const m of output.matchAll(/^\s*(\d+) fail\s*$/gm)) fail += Number(m[1]);
  return { pass, fail };
}

/**
 * Why a failing run failed: "assertion" only when every failing test failed on an assertion
 * (D7: not because an interface is missing or the code crashed, D34). Each failing test has
 * one `error:` line; every one of them must be an `expect(...)` assertion.
 */
export function failureKind(output: string): "assertion" | "other" {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const fails = (clean.match(/^\(fail\) /gm) ?? []).length;
  const errors = clean.match(/^error: .*$/gm) ?? [];
  const assertions = errors.filter((e) => /^error: expect\(/.test(e));
  if (!fails || CRASH.test(clean) || errors.length !== assertions.length || assertions.length < fails) return "other";
  return "assertion";
}

/**
 * What the answerer may see of a failing hidden-test run: the names of the failing tests and
 * the assertion messages, never the test code: source excerpts, stack frames, the exam's path and
 * the hidden test files' names are dropped.
 */
export function feedback(output: string, hiddenFiles: string[] = []): string {
  const names = hiddenFiles.map((f) => f.split("/").pop()!).filter(Boolean);
  const keep: string[] = [];
  for (const raw of output.split("\n")) {
    const l = raw.replace(/\x1b\[[0-9;]*m/g, "");
    if (/^\s*\d+\s*\|/.test(l) || /^\s*at\s/.test(l)) continue; // source excerpt, stack frame
    if (l.includes("/.hq-m1/") || names.some((n) => l.includes(n))) continue;
    if (/^\(fail\)|^error:|^\s*Expected|^\s*Received|^\s*[-+] /.test(l)) keep.push(l.trimEnd().slice(0, 400));
  }
  return keep.slice(0, 200).join("\n");
}
