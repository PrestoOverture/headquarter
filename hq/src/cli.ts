#!/usr/bin/env bun
// hq — M0 tooling: merge lock (M0.1, D29), goal report (M0.2, D31), bookkeeping (M0.3).
//
//   hq goal new <name> [--title <text>] [--from <rev>]   start goal/<name> in a linked worktree <repo>.goals/<name>
//   hq status [--json]    every goal: head, ahead/behind main, report and approval state, open tasks
//   hq report <goal>      the five-column goal report for goal/<goal>'s current commit
//   hq approve <goal>     you, in a terminal: read the report, bind approval to that commit
//   hq merge <goal>       merge an approved goal into main after the full tests pass
//   hq install [<rev>]    install hq/ from main (or <rev>) as the version that runs (M0.4)
//   hq rollback           go back to the previously installed version
//   hq version            the installed current and previous versions
//   hq install-hook       install the main-ref guard into this repository's git hooks
//   hq guard              (called by the hook)
//
//   hq task start <task> --goal <goal> --title <text> [--difficulty easy|medium|hard] [--model <id>] [--base <commit>]
//   hq task gate <task> <self_test|full_tests|codex_review|claude_diff> <pass|fail> [--claimed-done] [--note <text>]
//   hq task cost <task> <usd> [--model <id>]
//   hq task lines <task> [--rev <rev>]
//   hq task shelve <task> --why <text>
//   hq task cause <task> <cheat|misunderstanding|other> [--note <text>]
//   hq task false-reject <task> <gate> [--note <text>]
//   hq escalate --goal <goal> --why <text> [--task <task>] [--minutes <n>]
//   hq escape <task> --note <text>
//   hq stats [--json | --tasks]

import { closeSync, openSync, readSync } from "node:fs";
import { parseArgs } from "node:util";
import { goalBranch, MAIN, validGoal, writeApproval } from "./approval";
import { git, revParse } from "./git";
import { newGoal } from "./goal";
import { guard, installHook } from "./guard";
import { append, CAUSES, DIFFICULTIES, GATES, readEvents } from "./ledger";
import { recordLines } from "./lines";
import { merge } from "./merge";
import { readReportMarkdown, readReportMeta, report } from "./report";
import { install, installed, launcherPath, rollback } from "./versions";
import { render, rows, stats } from "./stats";
import { render as renderStatus, status } from "./status";

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

/**
 * Shows the report, then asks. Active time (D39) is measured here, at the approval entry:
 * from showing you the report to your answer, so time the goal spent waiting for you
 * does not count.
 */
export function approve(cwd: string, goal: string): string {
  if (!validGoal(goal)) throw new Error(`bad goal name ${goal}: lowercase letters, digits and dashes`);
  const head = revParse(goalBranch(goal), cwd);
  if (!head) throw new Error(`no branch ${goalBranch(goal)}`);
  // D31: you read the report before you approve; the report must describe this commit.
  const r = readReportMeta(cwd, goal, head);
  if (!r) throw new Error(`no report for ${goalBranch(goal)} at ${head.slice(0, 12)}: run \`hq report ${goal}\` and read it first`);
  if (r.test_code !== 0) throw new Error(`the report for ${head.slice(0, 12)} shows failing tests (exit ${r.test_code}); fix them first`);
  console.error(readReportMarkdown(cwd, goal, head));
  const shown = Date.now();
  append(cwd, { type: "report.shown", goal, commit: head });
  const typed = readTerminalLine(`Approve ${goalBranch(goal)} at ${head.slice(0, 12)}? Type the goal name to approve: `);
  if (typed !== goal) throw new Error("not approved");
  writeApproval(cwd, { goal, branch: goalBranch(goal), commit: head, approved_at: new Date().toISOString() });
  append(cwd, { type: "approve", goal, commit: head, active_s: Math.round((Date.now() - shown) / 1000) });
  return head;
}

function oneOf<T extends string>(v: string | undefined, allowed: readonly T[], what: string): T {
  if (!v || !allowed.includes(v as T)) throw new Error(`${what} must be one of ${allowed.join(", ")}`);
  return v as T;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`missing ${what}`);
  return v;
}

/** `hq task …`, `hq escalate`, `hq escape`: the events hq does not witness itself. */
export function record(cwd: string, args: string[]): string {
  const { values: o, positionals: p } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      goal: { type: "string" }, title: { type: "string" }, difficulty: { type: "string", default: "medium" },
      model: { type: "string" }, base: { type: "string" }, "claimed-done": { type: "boolean", default: false },
      note: { type: "string" }, rev: { type: "string" }, why: { type: "string" }, task: { type: "string" }, minutes: { type: "string" },
    },
  });
  const [cmd, sub, ...rest] = p;
  if (cmd === "escalate") {
    const goal = need(o.goal, "--goal");
    const minutes = o.minutes === undefined ? undefined : Number(o.minutes);
    if (minutes !== undefined && !(minutes >= 0)) throw new Error("--minutes must be a number");
    append(cwd, { type: "escalate", goal, task: o.task, why: need(o.why, "--why"), minutes });
    return `escalation recorded for goal ${goal}`;
  }
  if (cmd === "escape") {
    append(cwd, { type: "escape", task: need(sub, "<task>"), note: need(o.note, "--note") });
    return `escape recorded for task ${sub}`;
  }
  if (cmd !== "task") throw new Error("unknown command");
  const task = need(rest[0], "<task>");
  if (sub !== "start" && !readEvents(cwd).some((e) => e.type === "task.start" && e.task === task)) throw new Error(`no task ${task}: hq task start it first`);
  switch (sub) {
    case "start": {
      const goal = need(o.goal, "--goal");
      if (!validGoal(goal)) throw new Error(`bad goal name ${goal}`);
      const base = o.base ?? revParse(goalBranch(goal), cwd) ?? revParse(MAIN, cwd);
      if (!base) throw new Error("no base commit: pass --base");
      append(cwd, {
        type: "task.start", task, goal, title: need(o.title, "--title"), base: git(["rev-parse", base], cwd),
        difficulty: oneOf(o.difficulty, DIFFICULTIES, "--difficulty"), model: need(o.model ?? process.env.HQ_MODEL, "--model"),
      });
      return `task ${task} started on goal ${goal}`;
    }
    case "gate":
      append(cwd, {
        type: "task.gate", task, gate: oneOf(rest[1], GATES, "gate"), result: oneOf(rest[2], ["pass", "fail"] as const, "result"),
        claimed_done: o["claimed-done"]!, note: o.note,
      });
      return `gate recorded for task ${task}`;
    case "cost": {
      const usd = Number(rest[1]);
      if (!(usd >= 0)) throw new Error("<usd> must be a number");
      append(cwd, { type: "task.cost", task, usd, model: o.model });
      return `cost recorded for task ${task}`;
    }
    case "lines": {
      const e = recordLines(cwd, task, o.rev);
      return `task ${task}: ${e.added + e.deleted} lines (+${e.added} -${e.deleted}) up to ${e.end.slice(0, 12)}`;
    }
    case "shelve":
      append(cwd, { type: "task.shelve", task, why: need(o.why, "--why") });
      return `task ${task} shelved`;
    case "cause":
      append(cwd, { type: "task.cause", task, cause: oneOf(rest[1], CAUSES, "cause"), note: o.note });
      return `failure cause recorded for task ${task}`;
    case "false-reject":
      append(cwd, { type: "task.false_reject", task, gate: oneOf(rest[1], GATES, "gate"), note: o.note });
      return `false reject recorded for task ${task}`;
  }
  throw new Error(`unknown task command ${sub}`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, goal] = argv;
  const cwd = process.cwd();
  try {
    if (cmd === "goal") {
      const usage = "usage: hq goal new <name> [--title <text>] [--from <rev>]";
      if (goal !== "new") throw new Error(usage);
      const { values: o, positionals: p } = parseArgs({ args: argv.slice(2), allowPositionals: true, options: { title: { type: "string" }, from: { type: "string" } } });
      if (p.length !== 1) throw new Error(usage);
      const r = newGoal(cwd, p[0]!, o);
      console.log(`worktree ${r.path}\nbranch ${r.branch}`);
      return 0;
    }
    if (cmd === "status") {
      const { values: o } = parseArgs({ args: argv.slice(1), options: { json: { type: "boolean" } } });
      const goals = status(cwd);
      console.log(o.json ? JSON.stringify({ goals }, null, 2) : renderStatus(goals));
      return 0;
    }
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
      for (const err of r.linesErrors) console.error(`could not measure task size: ${err}`);
      if (r.reinstalled) console.log(`hq changed: installed ${r.reinstalled.slice(0, 12)} (hq rollback to undo)`);
      if (r.reinstallError) console.error(`hq changed but reinstalling failed; still running ${installed("current")}: ${r.reinstallError}`);
      return 0;
    }
    if (cmd === "install") {
      const c = install(cwd, goal);
      console.log(`installed hq ${c.slice(0, 12)} at ${launcherPath()}; previous: ${installed("previous") ?? "none"}`);
      return 0;
    }
    if (cmd === "rollback") {
      console.log(`rolled back to hq ${rollback()}`);
      return 0;
    }
    if (cmd === "version") {
      console.log(`current: ${installed("current") ?? "none"}\nprevious: ${installed("previous") ?? "none"}\nrunning: ${import.meta.path}`);
      return 0;
    }
    if (cmd === "install-hook") {
      console.log(`installed ${installHook(cwd, launcherPath())}`);
      return 0;
    }
    if (cmd === "guard") return await guard(cwd);
    if (cmd === "stats") {
      const events = readEvents(cwd);
      if (argv.includes("--tasks")) for (const r of rows(events)) console.log(JSON.stringify(r));
      else if (argv.includes("--json")) console.log(JSON.stringify(stats(events), null, 2));
      else console.log(render(stats(events)));
      return 0;
    }
    if (cmd === "task" || cmd === "escalate" || cmd === "escape") {
      console.log(record(cwd, argv));
      return 0;
    }
  } catch (e) {
    console.error(`hq: ${(e as Error).message}`);
    return 1;
  }
  console.error("usage: hq goal new <name> | hq status [--json] | hq report|approve|merge <goal> | hq install [<rev>] | hq rollback | hq version | hq install-hook | hq task … | hq escalate … | hq escape … | hq stats (see src/cli.ts)");
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
