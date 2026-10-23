// A task's size (the 200-line rule): lines added plus lines deleted between the task's
// recorded base commit and an end commit. Text files only; goal files and lockfiles do not
// count, since neither is code the reviewer has to read.

import { basename } from "node:path";
import { goalBranch } from "./approval";
import { git, revParse } from "./git";
import { append, type Event, readEvents } from "./ledger";

export const LINE_LIMIT = 200;
const LOCKFILES = new Set(["bun.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "go.sum"]);

export function countsForSize(path: string): boolean {
  return !/^goals\/[^/]+\.json$/.test(path) && !LOCKFILES.has(basename(path));
}

export function diffSize(cwd: string, base: string, end: string): { added: number; deleted: number } {
  // -z: paths come unquoted. Binary files show "-" for both counts and are skipped.
  const out = git(["diff", "--numstat", "-z", "--no-renames", base, end, "--"], cwd);
  let added = 0;
  let deleted = 0;
  for (const rec of out.split("\0").filter(Boolean)) {
    const [a, d, ...path] = rec.split("\t");
    if (a === "-" || d === "-" || !countsForSize(path.join("\t"))) continue;
    added += Number(a);
    deleted += Number(d);
  }
  return { added, deleted };
}

/** Measures `task` from its recorded base to `rev` (default: the head of its goal branch) and appends the `task.lines` event. */
export function recordLines(cwd: string, task: string, rev?: string): Extract<Event, { type: "task.lines" }> {
  const start = readEvents(cwd).filter((e) => e.type === "task.start" && e.task === task).at(-1);
  if (start?.type !== "task.start") throw new Error(`no task ${task}: hq task start it first`);
  const spec = rev ?? goalBranch(start.goal);
  const end = revParse(spec, cwd);
  if (!end) throw new Error(`${spec} is not a commit`);
  return append(cwd, { type: "task.lines", task, ...diffSize(cwd, start.base, end), end }) as Extract<Event, { type: "task.lines" }>;
}
