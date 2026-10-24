// Step-0 verdict for one task (roadmap 第 0 步): the writer's tests catch the bug when
// they fail on the buggy code and pass on the fixed code, consistently across reruns.

export const SCRIPT = ".step0/run_tests.sh";

export type Side = {
  applied: boolean; // writer patch (and, on the fixed side, the gold patch) applied
  runs: number[]; // exit codes of the writer's script, one per rerun; -1 = timeout
  rebuild_timed_out?: boolean;
};

export type Verdict =
  | "caught" // fails on buggy, passes on fixed
  | "passes_on_buggy" // too weak: does not detect the bug
  | "fails_on_fixed" // wrong test, or a misread of the issue
  | "flaky" // reruns of the same side disagree
  | "no_submission" // empty patch
  | "no_script" // patch without .step0/run_tests.sh
  | "touches_fix" // writer changed a file the gold fix changes
  | "patch_failed" // writer patch does not apply
  | "grade_error" // the project's rebuild timed out: says nothing about the tests
  | "excluded_disk"; // the task image does not fit on the runner (disk.ts): the tests were never run

/** Files a unified diff touches (the b/ side). */
export function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)].map((m) => m[1]!);
}

export function verdict(writerPatch: string, goldPatch: string, buggy: Side | null, fixed: Side | null): Verdict {
  if (!writerPatch.trim()) return "no_submission";
  const files = patchFiles(writerPatch);
  if (!files.includes(SCRIPT)) return "no_script";
  const gold = new Set(patchFiles(goldPatch));
  if (files.some((f) => gold.has(f))) return "touches_fix";
  if (!buggy?.applied || !fixed?.applied) return "patch_failed";
  if (buggy.rebuild_timed_out || fixed.rebuild_timed_out) return "grade_error";
  const pass = (c: number) => c === 0;
  const consistent = (s: Side) => new Set(s.runs.map(pass)).size === 1;
  if (!consistent(buggy) || !consistent(fixed)) return "flaky";
  if (!fixed.runs.every(pass)) return "fails_on_fixed";
  if (buggy.runs.every(pass)) return "passes_on_buggy";
  return "caught";
}

/** Verdicts that say nothing about the writer's tests themselves. */
export const INVALID: ReadonlySet<Verdict> = new Set(["no_submission", "no_script", "touches_fix", "patch_failed"]);
