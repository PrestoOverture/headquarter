#!/usr/bin/env node
// Read local agent records and git to report measurements.

import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { plugins } from "./plugins";
import { html, terminalTable } from "./report";
import { collect, type CollectOptions } from "./collect";
import { serve } from "./server";
import { version } from "../package.json";

const sharedHelp = `  --claude-dir <path>    Claude Code records (default: ~/.claude/projects)
  --codex-dir <path>     Codex records (default: ~/.codex/sessions)
  --opencode-dir <path>  OpenCode directory or database (default: ~/.local/share/opencode)
  --since <YYYY-MM-DD>   Include tasks starting on or after this date
  --ci                  Query GitHub checks using gh (requires network)
  --cache-dir <path>     Cache (default: $XDG_CACHE_HOME/crewmeter or ~/.cache/crewmeter)
  --no-cache            Disable all cache reads and writes`;
const collectHelp = `  --out <path>          HTML output (default: out/report.html); also writes .tasks.json
  --include-headless    Include unattended tasks in the terminal table`;
const serveHelp = `  --host <host>         Listen address (default: 127.0.0.1)
  --port <port>         Listen port, 0 for a free port (default: 4317)
  --open                Open the dashboard in a browser`;
const generalHelp = `  -h, --help            Show help and exit
  -v, --version         Show version and exit`;

const args = process.argv.slice(2);
const explicitCommand = ["collect", "serve", "mcp"].includes(args[0] ?? "");
const command = args[0] === "mcp" ? "mcp" : args[0] === "serve" ? "serve" : "collect";
if (explicitCommand) args.shift();
const { values } = parseArgs({
  args,
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    out: { type: "string", default: "out/report.html" },
    since: { type: "string" },
    ci: { type: "boolean", default: false },
    "cache-dir": { type: "string" },
    "no-cache": { type: "boolean", default: false },
    ...Object.fromEntries(plugins.map(plugin => [`${plugin.name}-dir`, { type: "string" as const }])),
    "include-headless": { type: "boolean", default: false },
    ...(command === "serve" ? {
      host: { type: "string" as const, default: "127.0.0.1" },
      port: { type: "string" as const, default: "4317" },
      open: { type: "boolean" as const, default: false },
    } : {}),
  },
});

if (values.version) {
  console.log(version);
  process.exit(0);
}
if (values.help) {
  console.log(explicitCommand
    ? `Usage: crewmeter ${command} [flags]\n\n${sharedHelp}\n${command === "collect" ? collectHelp + "\n" : command === "serve" ? serveHelp + "\n" : ""}${generalHelp}`
    : `Usage: crewmeter [collect|serve|mcp] [flags]

Commands:
  collect  Write a local HTML report and tasks JSON (default)
  serve    Run a local dashboard with refresh
  mcp      Run an MCP server over stdio

Shared flags:
${sharedHelp}

collect flags:
${collectHelp}

serve flags:
${serveHelp}

${generalHelp}`);
  process.exit(0);
}

const log = (s: string) => console.error(s);
const options: CollectOptions = {
  dirs: Object.fromEntries(plugins.flatMap(plugin => {
    const dir = (values as Record<string, unknown>)[`${plugin.name}-dir`];
    return typeof dir === "string" ? [[plugin.name, dir]] : [];
  })),
  since: values.since,
  ci: values.ci,
  cacheDir: values["cache-dir"],
  noCache: values["no-cache"],
};

if (command === "mcp") {
  const { mcp } = await import("./mcp");
  await mcp(options);
} else if (command === "serve") {
  const portArg = String(values.port);
  const port = Number(portArg);
  if (!/^\d+$/.test(portArg) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port must be an integer from 0 to 65535");
  }
  const host = String(values.host);
  if (!["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase())) {
    log("Warning: listening on a non-loopback address; the dashboard has no auth.");
  }
  const server = await serve({ ...options, host, port });
  const boundPort = (server.address() as { port: number }).port;
  const url = `http://${host === "::1" ? "[::1]" : ["localhost", "127.0.0.1"].includes(host) ? host : "127.0.0.1"}:${boundPort}/`;
  log(`dashboard: ${url}`);
  if (values.open) {
    const [program, ...openArgs] = process.platform === "darwin" ? ["open", url]
      : process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url] : ["xdg-open", url];
    const child = spawn(program!, openArgs, { detached: true, stdio: "ignore" });
    child.on("error", error => log(`Could not open browser: ${error.message}`));
    child.unref();
  }
} else {
  const { tasks, meta } = await collect(options, log);
  const out = resolve(values.out!);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html(tasks, meta));
  writeFileSync(out.replace(/\.html$/, "") + ".tasks.json", JSON.stringify(tasks, null, 1));

  const shown = tasks.filter((t) => t.repo && t.commits.length && (values["include-headless"] || !t.headless));
  console.log(terminalTable(shown));
  log(`\nreport: ${out}  (table above: tasks with commits${values["include-headless"] ? "" : ", headless excluded"})`);
}
