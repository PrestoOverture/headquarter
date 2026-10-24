// M0.0 (roadmap M0 实施计划): prove this repo's tests, git commits and process control work
// inside the Claude Code sandbox, and that the sandbox keeps an executor away from what
// the merge lock relies on (main's ref, git hooks and config).
//
//   bun scripts/sandbox/check.ts
//
// Makes a linked worktree on a throwaway branch, runs `claude -p` there with the sandbox
// settings below, has Claude's Bash tool run probe.sh once, and reads the probe's output
// from the tool result in the stream (not from the model's summary). Then confirms from
// outside the sandbox that main, the hooks and the config are unchanged, and cleans up.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MODEL = "claude-haiku-5-5";
const PROBE = "bash scripts/sandbox/probe.sh";

export const EXPECTED = [
  "tests", "commit", "spawn_kill", "spawn_kill_tree", "tmp_write", "local_listen",
  "hooks_write", "config_write", "main_update_ref", "main_ref_file", "packed_refs_write",
  "home_write", "codex_home_write", "ssh_read", "net_direct", "net_proxy",
];

export function git(args: string[], cwd: string): string {
  const p = Bun.spawnSync(["git", ...args], { cwd });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

/** Settings for the executor sessions (tech_stacks.md 沙箱与安全), plus the merge-lock denials. */
export function sandboxSettings(commonDir: string, home: string) {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyWrite: [join(commonDir, "refs/heads/main"), join(commonDir, "packed-refs")],
      },
      credentials: {
        files: [".ssh", ".aws", ".gnupg", ".config/gh", ".netrc"].map((p) => ({ path: join(home, p), mode: "deny" })),
      },
      // Tests start local servers (eval's proxy test listens on 127.0.0.1). On macOS this
      // also lets commands connect to anything already listening on localhost.
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: true },
    },
  };
}

/** PASS/FAIL lines from the Bash tool results in a stream-json log. */
export function probeLines(streamJson: string): string[] {
  const out: string[] = [];
  for (const line of streamJson.split("\n")) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type !== "user") continue;
    for (const c of m.message?.content ?? []) {
      if (c.type !== "tool_result") continue;
      const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((x: any) => x.text ?? "").join("\n");
      out.push(...text.split("\n").filter((l: string) => /^(PASS|FAIL) /.test(l) || l === "DONE"));
    }
  }
  return out;
}

export function verdicts(lines: string[]): Map<string, string> {
  const v = new Map<string, string>();
  for (const l of lines) {
    const m = /^(PASS|FAIL) (\w+)(.*)$/.exec(l);
    if (m) v.set(m[2]!, m[1] === "PASS" ? "PASS" : `FAIL${m[3]}`);
  }
  return v;
}

export function hooksSnapshot(commonDir: string): string {
  const dir = join(commonDir, "hooks");
  return existsSync(dir) ? readdirSync(dir).sort().join(",") : "";
}

async function main() {
  const repo = git(["rev-parse", "--show-toplevel"], process.cwd());
  const commonDir = resolve(repo, git(["rev-parse", "--git-common-dir"], repo));
  const token = randomBytes(4).toString("hex");
  const branch = `sandbox-probe/${token}`;
  const wt = join(tmpdir(), `hq-sandbox-${token}`);
  const before = {
    main: git(["rev-parse", "refs/heads/main"], repo),
    hooks: hooksSnapshot(commonDir),
    config: readFileSync(join(commonDir, "config"), "utf8"),
  };
  git(["worktree", "add", "-q", "-b", branch, wt, "HEAD"], repo);
  let failed = 0;
  try {
    // Dependencies come from outside the sandbox; the sandbox has no registry access.
    if (Bun.spawnSync(["bun", "install", "--frozen-lockfile"], { cwd: join(wt, "eval") }).exitCode !== 0) throw new Error("bun install failed");
    // The probe under test may not be committed yet; run this checkout's copy.
    mkdirSync(join(wt, "scripts/sandbox"), { recursive: true });
    writeFileSync(join(wt, "scripts/sandbox/probe.sh"), readFileSync(join(repo, "scripts/sandbox/probe.sh")));
    const settings = JSON.stringify(sandboxSettings(commonDir, process.env.HOME!));
    // A nested session must not look like a child of this one.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CLAUDE_CODE_") && k !== "CLAUDECODE") env[k] = v;
    const p = Bun.spawnSync(
      [
        "claude", "-p", "--model", MODEL, "--settings", settings, "--setting-sources", "", "--strict-mcp-config",
        "--output-format", "stream-json", "--verbose", "--allowedTools", `Bash(${PROBE})`,
      ],
      // The prompt goes on stdin: --allowedTools is variadic and would swallow it.
      { cwd: wt, env, timeout: 10 * 60 * 1000, stdin: Buffer.from(`Run this exact command once with the Bash tool and nothing else, then stop: ${PROBE}`) },
    );
    const stream = p.stdout.toString();
    writeFileSync(join(tmpdir(), `hq-sandbox-${token}.jsonl`), stream);
    const v = verdicts(probeLines(stream));
    const after = {
      main: git(["rev-parse", "refs/heads/main"], repo),
      hooks: hooksSnapshot(commonDir),
      config: readFileSync(join(commonDir, "config"), "utf8"),
    };
    const outside: [string, boolean][] = [
      ["main unchanged (checked outside)", after.main === before.main],
      ["hooks unchanged (checked outside)", after.hooks === before.hooks],
      ["config unchanged (checked outside)", after.config === before.config],
      ["probe commit landed on its branch", git(["log", "-1", "--format=%s", branch], repo) === "sandbox probe"],
    ];
    for (const name of EXPECTED) {
      const r = v.get(name) ?? "FAIL: no result (probe did not run in the sandbox?)";
      if (r !== "PASS") failed++;
      console.log(`${r === "PASS" ? "PASS" : "FAIL"}  ${name}${r === "PASS" ? "" : "  " + r.slice(4)}`);
    }
    for (const [name, ok] of outside) {
      if (!ok) failed++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    }
    if (v.size === 0) console.log(`claude exit ${p.exitCode}; stream saved to ${join(tmpdir(), `hq-sandbox-${token}.jsonl`)}\n${p.stderr.toString().slice(-2000)}`);
  } finally {
    Bun.spawnSync(["git", "worktree", "remove", "--force", wt], { cwd: repo });
    Bun.spawnSync(["git", "branch", "-D", branch], { cwd: repo });
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
