// M1's minimal script (roadmap M1 实施计划), shared parts: the exam store, running a fresh
// Claude session, and reading Bun test output. Bootstrapped with plain Claude Code (D44).
//
// The exam (D30) is ~/.hq/exams/<repo>/<task>/: files/ holds the hidden test files at the
// repository-relative paths they run from, run.sh runs them from the repository root, and
// interfaces.md is the interface list (D34). Answerers can neither read nor write it.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const repo = resolve(import.meta.dir, "../..");
const hqSrc = join(repo, "hq/src");

export async function repoId(): Promise<string> {
  const { repoId } = await import(join(hqSrc, "approval.ts"));
  return repoId(repo);
}

export function hqHome(): string {
  return process.env.HQ_HOME ?? join(homedir(), ".hq");
}

export async function examDir(task: string): Promise<string> {
  const dir = join(hqHome(), "exams", await repoId(), task);
  mkdirSync(join(dir, "files"), { recursive: true });
  return dir;
}

export function sh(cmd: string[], cwd: string, env?: Record<string, string>) {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdin: "ignore" });
  return { code: p.exitCode ?? -1, out: p.stdout.toString() + p.stderr.toString() };
}

export function git(args: string[], cwd = repo): string {
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

const NOT_ASSERTION = /Cannot find module|Cannot find package|SyntaxError|is not a function|is not a constructor|is not defined|Export named .* not found|ReferenceError|Unexpected token|error: Could not resolve/;
const ASSERTION = /error: expect\(|AssertionError|Expected:|Expected to |Received:/;

/**
 * Why a failing run failed: "assertion" when every failure is an assertion (D7: tests must
 * fail on assertions, not because an interface is missing, D34), "other" otherwise.
 */
export function failureKind(output: string): "assertion" | "other" {
  if (NOT_ASSERTION.test(output)) return "other";
  return ASSERTION.test(output) ? "assertion" : "other";
}

/**
 * What the answerer may see of a failing hidden-test run: the names of the failing tests and
 * the assertion messages, never the test code (source excerpts, file paths and stack frames
 * are dropped).
 */
export function feedback(output: string): string {
  const keep: string[] = [];
  for (const raw of output.split("\n")) {
    const l = raw.replace(/\x1b\[[0-9;]*m/g, "");
    if (/^\s*\d+\s*\|/.test(l)) continue; // source excerpt
    if (/^\s*at\s/.test(l)) continue; // stack frame
    if (/\/(exams|\.hq)\//.test(l) || /\.test\.[jt]sx?:\d+/.test(l)) continue; // paths into the exam
    if (/^\(fail\)|^error:|^\s*Expected|^\s*Received|^\s*[-+] /.test(l)) keep.push(l.trimEnd());
  }
  return keep.slice(0, 200).join("\n");
}
