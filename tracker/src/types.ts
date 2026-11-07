// The tracker's model. A session is one agent's record (one file); a task is one work episode plus
// the child sessions started during it, across vendors. Times are epoch milliseconds.

export type Tokens = { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number };

/** How a session came to be: started by a person or a program (root), or spawned by another session. */
export type Role = "root" | "subagent" | "review" | "delegated";

export type Session = {
  /** Counts only: source records/rows, invalid JSON, handled records, assistant replies. */
  parse: { records: number; unparsed: number; recognized: number; replies: number };
  events: { at: number; humanPrompts?: number; interrupts?: number; waitMs?: number; usage?: number; input?: number; cached?: number; output?: number; tokens?: Tokens }[];
  vendor: string;
  id: string;
  file: string;
  cwd: string;
  start: number;
  end: number;
  /** Times of the session's records, ascending (for matching a commit to the session that was active). */
  times: number[];
  models: Record<string, number>; // model -> assistant turns
  /** Started by a program, not a person: `claude -p`, `codex exec`, a Claude-to-Codex MCP job. */
  headless: boolean;
  role: Role;
  parent?: string; // the spawning session's id, when the record says so
  agentRole?: string;
  costUSD?: number; // Claude: the process's own total (subagents included)
  tokens: Tokens;
  humanPrompts: number;
  interrupts: number;
  /** Time the agent sat finished before the person's next prompt, each gap capped at WAIT_CAP_MS. */
  waitMs: number;
  /** Short commit hashes from `git commit` output seen in the session's tool results. */
  commitShas: string[];
  /** Claude only: Codex thread ids from the Codex MCP's results (the delegated sessions). */
  codexThreads: string[];
  gitRemote?: string;
  gitBranch?: string;
};

export const WAIT_CAP_MS = 60 * 60_000;

/** A tool call whose command can make commits: git commit/merge/revert/cherry-pick, or hq merge. */
export const COMMITS = /\bgit\b[^\n]{0,200}?\b(commit|merge|revert|cherry-pick)\b|\bhq merge\b/;

/** `[branch abc1234] subject` (git commit, merge, revert, cherry-pick); the branch may contain spaces ("detached HEAD"). */
const COMMIT_LINE = /^\[(?:[^\]\n]*?) ([0-9a-f]{7,40})\] /gm;
/** `abc1234 subject`, as `git log --oneline -1` prints after a quiet commit. */
const ONELINE = /^([0-9a-f]{7,40}) \S/gm;

/**
 * Short hashes in the output of a command that made commits. Candidates only: the caller keeps
 * those that exist in the session's repository and were committed while the session was running,
 * which drops hashes from a `git log` of older history.
 */
export function commitShasIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(COMMIT_LINE)) out.push(m[1]!);
  for (const m of text.matchAll(ONELINE)) out.push(m[1]!);
  return out;
}

export function emptySession(vendor: string, id: string, file: string): Session {
  return {
    parse: { records: 0, unparsed: 0, recognized: 0, replies: 0 },
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    events: [], vendor, id, file, cwd: "", start: Infinity, end: -Infinity, times: [], models: {},
    headless: false, role: "root", humanPrompts: 0, interrupts: 0, waitMs: 0, commitShas: [], codexThreads: [],
  };
}

export function touch(s: Session, ts: unknown): number | null {
  const t = typeof ts === "string" ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return null;
  if (t < s.start) s.start = t;
  if (t > s.end) s.end = t;
  s.times.push(t);
  return t;
}

export function finish(s: Session): Session {
  s.times.sort((a, b) => a - b);
  s.commitShas = [...new Set(s.commitShas)];
  s.codexThreads = [...new Set(s.codexThreads)];
  return s;
}

/** The model with the most turns. */
export function primaryModel(models: Record<string, number>): string | undefined {
  return Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0];
}
