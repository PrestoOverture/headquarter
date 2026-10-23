// Catch rate over every graded task (roadmap 第 0 步 stop line: below half, fix the writer
// before moving on). Invalid submissions count as misses: the writer failed to produce a
// usable test. Tasks with no report (writer or grade job crashed) or a grade_error are
// listed, not counted. Reports graded with --mutants also give a mutation score.
//
//   bun src/summarize.ts <results dir>    → summary.json in that dir, Markdown on stdout

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Verdict } from "./judge";
import type { MutantRecord, MutantResult } from "./mutants";

export type Report = {
  instance_id: string;
  language: string;
  verdict: Verdict;
  graded_at?: string;
  mutants?: MutantRecord[]; // only on caught tasks graded with --mutants
  mutants_left_out?: number;
};

/**
 * killed ÷ (killed + survived) over every graded mutant. Flaky, apply_failed, build_failed
 * and not_graded mutants are counted but stay out of the denominator; a report without a mutants list adds
 * nothing, so it never counts as killed. null when no report has mutation data.
 */
export function mutationScore(reports: Report[]) {
  const graded = reports.filter((r) => r.mutants);
  if (!graded.length) return null;
  const counts: Record<MutantResult, number> = { killed: 0, survived: 0, flaky: 0, apply_failed: 0, build_failed: 0, not_graded: 0 };
  for (const r of graded) for (const m of r.mutants!) counts[m.result]++;
  const denominator = counts.killed + counts.survived;
  return {
    score: denominator ? counts.killed / denominator : null,
    denominator,
    ...counts,
    mutants_left_out: graded.reduce((n, r) => n + (r.mutants_left_out ?? 0), 0),
    tasks: graded.length,
    tasks_without_mutants: graded.filter((r) => !r.mutants!.length).map((r) => r.instance_id),
  };
}

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
    mutation: mutationScore(reports),
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
  const mu = s.mutation;
  if (mu) {
    const score = mu.score === null ? "n/a" : `${(mu.score * 100).toFixed(1)}%`;
    lines.push(
      `\n### Mutation score ${score} (killed ${mu.killed}/${mu.denominator} = killed + survived)\n`,
      `${mu.tasks} tasks graded; flaky ${mu.flaky}, apply_failed ${mu.apply_failed}, build_failed ${mu.build_failed}, not_graded ${mu.not_graded}; mutants_left_out (cap) ${mu.mutants_left_out}; no mutants (single hunk): ${mu.tasks_without_mutants.join(", ") || "none"}`,
    );
  }
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
