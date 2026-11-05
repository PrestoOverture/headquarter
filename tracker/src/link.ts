// Link commits to sessions first, then split root sessions into work episodes and attach
// descendants to the episode in which their parent spawned them. Judge commits per episode.

import { type Commit, LOCKFILES, originEvidence, sameLanding, type ReworkLine, type Repo, type Repos } from "./git";
import { splitEpisodes } from "./episodes";
import { primaryModel, type Session } from "./types";

const MIN = 60_000;
const DAY = 86_400_000;
export const REWORK_WINDOW_MS = 14 * DAY;
/** Slack around a session's span for a commit its own output names (clock skew, a commit right after the last record). */
const EXACT_SLACK_MS = 10 * MIN;
/** How close a commit must be to one of a session's records to be guessed as that session's. */
const NEAR_MS = 10 * MIN;
const FIX_WORDS = /\b(bug|bugs|regression|revert|hotfix)\b|修复|修正|回滚/i;
const FIX_START = /^(?:[^:]{1,60}: )?fix(?:es|ed)?\b/i;
const STYLE_WORDS = /\b(lint|biome|eslint|prettier|format|formatting)\b/i;

export function isFixSubject(subject: string): boolean {
  return !STYLE_WORDS.test(subject) && (FIX_WORDS.test(subject) || FIX_START.test(subject));
}
const DOC_PATH = /(^|\/)docs\/|\.(md|mdx|rst|txt)$/;
const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.|_test\.|(^|\/)test_[^/]*\.py$/;
const UI_PATH = /(^|\/)(ui|components|pages|views|screens|styles|frontend)\/|\.(tsx|jsx|vue|svelte|css|scss|html)$/;

type Classification = { kind: "文档" | "测试" | "界面" | "代码" | "–"; size: "<100" | "100–300" | "300–1k" | "≥1k" | "–" };

/** Classify counted lines from landed commits, falling back to all commits. */
export function classifyTask(commits: readonly Pick<Commit, "mainline" | "fileLines">[]): Classification {
  if (!commits.length) return { kind: "–", size: "–" };
  const landed = commits.filter(c => c.mainline);
  let total = 0, docs = 0, tests = 0, ui = 0;
  for (const c of landed.length ? landed : commits) for (const [path, lines] of Object.entries(c.fileLines)) {
    if (LOCKFILES.test(path)) continue;
    total += lines;
    if (DOC_PATH.test(path)) docs += lines;
    else if (TEST_PATH.test(path)) tests += lines;
    else if (UI_PATH.test(path)) ui += lines;
  }
  const product = total - docs - tests;
  return {
    kind: total === 0 ? "代码"
      : docs / total >= 0.6 ? "文档"
      : tests / total >= 0.8 ? "测试"
      : product === 0 ? (docs > tests ? "文档" : "测试")
      : ui / product >= 0.4 ? "界面" : "代码",
    size: total < 100 ? "<100" : total < 300 ? "100–300" : total < 1000 ? "300–1k" : "≥1k",
  };
}

export type ChildKind = "claude-sub" | "codex" | "codex-sub" | "codex-review";

export type TaskCommit = {
  sha: string;
  at: number;
  subject: string;
  added: number;
  deleted: number;
  mainline: boolean;
  fileLines: Record<string, number>;
  /** exact: the session's own `git commit` output names it; time: guessed from repository and time. */
  how: "exact" | "time";
  revertedBy?: string;
  reworkedBy: string[];
  reworkEvidence: { sha: string; subject: string; days: number; lines: ReworkLine[] }[];
  mature: boolean; // the rework window has passed
};

export type Task = Classification & {
  id: string;
  vendor: Session["vendor"];
  combo: string;
  headless: boolean;
  repo?: string;
  repoKey?: string;
  cwd: string;
  start: number;
  end: number;
  model?: string;
  models: string[];
  kinds: ChildKind[];
  sessions: number;
  costUSD: number; // Claude sessions (cost-state); Codex records carry no prices
  codexTokens: number; // uncached input + output
  humanPrompts: number;
  interrupts: number;
  waitMs: number;
  commits: TaskCommit[];
  landed: boolean;
  reverted: boolean;
  reworked: boolean;
  mature: boolean;
  ci?: "pass" | "fail";
};

function kindOf(s: Session): ChildKind {
  if (s.vendor === "claude") return "claude-sub";
  if (s.role === "review") return "codex-review";
  if (s.role === "delegated") return "codex";
  return "codex-sub";
}

export function comboLabel(root: Session, kinds: Set<ChildKind>): string {
  let name: string = root.vendor;
  if (root.role === "delegated") name = "codex (via MCP, caller unknown)";
  else if (root.role !== "root") name = `${root.vendor} ${root.role} (parent unknown)`;
  if (root.headless && root.role === "root") name += " (headless)";
  return kinds.size ? `${name} → ${[...kinds].sort().join(" + ")}` : `${name} solo`;
}

/** Index of the last element <= t, or -1. */
function floorIndex(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Distance from `t` to the session's nearest record. */
function distance(s: Session, t: number): number {
  const i = floorIndex(s.times, t);
  let d = Infinity;
  if (i >= 0) d = t - s.times[i]!;
  if (i + 1 < s.times.length) d = Math.min(d, s.times[i + 1]! - t);
  return d;
}

export function buildTasks(sessions: Session[], repos: Repos, now = Date.now()): Task[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  // Claude's Codex MCP results name the Codex thread: that is the delegated session's parent.
  for (const s of sessions) {
    for (const thread of s.codexThreads) {
      const child = byId.get(thread);
      if (child && !child.parent) child.parent = s.id;
    }
  }
  const children = new Map<string, Session[]>();
  const roots: Session[] = [];
  for (const s of sessions) {
    if (s.parent && byId.has(s.parent) && s.parent !== s.id) {
      const list = children.get(s.parent) ?? [];
      list.push(s);
      children.set(s.parent, list);
    } else roots.push(s);
  }

  const tasks: Task[] = [];
  const members = new Map<Task, Session[]>();
  for (const root of roots) {
    const tree: Session[] = [];
    const seen = new Set<string>();
    const stack = [root];
    while (stack.length) {
      const s = stack.pop()!;
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      tree.push(s);
      stack.push(...(children.get(s.id) ?? []));
    }
    const kinds = new Set(tree.filter((s) => s !== root).map(kindOf));
    const repo = repos.of(root.cwd) ?? tree.map((s) => repos.of(s.cwd)).find(Boolean) ?? null;
    const models: Record<string, number> = {};
    for (const s of tree) for (const [m, n] of Object.entries(s.models)) models[m] = (models[m] ?? 0) + n;
    const task: Task = {
      id: root.id,
      vendor: root.vendor,
      combo: comboLabel(root, kinds),
      headless: root.headless,
      repo: repo?.name,
      repoKey: repo?.key,
      cwd: root.cwd,
      start: Math.min(...tree.map((s) => s.start)),
      end: Math.max(...tree.map((s) => s.end)),
      model: primaryModel(root.models) ?? primaryModel(models),
      models: Object.keys(models),
      kinds: [...kinds].sort(),
      sessions: tree.length,
      costUSD: tree.reduce((n, s) => n + (s.costUSD ?? 0), 0),
      codexTokens: tree.reduce((n, s) => n + (s.tokens ? Math.max(0, s.tokens.input - s.tokens.cached) + s.tokens.output : 0), 0),
      humanPrompts: tree.reduce((n, s) => n + s.humanPrompts, 0),
      interrupts: tree.reduce((n, s) => n + s.interrupts, 0),
      waitMs: tree.reduce((n, s) => n + s.waitMs, 0),
      kind: "–", size: "–",
      commits: [],
      landed: false,
      reverted: false,
      reworked: false,
      mature: false,
    };
    tasks.push(task);
    members.set(task, tree);
  }

  const commitSessions = new Map<string, Session>();
  attributeCommits(tasks, members, repos, commitSessions);
  const episodes: Task[] = [];
  for (const task of tasks) {
    const tree = members.get(task)!;
    const root = tree[0]!;
    const directChild = (s: Session): Session => {
      const seen = new Set<string>();
      while (s.parent && s.parent !== root.id && !seen.has(s.id)) {
        seen.add(s.id);
        const parent = byId.get(s.parent);
        if (!parent) break;
        s = parent;
      }
      return s;
    };
    const slices = splitEpisodes(root, task.commits.map(c => {
      const session = commitSessions.get(c.sha)!;
      return { at: c.at, sessionStart: session === root ? undefined : directChild(session).start };
    }));
    const indexAt = (at: number) => Math.max(0, slices.filter(s => s.start <= at).length - 1);
    // Descendants stay with the episode their direct ancestor joined, even when they run longer.
    const episodeOf = new Map<string, number>([[root.id, 0]]);
    const assign = (s: Session): number => {
      if (episodeOf.has(s.id)) return episodeOf.get(s.id)!;
      const parent = byId.get(s.parent ?? '');
      const i = !parent || parent === root ? indexAt(s.start) : assign(parent);
      episodeOf.set(s.id, i);
      return i;
    };
    for (const child of tree.slice(1)) assign(child);
    slices.forEach((slice, i) => {
      const children = tree.slice(1).filter(s => episodeOf.get(s.id) === i);
      const group = [slice, ...children];
      const kinds = new Set(children.map(kindOf));
      const commits = task.commits.filter(c => {
        const session = commitSessions.get(c.sha)!;
        return session === root
          ? indexAt(c.at) === i
          : episodeOf.get(session.id) === i;
      });
      const models: Record<string, number> = {};
      for (const s of group) for (const [m,n] of Object.entries(s.models)) models[m] = (models[m] ?? 0) + n;
      const episode: Task = { ...task, id: slice.id, start: slice.start, end: Math.max(slice.end, ...children.map(s => s.end)),
        combo: comboLabel(root, kinds), kinds: [...kinds].sort(), sessions: group.length, models: Object.keys(models),
        costUSD: group.reduce((n,s) => n+(s.costUSD ?? 0),0),
        codexTokens: group.reduce((n,s) => n+(s.tokens ? Math.max(0,s.tokens.input-s.tokens.cached)+s.tokens.output : 0),0),
        humanPrompts: group.reduce((n,s) => n+s.humanPrompts,0),
        interrupts: group.reduce((n,s) => n+s.interrupts,0), waitMs: group.reduce((n,s) => n+s.waitMs,0), commits,
      };
      Object.assign(episode, classifyTask(episode.commits));
      judge(episode, repos, now);
      episodes.push(episode);
    });
  }
  const episodeCommits = episodes.flatMap(t => t.commits);
  if (episodeCommits.length !== commitSessions.size || new Set(episodeCommits.map(c => c.sha)).size !== commitSessions.size) {
    throw new Error("Episode split must preserve every linked commit exactly once");
  }
  return episodes.sort((a, b) => a.start - b.start);
}

function attributeCommits(tasks: Task[], members: Map<Task, Session[]>, repos: Repos, commitSessions: Map<string, Session>) {
  const owner = new Map<string, { task: Task; how: "exact" | "time" }>(); // full sha -> task
  const repoOfSha = new Map<string, Repo>();

  // 1. Exact: the session's own commit output names the commit, and it was made while the session ran.
  for (const task of tasks) {
    for (const s of members.get(task)!) {
      for (const short of s.commitShas) {
        const own = repos.of(s.cwd) ?? (task.repoKey ? repos.all().find((r) => r.key === task.repoKey) : undefined);
        const candidates = own ? [own, ...repos.all().filter((r) => r !== own)] : repos.all();
        for (const repo of candidates) {
          const c = repo.byPrefix(short);
          if (!c || c.at < s.start - EXACT_SLACK_MS || c.at > s.end + EXACT_SLACK_MS) continue;
          if (!owner.has(c.sha)) {
            owner.set(c.sha, { task, how: "exact" });
            commitSessions.set(c.sha, s);
            repoOfSha.set(c.sha, repo);
          }
          break;
        }
      }
    }
  }

  // 2. By time: a commit in a task's repository made close to one of its sessions' records.
  const byRepo = new Map<string, { task: Task; s: Session }[]>();
  for (const task of tasks) {
    for (const s of members.get(task)!) {
      const repo = repos.of(s.cwd);
      if (!repo) continue;
      const list = byRepo.get(repo.key) ?? [];
      list.push({ task, s });
      byRepo.set(repo.key, list);
    }
  }
  const earliest = Math.min(...tasks.map((t) => t.start));
  for (const repo of repos.all()) {
    const cands = byRepo.get(repo.key) ?? [];
    if (!cands.length) continue;
    for (const c of repo.commits.values()) {
      if (owner.has(c.sha) || c.at < earliest) continue;
      let best: { task: Task; s: Session; d: number } | null = null;
      for (const { task, s } of cands) {
        if (c.at < s.start - NEAR_MS || c.at > s.end + NEAR_MS) continue;
        const d = distance(s, c.at);
        if (d <= NEAR_MS && (!best || d < best.d)) best = { task, s, d };
      }
      if (best) {
        owner.set(c.sha, { task: best.task, how: "time" });
        commitSessions.set(c.sha, best.s);
        repoOfSha.set(c.sha, repo);
      }
    }
  }

  for (const [sha, { task, how }] of owner) {
    const c = repoOfSha.get(sha)!.commits.get(sha)!;
    task.commits.push({
      sha, at: c.at, subject: c.subject, added: c.added, deleted: c.deleted, mainline: c.mainline, fileLines: c.fileLines, how,
      reworkedBy: [], reworkEvidence: [], mature: false,
    });
  }
  for (const t of tasks) t.commits.sort((a, b) => a.at - b.at);
}

const sortedMainline = new WeakMap<Repo, Commit[]>();
function mainlineByTime(repo: Repo): Commit[] {
  let list = sortedMainline.get(repo);
  if (!list) {
    list = [...repo.commits.values()].filter((c) => c.mainline).sort((a, b) => a.at - b.at);
    sortedMainline.set(repo, list);
  }
  return list;
}

/** Landed, reverted or reworked within the window, for one task's commits. */
function judge(task: Task, repos: Repos, now: number) {
  if (!task.commits.length) return;
  const repo = repos.all().find((r) => task.commits.every((tc) => r.commits.has(tc.sha))) ??
    repos.all().find((r) => r.commits.has(task.commits[0]!.sha));
  if (!repo) return;
  const own = new Set(task.commits.map(c => c.sha));
  const later = mainlineByTime(repo);
  for (const tc of task.commits) {
    tc.mature = now - tc.at >= REWORK_WINDOW_MS;
    if (!tc.mainline) continue;
    const c = repo.commits.get(tc.sha)!;
    const files = new Set(c.files.filter((f) => !LOCKFILES.test(f)));
    for (const d of later) {
      if (d.at <= c.at || own.has(d.sha)) continue;
      if (d.at - c.at > REWORK_WINDOW_MS) break;
      if (d.body.includes(`This reverts commit ${c.sha}`)) {
        tc.revertedBy = d.sha;
        tc.reworkedBy.push(d.sha);
        tc.reworkEvidence.push({ sha: d.sha, subject: d.subject, days: (d.at - c.at) / DAY, lines: [] });
        continue;
      }
      if (d.parents.length > 1 || !isFixSubject(d.subject)) continue;
      // a fix counts only if it rewrites or deletes lines this commit wrote
      if (!d.files.some((f) => files.has(f))) continue;
      const lines = originEvidence(repo, d.sha).get(c.sha);
      if (lines && !sameLanding(repo, c.sha, d.sha)) {
        tc.reworkedBy.push(d.sha);
        tc.reworkEvidence.push({ sha: d.sha, subject: d.subject, days: (d.at - c.at) / DAY, lines });
      }
    }
  }
  const landed = task.commits.filter((c) => c.mainline);
  task.landed = landed.length > 0;
  task.reverted = landed.some((c) => !!c.revertedBy);
  task.reworked = landed.some((c) => c.reworkedBy.length > 0);
  task.mature = task.landed && landed.every((c) => c.mature);
}

export type { Commit };
