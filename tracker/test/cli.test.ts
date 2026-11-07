import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceHealthFixture } from "./helpers/source-health";
import { version } from "../package.json";

test("help lists commands and their flags without collecting or starting a server", () => {
  const dir = mkdtempSync(join(tmpdir(), "crewmeter-help-"));
  try {
    for (const command of [undefined, "collect", "serve", "mcp"]) {
      const result = spawnSync(process.execPath, [join(import.meta.dir, "../src/cli.ts"),
        ...(command ? [command] : []), "--help"], { cwd: dir, encoding: "utf8",
        env: { ...process.env, XDG_CACHE_HOME: dir } });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      for (const flag of ["--claude-dir", "--codex-dir", "--opencode-dir", "--since", "--ci",
        "--cache-dir", "--no-cache", "--help", "--version"]) expect(result.stdout).toContain(flag);
      if (!command) for (const name of ["collect", "serve", "mcp"]) expect(result.stdout).toContain(name);
      if (!command || command === "collect") {
        expect(result.stdout).toContain("--out");
        expect(result.stdout).toContain("--include-headless");
      }
      if (!command || command === "serve") {
        for (const flag of ["--host", "--port", "--open"]) expect(result.stdout).toContain(flag);
      }
    }
    for (const flag of ["--version", "-v"]) {
      const result = spawnSync(process.execPath, [join(import.meta.dir, "../src/cli.ts"), flag],
        { cwd: dir, encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(version);
      expect(result.stderr).toBe("");
    }
    expect(existsSync(join(dir, "out"))).toBe(false);
    expect(existsSync(join(dir, "crewmeter"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("collect warns once per flagged plugin/month even when multiple checks flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "crewmeter-warnings-"));
  try {
    const claude = join(dir, "claude");
    mkdirSync(join(claude, "project"), { recursive: true });
    for (const [month, n] of [["01", 5], ["02", 3]] as const) for (let i = 0; i < n; i++) {
      writeFileSync(join(claude, "project", `${month}-${i}.jsonl`), JSON.stringify({
        type: "assistant", sessionId: `${month}-${i}`, cwd: dir,
        timestamp: `2026-${month}-01T00:00:00Z`, message: month === "01" ? { model: "known", usage: { output_tokens: 1 } } : {},
      }));
    }
    const result = spawnSync(process.execPath, [join(import.meta.dir, "../src/cli.ts"), "collect", "--claude-dir", claude,
      "--codex-dir", join(dir, "missing"), "--opencode-dir", join(dir, "missing"), "--no-cache", "--out", join(dir, "report.html")], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const warnings = result.stderr.split("\n").filter(line => line.startsWith("Warning:"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("claude 2026-02 UTC");
    expect(warnings[0]).toContain("有回复但 token 全零的会话 / 会话 3/3");
    expect(warnings[0]).toContain("有回复但无模型的会话 / 会话 3/3");
    expect(result.stdout).not.toContain("Warning:");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("serve emits flagged file warnings on startup and cached refresh, only on stderr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tracker-serve-health-"));
  const options = sourceHealthFixture(dir);
  const child = spawn(process.execPath, [join(import.meta.dir, "../src/cli.ts"), "serve", "--port", "0",
    "--cache-dir", options.cacheDir, ...Object.entries(options.dirs).flatMap(([name, path]) => [`--${name}-dir`, path])],
    { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk);
  child.stderr.on("data", chunk => stderr += chunk);
  const exited = new Promise(resolve => child.once("exit", resolve));
  try {
    const deadline = Date.now() + 5000;
    while (!stderr.includes("dashboard:") && Date.now() < deadline) await Bun.sleep(10);
    const url = stderr.match(/dashboard: (http:\/\/[^\s]+)/)?.[1];
    expect(url).toBeDefined();
    expect((await fetch(new URL("/api/refresh", url), { method: "POST", headers: { "X-Crewmeter": "1" } })).status).toBe(200);
    const warnings = stderr.split("\n").filter(line => line.startsWith("Warning:"));
    expect(warnings).toHaveLength(4);
    for (const vendor of ["claude", "codex"]) expect(warnings.filter(line => line ===
      `Warning: ${vendor} 2026-02 UTC — 未产生会话的来源文件 / 来源文件 3/3`)).toHaveLength(2);
    expect(stderr).toContain("16 reused");
    expect(stdout).toBe("");
  } finally {
    child.kill("SIGTERM");
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
