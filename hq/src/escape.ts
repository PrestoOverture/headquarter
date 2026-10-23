// Escape candidates: tasks of goals merged into main in the last 14 days that a later goal's
// fix touches again. Only suggestions: nothing is recorded (that is `hq escape`, by you), so a
// wrong guess costs a line of output, not a number in the stats.

import { git, revParse } from "./git";
import { type Event, readEvents } from "./ledger";
import { ESCAPE_WINDOW_DAYS, rows } from "./stats";

const DAY_MS = 86_400_000;
const FIX_WORDS = /fix|bug|regression|revert/i;

type MergeEvent = Extract<Event, { type: "merge" }>;
export type Candidate = {
  goal: string; // the earlier goal, whose tasks may have escaped
  merge_commit: string;
  merged_at: string;
  tasks: string[]; // its merged tasks with no escape recorded
  fixed_by: string; // the later goal
  commits: { commit: string; subject: string; reverts: boolean; files: string[] }[];
};

const NUL = "\0";

/** The non-merge commits of `from..to` with their subject, full message and changed files. */
function commitsOf(cwd: string, from: string, to: string) {
  const out = git(["log", "--no-merges", "-z", "--format=%H%x1f%s%x1f%B", `${from}..${to}`], cwd);
  return out
    .split(NUL)
    .filter(Boolean)
    .map((rec) => {
      const [commit, subject, message] = rec.split("\x1f") as [string, string, string];
      const files = git(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", commit], cwd).split(NUL).filter(Boolean);
      return { commit, subject, message, files };
    });
}

function changedFiles(cwd: string, merge: string): Set<string> {
  return new Set(git(["diff", "--name-only", "-z", "--no-renames", `${merge}^1`, merge], cwd).split(NUL).filter(Boolean));
}

/**
 * For each goal merged in the window, the earlier goals merged in the window whose files its
 * commits fix or revert. `only` limits the later goals to one merge commit (what hq merge shows).
 */
export function escapeCandidates(cwd: string, now = new Date(), only?: string): Candidate[] {
  const events = readEvents(cwd);
  const since = now.getTime() - ESCAPE_WINDOW_DAYS * DAY_MS;
  const merges = events.filter((e): e is MergeEvent => e.type === "merge" && Date.parse(e.at) >= since && !!revParse(e.merge_commit, cwd));
  const taskRows = rows(events, now);
  const out: Candidate[] = [];
  merges.forEach((later, i) => {
    if (only && later.merge_commit !== only) return;
    const from = revParse(`${later.merge_commit}^1`, cwd);
    const to = revParse(`${later.merge_commit}^2`, cwd);
    if (!from || !to) return;
    const commits = commitsOf(cwd, from, to);
    for (const earlier of merges.slice(0, i)) {
      if (earlier.goal === later.goal) continue;
      const tasks = taskRows.filter((r) => r.goal === earlier.goal && r.merged_at === earlier.at && !r.escaped).map((r) => r.task);
      if (!tasks.length) continue;
      const files = changedFiles(cwd, earlier.merge_commit);
      const hits = commits
        .map((c) => ({ commit: c.commit, subject: c.subject, reverts: c.message.includes(earlier.merge_commit), files: c.files.filter((f) => files.has(f)) }))
        .filter((c) => c.reverts || (FIX_WORDS.test(c.subject) && c.files.length));
      if (hits.length) out.push({ goal: earlier.goal, merge_commit: earlier.merge_commit, merged_at: earlier.at, tasks, fixed_by: later.goal, commits: hits });
    }
  });
  return out;
}

export function render(candidates: Candidate[]): string {
  const lines = ["escape candidates (a later fix touches these goals; nothing is recorded):"];
  for (const c of candidates) {
    lines.push(`  goal ${c.goal} (merged ${c.merged_at.slice(0, 10)}), touched again by goal ${c.fixed_by}:`);
    for (const k of c.commits) lines.push(`    ${k.commit.slice(0, 12)} ${k.subject}${k.reverts ? " [reverts the merge]" : ""}${k.files.length ? ` — ${k.files.join(", ")}` : ""}`);
    for (const t of c.tasks) lines.push(`    hq escape ${t} --note "..."`);
  }
  return lines.join("\n");
}
