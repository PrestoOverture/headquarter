import type { Session } from "./types";

export type SourceFileRead = { mtimeMs: number; sessions: number };
export type Ratio = { k: number; n: number };
export type MonthCheck = Ratio & { month: string; baseline: number | null; flagged: boolean };
export type SourceDiagnostics = {
  paths: { path: string; exists: boolean; detected: boolean }[];
  sessions: number;
  first: string | null;
  last: string | null;
  checks: Record<CheckName, { overall: Ratio; months: MonthCheck[] }>;
};
export const checkLabels = {
  unparsed: "JSON 解析失败记录 / 记录",
  unrecognized: "未产生会话的来源文件 / 来源文件",
  zeroTokens: "有回复但 token 全零的会话 / 会话",
  noModel: "有回复但无模型的会话 / 会话",
  emptyCwd: "工作目录为空的会话 / 会话",
};
type CheckName = keyof typeof checkLabels;

/** Pure: chronological checks against the last six eligible prior months (rates in [0, 1]). */
export function flagMonths(months: Record<string, Ratio>): MonthCheck[] {
  const history: number[] = [];
  return Object.entries(months).sort(([a], [b]) => a.localeCompare(b)).map(([month, { k, n }]) => {
    const prior = history.slice(-6).sort((a, b) => a - b);
    const mid = Math.floor(prior.length / 2);
    const baseline = prior.length ? (prior[mid]! + prior[Math.floor((prior.length - 1) / 2)]!) / 2 : null;
    const flagged = k >= 3 && n > 0 && baseline !== null && k / n - baseline >= 0.05 - 1e-12;
    if (n >= 5) history.push(k / n);
    return { month, k, n, baseline, flagged };
  });
}

/** Aggregate original sessions before task splitting or filtering; never retain record contents. */
export function sourceDiagnostics(paths: SourceDiagnostics["paths"], sessions: Session[], files: SourceFileRead[] = []): SourceDiagnostics {
  const names = Object.keys(checkLabels) as CheckName[];
  const checks = Object.fromEntries(names.map(name => [name, { overall: { k: 0, n: 0 }, months: {} as Record<string, Ratio> }])) as
    Record<CheckName, { overall: Ratio; months: Record<string, Ratio> }>;
  const add = (name: CheckName, value: Ratio, month: string | null) => {
    const check = checks[name];
    check.overall.k += value.k;
    check.overall.n += value.n;
    if (month !== null) {
      const total = check.months[month] ??= { k: 0, n: 0 };
      total.k += value.k;
      total.n += value.n;
    }
  };
  for (const file of files) add("unrecognized", { k: Number(file.sessions === 0), n: 1 },
    Number.isFinite(file.mtimeMs) ? new Date(file.mtimeMs).toISOString().slice(0, 7) : null);
  let first: string | null = null, last: string | null = null;
  for (const s of sessions) {
    const date = Number.isFinite(s.start) ? new Date(s.start).toISOString().slice(0, 10) : null;
    if (date !== null) {
      if (first === null || date < first) first = date;
      if (last === null || date > last) last = date;
    }
    const zeroTokens = s.parse.replies > 0 && Object.values(s.tokens).every(n => n === 0);
    const values: Omit<Record<CheckName, Ratio>, "unrecognized"> = {
      unparsed: { k: s.parse.unparsed, n: s.parse.records },
      zeroTokens: { k: Number(zeroTokens), n: 1 },
      noModel: { k: Number(s.parse.replies > 0 && Object.keys(s.models).length === 0), n: 1 },
      emptyCwd: { k: Number(typeof s.cwd !== "string" || !s.cwd.trim()), n: 1 },
    };
    for (const name of Object.keys(values) as (keyof typeof values)[]) add(name, values[name], date?.slice(0, 7) ?? null);
  }
  return { paths, sessions: sessions.length, first, last,
    checks: Object.fromEntries(names.map(name => [name, { overall: checks[name].overall, months: flagMonths(checks[name].months) }])) as SourceDiagnostics["checks"],
  };
}
