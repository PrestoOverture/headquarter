// Mutation testing for the writer's tests: a mutant is the gold patch with one hunk left
// out, i.e. the fix minus one piece. A good test should fail on it (killed); one that
// passes anyway (survived) pins down less than the whole fix. Built here from the patch
// text alone; grade.ts applies each mutant in a fresh container and runs the writer's script.

import type { Side } from "./judge";

export const MAX_MUTANTS = 8;

export type MutantResult = "killed" | "survived" | "flaky" | "apply_failed" | "build_failed" | "not_graded";

export type Mutant = {
  file: string; // the b/ path of the file the left-out hunk belongs to
  hunk: string; // that hunk's @@ header in the gold patch
  patch: string; // the gold patch without it
};

/** What report.json keeps per mutant. */
export type MutantRecord = {
  file: string;
  hunk: string;
  result: MutantResult;
  rebuild: number[]; // exit codes of the task's rebuild commands on the mutant
  runs: number[];
};

type Hunk = { header: string; lines: string[] }; // lines[0] is the @@ line
type FileDiff = { file: string; head: string[]; hunks: Hunk[] };

const HEADER = /^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@(.*)$/;

function parseHunk(lines: string[], at: number): Hunk {
  const m = HEADER.exec(lines[at]!);
  if (!m) throw new Error(`bad hunk header: ${lines[at]}`);
  let oldLeft = m[2] === undefined ? 1 : Number(m[2].slice(1));
  let newLeft = m[4] === undefined ? 1 : Number(m[4].slice(1));
  let end = at + 1;
  while (oldLeft > 0 || newLeft > 0) {
    const c = lines[end]?.[0];
    if (c === "-") oldLeft--;
    else if (c === "+") newLeft--;
    else if (c === " " || c === "") {
      oldLeft--;
      newLeft--; // an empty line is a context line whose trailing space got stripped
    } else if (c !== "\\") throw new Error(`hunk body ended early: ${lines[at]}`);
    end++;
  }
  while (lines[end]?.[0] === "\\") end++; // "\ No newline at end of file"
  return { header: lines[at]!, lines: lines.slice(at, end) };
}

function parseFiles(patch: string): FileDiff[] {
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const files: FileDiff[] = [];
  for (let i = 0; i < lines.length; ) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[i]!);
    if (!m) {
      i++;
      continue;
    }
    const file: FileDiff = { file: m[2]!, head: [lines[i++]!], hunks: [] };
    while (i < lines.length && !lines[i]!.startsWith("@@ ") && !lines[i]!.startsWith("diff --git ")) file.head.push(lines[i++]!);
    while (lines[i]?.startsWith("@@ ")) {
      const h = parseHunk(lines, i);
      file.hunks.push(h);
      i += h.lines.length;
    }
    files.push(file);
  }
  return files;
}

/** Every @@ hunk of every file, in patch order. */
export function splitHunks(patch: string): { file: string; header: string }[] {
  return parseFiles(patch).flatMap((f) => f.hunks.map((h) => ({ file: f.file, header: h.header })));
}

/** The file's lines with hunk `drop` left out; the new-side starts of the later hunks shift by what it added. */
function withoutHunk(f: FileDiff, drop: number): string[] {
  const kept = f.hunks.filter((_, i) => i !== drop);
  const head = f.head.join("\n");
  if (!kept.length) {
    if (/^(new|deleted) file mode/m.test(head)) return [];
    // a rename or mode change with edits keeps the rename or mode change
    if (/^(old mode|rename from|copy from)/m.test(head)) return f.head.filter((l) => !/^(index|---|\+\+\+) /.test(l));
    return [];
  }
  const m = HEADER.exec(f.hunks[drop]!.header)!;
  const shift = (m[4] === undefined ? 1 : Number(m[4].slice(1))) - (m[2] === undefined ? 1 : Number(m[2].slice(1)));
  const out = [...f.head];
  f.hunks.forEach((h, i) => {
    if (i === drop) return;
    if (i < drop) return out.push(...h.lines);
    const p = HEADER.exec(h.header)!;
    out.push(`@@ -${p[1]}${p[2] ?? ""} +${Number(p[3]) - shift}${p[4] ?? ""} @@${p[5]}`, ...h.lines.slice(1));
  });
  return out;
}

/**
 * One mutant per hunk, first MAX_MUTANTS in patch order; `left_out` counts the hunks past
 * the cap that got none. A single hunk gives no mutant: the patch minus it is the buggy
 * code, which the buggy side of grading already covers.
 */
export function buildMutants(patch: string, max = MAX_MUTANTS): { mutants: Mutant[]; left_out: number } {
  const files = parseFiles(patch);
  const total = files.reduce((n, f) => n + f.hunks.length, 0);
  if (total < 2) return { mutants: [], left_out: 0 };
  const mutants: Mutant[] = [];
  files.forEach((f, fi) =>
    f.hunks.forEach((h, hi) => {
      if (mutants.length >= max) return;
      const lines = files.flatMap((g, gi) => (gi === fi ? withoutHunk(g, hi) : [...g.head, ...g.hunks.flatMap((x) => x.lines)]));
      mutants.push({ file: f.file, hunk: h.header, patch: lines.join("\n") + "\n" });
    }),
  );
  return { mutants, left_out: total - mutants.length };
}

/**
 * killed: fails every run; survived: passes every run; flaky: the runs disagree.
 * None of the rest says anything about the tests, so they stay out of the score:
 * apply_failed (the patches do not apply), not_graded (rebuild timed out, no runs, or
 * grading threw), build_failed (the rebuild exit codes differ from the fixed side's).
 * build_failed is a lower bound: a hunk that breaks the build makes the script fail
 * whatever the tests check, and a compile error inside the writer's script rather than
 * in the rebuild still counts as killed (C/C++ may even rerun a stale binary).
 */
export function mutantResult(side: Side & { rebuild: number[] }, fixedRebuild: number[]): MutantResult {
  if (!side.applied) return "apply_failed";
  if (side.rebuild_timed_out || !side.runs.length) return "not_graded";
  if (side.rebuild.length !== fixedRebuild.length || side.rebuild.some((c, i) => c !== fixedRebuild[i])) return "build_failed";
  const passes = side.runs.filter((c) => c === 0).length;
  if (passes === side.runs.length) return "survived";
  return passes === 0 ? "killed" : "flaky";
}

/**
 * Grades the mutants of `patch` one by one with `grade`. `save` gets the records after
 * each step, starting with every mutant pending (not_graded), so a timeout or crash
 * keeps what is known; a mutant whose grading throws stays not_graded and the rest go on.
 */
export function gradeMutants(
  patch: string,
  fixedRebuild: number[],
  grade: (m: Mutant, i: number) => Side & { rebuild: number[] },
  save: (r: { mutants: MutantRecord[]; mutants_left_out: number }) => void,
): { mutants: MutantRecord[]; mutants_left_out: number } {
  const built = buildMutants(patch);
  const mutants: MutantRecord[] = built.mutants.map((m) => ({ file: m.file, hunk: m.hunk, result: "not_graded", rebuild: [], runs: [] }));
  const out = { mutants, mutants_left_out: built.left_out };
  save(out);
  built.mutants.forEach((m, i) => {
    try {
      const g = grade(m, i);
      mutants[i] = { ...mutants[i]!, result: mutantResult(g, fixedRebuild), rebuild: g.rebuild, runs: g.runs };
    } catch (e) {
      console.error(`mutant ${i + 1} (${m.file} ${m.hunk}) not graded: ${e instanceof Error ? e.message : e}`);
    }
    save(out);
  });
  return out;
}
