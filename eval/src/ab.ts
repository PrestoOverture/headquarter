// A/B comparison of two step-0 result directories (merge-runs output), task by task.
//
//   bun src/ab.ts <a-results> <b-results> [--ids <file>]    → Markdown on stdout
//
// A task is caught or a miss (every other verdict, as in summarize). Fixed: a miss in A,
// caught in B. Broken: caught in A, a miss in B. Unchanged: the rest. Catch rates use only
// the ids graded on both sides. An id with no report, a grade_error or an excluded_disk
// on either side is listed as missing and never counted. --ids restricts the comparison
// to the ids in the file (one per line, blank lines and # comments ignored); without it,
// to the ids found in either directory.

import { existsSync, readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Verdict } from "./judge";
import { readResults } from "./summarize";

type Side = Map<string, Verdict>; // graded ids only

export type Comparison = {
  compared: number;
  fixed: string[];
  broken: string[];
  unchanged: string[];
  a_caught: number;
  b_caught: number;
  a_rate: number | null;
  b_rate: number | null;
  by_task: Record<string, { a: Verdict; b: Verdict }>;
  missing: { id: string; in: ("a" | "b")[] }[];
};

/** Ids of an --ids file. */
export function parseIds(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

function readSide(dir: string): { graded: Side; present: Set<string> } {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`results directory does not exist: ${dir}`);
  const { reports, missing } = readResults(dir);
  return {
    graded: new Map(reports.filter((r) => r.verdict !== "grade_error" && r.verdict !== "excluded_disk").map((r) => [r.instance_id, r.verdict])),
    present: new Set([...reports.map((r) => r.instance_id), ...missing]),
  };
}

export function compare(aDir: string, bDir: string, ids?: string[]): Comparison {
  const [a, b] = [readSide(aDir), readSide(bDir)];
  const all = ids ? [...new Set(ids)] : [...new Set([...a.present, ...b.present])];
  const c: Comparison = { compared: 0, fixed: [], broken: [], unchanged: [], a_caught: 0, b_caught: 0, a_rate: null, b_rate: null, by_task: {}, missing: [] };
  for (const id of all.sort()) {
    const [va, vb] = [a.graded.get(id), b.graded.get(id)];
    if (!va || !vb) {
      c.missing.push({ id, in: [...(va ? [] : ["a" as const]), ...(vb ? [] : ["b" as const])] });
      continue;
    }
    c.by_task[id] = { a: va, b: vb };
    c.compared++;
    if (va === "caught") c.a_caught++;
    if (vb === "caught") c.b_caught++;
    if (va !== "caught" && vb === "caught") c.fixed.push(id);
    else if (va === "caught" && vb !== "caught") c.broken.push(id);
    else c.unchanged.push(id);
  }
  if (c.compared) {
    c.a_rate = c.a_caught / c.compared;
    c.b_rate = c.b_caught / c.compared;
  }
  return c;
}

export function markdown(c: Comparison): string {
  const rate = (caught: number, r: number | null) => (r === null ? "n/a" : `${(r * 100).toFixed(1)}% (${caught}/${c.compared})`);
  const lines = [
    `## A/B: ${c.compared} tasks graded on both sides\n`,
    `Catch rate A: ${rate(c.a_caught, c.a_rate)}`,
    `Catch rate B: ${rate(c.b_caught, c.b_rate)}\n`,
    `Fixed (miss to caught): ${c.fixed.length}, broken (caught to miss): ${c.broken.length}, unchanged: ${c.unchanged.length}\n`,
    "| task | A | B | change |\n| --- | --- | --- | --- |",
  ];
  const change = (id: string) => (c.fixed.includes(id) ? "fixed" : c.broken.includes(id) ? "broken" : "unchanged");
  for (const [id, v] of Object.entries(c.by_task)) lines.push(`| ${id} | ${v.a} | ${v.b} | ${change(id)} |`);
  if (c.missing.length) {
    lines.push("\nNot counted (no grade on that side):");
    for (const m of c.missing) lines.push(`- ${m.id}: ${m.in.map((s) => s.toUpperCase()).join(" and ")}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ options: { ids: { type: "string" } }, allowPositionals: true });
  const [a, b] = positionals;
  if (!a || !b || positionals.length > 2) throw new Error("usage: bun src/ab.ts <a-results> <b-results> [--ids <file>]");
  console.log(markdown(compare(a, b, values.ids ? parseIds(readFileSync(values.ids, "utf8")) : undefined)));
}
