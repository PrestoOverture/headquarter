// `hq status`: where every goal stands. Read-only: it reads refs, goal files, the report and
// approval stores and the ledger, and writes nothing.

import { goalBranch, MAIN, readApproval } from "./approval";
import { git, revParse, run, worktreeOf } from "./git";
import { type Event, GATES, type Gate, readEvents } from "./ledger";
import { readReportMeta, readReportMetas } from "./report";
import { rows } from "./stats";

export type ReportState = "none" | "green" | "red" | "stale";
export type ApprovalState = "none" | "approved" | "void";
export type OpenTask = { task: string; title: string; started_at: string; gates: Record<Gate, "pass" | "fail" | null> };
export type GoalStatus = {
  goal: string;
  title: string;
  branch: string;
  commit: string;
  subject: string;
  ahead: number | null;
  behind: number | null;
  worktree: string | null;
  report: ReportState;
  approval: ApprovalState;
  open_tasks: OpenTask[];
};

const PREFIX = "refs/heads/goal/";

function goalTitle(cwd: string, head: string, goal: string): string {
  const r = run(["git", "show", `${head}:goals/${goal}.json`], cwd);
  if (r.code !== 0) return goal;
  try {
    const title = JSON.parse(r.out).title;
    return typeof title === "string" && title ? title : goal;
  } catch {
    return goal;
  }
}

function reportState(cwd: string, goal: string, head: string): ReportState {
  const meta = readReportMeta(cwd, goal, head);
  if (meta) return meta.test_code === 0 ? "green" : "red";
  return readReportMetas(cwd, goal).length ? "stale" : "none";
}

function approvalState(cwd: string, goal: string, head: string): ApprovalState {
  const a = readApproval(cwd, goal);
  if (!a) return "none";
  return a.commit === head ? "approved" : "void";
}

/** Open tasks of `goal` with the latest result of each gate. */
function openTasks(events: Event[], goal: string): OpenTask[] {
  return rows(events)
    .filter((r) => r.goal === goal && r.status === "open")
    .map((r) => {
      const gates = Object.fromEntries(GATES.map((g) => [g, null])) as OpenTask["gates"];
      for (const e of events) if (e.type === "task.gate" && e.task === r.task) gates[e.gate] = e.result;
      return { task: r.task, title: r.title, started_at: r.started_at, gates };
    });
}

export function status(cwd: string): GoalStatus[] {
  const events = readEvents(cwd);
  const main = revParse(MAIN, cwd);
  const refs = git(["for-each-ref", "--format=%(refname)%09%(objectname)%09%(contents:subject)", PREFIX], cwd);
  return refs
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, head, ...subject] = line.split("\t");
      const goal = ref!.slice(PREFIX.length);
      let ahead: number | null = null;
      let behind: number | null = null;
      if (main) [behind, ahead] = git(["rev-list", "--left-right", "--count", `${main}...${head}`], cwd).split(/\s+/).map(Number) as [number, number];
      return {
        goal, title: goalTitle(cwd, head!, goal), branch: goalBranch(goal), commit: head!, subject: subject.join("\t"), ahead, behind,
        worktree: worktreeOf(goalBranch(goal), cwd), report: reportState(cwd, goal, head!), approval: approvalState(cwd, goal, head!),
        open_tasks: openTasks(events, goal),
      };
    });
}

export function render(goals: GoalStatus[]): string {
  if (!goals.length) return "no goals: no goal/<name> branches in this repository";
  return goals
    .map((g) => {
      const vs = g.ahead === null ? `no ${MAIN} to compare with` : `${g.ahead} ahead, ${g.behind} behind ${MAIN}`;
      const tasks = g.open_tasks.length
        ? g.open_tasks.map((t) => `    ${t.task}  ${t.title}  [${GATES.map((x) => `${x} ${t.gates[x] ?? "-"}`).join(", ")}]`)
        : ["    none"];
      return [
        `${g.goal}: ${g.title}`,
        `  ${g.branch}  ${g.commit.slice(0, 12)} ${g.subject}`,
        `  ${vs}${g.worktree ? `; worktree ${g.worktree}` : ""}`,
        `  report: ${g.report}; approval: ${g.approval}`,
        "  open tasks:",
        ...tasks,
      ].join("\n");
    })
    .join("\n\n");
}
