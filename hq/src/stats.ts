// Folds the ledger into one row per task and the metrics of prd 测评, each with its
// denominator. Rules from there: always show the denominator; under 50 tasks, no
// conclusions; record model versions; report false rejects; split by difficulty.

import { DIFFICULTIES, type Event, GATES, type Gate } from "./ledger";
import { LINE_LIMIT } from "./lines";

export const ESCAPE_WINDOW_DAYS = 14;
export const MIN_TASKS_FOR_CONCLUSIONS = 50;
const DAY_MS = 86_400_000;

export type TaskRow = {
  task: string;
  goal: string;
  title: string;
  difficulty: string;
  model: string;
  base: string;
  started_at: string;
  status: "merged" | "shelved" | "open";
  merged_at?: string;
  shelved_why?: string;
  gates: Partial<Record<Gate, { pass: number; fail: number; claimed_done_fail: number }>>;
  cost_usd: number;
  size: { added: number; deleted: number; lines: number; end: string } | null; // null: not checked
  causes: string[];
  false_rejects: number;
  escaped: boolean; // rework needed within the escape window after the merge
  escape_window_open: boolean;
};

export type Filters = { goals?: string[]; since?: Date; until?: Date };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** An ISO 8601 date or date-time; with no zone it is UTC, like the ledger's own stamps. */
export function parseDate(text: string, flag: string): Date {
  const m = ISO_DATE.exec(text);
  let t = NaN;
  if (m) {
    const [y, mo, d, h, mi, sec] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
    const valid = mo! >= 1 && mo! <= 12 && d! >= 1 && d! <= new Date(Date.UTC(y!, mo!, 0)).getUTCDate() && h! <= 23 && mi! <= 59 && sec! <= 59;
    if (valid) t = Date.parse(m[4] && !m[7] ? text + "Z" : text);
  }
  if (Number.isNaN(t)) throw new Error(`${flag}: ${JSON.stringify(text)} is not an ISO 8601 date or date-time`);
  return new Date(t);
}

/**
 * Keeps the tasks of the goals (--goal) that started in [since, until), all events of those
 * tasks, and the goal-level events (report shown, approve, merge, escalate) of their goals.
 * With a time window the goals are those of the kept tasks; with only --goal, those named.
 */
export function filterEvents(events: Event[], f: Filters): Event[] {
  const timed = f.since !== undefined || f.until !== undefined;
  if (!f.goals && !timed) return events;
  const kept = new Map<string, string>(); // task → goal
  for (const e of events) {
    if (e.type !== "task.start") continue;
    const t = Date.parse(e.at);
    const inGoals = !f.goals || f.goals.includes(e.goal);
    const inWindow = (!f.since || t >= f.since.getTime()) && (!f.until || t < f.until.getTime());
    if (inGoals && inWindow) kept.set(e.task, e.goal);
    else kept.delete(e.task);
  }
  const goals = timed ? new Set(kept.values()) : new Set(f.goals);
  return events.filter((e) => {
    if (e.type === "report.shown" || e.type === "approve" || e.type === "merge" || e.type === "escalate") return goals.has(e.goal);
    return kept.has(e.task);
  });
}

export function describeFilters(f: Filters): string {
  const parts = [];
  if (f.goals) parts.push(`目标 ${f.goals.join("、")}`);
  if (f.since) parts.push(`自 ${f.since.toISOString()} 起`);
  if (f.until) parts.push(`至 ${f.until.toISOString()} 前`);
  return parts.join("；");
}

export type Ratio = { n: number; of: number; rate: number | null };
const ratio = (n: number, of: number): Ratio => ({ n, of, rate: of ? n / of : null });

export function rows(events: Event[], now = new Date()): TaskRow[] {
  const byTask = new Map<string, TaskRow>();
  const merges = events.filter((e) => e.type === "merge");
  for (const e of events) {
    if (e.type === "task.start") {
      byTask.set(e.task, {
        task: e.task, goal: e.goal, title: e.title, difficulty: e.difficulty, model: e.model, base: e.base, started_at: e.at,
        status: "open", gates: {}, cost_usd: 0, size: null, causes: [], false_rejects: 0, escaped: false, escape_window_open: false,
      });
      continue;
    }
    if (!("task" in e) || !e.task) continue;
    const r = byTask.get(e.task);
    if (!r) continue;
    if (e.type === "task.gate") {
      const g = (r.gates[e.gate] ??= { pass: 0, fail: 0, claimed_done_fail: 0 });
      if (e.result === "pass") g.pass++;
      else {
        g.fail++;
        if (e.claimed_done) g.claimed_done_fail++;
      }
    } else if (e.type === "task.cost") r.cost_usd += e.usd;
    else if (e.type === "task.lines") r.size = { added: e.added, deleted: e.deleted, lines: e.added + e.deleted, end: e.end };
    else if (e.type === "task.shelve") {
      r.status = "shelved";
      r.shelved_why = e.why;
    } else if (e.type === "task.cause") r.causes.push(e.cause);
    else if (e.type === "task.false_reject") r.false_rejects++;
  }
  for (const r of byTask.values()) {
    if (r.status === "shelved") continue;
    const m = merges.find((x) => x.goal === r.goal && x.at >= r.started_at);
    if (!m) continue;
    r.status = "merged";
    r.merged_at = m.at;
    const deadline = Date.parse(m.at) + ESCAPE_WINDOW_DAYS * DAY_MS;
    r.escaped = events.some((e) => e.type === "escape" && e.task === r.task && Date.parse(e.at) <= deadline);
    r.escape_window_open = !r.escaped && now.getTime() < deadline;
  }
  return [...byTask.values()];
}

export function stats(events: Event[], now = new Date()) {
  const rs = rows(events, now);
  const started = rs.length;
  const merged = rs.filter((r) => r.status === "merged");
  const shelved = rs.filter((r) => r.status === "shelved");
  const escalations = events.filter((e) => e.type === "escalate");
  const activeS =
    events.reduce((s, e) => s + (e.type === "approve" ? e.active_s : 0), 0) +
    escalations.reduce((s, e) => s + (e.type === "escalate" ? (e.minutes ?? 0) * 60 : 0), 0);
  const cost = rs.reduce((s, r) => s + r.cost_usd, 0);
  const gates = Object.fromEntries(
    GATES.map((g) => {
      const sent = rs.reduce((s, r) => s + (r.gates[g] ? r.gates[g]!.pass + r.gates[g]!.fail : 0), 0);
      const caught = rs.reduce((s, r) => s + (r.gates[g]?.claimed_done_fail ?? 0), 0);
      return [g, ratio(caught, sent)];
    }),
  ) as Record<Gate, Ratio>;
  const fails = rs.reduce((s, r) => s + Object.values(r.gates).reduce((t, g) => t + (g?.fail ?? 0), 0), 0);
  const sized = rs.filter((r) => r.size);
  const small = sized.filter((r) => r.size!.lines < LINE_LIMIT);
  const causes: Record<string, number> = {};
  for (const r of rs) for (const c of r.causes) causes[c] = (causes[c] ?? 0) + 1;
  const byDifficulty = Object.fromEntries(
    DIFFICULTIES.map((d) => {
      const ds = rs.filter((r) => r.difficulty === d);
      return [d, { started: ds.length, merged: ds.filter((r) => r.status === "merged").length, shelved: ds.filter((r) => r.status === "shelved").length }];
    }),
  );
  return {
    tasks: started,
    conclusive: started >= MIN_TASKS_FOR_CONCLUSIONS,
    models: [...new Set(rs.map((r) => r.model))].sort(),
    caught_by_gate: gates, // self-reported done, then failed at this gate ÷ sent to this gate
    escalation_rate: ratio(escalations.length, started),
    escape_rate: ratio(merged.filter((r) => r.escaped).length, merged.length),
    escape_windows_open: merged.filter((r) => r.escape_window_open).length,
    pass_rate: ratio(merged.length, started),
    shelve_rate: ratio(shelved.length, started),
    cost_per_merged_usd: merged.length ? cost / merged.length : null,
    total_cost_usd: cost,
    active_s_per_merged: merged.length ? activeS / merged.length : null,
    total_active_s: activeS,
    false_rejects: ratio(rs.reduce((s, r) => s + r.false_rejects, 0), fails),
    size_checked: ratio(sized.length, started), // a task with no size is not checked, never passing
    under_limit: small.map((r) => ({ task: r.task, lines: r.size!.lines })),
    failure_causes: causes,
    by_difficulty: byDifficulty,
  };
}

const pct = (r: Ratio) => `${r.rate === null ? "—" : `${(r.rate * 100).toFixed(0)}%`}（${r.n}/${r.of}）`;

const csvField = (v: string | number) => {
  const t = String(v);
  return /[",\r\n]/.test(t) ? '"' + t.replaceAll('"', '""') + '"' : t;
};

/** RFC 4180: a header and one record per task, each ended by CRLF. */
export function toCsv(rs: TaskRow[]): string {
  const header = ["task", "goal", "title", "difficulty", "model", "status", "started_at", "merged_at", "lines", "cost_usd", ...GATES.flatMap((g) => [`${g}_pass`, `${g}_fail`])];
  const records = rs.map((r) => [
    r.task, r.goal, r.title, r.difficulty, r.model, r.status, r.started_at, r.merged_at ?? "", r.size?.lines ?? "", r.cost_usd,
    ...GATES.flatMap((g) => [r.gates[g]?.pass ?? 0, r.gates[g]?.fail ?? 0]),
  ]);
  return [header, ...records].map((rec) => rec.map(csvField).join(",") + "\r\n").join("");
}

export function render(s: ReturnType<typeof stats>, filters: Filters = {}): string {
  const applied = describeFilters(filters);
  const heading = `# M0 记账：${s.tasks} 个任务${applied ? `（${applied}）` : ""}`;
  if (!s.tasks) return `${heading}\n\n没有符合条件的任务。\n`;
  const lines = [
    heading,
    "",
    s.conclusive ? "" : `**不满 ${MIN_TASKS_FOR_CONCLUSIONS} 个任务，不下结论。**\n`,
    `模型：${s.models.join("、") || "—"}`,
    "",
    "| 指标 | 值 |",
    "| --- | --- |",
    ...GATES.map((g) => `| 自报完成但没过关：${g} | ${pct(s.caught_by_gate[g])} |`),
    `| 上报率 | ${pct(s.escalation_rate)} |`,
    `| 逃逸率（合入后 ${ESCAPE_WINDOW_DAYS} 天内返工） | ${pct(s.escape_rate)}${s.escape_windows_open ? `；${s.escape_windows_open} 个任务的窗口还没结束` : ""} |`,
    `| 合格率 | ${pct(s.pass_rate)} |`,
    `| 搁置率 | ${pct(s.shelve_rate)} |`,
    `| 每个合格任务的成本 | ${s.cost_per_merged_usd === null ? "—" : `$${s.cost_per_merged_usd.toFixed(2)}`}（共 $${s.total_cost_usd.toFixed(2)}） |`,
    `| 每个合格任务的主动时间 | ${s.active_s_per_merged === null ? "—" : `${(s.active_s_per_merged / 60).toFixed(1)} 分钟`}（共 ${(s.total_active_s / 60).toFixed(1)} 分钟） |`,
    `| 误拒（占关卡不过的次数） | ${pct(s.false_rejects)} |`,
    "",
    `任务大小：${s.size_checked.n}/${s.size_checked.of} 个任务有大小，${s.size_checked.of - s.size_checked.n} 个没查`,
    `不满 ${LINE_LIMIT} 行：${s.under_limit.map((t) => `${t.task} ${t.lines} 行`).join("、") || "—"}`,
    "",
    `失败原因：${Object.entries(s.failure_causes).map(([c, n]) => `${c} ${n}`).join("、") || "—"}`,
    "",
    "| 难度 | 开始 | 合入 | 搁置 |",
    "| --- | --- | --- | --- |",
    ...Object.entries(s.by_difficulty).map(([d, v]) => `| ${d} | ${v.started} | ${v.merged} | ${v.shelved} |`),
    "",
  ];
  return lines.join("\n");
}
