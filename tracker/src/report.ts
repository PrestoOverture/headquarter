// The local report: one self-contained HTML file (no network), filters in the page, and a terminal
// table from the same aggregation.

import { readFileSync } from "node:fs";
import { aggregate } from "./aggregate.js";
import type { Task } from "./link";

const AGGREGATE_SRC = readFileSync(new URL("./aggregate.js", import.meta.url), "utf8").replace(/^export /m, "");

export type Meta = { generatedAt: number; sessions: { claude: number; codex: number }; repos: number; ci: boolean };

/** What the page needs of a task (no file paths beyond the working directory, no prompt text). */
function slim(t: Task) {
  return {
    id: t.id, combo: t.combo, vendor: t.vendor, headless: t.headless, repo: t.repo ?? null, start: t.start, end: t.end,
    model: t.model ?? null, kinds: t.kinds, sessions: t.sessions, costUSD: t.costUSD, codexTokens: t.codexTokens,
    humanPrompts: t.humanPrompts, interrupts: t.interrupts, waitMs: t.waitMs, landed: t.landed, reworked: t.reworked,
    reverted: t.reverted, mature: t.mature, ci: t.ci ?? null,
    commits: t.commits.map((c) => ({
      sha: c.sha.slice(0, 10), at: c.at, subject: c.subject.slice(0, 120), added: c.added, deleted: c.deleted,
      reworkEvidence: c.reworkEvidence,
      mainline: c.mainline, how: c.how, reworked: c.reworkedBy.length > 0, reverted: !!c.revertedBy, mature: c.mature,
    })),
  };
}

const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const num = (x: number | null, d = 1) => (x === null ? "–" : x.toFixed(d));

export function terminalTable(tasks: Task[]): string {
  const rows = aggregate(tasks, (t: Task) => t.combo);
  const head = ["组合", "任务", "有提交", "合入率", "14天返工(成熟n)", "CI首过(n)", "$/任务", "$/合入", "Codex Mtok/任务", "插话/任务", "等你 分/任务"];
  const body = rows.map((r) => [
    r.key, String(r.tasks), String(r.withCommits), pct(r.landedRate), `${pct(r.reworkRate)} (${r.mature})`,
    `${pct(r.ciPassRate)} (${r.ci})`, num(r.costPerTask, 2), num(r.costPerLanded, 2), num(r.codexMTokPerTask, 2),
    num(r.promptsPerTask), num(r.waitMinPerTask),
  ]);
  const width = (s: string) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const cols = head.map((h, i) => Math.max(width(h), ...body.map((r) => width(r[i]!))));
  const line = (r: string[]) => r.map((c, i) => c + " ".repeat(cols[i]! - width(c))).join("  ");
  return [line(head), ...body.map(line)].join("\n");
}

export function html(tasks: Task[], meta: Meta): string {
  const data = JSON.stringify({ meta, tasks: tasks.map(slim) }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent 效果追踪</title>
<style>
:root { --bg:#fbfbfa; --fg:#1d1d1b; --muted:#6b6a66; --line:#e4e2dc; --card:#fff; --accent:#2f6f5e; --warn:#a4462c; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#ecebe7; --muted:#9a9891; --line:#2e2d2a; --card:#1e1e1c; --accent:#7fc4ae; --warn:#e48d72; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif; }
main { max-width: 1280px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 32px 0 8px; }
.sub { color: var(--muted); margin: 0 0 16px; }
.filters { display:flex; flex-wrap:wrap; gap:12px 20px; align-items:center; padding:12px; background:var(--card); border:1px solid var(--line); border-radius:8px; }
.filters label { display:flex; gap:6px; align-items:center; color:var(--muted); }
select, input { font: inherit; color: var(--fg); background: var(--bg); border:1px solid var(--line); border-radius:6px; padding:3px 6px; }
.scroll { overflow-x:auto; border:1px solid var(--line); border-radius:8px; background:var(--card); }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th { font-weight: 600; color: var(--muted); font-size: 12px; position: sticky; top: 0; background: var(--card); }
tr:last-child td { border-bottom: 0; }
.n { color: var(--muted); font-size: 12px; }
.bad { color: var(--warn); }
.good { color: var(--accent); }
details { margin-top: 24px; }
summary { cursor: pointer; font-weight: 600; }
ul.notes { color: var(--muted); padding-left: 20px; }
td.l { text-align:left; white-space: normal; min-width: 240px; }
</style>
</head>
<body>
<main>
<h1>Agent 效果追踪</h1>
<p class="sub" id="meta"></p>
<div class="filters">
  <label>仓库 <select id="repo"></select></label>
  <label>从 <input type="date" id="from"></label>
  <label>到 <input type="date" id="to"></label>
  <label>分组 <select id="group">
    <option value="combo">组合</option>
    <option value="combo+model">组合 × 主模型</option>
    <option value="combo+month">组合 × 月份</option>
    <option value="repo">仓库</option>
  </select></label>
  <label><input type="checkbox" id="commits" checked> 只看有提交的任务</label>
  <label><input type="checkbox" id="headless"> 含无人值守（claude -p、codex exec）</label>
  <label><input type="checkbox" id="norepo"> 含不在仓库里的会话</label>
</div>
<h2>按组合</h2>
<div class="scroll"><table id="summary"></table></div>
<ul class="notes">
  <li>任务 = 一件工作：从人的提示开始，产生提交后遇到下一条人的提示才分成下一件；没有提交的连续提示归在一起。子会话按启动时间归到父会话当时的任务；没有人的提示的后台会话仍算一件。</li>
  <li>合入率 = 有提交的任务里，至少一个提交进了主分支的比例。最近几天的任务可能还没合。</li>
  <li>14 天返工：合入的提交在 14 天内被回滚，或它写的行被别的以 fix/bug/修复 为题的提交改掉或删掉（git blame）。只算已过 14 天的任务（n）。</li>
  <li>花费只有 Claude 的美元数，按各任务的 assistant token 用量分摊（缺少用量时均分）；Codex 按累计 token 的增量分摊，按百万 token 列出（不含缓存命中的输入）。</li>
  <li>插话 = 人发的消息数（含第一条）；等你 = agent 做完到你下一条消息的时间，每段最多算 60 分钟。</li>
  <li>提交对上会话：「精确」是会话自己 git commit 的输出里有这个哈希；其余按仓库和时间猜（相差 10 分钟内）。</li>
</ul>
<details open>
<summary>任务明细（最近 300 个）</summary>
<div class="scroll" style="margin-top:8px"><table id="tasks"></table></div>
</details>
<h2>返工明细</h2>
<div class="scroll"><table id="rework"></table></div>
</main>
<script>
const DATA = ${data};
${AGGREGATE_SRC}
const $ = (id) => document.getElementById(id);
const pct = (x) => x === null ? "–" : Math.round(x * 100) + "%";
const num = (x, d = 1) => x === null ? "–" : x.toFixed(d);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const m = DATA.meta;
$("meta").textContent = "生成于 " + new Date(m.generatedAt).toLocaleString() + " · Claude 会话 " + m.sessions.claude + " · Codex 会话 " + m.sessions.codex + " · 仓库 " + m.repos + (m.ci ? " · 含 CI" : " · 未查 CI（--ci）");
const repos = [...new Set(DATA.tasks.map((t) => t.repo).filter(Boolean))].sort();
$("repo").innerHTML = '<option value="">全部</option>' + repos.map((r) => '<option>' + esc(r) + '</option>').join("");

function filtered() {
  const repo = $("repo").value, from = $("from").value, to = $("to").value;
  return DATA.tasks.filter((t) =>
    (!repo || t.repo === repo) &&
    (!from || day(t.start) >= from) && (!to || day(t.start) <= to) &&
    ($("headless").checked || !t.headless) &&
    ($("norepo").checked || t.repo) &&
    (!$("commits").checked || t.commits.length > 0));
}

function keyFn() {
  const g = $("group").value;
  if (g === "combo+model") return (t) => t.combo + " · " + (t.model || "?");
  if (g === "combo+month") return (t) => t.combo + " · " + day(t.start).slice(0, 7);
  if (g === "repo") return (t) => t.repo || "(无仓库)";
  return (t) => t.combo;
}

function render() {
  const ts = filtered();
  const rows = aggregate(ts, keyFn());
  if ($("group").value === "combo+month") rows.sort((a, b) => a.key.localeCompare(b.key));
  const head = ["", "任务", "有提交", "合入率", "14天返工", "回滚", "CI首过", "$/任务", "$/合入", "Codex Mtok/任务", "插话/任务", "打断/任务", "等你 分/任务", "合入行数/任务", "精确对上"];
  $("summary").innerHTML = "<tr>" + head.map((h) => "<th>" + h + "</th>").join("") + "</tr>" + rows.map((r) => "<tr>" + [
    esc(r.key), r.tasks, r.withCommits, pct(r.landedRate),
    pct(r.reworkRate) + ' <span class="n">n=' + r.mature + "</span>",
    pct(r.revertRate),
    pct(r.ciPassRate) + ' <span class="n">n=' + r.ci + "</span>",
    num(r.costPerTask, 2), num(r.costPerLanded, 2), num(r.codexMTokPerTask, 2),
    num(r.promptsPerTask), num(r.interruptsPerTask, 2), num(r.waitMinPerTask), num(r.linesLandedPerTask, 0), pct(r.exactShare),
  ].map((c) => "<td>" + c + "</td>").join("") + "</tr>").join("");

  $("rework").innerHTML = "<tr>" + ["日期", "组合", "仓库", "提交", "修复提交", "间隔天数", "证据"].map(h => "<th>" + h + "</th>").join("") + "</tr>" + ts.flatMap(t => t.commits.filter(c => c.mainline && c.reworked).flatMap(c => c.reworkEvidence.map(f => "<tr>" + [day(c.at), esc(t.combo), esc(t.repo || "–"), esc(c.sha + " " + c.subject), esc(f.sha + " " + f.subject), num(f.days), f.lines.map(l => esc(l.file + ": " + l.text)).join("<br>")].map(v => '<td class="l">' + v + "</td>").join("") + "</tr>"))).join("");

  const recent = ts.slice().sort((a, b) => b.start - a.start).slice(0, 300);
  const th = ["开始", "组合", "仓库", "主模型", "提交（合入）", "结果", "$", "Codex Mtok", "插话", "提交"];
  $("tasks").innerHTML = "<tr>" + th.map((h) => "<th>" + h + "</th>").join("") + "</tr>" + recent.map((t) => {
    const landedN = t.commits.filter((c) => c.mainline).length;
    const result = !t.commits.length ? "–" : !t.landed ? "未合入" : t.reverted ? '<span class="bad">回滚</span>' : t.reworked ? '<span class="bad">返工</span>' : t.mature ? '<span class="good">存活</span>' : "合入（观察中）";
    const commits = t.commits.slice(0, 4).map((c) => esc(c.sha.slice(0, 7) + " " + c.subject) + (c.how === "time" ? ' <span class="n">(猜)</span>' : "")).join("<br>") + (t.commits.length > 4 ? '<br><span class="n">…共 ' + t.commits.length + " 个</span>" : "");
    return "<tr>" + [
      day(t.start), esc(t.combo), esc(t.repo || "–"), esc(t.model || "–"), t.commits.length + "（" + landedN + "）", result,
      t.costUSD ? t.costUSD.toFixed(2) : "–", t.codexTokens ? (t.codexTokens / 1e6).toFixed(2) : "–", t.humanPrompts,
    ].map((c) => "<td>" + c + "</td>").join("") + '<td class="l">' + commits + "</td></tr>";
  }).join("");
}

for (const id of ["repo", "from", "to", "group", "commits", "headless", "norepo"]) $(id).addEventListener("input", render);
render();
</script>
</body>
</html>
`;
}
