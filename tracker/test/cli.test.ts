import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
