import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../src/collect";
import { aggregate } from "../src/aggregate.js";
import { trend } from "../src/trend.js";
import { stdioClient } from "./helpers/mcp-client";

function fixture(dir: string) {
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

test("stdio initialize, five schemas, all tools, incremental refresh, and dashboard security", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crewmeter-mcp-"));
  const options = fixture(dir);
  const client = stdioClient(process.env.MCP_TEST_COMMAND ?? process.execPath, [process.env.MCP_TEST_ENTRY ?? join(import.meta.dir, "../src/cli.ts"), "mcp", "--cache-dir", options.cacheDir,
    ...Object.entries(options.dirs).flatMap(([name, path]) => [`--${name}-dir`, path])]);
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
  try {
    expect((await client.initialize()).serverInfo.name).toBe("crewmeter");
    const { tools } = await client.request("tools/list");
    expect(tools.map((t: any) => t.name).sort()).toEqual(["dashboard", "refresh", "summary", "tasks", "trend"]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      for (const key of ["from", "to", "repo", "agent", "commits_only", "include_headless", "include_empty"]) expect(tool.inputSchema.properties[key]).toBeDefined();
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
    const data = await collect(options, () => {});
    expect(data.tasks.some(t => t.reworked && t.mature)).toBe(true);
    expect(data.tasks.some(t => t.headless)).toBe(true);
    const defaultTasks = data.tasks.filter(t => t.repo && t.commits.length && !t.headless && !t.empty);
    const call = async (name: string, args = {}) => {
      const result = await client.call(name, args);
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toStartWith("筛选：");
      expect(result.content[0].text).toMatch(/\n生成于：\d{4}-/);
      expect(result.content[0].text).toContain("盲区：");
      return result;
    };
    for (const group of ["combo", "model", "agent", "repo"]) {
      const result = await call("summary", { group });
      const expected = aggregate(defaultTasks, (t: any) => group === "agent" ? t.vendor : t[group] || "?");
      expect(summaryNumbers(result.structuredContent.rows)).toEqual(summaryNumbers(expected));
      expect(result.structuredContent.rows.every((r: any) => r.smallSample)).toBe(true);
      expect(result.content[0].text).toContain("14天返工 k/n");
      for (const r of expected) expect(result.content[0].text).toContain(`| ${r.key} | ${r.tasks} | ${Math.round(r.landedRate! * 100)}% (${r.landed}/${r.withCommits}) | ${Math.round(r.reworkRate! * 100)}% (${Math.round((r.reworkRate ?? 0) * r.mature)}/${r.mature}) |`);
      expect(result.content[0].text.split("\n")[0]).toBe("筛选：只看有提交的任务；不含无人值守；不含空任务");
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
    expect(filteredSummary.content[0].text.split("\n")[0]).toBe(`筛选：从 2026-01-12；到 2026-02-10；仓库：${filters.repo}；agent：claude；含无提交的任务；含无人值守；含空任务`);
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
    expect((await client.call("summary", { group: "invalid" })).isError).toBe(true);
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
    expect((await client.request("tools/list")).tools).toHaveLength(5);
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
