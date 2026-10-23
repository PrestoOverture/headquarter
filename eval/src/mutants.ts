// Mutation testing for the writer's tests: a mutant is the gold patch with one hunk left
// out, i.e. the fix minus one piece. A good test should fail on it (killed); one that
// passes anyway (survived) pins down less than the whole fix. Built here from the patch
// text alone; grade.ts applies each mutant in a fresh container and runs the writer's script.

import type { Side } from "./judge";

export const MAX_MUTANTS = 8;

export type MutantResult = "killed" | "survived" | "flaky" | "apply_failed";

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
 * Neither a patch that does not apply nor a rebuild that timed out says anything about
 * the tests, so both are apply_failed and stay out of the score.
 */
export function mutantResult(side: Side): MutantResult {
  if (!side.applied || side.rebuild_timed_out || !side.runs.length) return "apply_failed";
  const passes = side.runs.filter((c) => c === 0).length;
  if (passes === side.runs.length) return "survived";
  return passes === 0 ? "killed" : "flaky";
}
