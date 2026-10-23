// Catch rate over every graded task (roadmap 第 0 步 stop line: below half, fix the writer
// before moving on). Invalid submissions count as misses: the writer failed to produce a
// usable test. Tasks with no report (writer or grade job crashed) or a grade_error are
// listed, not counted.
//
//   bun src/summarize.ts <results dir>    → summary.json in that dir, Markdown on stdout

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Verdict } from "./judge";

export type Report = { instance_id: string; language: string; verdict: Verdict; graded_at?: string };

export function summarize(reports: Report[], missing: string[]) {
  const counts: Partial<Record<Verdict, number>> = {};
  for (const r of reports) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const caught = counts.caught ?? 0;
  const graded = reports.length - (counts.grade_error ?? 0);
  return {
    graded,
    caught,
    catch_rate: graded ? caught / graded : null,
    passes_stop_line: graded ? caught / graded >= 0.5 : null,
    counts,
    missing,
    by_task: Object.fromEntries(reports.map((r) => [r.instance_id, r.verdict])),
  };
}

/** Reads <dir>/<id>/report.json for every id directory; ids without one are "missing". */
export function readResults(dir: string) {
  const reports: Report[] = [];
  const missing: string[] = [];
  for (const id of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const p = join(dir, id, "report.json");
    if (existsSync(p)) reports.push(JSON.parse(readFileSync(p, "utf8")));
    else missing.push(id);
  }
  return { reports, missing };
}

export function markdown(s: ReturnType<typeof summarize>): string {
  const pct = s.catch_rate === null ? "n/a" : `${(s.catch_rate * 100).toFixed(1)}%`;
  const lines = [
    `## Step 0: writer catch rate ${pct} (${s.caught}/${s.graded})\n`,
    `Stop line (≥ 50%): ${s.passes_stop_line === null ? "n/a" : s.passes_stop_line ? "passed" : "NOT passed"}\n`,
    "| verdict | tasks |\n| --- | --- |",
  ];
  for (const [v, n] of Object.entries(s.counts).sort((a, b) => b[1] - a[1])) lines.push(`| ${v} | ${n} |`);
  if (s.missing.length) lines.push(`\nNo report (job failed): ${s.missing.join(", ")}`);
  return lines.join("\n");
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: bun src/summarize.ts <results dir>");
  const { reports, missing } = readResults(dir);
  const s = summarize(reports, missing);
  writeFileSync(join(dir, "summary.json"), JSON.stringify(s, null, 2) + "\n");
  console.log(markdown(s));
}
