// Merges step-0 result directories from several runs, so a re-graded task replaces its
// older grade without rerunning the rest. Each id's directory is taken whole from the run
// that holds its latest grade.
//
//   bun src/merge-runs.ts <out> <run dir>...    → <out>/<id>/, summary.json, summary.md,
//                                                 sources.json; Markdown on stdout
//
// A run dir holds <id>/ directly (the step0-results artifact) or graded-<id>/<id>/
// (artifacts downloaded by pattern). Latest grade: the newest report.json graded_at; a
// report without it is older than any with it, and among those the later run dir on the
// command line wins. A run that has write.json but no report.json never replaces a grade.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { markdown, readResults, summarize, type Report } from "./summarize";

type Candidate = { dir: string; run: string; graded: Report | null; written: boolean };

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** Instance id → its directory in one run dir, from either layout. */
function idDirs(run: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const name of readdirSync(run).sort()) {
    if (!isDir(join(run, name))) continue;
    const id = name.replace(/^graded-/, "");
    if (name !== id && isDir(join(run, name, id))) found.set(id, join(run, name, id));
    else if (!found.has(name)) found.set(name, join(run, name));
  }
  return found;
}

/** Whether `b` replaces `a`, the best so far; `b` comes from a later run dir. */
function newer(a: Report, b: Report): boolean {
  const t = (r: Report) => Date.parse(r.graded_at ?? "");
  const [ta, tb] = [t(a), t(b)];
  if (Number.isNaN(ta) || Number.isNaN(tb)) return !Number.isNaN(tb) || Number.isNaN(ta);
  return tb >= ta;
}

export function mergeRuns(out: string, runs: string[]) {
  if (!runs.length) throw new Error("usage: bun src/merge-runs.ts <out> <run dir>...");
  for (const run of runs) if (!isDir(run)) throw new Error(`run directory does not exist: ${run}`);
  if (existsSync(out) && (!isDir(out) || readdirSync(out).length)) throw new Error(`${out} already exists and is not empty`);

  const candidates = new Map<string, Candidate[]>();
  for (const run of runs)
    for (const [id, dir] of idDirs(run)) {
      const report = join(dir, "report.json");
      const graded = existsSync(report) ? (JSON.parse(readFileSync(report, "utf8")) as Report) : null;
      candidates.set(id, [...(candidates.get(id) ?? []), { dir, run, graded, written: existsSync(join(dir, "write.json")) }]);
    }

  const chosen = new Map<string, Candidate>();
  const ungraded: string[] = [];
  for (const [id, list] of [...candidates].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let best: Candidate | undefined;
    for (const c of list) if (c.graded && (!best || newer(best.graded!, c.graded))) best = c;
    if (!best) {
      best = [...list].reverse().find((c) => c.written) ?? list.at(-1)!;
      if (best.written) ungraded.push(id);
    }
    chosen.set(id, best);
  }

  mkdirSync(out, { recursive: true });
  for (const [id, c] of chosen) cpSync(c.dir, join(out, id), { recursive: true });
  const sources = { sources: Object.fromEntries([...chosen].map(([id, c]) => [id, c.run])), ungraded };
  writeFileSync(join(out, "sources.json"), JSON.stringify(sources, null, 2) + "\n");
  const { reports, missing } = readResults(out);
  const summary = summarize(reports, missing);
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(join(out, "summary.md"), markdown(summary) + "\n");
  return { summary, sources };
}

if (import.meta.main) {
  const [out, ...runs] = process.argv.slice(2);
  if (!out) throw new Error("usage: bun src/merge-runs.ts <out> <run dir>...");
  console.log(markdown(mergeRuns(out, runs).summary));
}
