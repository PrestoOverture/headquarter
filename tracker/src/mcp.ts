import { homedir } from "node:os";
import type { Server as HttpServer } from "node:http";
import { Worker } from "node:worker_threads";
import { setTimeout, clearTimeout } from "node:timers";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { aggregate } from "./aggregate.js";
import { checkLabels } from "./diagnostics";
import type { collect, CollectOptions, CollectProgress } from "./collect";
import type { Task } from "./link";
import { serve } from "./server";
import { trend, type Bucket, type Metric } from "./trend.js";
import { version as VERSION } from "../package.json";

type Collection = Awaited<ReturnType<typeof collect>>;
type Group = "combo" | "model" | "agent" | "repo";
type Args = {
  from?: string; to?: string; repo?: string; agent?: string;
  commits_only?: boolean; include_headless?: boolean; include_empty?: boolean; include_ongoing?: boolean;
  group?: Group; key?: string; limit?: number; bucket?: Bucket; metric?: Metric; port?: number;
};
const filters = {
  from: { type: "string", format: "date", description: "Inclusive task start date, UTC (YYYY-MM-DD)." },
  to: { type: "string", format: "date", description: "Inclusive task start date, UTC (YYYY-MM-DD)." },
  repo: { type: "string", description: "Exact dashboard repository name." },
  agent: { type: "string", description: "Exact root agent/vendor name." },
  commits_only: { type: "boolean", default: true },
  include_headless: { type: "boolean", default: false },
  include_empty: { type: "boolean", default: false },
  include_ongoing: { type: "boolean", default: false },
};
const group = { type: "string", enum: ["combo", "model", "agent", "repo"], default: "combo" };
const definitions: [string, string, Record<string, unknown>][] = [
  ["discover", "本地来源路径、检测状态、会话日期及解析健康检查（全部会话，不受任务筛选影响）。", {}],
  ["report", "一次返回固定顺序的中文报告：来源、组合汇总、主模型切换、样本少提示、盲区及本地仪表盘入口。请原样展示。", {}],
  ["summary", "Measured task outcomes, token medians and attention means by group.", { group }],
  ["trend", "UTC vendor/bucket measurements and dominant root-model switches, matching the dashboard.", {
    bucket: { type: "string", enum: ["week", "4week"], default: "4week" },
    metric: { type: "string", enum: ["output", "input"], default: "output", description: "Input includes cache reads and writes." },
  }],
  ["tasks", "Recent tasks and recorded rework evidence; key matches a summary group exactly.", {
    group, key: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  }],
  ["refresh", "Rerun incremental collection and report counts and elapsed time. Filters apply to reported task count.", {}],
  ["dashboard", "Open an in-process loopback dashboard. Filters are applied in the returned dashboard URL.", {
    port: { type: "integer", minimum: 0, maximum: 65535, default: 4317, description: "Falls back to a free port if occupied; 0 requests a free port." },
  }],
];
const tools: Tool[] = definitions.map(([name, description, extra]) => ({
  name, description, inputSchema: { type: "object", properties: name === "discover" ? {} : { ...filters, ...extra }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}));
const validator = new AjvJsonSchemaValidator();
const validators = new Map(tools.map(tool => [tool.name, validator.getValidator<Args>(tool.inputSchema)]));
// Apply at the response boundary so text, filters and nested structured data agree.
export function homeRelative<T>(value: T, home = homedir()): T {
  if (!home || home === "/") return value;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const raw = new RegExp(escape(home) + "(?=[/\\\\]|$)", "g");
  const encoded = new RegExp(escape(encodeURIComponent(home)) + "(?=%2F|%5C|$)", "g");
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "string"
    ? item.replace(raw, "~").replace(encoded, "~") : item));
}
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
function applied(a: Args) {
  return { from: a.from ?? null, to: a.to ?? null, repo: a.repo ?? null, agent: a.agent ?? null,
    commits_only: a.commits_only ?? true, include_headless: a.include_headless ?? false, include_empty: a.include_empty ?? false, include_ongoing: a.include_ongoing ?? false };
}
function filterTasks(tasks: Task[], a: Args) {
  const f = applied(a);
  return tasks.filter(t => t.repo && (!f.repo || t.repo === f.repo) && (!f.agent || t.vendor === f.agent)
    && (!f.from || day(t.start) >= f.from) && (!f.to || day(t.start) <= f.to)
    && (f.include_ongoing || !t.ongoing) && (f.include_empty || !t.empty) && (f.include_headless || !t.headless) && (!f.commits_only || t.commits.length > 0));
}
function keyOf(group: Group) {
  return (t: Task) => group === "model" ? t.model || "?" : group === "agent" ? t.vendor
    : group === "repo" ? t.repo || "(无仓库)" : t.combo;
}
const blindSpots = "盲区：仅含本地记录；提交可能按时间推测归属；14 天返工仅统计已成熟的合入任务，以及回滚或修复提交改写的行，不能覆盖所有缺陷。token 依赖记录中的用量；等你时间每段最多 60 分钟。任一分母 <20 标记为样本少。";
const disclosure = "离机内容：汇总数字、仓库名、提交 sha 和标题、文件名；不含代码和对话内容";
const cell = (value: unknown) => homeRelative(String(value ?? "–")).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r\n|[\r\n]/g, "<br>").replace(/\t/g, " ");
const table = (header: string[], rows: unknown[][]) => [header, header.map(() => "---"), ...rows]
  .map(row => "| " + row.map(cell).join(" | ") + " |").join("\n");
const tokens = (value: number | null) => value === null ? "–" : (value / 1000).toFixed(1) + "k";
const rate = (k: number, n: number) => (n ? Math.round(k / n * 100) + "%" : "–") + ` (${k}/${n})`;
function filterText(a: Args) {
  const f = applied(a);
  return "筛选：" + [f.from && `从 ${f.from}`, f.to && `到 ${f.to}`, f.repo && `仓库：${f.repo}`, f.agent && `agent：${f.agent}`,
    f.commits_only ? "只看有提交的任务" : "含无提交的任务", f.include_headless ? "含无人值守" : "不含无人值守",
    f.include_empty ? "含空任务" : "不含空任务", f.include_ongoing ? "含进行中任务" : "不含进行中任务"].filter(Boolean).map(cell).join("；");
}
const resultLabels: Record<string, string> = {
  "no commits": "–", "not landed": "未合入", reverted: "回滚", reworked: "返工", "survived 14 days": "存活", "landed (observing)": "合入（观察中）",
};

function summaryRows(ts: Task[], group: Group = "combo") {
  return aggregate(ts, keyOf(group)).map(r => ({ ...r,
    rework: Math.round((r.reworkRate ?? 0) * r.mature), smallSample: r.tasks < 20 || r.withCommits < 20 || r.mature < 20,
  }));
}
function summaryTable(rows: ReturnType<typeof summaryRows>) {
  return table(["分组", "任务 n", "合入率 k/n", "14天返工 k/n", "输入 k 中位数", "缓存读 k 中位数", "缓存写 k 中位数", "输出 k 中位数", "插话/任务", "打断/任务", "等你 分/任务", "样本少"],
          rows.map(r => [r.key, r.tasks, rate(r.landed, r.withCommits), rate(r.rework, r.mature), tokens(r.medianInput), tokens(r.medianCacheRead), tokens(r.medianCacheWrite), tokens(r.medianOutput), r.promptsPerTask.toFixed(1), r.interruptsPerTask.toFixed(2), r.waitMinPerTask.toFixed(1), r.smallSample ? "是" : "否"]));
}
function switchesText(measured: ReturnType<typeof trend>) {
  return measured.switches.length ? measured.switches.map(p => `- ${day(p.at)}  ${cell(p.vendor)}: ${cell(p.old)} → ${cell(p.model)}`).join("\n") : "无";
}
function foundText(data: Collection) {
  return Object.entries(data.meta.sources).map(([name, source]) => {
    const flagged = Object.entries(source.checks).flatMap(([check, value]) => value.months.filter(m => m.flagged)
      .map(m => `${m.month} UTC：${checkLabels[check as keyof typeof checkLabels]} ${m.k}/${m.n}`));
    return `### ${cell(name)}：${source.paths.some(p => p.detected) ? "已找到" : "未找到"}\n\n` +
      table(["尝试路径", "存在", "检测到记录"], source.paths.map(p => [p.path, p.exists ? "是" : "否", p.detected ? "是" : "否"])) +
      `\n\n会话 n：${source.sessions}；日期范围 UTC：${source.first ?? "–"} 至 ${source.last ?? "–"}\n\n${checkLabels.unrecognized}：${rate(source.checks.unrecognized.overall.k, source.checks.unrecognized.overall.n)}（月份按文件 mtime UTC）\n\n解析健康异常月份：${flagged.length ? "\n\n" + flagged.map(v => "- " + v).join("\n") : "无"}`;
  }).join("\n\n");
}

export async function mcp(options: CollectOptions, runtime: { collectionDelayMs?: number } = {}) {
  let current: Collection | undefined;
  let running: Promise<Collection> | undefined;
  let worker: Worker | undefined;
  let dashboard: HttpServer | undefined;
  let opening: Promise<HttpServer> | undefined;
  let startedAt = Date.now();
  let progress: CollectProgress = { plugin: "准备", parsed: 0, reused: 0, elapsedSeconds: 0 };
  function refresh(): Promise<Collection> {
    if (!running) {
      startedAt = Date.now();
      progress = { plugin: "准备", parsed: 0, reused: 0, elapsedSeconds: 0 };
      const pending = new Promise<Collection>((resolve, reject) => {
        const activeWorker = worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "./collect-worker.ts" : "./collect-worker.js", import.meta.url), {
          workerData: { options, delayMs: runtime.collectionDelayMs }, stdout: true, stderr: true,
        });
        // Even accidental parser stdout must never reach the protocol stream.
        activeWorker.stdout.pipe(process.stderr, { end: false });
        activeWorker.stderr.pipe(process.stderr, { end: false });
        activeWorker.on("message", (message: { type: "progress"; progress: CollectProgress } | { type: "complete"; data: Collection }) => {
          if (message.type === "progress") progress = message.progress;
          else { current = message.data; resolve(message.data); }
        });
        activeWorker.once("error", reject);
        activeWorker.once("exit", code => { reject(new Error(`Collection worker exited before returning data (${code})`)); if (worker === activeWorker) worker = undefined; });
      });
      running = pending.finally(() => { running = undefined; });
    }
    return running;
  }
  const ready = refresh();
  // Initialization/listing remain available even if initial collection fails; calls report the failure.
  void ready.catch(error => console.error("initial collection failed:", error));
  const server = new Server({ name: "crewmeter", version: VERSION }, { capabilities: { tools: {}, prompts: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: "report", description: "调用 report 工具并原样展示中文报告。" }] }));
  server.setRequestHandler(GetPromptRequestSchema, async request => ({ messages: [{ role: "user", content: { type: "text",
    text: (request.params.name === "report" ? "请调用 report 工具，将其返回的中文 Markdown 原样展示，不要改写或重新计算。若返回扫描中，请稍后重试 report。" : "错误：未知提示。") + "\n\n" + disclosure,
  } }] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const a = (request.params.arguments ?? {}) as Args;
    let data: Collection | undefined;
    const result = (body: string, structuredContent?: Record<string, unknown>, isError = false) => homeRelative({
      content: [{ type: "text" as const, text: `${request.params.name === "discover" ? "范围：全部来源会话（任务筛选不适用）" : filterText(isError ? {} : a)}\n生成于：${data ? new Date(data.meta.generatedAt).toISOString() : "未知"}\n\n${data ? `已排除进行中任务：${filterTasks(data.tasks, { ...(isError ? {} : a), include_ongoing: true }).length - filterTasks(data.tasks, isError ? {} : a).length}（最新会话记录距采集时间 30 分钟内）\n\n` : ""}${body}${request.params.name === "report" && !isError && data ? "" : "\n\n" + blindSpots}\n\n${disclosure}` }],
      ...(structuredContent ? { structuredContent } : {}), ...(isError ? { isError } : {}),
    });
    try {
      const validate = validators.get(request.params.name);
      if (!validate) return result(`错误：未知工具：${request.params.name}`, undefined, true);
      const checked = validate(a);
      if (!checked.valid) return result(`错误：${checked.errorMessage}`, undefined, true);
      const start = performance.now();
      const pending = request.params.name === "refresh" ? refresh() : (running ?? (current ? Promise.resolve(current) : ready));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        data = await Promise.race([pending, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 14_900); })]);
      } finally { clearTimeout(timer); }
      if (!data) {
        const snapshot = { ...progress, elapsedSeconds: (Date.now() - startedAt) / 1000 };
        return result(`扫描中：当前插件 ${cell(snapshot.plugin)}；已解析 ${snapshot.parsed} 个文件；已复用 ${snapshot.reused} 个文件；已耗时 ${snapshot.elapsedSeconds.toFixed(1)} 秒。采集仍在后台继续，请稍后重试 ${cell(request.params.name)}。`, { status: "scanning", progress: snapshot });
      }
      if (request.params.name === "refresh") {
        const counts = { sessions: data.meta.sessions, repos: data.meta.repos, tasks: data.tasks.length,
          filteredTasks: filterTasks(data.tasks, a).length, elapsedMs: performance.now() - start };
        return result(`会话：${Object.entries(counts.sessions).map(([name, n]) => `${name} ${n}`).join("；")}\n仓库 n：${counts.repos}；任务 n：${counts.tasks}；筛选后任务 n：${counts.filteredTasks}\n耗时：${counts.elapsedMs.toFixed(1)} 毫秒`, counts);
      }
      data ??= current!;
      if (request.params.name === "discover") {
        const sections = Object.entries(data.meta.sources).map(([name, source]) => {
          const paths = table(["尝试路径", "存在", "检测到记录"], source.paths.map(p => [p.path, p.exists ? "是" : "否", p.detected ? "是" : "否"]));
          const checks = Object.entries(source.checks);
          return `### ${name}：${source.paths.some(p => p.detected) ? "已找到" : "未找到"}\n\n${paths}\n\n会话 n：${source.sessions}；首个会话 UTC：${source.first ?? "–"}；末个会话 UTC：${source.last ?? "–"}\n\n` +
            table(["检查", "总体 k/n"], checks.map(([key, value]) => [checkLabels[key as keyof typeof checkLabels], rate(value.overall.k, value.overall.n)])) + "\n\n" +
            table(["检查", "月份 UTC", "k/n", "历史中位率", "异常"], checks.flatMap(([key, value]) => value.months.map(m => [checkLabels[key as keyof typeof checkLabels], m.month, rate(m.k, m.n), m.baseline === null ? "无基线" : `${(m.baseline * 100).toFixed(1)}%`, m.flagged ? "是" : "否"])));
        });
        return result(sections.join("\n\n") + "\n\n规则：来源文件检查按文件 mtime 归入 UTC 月；其余检查按会话开始时间归入 UTC 月，无有效日期只计总体。k≥3 且比此前最多 6 个 n≥5 的月份的中位率高至少 5 个百分点才标记；无基线不标记。JSONL 计非空行，OpenCode 计会话、消息及其 part 行；未识别记录不等于 JSON 解析失败。", { sources: data.meta.sources });
      }
      const ts = filterTasks(data.tasks, a);
      if (request.params.name === "report") {
        const rows = summaryRows(ts);
        const measured = trend(ts);
        const small = rows.filter(r => r.smallSample);
        return result(`## 发现了什么\n\n${foundText(data)}\n\n## 组合汇总\n\n${summaryTable(rows)}\n\n## 主模型切换\n\n${switchesText(measured)}\n\n## 小样本提示\n\n任一分母 <20 标记为样本少；token 为每任务中位数，注意力为每任务均值。${small.length ? "样本少的组合：" + small.map(r => cell(r.key)).join("、") + "。" : rows.length ? "当前组合均无样本少标记。" : "当前筛选无任务。"}\n\n## 盲区\n\n${blindSpots}\n\n## 本地仪表盘\n\n调用 dashboard 工具可打开本地仪表盘。`, { rows, switches: measured.switches, sources: data.meta.sources });
      }
      if (request.params.name === "summary") {
        const rows = summaryRows(ts, a.group);
        return result(summaryTable(rows), { rows });
      }
      if (request.params.name === "trend") {
        const measured = trend(ts, a.bucket, a.metric);
        return result(table(["agent", "时间桶 UTC", "14天返工 k/n", a.metric === "input" ? "总输入 k 中位数（含缓存）" : "输出 k 中位数", "任务 n"], measured.series.flatMap(s => s.points.map(p => [s.vendor, day(p.at), rate(p.k, p.mature), tokens(p.median), p.n])))
          + "\n\n主模型切换：" + (measured.switches.length ? "\n\n" + switchesText(measured) : "无"), measured);
      }
      if (request.params.name === "tasks") {
        const matched = ts.filter(t => a.key === undefined || keyOf(a.group ?? "combo")(t) === a.key);
        const rows = matched.sort((a, b) => b.start - a.start).slice(0, a.limit ?? 20).map(t => ({
            id: t.id, date: day(t.start), combo: t.combo, repo: t.repo, model: t.model ?? "?",
            commits: t.commits.map(c => ({ sha: c.sha, subject: c.subject, mainline: c.mainline, how: c.how,
              reworkEvidence: c.reworkEvidence.map(e => {
                const counts = new Map<string, number>();
                for (const { file } of e.lines) counts.set(file, (counts.get(file) ?? 0) + 1);
                return { sha: e.sha, subject: e.subject, days: e.days,
                  files: [...counts].map(([file, lines]) => ({ file, lines })) };
              }),
            })),
            result: !t.commits.length ? "no commits" : !t.landed ? "not landed" : t.reverted ? "reverted" : t.reworked ? "reworked" : t.mature ? "survived 14 days" : "landed (observing)",
          }));
        return result(table(["开始", "组合", "仓库", "主模型", "提交与返工证据", "结果"], rows.map(t => [t.date, t.combo, t.repo, t.model,
          t.commits.map(c => `${c.sha} ${c.subject}（${c.mainline ? "合入" : "未合入"}，${c.how === "exact" ? "精确" : "猜"}）` +
            c.reworkEvidence.map(e => `；返工：${e.sha} ${e.subject}（间隔 ${e.days.toFixed(1)} 天）` + e.files.map(f => `；${f.file}: ${f.lines} 行`).join("")).join("")).join("\n") || "–", resultLabels[t.result]])), { tasks: rows, n: rows.length, total: matched.length });
      }
      if (!opening) opening = (async () => {
        try { return await serve({ host: "127.0.0.1", port: a.port ?? 4317 }, refresh, () => current!); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
          return serve({ host: "127.0.0.1", port: 0 }, refresh, () => current!);
        }
      })().then(value => dashboard = value).catch(error => { opening = undefined; throw error; });
      const http = await opening;
      // Use the latest snapshot if a concurrent refresh completed during binding.
      data = current!;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(applied(a))) if (value !== null) params.set(key, String(value));
      const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/#${params}`;
      return result(`仪表盘：${url}`, { url });
    } catch (error) {
      console.error("MCP tool call failed:", error);
      data ??= current;
      // Internal exceptions can contain local source or conversation text.
      return result("错误：工具调用失败，请检查工具名称、参数或本地采集状态。", undefined, true);
    }
  });
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    await worker?.terminate();
    // Wait for a pending dashboard bind before closing its owned HTTP server.
    await opening?.catch(() => {});
    dashboard?.closeAllConnections();
    dashboard?.close();
    await server.close();
  }
  process.stdin.once("end", () => void close());
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  await server.connect(new StdioServerTransport());
}
