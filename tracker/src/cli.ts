#!/usr/bin/env bun
// tracker: read the local Claude Code and Codex records plus git, and write a report of which
// agent combinations delivered work that lasted, at what cost and how much of your attention.
//
//   bun src/cli.ts [--out out/report.html] [--since YYYY-MM-DD] [--ci]
//                  [--claude-dir ~/.claude/projects] [--codex-dir ~/.codex/sessions]

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { addCi } from "./ci";
import { readClaude } from "./claude";
import { readCodex } from "./codex";
import { Repos } from "./git";
import { buildTasks } from "./link";
import { html, terminalTable } from "./report";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: "string", default: "out/report.html" },
    since: { type: "string" },
    ci: { type: "boolean", default: false },
    "claude-dir": { type: "string", default: join(homedir(), ".claude/projects") },
    "codex-dir": { type: "string", default: join(homedir(), ".codex/sessions") },
    "include-headless": { type: "boolean", default: false },
  },
});

const log = (s: string) => console.error(s);
const t0 = Date.now();
const claude = readClaude(values["claude-dir"]!);
const codex = readCodex(values["codex-dir"]!);
log(`read ${claude.length} Claude and ${codex.length} Codex sessions in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const repos = new Repos(homedir());
let tasks = buildTasks([...claude, ...codex], repos);
if (values.since) {
  const since = Date.parse(values.since);
  tasks = tasks.filter((t) => t.start >= since);
}
const commits = tasks.flatMap((t) => t.commits);
log(`${tasks.length} tasks in ${repos.all().length} repositories; ${commits.length} commits linked (${commits.filter((c) => c.how === "exact").length} exact)`);
if (values.ci) addCi(tasks, repos, join(homedir(), ".cache/agent-tracker/ci.json"), log);

const out = resolve(values.out!);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html(tasks, { generatedAt: Date.now(), sessions: { claude: claude.length, codex: codex.length }, repos: repos.all().length, ci: values.ci! }));
writeFileSync(out.replace(/\.html$/, "") + ".tasks.json", JSON.stringify(tasks, null, 1));

const shown = tasks.filter((t) => t.repo && t.commits.length && (values["include-headless"] || !t.headless));
console.log(terminalTable(shown));
log(`\nreport: ${out}  (table above: tasks with commits${values["include-headless"] ? "" : ", headless excluded"})`);
