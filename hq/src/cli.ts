#!/usr/bin/env bun
// hq — M0 merge lock (roadmap M0.1, D29).
//
//   hq report <goal>      the five-column goal report (D31) for goal/<goal>'s current commit
//   hq approve <goal>     you, in a terminal: bind approval to goal/<goal>'s current commit
//   hq merge <goal>       merge an approved goal into main after the full tests pass
//   hq install-hook       install the main-ref guard into this repository's git hooks
//   hq guard              (called by the hook)

import { closeSync, openSync, readSync } from "node:fs";
import { goalBranch, MAIN, validGoal, writeApproval } from "./approval";
import { git, revParse } from "./git";
import { guard, installHook } from "./guard";
import { merge } from "./merge";
import { readReportMeta, report } from "./report";

/** One line typed on the controlling terminal. An agent's shell has none, so it cannot answer. */
export function readTerminalLine(prompt: string): string {
  const tty = process.env.HQ_TTY ?? "/dev/tty"; // HQ_TTY: tests only
  let fd: number;
  try {
    fd = openSync(tty, "r");
  } catch {
    throw new Error("hq approve needs a terminal you type in");
  }
  process.stderr.write(prompt);
  const buf = Buffer.alloc(1);
  let line = "";
  try {
    while (readSync(fd, buf, 0, 1, null) === 1 && buf[0] !== 10) line += String.fromCharCode(buf[0]!);
  } finally {
    closeSync(fd);
  }
  return line.trim();
}

export function approve(cwd: string, goal: string): string {
  if (!validGoal(goal)) throw new Error(`bad goal name ${goal}: lowercase letters, digits and dashes`);
  const head = revParse(goalBranch(goal), cwd);
  if (!head) throw new Error(`no branch ${goalBranch(goal)}`);
  // D31: you read the report before you approve; the report must describe this commit.
  const r = readReportMeta(cwd, goal, head);
  if (!r) throw new Error(`no report for ${goalBranch(goal)} at ${head.slice(0, 12)}: run \`hq report ${goal}\` and read it first`);
  if (r.test_code !== 0) throw new Error(`the report for ${head.slice(0, 12)} shows failing tests (exit ${r.test_code}); fix them first`);
  console.error(git(["log", "--oneline", `${MAIN}..${head}`], cwd) || "(no commits ahead of main)");
  console.error(git(["diff", "--stat", `${MAIN}...${head}`], cwd));
  const typed = readTerminalLine(`Approve ${goalBranch(goal)} at ${head.slice(0, 12)}? Type the goal name to approve: `);
  if (typed !== goal) throw new Error("not approved");
  writeApproval(cwd, { goal, branch: goalBranch(goal), commit: head, approved_at: new Date().toISOString() });
  return head;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, goal] = argv;
  const cwd = process.cwd();
  try {
    if (cmd === "report" && goal) {
      const r = report(cwd, goal);
      console.log(r.markdown);
      console.error(`report saved to ${r.path}`);
      return r.meta.test_code === 0 ? 0 : 1;
    }
    if (cmd === "approve" && goal) {
      const head = approve(cwd, goal);
      console.log(`approved ${goalBranch(goal)} at ${head.slice(0, 12)}; a new commit voids it`);
      return 0;
    }
    if (cmd === "merge" && goal) {
      const r = merge(cwd, goal);
      if (r.testOutput) console.log(r.testOutput.trimEnd());
      if (!r.ok) {
        console.error(`not merged: ${r.reason}`);
        return 1;
      }
      console.log(`merged goal ${goal} into ${MAIN} as ${r.mergeCommit.slice(0, 12)}\nto take it back out: ${r.revert}`);
      return 0;
    }
    if (cmd === "install-hook") {
      console.log(`installed ${installHook(cwd, process.execPath, import.meta.path)}`);
      return 0;
    }
    if (cmd === "guard") return await guard(cwd);
  } catch (e) {
    console.error(`hq: ${(e as Error).message}`);
    return 1;
  }
  console.error("usage: hq report <goal> | hq approve <goal> | hq merge <goal> | hq install-hook");
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
