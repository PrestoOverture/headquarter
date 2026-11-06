import type { Server as HttpServer } from "node:http";
import { Worker } from "node:worker_threads";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { aggregate } from "./aggregate.js";
import type { collect, CollectOptions } from "./collect";
import type { Task } from "./link";
import { serve } from "./server";
import { trend, type Bucket, type Metric } from "./trend.js";
import { version as VERSION } from "../package.json";

type Collection = Awaited<ReturnType<typeof collect>>;
type Group = "combo" | "model" | "agent" | "repo";
type Args = {
  from?: string; to?: string; repo?: string; agent?: string;
  commits_only?: boolean; include_headless?: boolean; include_empty?: boolean;
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
};
const group = { type: "string", enum: ["combo", "model", "agent", "repo"], default: "combo" };
const definitions: [string, string, Record<string, unknown>][] = [
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
  name, description, inputSchema: { type: "object", properties: { ...filters, ...extra }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}));
const validator = new AjvJsonSchemaValidator();
const validators = new Map(tools.map(tool => [tool.name, validator.getValidator<Args>(tool.inputSchema)]));
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
function applied(a: Args) {
  return { from: a.from ?? null, to: a.to ?? null, repo: a.repo ?? null, agent: a.agent ?? null,
    commits_only: a.commits_only ?? true, include_headless: a.include_headless ?? false, include_empty: a.include_empty ?? false };
}
function filterTasks(tasks: Task[], a: Args) {
  const f = applied(a);
  return tasks.filter(t => t.repo && (!f.repo || t.repo === f.repo) && (!f.agent || t.vendor === f.agent)
    && (!f.from || day(t.start) >= f.from) && (!f.to || day(t.start) <= f.to)
    && (f.include_empty || !t.empty) && (f.include_headless || !t.headless) && (!f.commits_only || t.commits.length > 0));
}
function keyOf(group: Group) {
  return (t: Task) => group === "model" ? t.model || "?" : group === "agent" ? t.vendor
    : group === "repo" ? t.repo || "(无仓库)" : t.combo;
}
const blindSpots = "盲区：仅含本地记录；提交可能按时间推测归属；14 天返工仅统计已成熟的合入任务，以及回滚或修复提交改写的行，不能覆盖所有缺陷。token 依赖记录中的用量；等你时间每段最多 60 分钟。任一分母 <20 标记为样本少。";
const cell = (value: unknown) => String(value ?? "–").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r\n|[\r\n]/g, "<br>").replace(/\t/g, " ");
const table = (header: string[], rows: unknown[][]) => [header, header.map(() => "---"), ...rows]
  .map(row => "| " + row.map(cell).join(" | ") + " |").join("\n");
const tokens = (value: number | null) => value === null ? "–" : (value / 1000).toFixed(1) + "k";
const rate = (k: number, n: number) => (n ? Math.round(k / n * 100) + "%" : "–") + ` (${k}/${n})`;
function filterText(a: Args) {
  const f = applied(a);
  return "筛选：" + [f.from && `从 ${f.from}`, f.to && `到 ${f.to}`, f.repo && `仓库：${f.repo}`, f.agent && `agent：${f.agent}`,
    f.commits_only ? "只看有提交的任务" : "含无提交的任务", f.include_headless ? "含无人值守" : "不含无人值守",
    f.include_empty ? "含空任务" : "不含空任务"].filter(Boolean).map(cell).join("；");
}
const resultLabels: Record<string, string> = {
  "no commits": "–", "not landed": "未合入", reverted: "回滚", reworked: "返工", "survived 14 days": "存活", "landed (observing)": "合入（观察中）",
};

export async function mcp(options: CollectOptions) {
  let current: Collection | undefined;
  let running: Promise<Collection> | undefined;
  let worker: Worker | undefined;
  let dashboard: HttpServer | undefined;
  let opening: Promise<HttpServer> | undefined;
  function refresh(): Promise<Collection> {
    if (!running) {
      const pending = new Promise<Collection>((resolve, reject) => {
        const activeWorker = worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "./collect-worker.ts" : "./collect-worker.js", import.meta.url), {
          workerData: options, stdout: true, stderr: true,
        });
        // Even accidental parser stdout must never reach the protocol stream.
        activeWorker.stdout.pipe(process.stderr, { end: false });
        activeWorker.stderr.pipe(process.stderr, { end: false });
        activeWorker.once("message", (data: Collection) => { current = data; resolve(data); });
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
  const server = new Server({ name: "crewmeter", version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const a = (request.params.arguments ?? {}) as Args;
    let data: Collection | undefined;
    const result = (body: string, structuredContent?: Record<string, unknown>, isError = false) => ({
      content: [{ type: "text" as const, text: `${filterText(a)}\n生成于：${data ? new Date(data.meta.generatedAt).toISOString() : "未知"}\n\n${body}\n\n${blindSpots}` }],
      ...(structuredContent ? { structuredContent } : {}), ...(isError ? { isError } : {}),
    });
    try {
      const validate = validators.get(request.params.name);
      if (!validate) throw new Error(`未知工具：${request.params.name}`);
      const checked = validate(a);
      if (!checked.valid) throw new Error(checked.errorMessage);
      try { data = await (running ?? (current ? Promise.resolve(current) : ready)); }
      catch (error) { if (request.params.name !== "refresh") throw error; }
      if (request.params.name === "refresh") {
        const start = performance.now();
        data = await refresh();
        const counts = { sessions: data.meta.sessions, repos: data.meta.repos, tasks: data.tasks.length,
          filteredTasks: filterTasks(data.tasks, a).length, elapsedMs: performance.now() - start };
        return result(`会话：${Object.entries(counts.sessions).map(([name, n]) => `${name} ${n}`).join("；")}\n仓库 n：${counts.repos}；任务 n：${counts.tasks}；筛选后任务 n：${counts.filteredTasks}\n耗时：${counts.elapsedMs.toFixed(1)} 毫秒`, counts);
      }
      data ??= current!;
      const ts = filterTasks(data.tasks, a);
      if (request.params.name === "summary") {
        const rows = aggregate(ts, keyOf(a.group ?? "combo")).map(r => ({ ...r,
          rework: Math.round((r.reworkRate ?? 0) * r.mature), smallSample: r.tasks < 20 || r.withCommits < 20 || r.mature < 20,
        }));
        return result(table(["分组", "任务 n", "合入率 k/n", "14天返工 k/n", "输入 k 中位数", "缓存读 k 中位数", "缓存写 k 中位数", "输出 k 中位数", "插话/任务", "打断/任务", "等你 分/任务", "样本少"],
          rows.map(r => [r.key, r.tasks, rate(r.landed, r.withCommits), rate(r.rework, r.mature), tokens(r.medianInput), tokens(r.medianCacheRead), tokens(r.medianCacheWrite), tokens(r.medianOutput), r.promptsPerTask.toFixed(1), r.interruptsPerTask.toFixed(2), r.waitMinPerTask.toFixed(1), r.smallSample ? "是" : "否"])), { rows });
      }
      if (request.params.name === "trend") {
        const measured = trend(ts, a.bucket, a.metric);
        return result(table(["agent", "时间桶 UTC", "14天返工 k/n", a.metric === "input" ? "总输入 k 中位数（含缓存）" : "输出 k 中位数", "任务 n"], measured.series.flatMap(s => s.points.map(p => [s.vendor, day(p.at), rate(p.k, p.mature), tokens(p.median), p.n])))
          + "\n\n主模型切换：" + (measured.switches.length ? "\n\n" + measured.switches.map(p => `- ${day(p.at)}  ${cell(p.vendor)}: ${cell(p.old)} → ${cell(p.model)}`).join("\n") : "无"), measured);
      }
      if (request.params.name === "tasks") {
        const matched = ts.filter(t => a.key === undefined || keyOf(a.group ?? "combo")(t) === a.key);
        const rows = matched.sort((a, b) => b.start - a.start).slice(0, a.limit ?? 20).map(t => ({
            id: t.id, date: day(t.start), combo: t.combo, repo: t.repo, model: t.model ?? "?",
            commits: t.commits.map(c => ({ sha: c.sha, subject: c.subject, mainline: c.mainline, how: c.how, reworkEvidence: c.reworkEvidence })),
            result: !t.commits.length ? "no commits" : !t.landed ? "not landed" : t.reverted ? "reverted" : t.reworked ? "reworked" : t.mature ? "survived 14 days" : "landed (observing)",
          }));
        return result(table(["开始", "组合", "仓库", "主模型", "提交与返工证据", "结果"], rows.map(t => [t.date, t.combo, t.repo, t.model,
          t.commits.map(c => `${c.sha} ${c.subject}（${c.mainline ? "合入" : "未合入"}，${c.how === "exact" ? "精确" : "猜"}）` +
            c.reworkEvidence.map(e => `；返工：${e.sha} ${e.subject}（间隔 ${e.days.toFixed(1)} 天）` + e.lines.map(l => `；${l.file}: ${l.text}`).join("")).join("")).join("\n") || "–", resultLabels[t.result]])), { tasks: rows, n: rows.length, total: matched.length });
      }
      if (!opening) opening = (async () => {
        try { return await serve({ host: "127.0.0.1", port: a.port ?? 4317 }, refresh, () => current!); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
          return serve({ host: "127.0.0.1", port: 0 }, refresh, () => current!);
        }
      })().then(value => dashboard = value).catch(error => { opening = undefined; throw error; });
      const http = await opening;
      // serve's initial load may have refreshed the snapshot.
      data = current!;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(applied(a))) if (value !== null) params.set(key, String(value));
      const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/#${params}`;
      return result(`仪表盘：${url}`, { url });
    } catch (error) {
      data ??= current;
      return result(`错误：${(error as Error).message}`, undefined, true);
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
