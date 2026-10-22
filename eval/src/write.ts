// Writer job: one Claude run per task that writes tests exposing the issue.
//
//   bun src/write.ts --tasks tasks/public.json --id <instance_id> --out results
//
// Isolation follows c2c-eval-runner's pilot (isolation v3): the task file holds no gold
// data; the checkout lives in an opaque dir outside this repo with its git history
// squashed to the base tree (the image's .git still holds the upstream fix); the work
// container has no network; the agent's own traffic goes through BlockProxy; no web
// tools and no GitHub login. Output: <out>/<id>/writer.patch and write.json.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { patchFiles, SCRIPT } from "./judge";
import { BlockProxy } from "./proxy";
import { run, sh } from "./sh";
import { findTask, type PublicTask } from "./tasks";

export const MODEL = "claude-opus-5-5";
export const EFFORT = "high";
const RUN_CAP_MS = 60 * 60 * 1000;
const WS_ROOT = "/tmp/ws"; // outside the repo: agents walk parent dirs for CLAUDE.md / AGENTS.md

// In -p mode the session ends when the model ends its turn (same note as c2c's runs).
const HEADLESS =
  "This session is non-interactive. It ends the moment you end your turn, and nothing will " +
  "resume it later. Do not run commands in the background and do not end your turn while " +
  "waiting for anything.";

const CLAUDE = [
  "claude", "-p", "--model", MODEL, "--effort", EFFORT,
  "--output-format", "stream-json", "--verbose",
  "--setting-sources", "", "--strict-mcp-config",
  "--permission-mode", "bypassPermissions",
  "--disallowedTools", "Monitor", "ScheduleWakeup", "CronCreate", "WebFetch", "WebSearch",
  "--append-system-prompt", HEADLESS,
];

function prepareWorkspace(task: PublicTask, dir: string, image: string, ctr: string) {
  const ws = join(dir, "testbed");
  const plat = ["--platform", task.platform];
  const tmp = sh(["docker", "create", ...plat, image]).trim();
  try {
    sh(["docker", "cp", `${tmp}:/testbed`, ws]);
  } finally {
    run(["docker", "rm", tmp]);
  }
  if (task.sanitize_git) {
    rmSync(join(ws, ".git"), { recursive: true, force: true });
    sh(["git", "init", "-q"], { cwd: ws });
    sh(["git", "add", "-A"], { cwd: ws });
    sh(["git", "-c", "user.name=step0", "-c", "user.email=step0@invalid", "commit", "-q", "-m", "base"], { cwd: ws });
  }
  const base = sh(["git", "rev-parse", "HEAD"], { cwd: ws }).trim();
  run(["docker", "rm", "-f", ctr]);
  sh(["docker", "run", "-d", ...plat, "--network", "none", "--name", ctr, "-v", `${ws}:/testbed`, image, "sleep", "infinity"]);
  const envrun = join(dir, "bin", "envrun");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(envrun, `#!/bin/bash\nexec docker exec -i -w /testbed ${ctr} bash -c "${task.env_activate} && $*"\n`);
  chmodSync(envrun, 0o755);
  return { ws, envrun, base };
}

function agentEnv(home: string, proxyUrl: string): Record<string, string> {
  const drop = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !drop.has(k)) env[k] = v;
  mkdirSync(join(home, "gh-empty"), { recursive: true });
  env.GH_CONFIG_DIR = join(home, "gh-empty");
  env.GIT_TERMINAL_PROMPT = "0";
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) env[k] = proxyUrl;
  env.NO_PROXY = env.no_proxy = "localhost,127.0.0.1";
  return env;
}

async function runAgent(cmd: string[], cwd: string, logPath: string, env: Record<string, string>) {
  const start = Date.now();
  const log = openSync(logPath, "w");
  const proc = spawn(cmd[0]!, cmd.slice(1), { cwd, env, stdio: ["ignore", log, log], detached: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.kill(-proc.pid!, "SIGKILL"); // the whole group: claude and whatever it started
  }, RUN_CAP_MS);
  const code = await new Promise<number>((resolve) => proc.on("exit", (c) => resolve(c ?? -1)));
  clearTimeout(timer);
  return { exit_code: code, timed_out: timedOut, duration_s: Math.round((Date.now() - start) / 1000) };
}

/** The final `result` message of a stream-json log. */
export function claudeResult(log: string): Record<string, unknown> | null {
  let result: Record<string, unknown> | null = null;
  for (const line of log.split("\n")) {
    try {
      const m = JSON.parse(line);
      if (m.type === "result") result = m;
    } catch {}
  }
  if (!result) return null;
  const keep = ["subtype", "is_error", "num_turns", "total_cost_usd", "usage", "modelUsage"];
  return Object.fromEntries(keep.map((k) => [k, result![k]]));
}

export function promptFor(task: PublicTask, workdir: string, envrun: string): string {
  const template = readFileSync(join(import.meta.dir, "writer_prompt.md"), "utf8");
  const vars: Record<string, string> = {
    repo: task.repo,
    workdir,
    envrun,
    rebuild_cmds: task.rebuild_cmds.map((c) => "    " + c).join("\n"),
    problem_statement: task.problem_statement,
  };
  return template.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
}

async function main() {
  const { values } = parseArgs({ options: { tasks: { type: "string" }, id: { type: "string" }, out: { type: "string" } } });
  if (!values.tasks || !values.id || !values.out) throw new Error("usage: --tasks <file> --id <instance_id> --out <dir>");
  const tasks: PublicTask[] = JSON.parse(readFileSync(values.tasks, "utf8"));
  const task = findTask(tasks, values.id);
  const runDir = join(values.out, task.instance_id);
  if (existsSync(join(runDir, "write.json"))) return console.log(`${task.instance_id}: already written`);
  mkdirSync(runDir, { recursive: true });

  sh(["docker", "pull", "--platform", task.platform, task.image], { timeoutMs: 60 * 60 * 1000 });
  // Everything the agent can see has an opaque name: no instance id, no PR number.
  const token = randomBytes(6).toString("hex");
  const opaque = join(WS_ROOT, token);
  const ctr = `ws-${token}`;
  const alias = `ws-image:${token}`;
  mkdirSync(opaque, { recursive: true });
  sh(["docker", "tag", task.image, alias]);
  const proxy = await new BlockProxy().start();
  proxy.logPath = join(runDir, "blocked.log");
  let record: Record<string, unknown>;
  try {
    const { ws, envrun, base } = prepareWorkspace(task, opaque, alias, ctr);
    const cmd = [...CLAUDE, promptFor(task, ws, envrun)];
    const logPath = join(runDir, "agent.jsonl");
    const outcome = await runAgent(cmd, ws, logPath, agentEnv(opaque, proxy.url));
    const log = readFileSync(logPath, "utf8");
    // Not a writer outcome: leave no write.json so the task can be rerun.
    if (log.includes('"error":"authentication_failed"')) throw new Error("claude could not authenticate");
    if (log.includes('"error":"rate_limit"') || log.includes("hit your limit")) throw new Error("claude hit the plan's usage limit");
    // The container writes into the bind mount as root; take ownership back for git.
    run(["sudo", "-n", "chown", "-R", `${process.getuid!()}:${process.getgid!()}`, ws]);
    sh(["git", "add", "-A"], { cwd: ws });
    const patch = sh(["git", "diff", "--cached", "--binary", base], { cwd: ws });
    writeFileSync(join(runDir, "writer.patch"), patch);
    const files = patchFiles(patch);
    record = {
      instance_id: task.instance_id,
      model: MODEL,
      effort: EFFORT,
      ...outcome,
      patch_files: files,
      has_script: files.includes(SCRIPT),
      claude: claudeResult(log),
    };
  } finally {
    proxy.close();
    run(["docker", "rm", "-f", ctr]);
    run(["docker", "rmi", alias]);
    run(["sudo", "-n", "rm", "-rf", opaque]);
    rmSync(opaque, { recursive: true, force: true });
  }
  writeFileSync(join(runDir, "write.json"), JSON.stringify(record, null, 2) + "\n");
  console.log(`${task.instance_id}: ${record.duration_s}s, exit ${record.exit_code}${record.timed_out ? " TIMEOUT" : ""}, files ${(record.patch_files as string[]).length}, script ${record.has_script}`);
}

if (import.meta.main) await main();
