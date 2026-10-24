// Claude Code settings for M1's three sessions. All three get the executor sandbox (M0.0) and may
// not read anything that shows M0's work (common.ts deniedReads). The answerer may not read or
// write any exam and may not change the test configuration (D30); the writer may read and write
// its own exam; the interfaces session only reads.

import { join } from "node:path";
import { answererSettings } from "../m0/settings";
import { deniedReads, examDir } from "./common";

const TEST_CONFIG = [".hq.json", ".github", "goals", "bunfig.toml", "hq/package.json", "hq/bunfig.toml", "eval/package.json", "eval/bunfig.toml"];

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

