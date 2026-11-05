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
import { plugins } from "./plugins";
import { Repos } from "./git";
import { buildTasks } from "./link";
import { html, terminalTable } from "./report";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: "string", default: "out/report.html" },
    since: { type: "string" },
    ci: { type: "boolean", default: false },
    ...Object.fromEntries(plugins.map(plugin => [`${plugin.name}-dir`, { type: "string" as const }])),
    "include-headless": { type: "boolean", default: false },
  },
});

const log = (s: string) => console.error(s);
const t0 = Date.now();
const counts: Record<string, number> = {};
const sessions = plugins.flatMap(plugin => {
  const override = (values as Record<string, unknown>)[`${plugin.name}-dir`];
  const paths = typeof override === "string" ? [override] : plugin.defaultPaths(homedir());
  const read = paths.flatMap(path => plugin.read(path));
  counts[plugin.name] = read.length;
  return read;
});
log(`read ${Object.entries(counts).map(([name, count]) => `${count} ${name}`).join(" and ")} sessions in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const repos = new Repos(homedir());
let tasks = buildTasks(sessions, repos);
if (values.since) {
  const since = Date.parse(values.since);
  tasks = tasks.filter((t) => t.start >= since);
}
const commits = tasks.flatMap((t) => t.commits);
log(`${tasks.length} tasks in ${repos.all().length} repositories; ${commits.length} commits linked (${commits.filter((c) => c.how === "exact").length} exact)`);
if (values.ci) await addCi(tasks, repos, join(homedir(), ".cache/agent-tracker/ci-v3.json"), log);

const out = resolve(values.out!);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html(tasks, { generatedAt: Date.now(), sessions: counts, repos: repos.all().length, ci: values.ci! }));
writeFileSync(out.replace(/\.html$/, "") + ".tasks.json", JSON.stringify(tasks, null, 1));

const shown = tasks.filter((t) => t.repo && t.commits.length && (values["include-headless"] || !t.headless));
console.log(terminalTable(shown));
log(`\nreport: ${out}  (table above: tasks with commits${values["include-headless"] ? "" : ", headless excluded"})`);
