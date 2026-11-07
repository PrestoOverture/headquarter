import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer, request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as mcpModule from "../src/mcp";
import { sourceHealthFixture } from "./helpers/source-health";
import { collect } from "../src/collect";
import { aggregate } from "../src/aggregate.js";
import { trend } from "../src/trend.js";
import { stdioClient } from "./helpers/mcp-client";

function fixture(dir: string, reworkFiles: Record<string, string> = {}) {
  const repo = join(dir, "repo");
  const claude = join(dir, "claude"), codex = join(dir, "codex");
  for (const path of [repo, claude, codex]) mkdirSync(path);
  const git = (args: string[], at = "2026-01-05T00:00:00Z") => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test", GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
    if (result.status) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  mkdirSync(join(claude, "project"));
  git(["init", "-b", "main"]);
  const add = (id: string, date: string, model: string, text: string, subject: string, headless = false) => {
    const at = Date.parse(date);
    writeFileSync(join(repo, "work.txt"), text);
    if (id === "first" || id === "second") for (const [file, original] of Object.entries(reworkFiles)) {
      writeFileSync(join(repo, file), id === "first" ? original : "fixed\n");
    }
    git(["add", "."]); git(["commit", "-m", subject], date);
    const sha = git(["rev-parse", "HEAD"]);
    const row = (type: string, offset: number, message: unknown) => ({ type, timestamp: new Date(at + offset).toISOString(), sessionId: id, cwd: repo, entrypoint: headless ? "sdk-cli" : "cli", message });
    writeFileSync(join(claude, "project", `${id}.jsonl`), [
      row("user", -2000, { content: "work" }),
      row("assistant", -1000, { model, content: [{ type: "tool_use", id: "commit", name: "Bash", input: { command: "git commit -m work" } }], usage: { input_tokens: 10 + at % 30, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: id.length * 10 } }),
      row("user", 0, { content: [{ type: "tool_result", tool_use_id: "commit", content: `[main ${sha.slice(0, 7)}] ${subject}` }] }),
      row("assistant", 1000, { model, content: "done" }),
    ].map(row => JSON.stringify(row)).join("\n"));
  };
  add("first", "2026-01-05T12:00:00Z", "A", "first\n", "feature");
  add("second", "2026-01-12T12:00:00Z", "B", "fixed\n", "fix feature");
  add("third", "2026-01-26T12:00:00Z", "C", "fixed\nmore\n", "more work");
  add("headless", "2026-02-02T12:00:00Z", "C", "fixed\nmore\nheadless\n", "headless", true);
  writeFileSync(join(claude, "project", "empty.jsonl"), JSON.stringify({ type: "user", timestamp: "2026-03-01T00:00:00Z", sessionId: "empty", cwd: repo, entrypoint: "cli", message: { content: "unfinished" } }));
  const at = "2026-02-10T00:00:00Z";
  writeFileSync(join(codex, "session.jsonl"), [
    { type: "session_meta", timestamp: at, payload: { id: "codex", cwd: repo, source: "vscode" } },
    { type: "turn_context", timestamp: at, payload: { model: "codex-model" } },
    { type: "event_msg", timestamp: at, payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 } } } },
  ].map(row => JSON.stringify(row)).join("\n"));
  return { dirs: { claude, codex, opencode: join(dir, "missing") }, cacheDir: join(dir, "cache") };
}

const summaryNumbers = (rows: any[]) => rows.map(r => ({ key: r.key, tasks: r.tasks, landed: r.landed,
  withCommits: r.withCommits, mature: r.mature, rework: Math.round((r.reworkRate ?? 0) * r.mature),
  medianInput: r.medianInput, medianCacheRead: r.medianCacheRead, medianCacheWrite: r.medianCacheWrite,
  medianOutput: r.medianOutput, promptsPerTask: r.promptsPerTask, interruptsPerTask: r.interruptsPerTask, waitMinPerTask: r.waitMinPerTask }));
const disclosure = "离机内容：汇总数字、仓库名、提交 sha 和标题、文件名；不含代码和对话内容";

test("stdio initialize, seven schemas, all tools, incremental refresh, and dashboard security", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crewmeter-mcp-"));
  const options = fixture(dir);
  const client = stdioClient(process.env.MCP_TEST_COMMAND ?? process.execPath, [process.env.MCP_TEST_ENTRY ?? join(import.meta.dir, "../src/cli.ts"), "mcp", "--cache-dir", options.cacheDir,
    ...Object.entries(options.dirs).flatMap(([name, path]) => [`--${name}-dir`, path])]);
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
  try {
    expect((await client.initialize()).serverInfo.name).toBe("crewmeter");
    const { tools } = await client.request("tools/list");
    expect(tools.map((t: any) => t.name).sort()).toEqual(["dashboard", "discover", "refresh", "report", "summary", "tasks", "trend"]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      if (tool.name === "discover") expect(tool.inputSchema.properties).toEqual({});
      else for (const key of ["from", "to", "repo", "agent", "commits_only", "include_headless", "include_empty", "include_ongoing"]) expect(tool.inputSchema.properties[key]).toBeDefined();
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
    const data = await collect(options, () => {});
    const discovered = await client.call("discover");
    expect(discovered.isError).not.toBe(true);
    expect(discovered.structuredContent.sources).toEqual(data.meta.sources);
    expect(discovered.structuredContent.sources.claude.paths).toEqual([{ path: options.dirs.claude, exists: true, detected: true }]);
    expect(discovered.structuredContent.sources.codex.paths).toEqual([{ path: options.dirs.codex, exists: true, detected: true }]);
    expect(discovered.structuredContent.sources.claude.first).toBe("2026-01-05");
    expect(discovered.structuredContent.sources.claude.last).toBe("2026-03-01");
    expect(discovered.structuredContent.sources.opencode).toEqual({
      paths: [{ path: options.dirs.opencode, exists: false, detected: false }],
      sessions: 0, first: null, last: null, checks: expect.any(Object),
    });
    expect(discovered.content[0].text).toContain("opencode：未找到");
    expect(discovered.content[0].text).toContain("总体 k/n");
    expect(discovered.content[0].text).toContain("月份 UTC");
    expect(discovered.content[0].text).toEndWith(disclosure);
    expect(data.tasks.some(t => t.reworked && t.mature)).toBe(true);
    expect(data.tasks.some(t => t.headless)).toBe(true);
    const defaultTasks = data.tasks.filter(t => t.repo && t.commits.length && !t.headless && !t.empty);
    const call = async (name: string, args = {}) => {
      const result = await client.call(name, args);
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toStartWith("筛选：");
      expect(result.content[0].text).toMatch(/\n生成于：\d{4}-/);
      expect(result.content[0].text).toContain("盲区：");
      expect(result.content[0].text).toEndWith(disclosure);
      return result;
    };
    expect((await client.request("prompts/list")).prompts.map((p: any) => p.name)).toContain("report");
    const prompt = await client.request("prompts/get", { name: "report" });
    expect(prompt.messages[0].content.text).toContain("调用 report 工具");
    expect(prompt.messages[0].content.text).toContain("原样展示");
    expect(prompt.messages[0].content.text).toEndWith(disclosure);
    const report = await call("report");
    const summary = await call("summary");
    const markdown = report.content[0].text;
    const sections = ["## 发现了什么", "## 组合汇总", "## 主模型切换", "## 小样本提示", "## 盲区", "## 本地仪表盘"];
    const positions = sections.map(section => markdown.indexOf(section));
    expect(positions.every((pos, i) => pos >= 0 && (i === 0 || pos > positions[i - 1]!))).toBe(true);
    expect(markdown.split("## 组合汇总\n\n")[1].split("\n\n## 主模型切换")[0]).toBe(summary.content[0].text.match(/\| 分组 \|[\s\S]*?(?=\n\n)/)![0]);
    expect(report.structuredContent.rows).toEqual(summary.structuredContent.rows);
    expect(report.structuredContent.switches).toEqual((await call("trend")).structuredContent.switches);
    expect(markdown).toContain(options.dirs.claude);
    expect(markdown).toContain("会话 n：5");
    expect(markdown).toContain("2026-01-05 至 2026-03-01");
    expect(markdown).toContain("解析健康异常月份：无");
    expect(markdown).toContain("调用 dashboard 工具可打开本地仪表盘");
    for (const group of ["combo", "model", "agent", "repo"]) {
      const result = await call("summary", { group });
      const expected = aggregate(defaultTasks, (t: any) => group === "agent" ? t.vendor : t[group] || "?");
      expect(summaryNumbers(result.structuredContent.rows)).toEqual(summaryNumbers(expected));
      expect(result.structuredContent.rows.every((r: any) => r.smallSample)).toBe(true);
      expect(result.content[0].text).toContain("14天返工 k/n");
      for (const r of expected) expect(result.content[0].text).toContain(`| ${r.key} | ${r.tasks} | ${Math.round(r.landedRate! * 100)}% (${r.landed}/${r.withCommits}) | ${Math.round(r.reworkRate! * 100)}% (${Math.round((r.reworkRate ?? 0) * r.mature)}/${r.mature}) |`);
      expect(result.content[0].text.split("\n")[0]).toBe("筛选：只看有提交的任务；不含无人值守；不含空任务；不含进行中任务");
      expect(result.content[0].text).toContain("| --- | --- |");
      expect(result.content[0].text).not.toContain("\t");
    }
    for (const bucket of ["week", "4week"] as const) for (const metric of ["input", "output"] as const) {
      const result = await call("trend", { bucket, metric });
      expect(result.structuredContent).toEqual(trend(defaultTasks, bucket, metric));
      if (bucket === "week") {
        expect(result.content[0].text).toContain("| claude | 2026-01-19 | – (0/0) | – | 0 |");
        expect(result.content[0].text).toContain("- 2026-01-12  claude: A → B\n- 2026-01-26  claude: B → C");
      }
      expect(result.content[0].text).not.toContain('"at":');
    }
    // Every specified filter is exercised together and also compared with the page below.
    const filters = { from: "2026-01-12", to: "2026-02-10", repo: data.tasks[0]!.repo!, agent: "claude", commits_only: false, include_headless: true, include_empty: true };
    const selected = data.tasks.filter(t => t.repo === filters.repo && t.vendor === "claude" && new Date(t.start).toISOString().slice(0, 10) >= filters.from && new Date(t.start).toISOString().slice(0, 10) <= filters.to);
    const filteredSummary = await call("summary", filters);
    expect(summaryNumbers(filteredSummary.structuredContent.rows)).toEqual(summaryNumbers(aggregate(selected, t => t.combo)));
    expect(filteredSummary.content[0].text.split("\n")[0]).toBe(`筛选：从 2026-01-12；到 2026-02-10；仓库：${filters.repo}；agent：claude；含无提交的任务；含无人值守；含空任务；不含进行中任务`);
    const recent = (await call("tasks", { limit: 2 })).structuredContent;
    expect(recent.tasks.map((t: any) => t.id)).toEqual(defaultTasks.slice().sort((a, b) => b.start - a.start).slice(0, 2).map(t => t.id));
    const keyedResult = await call("tasks", { group: "model", key: "A", limit: 100 });
    const keyed = keyedResult.structuredContent.tasks;
    expect(keyedResult.content[0].text).toContain("提交与返工证据");
    expect(keyedResult.content[0].text).toContain("；返工：");
    expect(keyedResult.content[0].text).toContain("| 返工 |");
    expect(keyedResult.content[0].text).not.toContain('"reworkEvidence":');
    expect(keyed).toHaveLength(1);
    expect(keyed[0].result).toBe("reworked");
    expect(keyed[0].commits[0].reworkEvidence.length).toBeGreaterThan(0);
    for (const args of [{ limit: 101 }, { limit: 0 }, { limit: 1.5 }]) expect((await client.call("tasks", args)).isError).toBe(true);
    const error = await client.call("summary", { group: "invalid" });
    expect(error.isError).toBe(true);
    expect(error.content[0].text).toEndWith(disclosure);
    expect((await client.call("trend", { bucket: "month" })).isError).toBe(true);
    expect((await client.call("summary", { from: "2026-02-31" })).isError).toBe(true);
    const file = join(options.dirs.claude, "project", "first.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace('"output_tokens":50', '"output_tokens":500'));
    const refreshed = await call("refresh");
    expect(refreshed.structuredContent.tasks).toBe(data.tasks.length);
    expect(refreshed.structuredContent.elapsedMs).toBeGreaterThan(0);
    expect(refreshed.content[0].text).toContain("会话：claude");
    expect(refreshed.content[0].text).toMatch(/耗时：\d+\.\d 毫秒/);
    const updated = await collect(options, () => {});
    expect(summaryNumbers((await call("summary")).structuredContent.rows)).toEqual(summaryNumbers(aggregate(updated.tasks.filter(t => t.repo && t.commits.length && !t.headless && !t.empty), t => t.combo)));
    expect(client.stderr).toContain("reused");
    const result = await call("dashboard", { ...filters, port: (occupied.address() as { port: number }).port });
    const url = result.structuredContent.url;
    expect(result.content[0].text).toContain(`仪表盘：${url}`);
    expect(new URL(url).hostname).toBe("127.0.0.1");
    expect(new URL(url).port).not.toBe(String((occupied.address() as { port: number }).port));
    expect((await call("dashboard", { port: 0 })).structuredContent.url.split("#")[0]).toBe(url.split("#")[0]);
    const page = await (await fetch(url)).text();
    expect(page).toContain('id="refresh"');
    const pageData = JSON.parse(page.match(/let DATA = (.*);/)![1]!);
    expect(pageData.tasks.length).toBe(updated.tasks.length);
    const { evaluateDashboard } = await import("./helpers/dashboard");
    const view = evaluateDashboard(page, url);
    const dashboardRows = view.read("aggregate(filtered(), keyFn())");
    expect(summaryNumbers((await call("summary", filters)).structuredContent.rows)).toEqual(summaryNumbers(dashboardRows));
    const forbidden = await new Promise<number>(resolve => {
      const req = request(url.split("#")[0], { headers: { Host: "evil.test" } }, res => { res.resume(); resolve(res.statusCode!); }); req.end();
    });
    expect(forbidden).toBe(403);
    const refreshURL = new URL("/api/refresh", url);
    expect((await fetch(refreshURL, { method: "POST" })).status).toBe(403);
    expect((await fetch(refreshURL, { method: "GET", headers: { "X-Crewmeter": "1" } })).status).toBe(403);
    expect((await fetch(refreshURL, { method: "POST", headers: { "X-Crewmeter": "1" } })).status).toBe(200);
    // A protocol refresh also updates the already-open dashboard snapshot.
    await call("refresh");
    const lastPage = JSON.parse((await (await fetch(url)).text()).match(/let DATA = (.*);/)![1]!);
    expect(lastPage.meta.generatedAt).toBeGreaterThan(pageData.meta.generatedAt);
  } finally {
    occupied.close();
    expect(await client.close()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP tasks returns only per-file rework counts and leaves local dashboard evidence intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crewmeter-mcp-privacy-"));
  const sourceFiles = {
    "work.txt": "const privateEvidenceAlpha = 101;\nconst privateEvidenceBeta = 202;\n",
    "other.ts": "export const privateEvidenceGamma = 303;\n",
  };
  const options = fixture(dir, sourceFiles);
  const client = stdioClient(process.env.MCP_TEST_COMMAND ?? process.execPath, [process.env.MCP_TEST_ENTRY ?? join(import.meta.dir, "../src/cli.ts"), "mcp",
    "--cache-dir", options.cacheDir, ...Object.entries(options.dirs).flatMap(([name, path]) => [`--${name}-dir`, path])]);
  try {
    await client.initialize();
    const data = await collect(options, () => {});
    const task = data.tasks.find(t => t.model === "A")!;
    const commit = task.commits[0]!;
    expect(commit.reworkEvidence).toHaveLength(1);
    const evidence = commit.reworkEvidence[0]!;
    expect(evidence.lines).toHaveLength(3);
    const result = await client.call("tasks");
    expect(result.isError).not.toBe(true);
    const serialized = JSON.stringify(result);
    for (const { text } of evidence.lines) expect(serialized).not.toContain(text);
    const returned = result.structuredContent.tasks.find((t: any) => t.id === task.id);
    expect(returned.repo).toBe(task.repo);
    expect(returned.commits[0].subject).toBe(commit.subject);
    const counts = Object.keys(sourceFiles).map(file => ({ file, lines: evidence.lines.filter(l => l.file === file).length }));
    expect(counts).toEqual([{ file: "work.txt", lines: 2 }, { file: "other.ts", lines: 1 }]);
    expect(returned.commits[0].reworkEvidence).toEqual([{
      sha: evidence.sha, subject: evidence.subject, days: evidence.days,
      files: expect.arrayContaining(counts),
    }]);
    expect(returned.commits[0].reworkEvidence[0].files).toHaveLength(2);
    for (const { file, lines } of counts) expect(result.content[0].text).toContain(`${file}: ${lines} 行`);
    expect(result.content[0].text).toContain(`${evidence.sha} ${evidence.subject}`);

    // Invalid values are not echoed by validation; unknown tool names are actionable.
    const unknown = await client.call("missing_tool");
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("未知工具：missing_tool");
    for (const { text } of evidence.lines) {
      const error = await client.call("tasks", { repo: text, limit: 0 });
      expect(error.isError).toBe(true);
      expect(JSON.stringify(error)).not.toContain(text);
      expect(error.content[0].text).toContain("limit");
      expect(error.content[0].text).toEndWith(disclosure);
    }
    const dashboard = await client.call("dashboard", { port: 0 });
    const page = await (await fetch(dashboard.structuredContent.url)).text();
    const pageData = JSON.parse(page.match(/let DATA = (.*);/)![1]!);
    const localTask = pageData.tasks.find((t: any) => t.id === task.id);
    expect(localTask.commits[0].reworkEvidence).toEqual(commit.reworkEvidence);
  } finally {
    expect(await client.close()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }
});


test("initial collect runs in the background, tools wait, and no-cache/since flags reach the worker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crewmeter-mcp-background-"));
  const options = fixture(dir);
  const bin = join(dir, "bin"), entered = join(dir, "entered"), release = join(dir, "release");
  mkdirSync(bin);
  // Gate git in the collection worker, while initialize/list must remain responsive.
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  const git = join(bin, "git");
  writeFileSync(git, `#!/bin/sh
touch '${entered}'
while [ ! -f '${release}' ]; do sleep 0.02; done
exec '${realGit}' "$@"
`);
  chmodSync(git, 0o755);
  const client = stdioClient("/usr/bin/env", [`PATH=${bin}:${process.env.PATH}`, process.env.MCP_TEST_COMMAND ?? process.execPath,
    process.env.MCP_TEST_ENTRY ?? join(import.meta.dir, "../src/cli.ts"), "mcp", "--no-cache", "--since", "2026-01-12",
    "--cache-dir", options.cacheDir, ...Object.entries(options.dirs).flatMap(([name, path]) => [`--${name}-dir`, path])]);
  let pending: Promise<any> | undefined;
  try {
    await client.initialize();
    let settled = false;
    pending = client.call("summary", { group: "combo" }).then(value => { settled = true; return value; });
    const deadline = Date.now() + 5000;
    while (!existsSync(entered) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(entered)).toBe(true);
    expect((await client.request("tools/list")).tools).toHaveLength(7);
    expect(settled).toBe(false);
    writeFileSync(release, "go");
    const result = await pending;
    expect(result.isError).not.toBe(true);
    const data = await collect({ ...options, noCache: true, since: "2026-01-12" }, () => {});
    const expected = aggregate(data.tasks.filter(t => t.repo && t.commits.length && !t.headless && !t.empty), t => t.combo);
    expect(summaryNumbers(result.structuredContent.rows)).toEqual(summaryNumbers(expected));
    expect(existsSync(options.cacheDir)).toBe(false);
  } finally {
    writeFileSync(release, "go");
    await pending?.catch(() => {});
    expect(await client.close()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }
});


test("MCP text rounds display values only, with unquoted Markdown cells and consistent token units", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crewmeter-mcp-format-"));
  const options = fixture(dir);
  const second = join(options.dirs.claude, "project", "second.jsonl");
  const rows = readFileSync(second, "utf8").split("\n").map(line => JSON.parse(line));
  rows[0].timestamp = "2026-01-12T10:00:00Z";
  rows[1].timestamp = "2026-01-12T10:15:00Z";
  rows[1].message.usage.output_tokens = 3743636;
  rows.splice(2, 0,
    { ...rows[0], timestamp: "2026-01-12T11:12:34Z", message: { content: "continue" } },
    { ...rows[0], timestamp: "2026-01-12T11:20:00Z", message: { content: "[Request interrupted by user]" } });
  writeFileSync(second, rows.map(row => JSON.stringify(row)).join("\n"));
  const third = join(options.dirs.claude, "project", "third.jsonl");
  const other = readFileSync(third, "utf8").split("\n").map(line => JSON.parse(line));
  other[0].timestamp = "2026-01-12T13:00:00Z";
  other[1].message.usage.output_tokens = 3743637;
  for (const row of other) if (row.message.model) row.message.model = "C|line\nmodel";
  writeFileSync(third, other.map(row => JSON.stringify(row)).join("\n"));
  const client = stdioClient(process.env.MCP_TEST_COMMAND ?? process.execPath, [process.env.MCP_TEST_ENTRY ?? join(import.meta.dir, "../src/cli.ts"), "mcp",
    "--cache-dir", options.cacheDir, ...Object.entries(options.dirs).flatMap(([name, path]) => [`--${name}-dir`, path])]);
  try {
    await client.initialize();
    const summary = await client.call("summary");
    expect(summary.content[0].text).toContain(" | 1.3 | 0.33 | 19.2 | 是 |");
    const selected = { from: "2026-01-12", to: "2026-01-26" };
    const result = await client.call("summary", selected);
    expect(result.isError).not.toBe(true);
    const data = await collect(options, () => {});
    const tasks = data.tasks.filter(t => t.repo && t.commits.length && !t.headless && !t.empty && t.start >= Date.parse(selected.from) && t.start < Date.parse(selected.to) + 86400000);
    expect(summaryNumbers(result.structuredContent.rows)).toEqual(summaryNumbers(aggregate(tasks, t => t.combo)));
    expect(result.structuredContent.rows[0].medianOutput).toBe(3743636.5);
    expect(result.content[0].text).toContain("| claude solo | 2 | 100% (2/2) | 0% (0/2) |");
    expect(result.content[0].text).toContain(" | 3743.6k | 1.5 | 0.50 | 28.8 | 是 |");
    expect(result.content[0].text).not.toMatch(/3743636\.5|"claude solo"|\t/);
    const measured = await client.call("trend", { ...selected, bucket: "week" });
    expect(measured.structuredContent).toEqual(trend(tasks, "week"));
    expect(measured.structuredContent.series[0].points[0].median).toBe(3743636.5);
    expect(measured.content[0].text).toContain("| claude | 2026-01-12 | 0% (0/2) | 3743.6k | 2 |");
    expect(measured.content[0].text).toContain("主模型切换：无");
    const recent = await client.call("tasks", selected);
    expect(recent.content[0].text).toContain("C\\|line<br>model");
    expect(recent.content[0].text).not.toContain('"C|line');
  } finally {
    expect(await client.close()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delayed worker returns non-error scanning within 15 seconds and real report on retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crewmeter-mcp-delay-"));
  const options = fixture(dir);
  const entry = join(dir, "delayed.ts");
  writeFileSync(entry, `import { mcp } from ${JSON.stringify(join(import.meta.dir, "../src/mcp.ts"))}; await mcp(${JSON.stringify(options)}, { collectionDelayMs: 16000 });`);
  const client = stdioClient(process.execPath, [entry]);
  try {
    await client.initialize();
    const start = performance.now();
    const scanning = await client.call("report");
    expect(performance.now() - start).toBeLessThanOrEqual(15000);
    expect(scanning.isError).not.toBe(true);
    expect(scanning.structuredContent.status).toBe("scanning");
    expect(scanning.structuredContent.progress).toEqual({ plugin: "准备", parsed: 0, reused: 0, elapsedSeconds: expect.any(Number) });
    expect(scanning.structuredContent.progress.elapsedSeconds).toBeGreaterThan(14);
    expect(scanning.content[0].text).toContain("扫描中：当前插件 准备；已解析 0 个文件；已复用 0 个文件");
    expect(scanning.content[0].text).toContain("采集仍在后台继续，请稍后重试 report");
    expect(scanning.content[0].text).toEndWith(disclosure);
    const report = await client.call("report");
    expect(report.isError).not.toBe(true);
    expect(report.content[0].text).toContain("## 组合汇总");
    expect(report.structuredContent.rows.reduce((n: number, row: any) => n + row.tasks, 0)).toBe(3);
    expect(report.content[0].text).toEndWith(disclosure);
    expect(client.stderr).toContain("files parsed");
  } finally {
    expect(await client.close()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("latest session record five minutes ago is excluded by MCP and dashboard unless include_ongoing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crewmeter-mcp-ongoing-"));
  const options = fixture(dir);
  const file = join(options.dirs.claude, "project", "third.jsonl");
  const rows = readFileSync(file, "utf8").split("\n").map(line => JSON.parse(line));
  rows.push({ ...rows.at(-1), timestamp: new Date(Date.now() - 5 * 60_000).toISOString() });
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n"));
  const progress: any[] = [];
  const data = await collect(options, () => {}, value => progress.push(value));
  const ongoing = data.tasks.find(t => t.model === "C" && !t.headless)!;
  expect(ongoing.ongoing).toBe(true);
  expect(data.tasks.find(t => t.model === "A")!.ongoing).toBe(false);
  expect(progress.some(p => p.plugin === "claude" && p.parsed > 0)).toBe(true);
  expect(progress.at(-1).parsed).toBe(6);
  expect(progress.at(-1).plugin).toBe("git/link");
  const reused: any[] = [];
  await collect(options, () => {}, value => reused.push(value));
  expect(reused.at(-1).reused).toBe(6);
  const client = stdioClient(process.env.MCP_TEST_COMMAND ?? process.execPath, [process.env.MCP_TEST_ENTRY ?? join(import.meta.dir, "../src/cli.ts"), "mcp",
    "--cache-dir", options.cacheDir, ...Object.entries(options.dirs).flatMap(([name, path]) => [`--${name}-dir`, path])]);
  try {
    await client.initialize();
    for (const name of ["report", "summary", "trend", "tasks", "refresh"]) {
      const result = await client.call(name);
      const included = await client.call(name, { include_ongoing: true });
      expect(result.isError).not.toBe(true);
      expect(included.isError).not.toBe(true);
      expect(result.content[0].text).toContain("已排除进行中任务：1");
      expect(included.content[0].text).toContain("已排除进行中任务：0");
      if (name === "summary" || name === "report") {
        expect(result.structuredContent.rows[0].tasks).toBe(2);
        expect(included.structuredContent.rows[0].tasks).toBe(3);
      } else if (name === "tasks") {
        expect(result.structuredContent.tasks.some((t: any) => t.id === ongoing.id)).toBe(false);
        expect(included.structuredContent.tasks.some((t: any) => t.id === ongoing.id)).toBe(true);
      } else if (name === "refresh") {
        expect(result.structuredContent.filteredTasks).toBe(2);
        expect(included.structuredContent.filteredTasks).toBe(3);
      } else {
        expect(result.structuredContent.series[0].points.reduce((n: number, p: any) => n + p.n, 0)).toBe(2);
        expect(included.structuredContent.series[0].points.reduce((n: number, p: any) => n + p.n, 0)).toBe(3);
      }
    }
    const dashboard = await client.call("dashboard", { port: 0 });
    expect(dashboard.content[0].text).toContain("已排除进行中任务：1");
    const page = await (await fetch(dashboard.structuredContent.url)).text();
    const { evaluateDashboard } = await import("./helpers/dashboard");
    const view = evaluateDashboard(page, dashboard.structuredContent.url);
    expect(view.read("filtered().length")).toBe(2);
    expect(view.get("ongoing-excluded").textContent).toBe("已排除进行中任务：1");
    view.change("ongoing", true);
    expect(view.read("filtered().length")).toBe(3);
    expect(view.get("ongoing-excluded").textContent).toBe("已排除进行中任务：0");
    const included = await client.call("dashboard", { include_ongoing: true });
    expect(new URL(included.structuredContent.url).hash).toContain("include_ongoing=true");
    expect(evaluateDashboard(page, included.structuredContent.url).read("filtered().length")).toBe(3);
    // Collection's terminal output keeps all eligible tasks, including ongoing ones.
    const { terminalTable } = await import("../src/report");
    expect(terminalTable(data.tasks.filter(t => t.repo && t.commits.length && !t.headless))).toContain("claude solo  3");
  } finally {
    expect(await client.close()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("all MCP tool responses abbreviate HOME in text and structured data", async () => {
  const home = homedir();
  const dir = mkdtempSync(join(home, ".crewmeter-mcp-home-"));
  const options = fixture(dir);
  const client = stdioClient(process.env.MCP_TEST_COMMAND ?? process.execPath, [process.env.MCP_TEST_ENTRY ?? join(import.meta.dir, "../src/cli.ts"), "mcp",
    "--cache-dir", options.cacheDir, ...Object.entries(options.dirs).flatMap(([name, path]) => [`--${name}-dir`, path])]);
  try {
    await client.initialize();
    for (const name of ["discover", "report", "summary", "trend", "tasks", "refresh", "dashboard"]) {
      const args = name === "discover" ? {} : { repo: join(home, "private-repo"), ...(name === "dashboard" ? { port: 0 } : {}) };
      const result = await client.call(name, args);
      expect(result.isError).not.toBe(true);
      const serialized = JSON.stringify(result);
      expect(serialized).toContain("~/");
      expect(serialized).not.toContain(home);
      expect(serialized).not.toContain(encodeURIComponent(home));
      if (name === "discover") expect(result.structuredContent.sources.claude.paths[0].path).toBe(options.dirs.claude.replace(home, "~"));
      expect(result.content[0].text).toEndWith(disclosure);
    }
  } finally {
    expect(await client.close()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP returns validation messages but logs internal exceptions only to stderr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crewmeter-mcp-errors-"));
  const options = fixture(dir);
  const secret = "private-internal-sentinel";
  symlinkSync(join(dir, secret), join(options.dirs.codex, secret + ".jsonl"));
  const client = stdioClient(process.env.MCP_TEST_COMMAND ?? process.execPath, [process.env.MCP_TEST_ENTRY ?? join(import.meta.dir, "../src/cli.ts"), "mcp",
    "--cache-dir", options.cacheDir, ...Object.entries(options.dirs).flatMap(([name, path]) => [`--${name}-dir`, path])]);
  try {
    await client.initialize();
    const invalid = await client.call("tasks", { limit: 0 });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain("limit");
    expect(invalid.content[0].text).toContain("must be >= 1");
    const unknown = await client.call("missing_tool");
    expect(unknown.content[0].text).toContain("未知工具：missing_tool");
    const failed = await client.call("summary");
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain("错误：工具调用失败");
    expect(JSON.stringify(failed)).not.toContain(secret);
    expect(JSON.stringify(failed)).not.toContain("ENOENT");
    expect(failed.content[0].text).toEndWith(disclosure);
    expect(client.stderr).toContain("MCP tool call failed:");
    expect(client.stderr).toContain(secret);
    expect(client.stderr).toContain("ENOENT");
    expect(client.stderr).toContain("statSync");
  } finally {
    expect(await client.close()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("home paths match separator boundaries, escape regex characters and preserve sibling prefixes", () => {
  for (const home of ["/home/user.[x]", "C:\\Users\\user.[x]"]) {
    const sibling = home + "-other/file";
    const encoded = encodeURIComponent(home);
    expect(mcpModule.homeRelative({ paths: [home, home + "/file", home + "\\file", sibling,
      encoded + "%2Ffile", encoded + "%5Cfile", encoded + "-other%2Ffile"] }, home)).toEqual({
      paths: ["~", "~/file", "~\\file", sibling, "~%2Ffile", "~%5Cfile", encoded + "-other%2Ffile"],
    });
  }
  for (const home of ["/", ""]) {
    const value = { path: "/home/file", encoded: "%2Fhome%2Ffile" };
    expect(mcpModule.homeRelative(value, home)).toEqual(value);
  }
});

test("Windows home paths are shortened before Markdown table backslash escaping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tracker-windows-home-"));
  const home = "C:\\Users\\private.[x]";
  const source = home + "\\sessions";
  const sibling = home + "-other\\sessions";
  const client = stdioClient("/usr/bin/env", [`HOME=${home}`, `BUN_RUNTIME_TRANSPILER_CACHE_PATH=${join(dir, "bun-cache")}`, process.env.MCP_TEST_COMMAND ?? process.execPath,
    process.env.MCP_TEST_ENTRY ?? join(import.meta.dir, "../src/cli.ts"), "mcp", "--cache-dir", join(dir, "cache"),
    "--claude-dir", source, "--codex-dir", sibling, "--opencode-dir", home]);
  try {
    await client.initialize();
    for (const name of ["discover", "report"]) {
      const result = await client.call(name);
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain("| ~\\\\sessions |");
      expect(result.content[0].text).toContain("| C:\\\\Users\\\\private.[x]-other\\\\sessions |");
      expect(result.structuredContent.sources.claude.paths[0].path).toBe("~\\sessions");
      expect(result.structuredContent.sources.codex.paths[0].path).toBe(sibling);
    }
  } finally {
    expect(await client.close()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown-only source files appear in discover, report and worker stderr on cached refresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tracker-mcp-health-"));
  const options = sourceHealthFixture(dir);
  const client = stdioClient(process.env.MCP_TEST_COMMAND ?? process.execPath, [process.env.MCP_TEST_ENTRY ?? join(import.meta.dir, "../src/cli.ts"), "mcp",
    "--cache-dir", options.cacheDir, ...Object.entries(options.dirs).flatMap(([name, path]) => [`--${name}-dir`, path])]);
  try {
    await client.initialize();
    for (const name of ["discover", "report"]) {
      const result = await client.call(name);
      expect(result.isError).not.toBe(true);
      for (const vendor of ["claude", "codex"]) {
        const check = result.structuredContent.sources[vendor].checks.unrecognized;
        expect(check.overall).toEqual({ k: 3, n: 8 });
        expect(check.months[1]).toMatchObject({ month: "2026-02", k: 3, n: 3, flagged: true });
      }
      expect(result.content[0].text).toContain("未产生会话的来源文件 / 来源文件");
      expect(result.content[0].text).toContain("2026-02");
    }
    await client.call("refresh");
    // Worker stderr and result messages use separate pipes; allow their delivery to catch up.
    const deadline = Date.now() + 3000;
    while (client.stderr.split("Warning:").length < 5 && Date.now() < deadline) await Bun.sleep(10);
    const warnings = client.stderr.split("\n").filter(line => line.startsWith("Warning:"));
    expect(warnings).toHaveLength(4);
    for (const vendor of ["claude", "codex"]) expect(warnings.filter(line => line ===
      `Warning: ${vendor} 2026-02 UTC — 未产生会话的来源文件 / 来源文件 3/3`)).toHaveLength(2);
    expect(client.stderr).toContain("16 reused");
    // A lone unknown file must remain visible even without an eligible monthly baseline.
    for (const vendor of ["claude", "codex"] as const) for (let i = 0; i < 8; i++) {
      if (i !== 5) rmSync(join(options.dirs[vendor], vendor === "claude" ? "project" : "", `${i}.jsonl`));
    }
    await client.call("refresh");
    for (const name of ["discover", "report"]) {
      const result = await client.call(name);
      for (const vendor of ["claude", "codex"]) {
        expect(result.structuredContent.sources[vendor].sessions).toBe(0);
        expect(result.structuredContent.sources[vendor].checks.unrecognized.overall).toEqual({ k: 1, n: 1 });
      }
      expect(result.content[0].text).toContain("100% (1/1)");
      expect(result.content[0].text).toContain("未产生会话的来源文件 / 来源文件");
    }
  } finally {
    expect(await client.close()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }
});
