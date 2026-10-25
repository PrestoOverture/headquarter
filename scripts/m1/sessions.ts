// Claude Code settings for M1's three sessions. All three get the executor sandbox (M0.0) and may
// not read anything that shows M0's work (common.ts deniedReads). The answerer may not read or
// write any exam and may not change the test configuration (D30); the writer may read and write
// its own exam; the interfaces session only reads.

import { join } from "node:path";
import { answererSettings } from "../m0/settings";
import { deniedReads, examDir, git } from "./common";

// What decides how an answer is tested. Not .github: M1 grades with the exam's run.sh and runs
// the full tests from the starting point's .hq.json, so CI workflows decide nothing here, and
// tasks t07, t08 and t13 have to change one (as M0's answers did).
export const TEST_CONFIG = [".hq.json", "goals", "bunfig.toml", "hq/package.json", "hq/bunfig.toml", "eval/package.json", "eval/bunfig.toml"];

/** Test configuration committed between two commits: the sandbox guards the working tree, not git plumbing (D30). */
export function configTouched(dir: string, from: string, to: string): string[] {
  return git(["diff", "--name-only", "--no-renames", `${from}..${to}`], dir).split("\n").filter((f) => f && TEST_CONFIG.some((c) => f === c || f.startsWith(`${c}/`)));
}

export function answererOf(task: string, cwd: string) {
  return answererSettings(join(cwd, ".git"), process.env.HOME!, deniedReads(task, { exam: true }), TEST_CONFIG.map((p) => join(cwd, p)));
}

export function writerOf(task: string, cwd: string) {
  const s = answererSettings(join(cwd, ".git"), process.env.HOME!, deniedReads(task, { exam: false }), []);
  return { ...s, sandbox: { ...s.sandbox, filesystem: { ...s.sandbox.filesystem, allowWrite: [examDir(task)] } } };
}

export function readerOf(task: string, cwd: string) {
  return answererSettings(join(cwd, ".git"), process.env.HOME!, deniedReads(task, { exam: true }), []);
}

