// The local report: one self-contained HTML file (no network), filters in the page, and a terminal
// table from the same aggregation.

import { readFileSync } from "node:fs";
import { aggregate } from "./aggregate.js";
import type { Task } from "./link";

const TREND_SRC = readFileSync(new URL("./trend.js", import.meta.url), "utf8").replace(/^export /gm, "");
const AGGREGATE_SRC = readFileSync(new URL("./aggregate.js", import.meta.url), "utf8").replace(/^export /m, "");

export type Meta = { generatedAt: number; sessions: Record<string, number>; repos: number; ci: boolean };

/** What the page needs of a task (no file paths beyond the working directory, no prompt text). */
function slim(t: Task) {
  return {
    id: t.id, kind: t.kind, size: t.size, combo: t.combo, vendor: t.vendor, headless: t.headless, empty: t.empty, repo: t.repo ?? null, start: t.start, end: t.end,
    model: t.model ?? null, kinds: t.kinds, sessions: t.sessions, costUSD: t.costUSD, tokens: t.tokens,
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
  const head = ["组合", "任务", "有提交", "合入率", "14天返工(成熟n)", "CI 新失败 (n)", "原本就红", "$/任务", "$/合入", "输入 k/任务", "缓存读 k/任务", "缓存写 k/任务", "输出 k/任务", "插话/任务", "等你 分/任务"];
  const body = rows.map((r) => [
    r.key, String(r.tasks), String(r.withCommits), `${pct(r.landedRate)} (n=${r.withCommits})`, `${pct(r.reworkRate)} (${r.mature})`,
    `${pct(r.ciBreakRate)} (${r.ci})`, String(r.ciInherited), num(r.costPerTask, 2), num(r.costPerLanded, 2), num(r.inputPerTask / 1000, 2), num(r.cacheReadPerTask / 1000, 2), num(r.cacheWritePerTask / 1000, 2), num(r.outputPerTask / 1000, 2),
    num(r.promptsPerTask), num(r.waitMinPerTask),
  ]);
  const width = (s: string) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const cols = head.map((h, i) => Math.max(width(h), ...body.map((r) => width(r[i]!))));
  const line = (r: string[]) => r.map((c, i) => c + " ".repeat(cols[i]! - width(c))).join("  ");
  return [line(head), ...body.map(line)].join("\n");
}

export function dashboardData(tasks: Task[], meta: Meta) {
  return { meta, tasks: tasks.map(slim) };
}

export function html(tasks: Task[], meta: Meta, live = false): string {
  // Escape recorded URLs in the JSON without changing their decoded display text.
  const data = JSON.stringify(dashboardData(tasks, meta)).replace(/</g, "\\u003c").replace(/https?:/gi, s => s.slice(0, -1) + "\\u003a");
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
select, input, button { font: inherit; color: var(--fg); background: var(--bg); border:1px solid var(--line); border-radius:6px; padding:3px 6px; }
button { cursor:pointer; }
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
.cards { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-top:20px; }
.card, .chart { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; }
.card strong { display:block; font-size:26px; font-variant-numeric:tabular-nums; }
.card .label { color:var(--muted); }
.rate-bar { display:block; height:3px; background:var(--line); margin-top:4px; }
.rate-bar i { display:block; height:100%; background:var(--accent); }
.chart { margin-top:12px; overflow-x:auto; }
.chart svg { display:block; width:100%; min-width:680px; color:var(--muted); font:12px sans-serif; }
.legend { display:flex; flex-wrap:wrap; gap:16px; margin:8px 0; }
.legend span { border-left:10px solid; padding-left:6px; }
@media (max-width:700px) { .cards { grid-template-columns:repeat(2,minmax(0,1fr)); } }
td.l { text-align:left; white-space: normal; min-width: 240px; }
</style>
</head>
<body>
<main>
<h1>Agent 效果追踪</h1>
<p class="sub" id="meta"></p>
<p id="refresh-controls" hidden><button id="refresh" type="button">刷新</button> <span id="last-updated"></span> <span id="refresh-status" role="status"></span></p>
<div class="filters">
  <label>仓库 <select id="repo"></select></label>
  <label>agent <select id="agent"></select></label>
  <label>类型 <select id="kind"></select></label>
  <label>规模 <select id="size"></select></label>
  <label>从 <input type="date" id="from"></label>
  <label>到 <input type="date" id="to"></label>
  <label>分组 <select id="group">
    <option value="combo">组合</option>
    <option value="model">模型</option>
    <option value="agent">agent</option>
    <option value="combo+agent">组合 × agent</option>
    <option value="combo+model">组合 × 模型</option>
    <option value="combo+month">组合 × 月份</option>
    <option value="combo+kind">组合 × 类型</option>
    <option value="combo+size">组合 × 规模</option>
    <option value="repo">仓库</option>
  </select></label>
  <label><input type="checkbox" id="commits" checked> 只看有提交的任务</label>
  <label><input type="checkbox" id="headless"> 含无人值守（claude -p、codex exec）</label>
  <label><input type="checkbox" id="norepo"> 含不在仓库里的会话</label>
  <label><input type="checkbox" id="empty"> 含空任务（无回复）<span id="empty-count"></span></label>
</div>
<div class="cards" id="cards"></div>
<h2>分组汇总</h2>
<label><input type="checkbox" id="more"> 更多列（$ / CI 等）</label>
<div class="scroll"><table id="summary"></table></div>
<ul class="notes">
  <li>任务 = 一件工作：从人的提示开始，产生提交后遇到下一条人的提示才分成下一件；没有提交的连续提示归在一起。子会话按启动时间归到父会话当时的任务；没有人的提示的后台会话仍算一件。</li>
  <li>合入率 = 有提交的任务里，至少一个提交进了主分支的比例。最近几天的任务可能还没合。</li>
  <li>14 天返工：合入的提交在 14 天内被回滚，或它写的行被别的以 fix/bug/修复 为题的提交改掉或删掉（git blame）。只算已过 14 天的任务（n）。</li>
  <li>汇总 token 是每任务用量的中位数（MEDIAN）；注意力是每任务均值。趋势按任务开始日期分桶（UTC，周一开始），主模型切换按当前筛选中各 agent 每桶任务数最多的根模型计算。</li>
  <li>花费使用记录中的美元数，按各任务的用量分摊（缺少用量时均分）；token 按千个列出，输入不含缓存，输出包含推理。</li>
  <li>插话 = 人发的消息数（含第一条）；等你 = agent 做完到你下一条消息的时间，每段最多算 60 分钟。</li>
  <li>提交对上会话：「精确」是会话自己 git commit 的输出里有这个哈希；其余按仓库和时间猜（相差 10 分钟内）。</li>
</ul>
<h2>趋势</h2>
<div class="filters">
  <label>时间桶 <select id="bucket"><option value="4week" selected>4 周</option><option value="week">周</option></select></label>
  <label>token <select id="token-metric"><option value="output">输出</option><option value="input">总输入（含缓存读 / 写）</option></select></label>
  <label><input type="checkbox" id="markers" checked> 主模型切换</label>
</div>
<div id="legend" class="legend"></div>
<p class="n">返工点仅显示成熟 n ≥ 3；柱为成熟 n（右轴）。token 为每任务中位数，对数轴不绘制 0。虚线标记主模型相对前一个非空桶的切换；首桶不标记。并列时保留原主模型，否则按模型名排序；未知模型记为 ?。</p>
<div class="chart" id="trend-rework"></div>
<div class="chart" id="trend-tokens"></div>
<details open>
<summary>任务明细（最近 300 个）</summary>
<div class="scroll" style="margin-top:8px"><table id="tasks"></table></div>
</details>
<h2>返工明细</h2>
<div class="scroll"><table id="rework"></table></div>
</main>
<script>
let DATA = ${data};
${AGGREGATE_SRC}
const {bucketAt: trendBucketAt, modelSwitches: trendModelSwitches, trend} = (() => {
${TREND_SRC}
return {bucketAt, modelSwitches, trend};
})();
const $ = (id) => document.getElementById(id);
const pct = (x) => x === null ? "–" : Math.round(x * 100) + "%";
const num = (x, d = 1) => x === null ? "–" : x.toFixed(d);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let m, agents;
function updateData(data) {
  DATA = data;
  m = DATA.meta;
  $("meta").textContent = "生成于 " + new Date(m.generatedAt).toLocaleString() + " · " + Object.entries(m.sessions).map(([name, count]) => name + " 会话 " + count).join(" · ") + " · 仓库 " + m.repos + (m.ci ? " · 含 CI" : " · 未查 CI（--ci）");
  $("last-updated").textContent = "上次更新 " + new Date(m.generatedAt).toLocaleString();
  $("empty-count").textContent = "（" + DATA.tasks.filter(t => t.empty).length + "）";
  agents = [...new Set(DATA.tasks.map(t => t.vendor))].sort();
  const repos = [...new Set(DATA.tasks.map((t) => t.repo).filter(Boolean))].sort();
  for (const [id, choices] of [["agent", agents], ["repo", repos]]) {
    const selected = $(id).value;
    const options = selected && !choices.includes(selected) ? [...choices, selected] : choices;
    $(id).innerHTML = '<option value="">全部</option>' + options.map(v => '<option>' + esc(v) + '</option>').join("");
    $(id).value = selected;
  }
}
updateData(DATA);

if (${live} && location.protocol !== "file:") {
  $("refresh-controls").hidden = false;
  $("refresh").addEventListener("click", async () => {
    $("refresh").disabled = true;
    $("refresh-status").textContent = "刷新中…";
    try {
      const response = await fetch("/api/refresh", { method:"POST", headers:{"X-Crewmeter":"1"} });
      if (!response.ok) throw new Error("HTTP " + response.status);
      updateData(await response.json());
      render();
      $("refresh-status").textContent = "";
    } catch (error) {
      $("refresh-status").textContent = "刷新失败：" + error.message;
    } finally { $("refresh").disabled = false; }
  });
}

for (const [id, options] of [["kind", ["文档", "测试", "界面", "代码", "–"]], ["size", ["<100", "100–300", "300–1k", "≥1k", "–"]]]) {
  $(id).innerHTML = '<option value="">全部</option>' + options.map(v => '<option>' + esc(v) + '</option>').join("");
}

function filtered() {
  const repo = $("repo").value, from = $("from").value, to = $("to").value;
  return DATA.tasks.filter((t) =>
    (!repo || t.repo === repo) &&
    (!$("agent").value || t.vendor === $("agent").value) &&
    ($("empty").checked || !t.empty) &&
    (!$("kind").value || t.kind === $("kind").value) &&
    (!$("size").value || t.size === $("size").value) &&
    (!from || day(t.start) >= from) && (!to || day(t.start) <= to) &&
    ($("headless").checked || !t.headless) &&
    ($("norepo").checked || t.repo) &&
    (!$("commits").checked || t.commits.length > 0));
}

function keyFn() {
  const g = $("group").value;
  if (g === "model") return (t) => t.model || "?";
  if (g === "agent") return (t) => t.vendor;
  if (g === "combo+agent") return (t) => t.combo + " · " + t.vendor;
  if (g === "combo+model") return (t) => t.combo + " · " + (t.model || "?");
  if (g === "combo+month") return (t) => t.combo + " · " + day(t.start).slice(0, 7);
  if (g === "combo+kind") return (t) => t.combo + " · " + t.kind;
  if (g === "combo+size") return (t) => t.combo + " · " + t.size;
  if (g === "repo") return (t) => t.repo || "(无仓库)";
  return (t) => t.combo;
}

const DAY = 86400000;
function bucketAt(at) { return trendBucketAt(at, $("bucket").value); }
function modelSwitches(tasks) { return trendModelSwitches(tasks, $("bucket").value); }
const colors = ["#387bcb", "#d07724", "#8c59b5", "#28917d", "#c45169", "#7c8234"];
const color = vendor => colors[agents.indexOf(vendor) % colors.length];

function renderTrends(ts) {
  const vendors = [...new Set(ts.map(t => t.vendor))].sort();
  $("legend").innerHTML = vendors.map(v => '<span style="border-color:' + color(v) + '">' + esc(v) + '</span>').join("");
  if (!ts.length) {
    $("trend-rework").innerHTML = $("trend-tokens").innerHTML = '<p class="n">当前筛选无任务（n=0）</p>';
    return;
  }
  const span = ($("bucket").value === "week" ? 7 : 28) * DAY;
  const {buckets, series, switches} = trend(ts, $("bucket").value, $("token-metric").value);
  const first = buckets[0];
  const input = $("token-metric").value === "input";
  const left = 72, right = 840, width = right-left, height = 236;
  const step = width / buckets.length;
  const x = at => left + ((at-first) / span + 0.5) * step;
  // Put marker labels in non-overlapping lanes above the plot, on both charts.
  const lanes = [];
  const markers = $("markers").checked ? switches.map(p => {
      const text = p.vendor + ": " + p.old + " → " + p.model;
      const short = text.length > 80 ? text.slice(0,77) + "…" : text;
      const labelWidth = [...short].reduce((n,c) => n + (c.charCodeAt(0) > 0x2e80 ? 12 : 7), 0);
      const labelX = Math.max(left, Math.min(x(bucketAt(p.at))+4, right-labelWidth));
      let lane = lanes.findIndex(end => end+8 < labelX);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = labelX+labelWidth;
      return {...p, text, short, labelX, labelY:42+lane*20};
    }) : [];
  const top = 64+lanes.length*20, bottom = top+height;
  const line = (x1,y1,x2,y2,attrs='') => '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" ' + attrs + '/>';
  const label = (x,y,text,attrs='') => '<text x="' + x + '" y="' + y + '" fill="currentColor" ' + attrs + '>' + esc(text) + '</text>';
  const positives = series.flatMap(s => s.points.map(p => p.median)).filter(v => v > 0);
  const low = positives.length ? Math.floor(Math.log10(Math.min(...positives))) : 0;
  const high = Math.max(low+1, positives.length ? Math.ceil(Math.log10(Math.max(...positives))) : 1);
  const maxN = Math.max(1, ...series.flatMap(s => s.points.map(p => p.mature)));
  const yToken = v => bottom - (Math.log10(v)-low) / (high-low) * height;
  for (const type of ["rework", "tokens"]) {
    const title = type === "rework" ? "A · 14 天返工率 / 成熟 n" : "B · 每任务" + (input ? "总输入（含缓存）" : "输出") + " token 中位数（对数轴）";
    let svg = '<svg viewBox="0 0 920 ' + (bottom+60) + '" role="img" aria-label="' + esc(title) + '"><title>' + esc(title) + '</title>';
    svg += label(left, 20, title);
    const immature = buckets.filter(at => at >= m.generatedAt - 14*DAY && at <= m.generatedAt);
    if (type === "rework") for (const at of immature) {
      svg += '<rect x="' + (x(at)-step/2) + '" y="' + top + '" width="' + step + '" height="' + height + '" fill="var(--warn)" opacity="0.1"/>';
    }
    if (type === "rework" && immature.length) svg += label(x(immature[0])-step/2+4, top+14, "未满 14 天");
    const ticks = type === "rework" ? [0,0.25,0.5,0.75,1] : Array.from({length:high-low+1}, (_,i) => 10**(low+i));
    for (const tick of ticks) {
      const y = type === "rework" ? bottom-tick*height : yToken(tick);
      svg += line(left,y,right,y,'stroke="var(--line)"');
      svg += label(left-8,y+4,type === "rework" ? pct(tick) : tick.toLocaleString(), 'text-anchor="end"');
      if (type === "rework") svg += label(right+8,y+4,String(Math.round(tick*maxN)));
    }
    const every = Math.max(1, Math.ceil(buckets.length / 8));
    buckets.forEach((at,i) => { if (i % every === 0) svg += label(x(at), bottom+24, day(at), 'text-anchor="middle"'); });
    for (const [vi,s] of series.entries()) {
      let previous = null;
      for (const p of s.points) {
        const title = esc(s.vendor + " · " + day(p.at) + (type === "rework" ? " · 返工 " + p.k + "/" + p.mature + "（成熟 n）" : " · 中位数 " + (p.median === null ? "–" : p.median) + " · n=" + p.n + " · 返工 " + p.k + "/" + p.mature));
        if (type === "rework" && p.mature) {
          const barWidth = Math.max(0.2, Math.min(16, step*0.65/vendors.length));
          const h = p.mature/maxN*height;
          svg += '<rect data-series="mature" x="' + (x(p.at)+(vi-vendors.length/2)*barWidth) + '" y="' + (bottom-h) + '" width="' + barWidth + '" height="' + h + '" fill="' + color(s.vendor) + '" opacity="0.18"><title>' + title + '</title></rect>';
        }
        const value = type === "rework" ? p.rework : p.median;
        if (value === null || (type === "tokens" && value <= 0)) { previous = null; continue; }
        const point = {x:x(p.at), y:type === "rework" ? bottom-value*height : yToken(value)};
        if (previous) svg += line(previous.x,previous.y,point.x,point.y,'stroke="' + color(s.vendor) + '" stroke-width="2"');
        svg += '<circle data-series="' + type + '" cx="' + point.x + '" cy="' + point.y + '" r="4" fill="' + color(s.vendor) + '"><title>' + title + '</title></circle>';
        previous = point;
      }
    }
    for (const p of markers) {
      const at = bucketAt(p.at);
      svg += '<g data-model-marker="' + esc(p.text) + '"><title>' + esc(p.text + " · 主模型切换 " + day(p.at)) + '</title>' +
        line(x(at),p.labelY+4,x(at),bottom,'stroke="' + color(p.vendor) + '" stroke-dasharray="5 4"') +
        label(p.labelX,p.labelY,p.short) + '</g>';
    }
    svg += '</svg>';
    $(type === "rework" ? "trend-rework" : "trend-tokens").innerHTML = svg;
  }
}

function rate(k, n) {
  return '<span class="n">' + k + '/' + n + ' (n=' + n + ')' + (n < 20 ? ' · 样本少' : '') + '</span>';
}

function render() {
  const ts = filtered();
  const rows = aggregate(ts, keyFn());
  if ($("group").value === "combo+month") rows.sort((a, b) => a.key.localeCompare(b.key));
  const all = aggregate(ts, () => "all")[0];
  const mature = all ? Math.round((all.reworkRate || 0) * all.mature) : 0;
  const card = (label, value, detail) => '<div class="card"><div class="label">' + label + '</div><strong>' + value + '</strong><span class="n">' + detail + '</span></div>';
  $("cards").innerHTML = card("任务", ts.length, "n=" + ts.length) +
    card("有提交 / 合入", all ? all.withCommits + " / " + all.landed : "0 / 0", "任务 n=" + ts.length) +
    card("14 天返工率", pct(all ? all.reworkRate : null), rate(mature, all ? all.mature : 0)) +
    card("平均人类提示 / 任务", num(all ? all.promptsPerTask : null), "n=" + ts.length);
  const more = $("more").checked;
  const head = ["分组", "任务 n", "有提交", "合入率 k/n", "14天返工 k/n", "输入 k 中位数", "缓存读 k 中位数", "缓存写 k 中位数", "输出 k 中位数", "插话/任务", "打断/任务", "等你 分/任务"];
  if (more) head.push("回滚率 k/n", "CI 新失败 (n) k/n", "原本就红", "$/任务", "$/合入", "合入行数/任务", "精确对上");
  $("summary").innerHTML = "<tr>" + head.map((h) => "<th>" + h + "</th>").join("") + "</tr>" + rows.map((r) => {
    const k = Math.round((r.reworkRate || 0) * r.mature);
    const cells = [esc(r.key), r.tasks, r.withCommits, pct(r.landedRate) + " " + rate(r.landed, r.withCommits),
      pct(r.reworkRate) + " " + rate(k, r.mature) + '<span class="rate-bar"><i style="width:' + (r.reworkRate === null ? 0 : r.reworkRate * 100) + '%"></i></span>',
      num(r.medianInput / 1000, 2), num(r.medianCacheRead / 1000, 2), num(r.medianCacheWrite / 1000, 2), num(r.medianOutput / 1000, 2),
      num(r.promptsPerTask), num(r.interruptsPerTask, 2), num(r.waitMinPerTask)];
    if (more) {
      const commits = ts.filter(t => keyFn()(t) === r.key).flatMap(t => t.commits);
      cells.push(pct(r.revertRate) + " " + rate(Math.round((r.revertRate || 0) * r.mature), r.mature),
      pct(r.ciBreakRate) + " " + rate(r.ciBroke, r.ci), r.ciInherited, num(r.costPerTask, 2), num(r.costPerLanded, 2), num(r.linesLandedPerTask, 0), pct(r.exactShare) + " " + rate(commits.filter(c => c.how === "exact").length, commits.length));
    }
    return "<tr>" + cells.map(c => "<td>" + c + "</td>").join("") + "</tr>";
  }).join("");
  renderTrends(ts);

  $("rework").innerHTML = "<tr>" + ["日期", "组合", "仓库", "提交", "修复提交", "间隔天数", "证据"].map(h => "<th>" + h + "</th>").join("") + "</tr>" + ts.flatMap(t => t.commits.filter(c => c.mainline && c.reworked).flatMap(c => c.reworkEvidence.map(f => "<tr>" + [day(c.at), esc(t.combo), esc(t.repo || "–"), esc(c.sha + " " + c.subject), esc(f.sha + " " + f.subject), num(f.days), f.lines.map(l => esc(l.file + ": " + l.text)).join("<br>")].map(v => '<td class="l">' + v + "</td>").join("") + "</tr>"))).join("");

  const recent = ts.slice().sort((a, b) => b.start - a.start).slice(0, 300);
  const th = ["开始", "组合", "类型", "规模", "仓库", "主模型", "提交（合入）", "结果", "$", "输入 k", "缓存读 k", "缓存写 k", "输出 k", "插话", "提交"];
  $("tasks").innerHTML = "<tr>" + th.map((h) => "<th>" + h + "</th>").join("") + "</tr>" + recent.map((t) => {
    const landedN = t.commits.filter((c) => c.mainline).length;
    const result = !t.commits.length ? "–" : !t.landed ? "未合入" : t.reverted ? '<span class="bad">回滚</span>' : t.reworked ? '<span class="bad">返工</span>' : t.mature ? '<span class="good">存活</span>' : "合入（观察中）";
    const commits = t.commits.slice(0, 4).map((c) => esc(c.sha.slice(0, 7) + " " + c.subject) + (c.how === "time" ? ' <span class="n">(猜)</span>' : "")).join("<br>") + (t.commits.length > 4 ? '<br><span class="n">…共 ' + t.commits.length + " 个</span>" : "");
    return "<tr>" + [
      day(t.start), esc(t.combo), esc(t.kind), esc(t.size), esc(t.repo || "–"), esc(t.model || "–"), t.commits.length + "（" + landedN + "）", result,
      t.costUSD ? t.costUSD.toFixed(2) : "–", num(t.tokens.input / 1000, 2), num(t.tokens.cacheRead / 1000, 2), num(t.tokens.cacheWrite / 1000, 2), num(t.tokens.output / 1000, 2), t.humanPrompts,
    ].map((c) => "<td>" + c + "</td>").join("") + '<td class="l">' + commits + "</td></tr>";
  }).join("");
}

if (${live} && location.hash) {
  const params = new URLSearchParams(location.hash.slice(1));
  for (const id of ["from", "to", "repo", "agent"]) if (params.has(id)) {
    const value = params.get(id);
    if ((id === "repo" || id === "agent") && value && !DATA.tasks.some(t => (id === "repo" ? t.repo : t.vendor) === value)) {
      $(id).innerHTML += '<option>' + esc(value) + '</option>';
    }
    $(id).value = value;
  }
  for (const [key, id] of [["commits_only", "commits"], ["include_headless", "headless"], ["include_empty", "empty"]]) {
    if (params.has(key)) $(id).checked = params.get(key) === "true";
  }
}

for (const id of ["repo", "agent", "kind", "size", "from", "to", "group", "commits", "headless", "norepo", "empty", "more", "bucket", "token-metric", "markers"]) $(id).addEventListener("input", render);
render();
</script>
</body>
</html>
`;
}
