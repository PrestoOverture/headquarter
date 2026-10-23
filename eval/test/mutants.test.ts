import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildMutants, MAX_MUTANTS, mutantResult, splitHunks } from "../src/mutants";
import { run } from "../src/sh";
import { markdown, mutationScore, summarize, type Report } from "../src/summarize";
import { keptTasks } from "../src/tasks";

const root = mkdtempSync(join(tmpdir(), "mutants-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const nums = (count: number, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
const text = (ls: string[], newline = true) => ls.join("\n") + (newline ? "\n" : "");
const change = (ls: string[], edits: Record<number, string[]>) => ls.flatMap((l, i) => edits[i + 1] ?? [l]);

type Files = Record<string, string | null>; // null = absent

/** A real repo with a base commit and a fixed commit; `gold` is the diff between them. */
function repo(base: Files, fixed: Files) {
  const dir = join(root, `repo${n++}`);
  mkdirSync(dir);
  const git = (...a: string[]) => {
    const r = run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...a], { cwd: dir });
    if (r.code !== 0) throw new Error(`git ${a.join(" ")}: ${r.out}`);
    return r.out;
  };
  const put = (files: Files) => {
    for (const [f, data] of Object.entries(files)) {
      if (data === null) rmSync(join(dir, f), { force: true });
      else {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        writeFileSync(join(dir, f), data);
      }
    }
  };
  git("init", "-q");
  put(base);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  put(fixed);
  git("add", "-A");
  git("commit", "-q", "-m", "fixed");
  const gold = git("diff", "-M", "HEAD~1", "HEAD");
  const fixedRev = git("rev-parse", "HEAD").trim();
  git("checkout", "-q", "--detach", "HEAD~1");
  const reset = () => {
    git("reset", "-q", "--hard");
    git("clean", "-fdq");
  };
  return { dir, git, gold, fixedRev, reset };
}

const A = nums(60, "a");
const B = nums(30, "b");
const NL = nums(30, "n");
const base: Files = { "a.txt": text(A), "b.txt": text(B), "gone.txt": "bye\nbye\n", "nl.txt": text(NL, false) };
const fixed: Files = {
  // a.txt: +2 lines at 3, -2 lines at 25, one line changed at 50
  "a.txt": text(change(A, { 3: ["a 3 fixed", "extra 1", "extra 2"], 25: [], 26: [], 50: ["a 50 fixed"] })),
  "b.txt": text(change(B, { 5: ["b 5 fixed"], 28: ["b 28 fixed"] })),
  "gone.txt": null,
  "new.txt": "brand\nnew\n",
  "nl.txt": text(change(NL, { 2: ["n 2 fixed"], 30: ["n 30 fixed"] }), false),
};

describe("splitHunks", () => {
  const { gold } = repo(base, fixed);
  test("lists every hunk of every file in patch order", () => {
    const hunks = splitHunks(gold);
    expect(hunks.map((h) => h.file)).toEqual(["a.txt", "a.txt", "a.txt", "b.txt", "b.txt", "gone.txt", "new.txt", "nl.txt", "nl.txt"]);
    expect(hunks.every((h) => /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(h.header))).toBe(true);
  });
  test("a patch without hunks has none", () => {
    expect(splitHunks("")).toEqual([]);
    expect(splitHunks("diff --git a/x b/x\nGIT binary patch\nliteral 0\nHcmV?d00001\n\n")).toEqual([]);
  });
});

describe("buildMutants", () => {
  test("one mutant per hunk, each recording its file and hunk header", () => {
    const { gold } = repo(base, fixed);
    const hunks = splitHunks(gold);
    const { mutants, left_out } = buildMutants(gold, 99);
    expect(left_out).toBe(0);
    expect(mutants.map((m) => [m.file, m.hunk])).toEqual(hunks.map((h) => [h.file, h.header]));
    for (const m of mutants) expect(m.patch).not.toBe(gold);
  });

  test("a single hunk gives no mutants, even with a new file elsewhere in the patch", () => {
    const one = repo({ "a.txt": text(A) }, { "a.txt": text(change(A, { 3: ["x"] })) });
    expect(buildMutants(one.gold)).toEqual({ mutants: [], left_out: 0 });
    const newFile = repo({ "a.txt": text(A) }, { "a.txt": text(A), "n.txt": "hi\n" });
    expect(buildMutants(newFile.gold)).toEqual({ mutants: [], left_out: 0 });
  });

  test("two files with one hunk each give two mutants", () => {
    const two = repo({ "a.txt": text(A), "b.txt": text(B) }, { "a.txt": text(change(A, { 3: ["x"] })), "b.txt": text(change(B, { 3: ["y"] })) });
    const { mutants } = buildMutants(two.gold);
    expect(mutants.map((m) => m.file)).toEqual(["a.txt", "b.txt"]);
    expect(splitHunks(mutants[0]!.patch).map((h) => h.file)).toEqual(["b.txt"]);
    expect(splitHunks(mutants[1]!.patch).map((h) => h.file)).toEqual(["a.txt"]);
  });

  test("hunk headers shift by what the removed hunk added or removed", () => {
    const patch = [
      "diff --git a/f b/f",
      "index 1..2 100644",
      "--- a/f",
      "+++ b/f",
      "@@ -3,3 +3,5 @@ first",
      " c",
      "+p",
      "+q",
      " c",
      " c",
      "@@ -20,5 +22,3 @@ second",
      " c",
      "-r",
      "-s",
      " c",
      " c",
      "@@ -40 +40 @@ third",
      "-t",
      "+u",
      "",
    ].join("\n");
    const [dropFirst, dropSecond, dropThird] = buildMutants(patch).mutants.map((m) => splitHunks(m.patch).map((h) => h.header));
    expect(dropFirst).toEqual(["@@ -20,5 +20,3 @@ second", "@@ -40 +38 @@ third"]);
    expect(dropSecond).toEqual(["@@ -3,3 +3,5 @@ first", "@@ -40 +42 @@ third"]);
    expect(dropThird).toEqual(["@@ -3,3 +3,5 @@ first", "@@ -20,5 +22,3 @@ second"]);
  });

  test("every mutant git-applies to the base tree and differs from the fix by exactly its hunk", () => {
    const r = repo(base, fixed);
    const { mutants } = buildMutants(r.gold, 99);
    expect(mutants.length).toBe(9);
    for (const m of mutants) {
      r.reset();
      writeFileSync(join(r.dir, "m.diff"), m.patch);
      const check = run(["git", "apply", "--check", "m.diff"], { cwd: r.dir });
      expect(`${m.file} ${m.hunk}: ${check.out}`).toBe(`${m.file} ${m.hunk}: `);
      r.git("apply", "m.diff");
      rmSync(join(r.dir, "m.diff"));
      r.git("add", "-A");
      const rest = splitHunks(r.git("diff", "--cached", r.fixedRev));
      expect(rest.map((h) => h.file)).toEqual([m.file]);
    }
  });

  test("leaving out the only hunk of a new or deleted file drops that file", () => {
    const { gold } = repo(base, fixed);
    const { mutants } = buildMutants(gold, 99);
    const without = (file: string) => mutants.find((m) => m.file === file && m.hunk.startsWith("@@ -0,0"))!.patch;
    const newGone = without("new.txt");
    expect(newGone).not.toContain("new.txt");
    expect(newGone).toContain("diff --git a/gone.txt b/gone.txt");
    const goneGone = mutants.find((m) => m.file === "gone.txt")!.patch;
    expect(goneGone).not.toContain("gone.txt");
    expect(goneGone).toContain("diff --git a/new.txt b/new.txt");
    expect(goneGone).not.toMatch(/deleted file mode/);
  });

  test("a rename with edits keeps the rename when its hunks are left out", () => {
    const r = repo(
      { "old.txt": text(A), "b.txt": text(B) },
      { "old.txt": null, "new.txt": text(change(A, { 3: ["x"] })), "b.txt": text(change(B, { 3: ["y"] })) },
    );
    expect(r.gold).toContain("rename from old.txt");
    const m = buildMutants(r.gold).mutants.find((x) => x.file === "new.txt")!;
    expect(m.patch).toContain("rename from old.txt");
    writeFileSync(join(r.dir, "m.diff"), m.patch);
    expect(run(["git", "apply", "--check", "m.diff"], { cwd: r.dir }).code).toBe(0);
  });

  test("at most 8 mutants, the first 8 in patch order, and the rest counted", () => {
    const big = nums(300, "x");
    const edits = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [10 + i * 20, [`changed ${i}`]]));
    const r = repo({ "big.txt": text(big) }, { "big.txt": text(change(big, edits)) });
    const hunks = splitHunks(r.gold);
    expect(hunks.length).toBe(12);
    const { mutants, left_out } = buildMutants(r.gold);
    expect(MAX_MUTANTS).toBe(8);
    expect(mutants.length).toBe(8);
    expect(left_out).toBe(4);
    expect(mutants.map((m) => m.hunk)).toEqual(hunks.slice(0, 8).map((h) => h.header));
    expect(buildMutants(r.gold)).toEqual({ mutants, left_out });
    for (const m of mutants) {
      r.reset();
      writeFileSync(join(r.dir, "m.diff"), m.patch);
      expect(run(["git", "apply", "--check", "m.diff"], { cwd: r.dir }).code).toBe(0);
    }
  });

  test("exactly 8 hunks leaves none out", () => {
    const big = nums(300, "x");
    const edits = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [10 + i * 20, [`changed ${i}`]]));
    const r = repo({ "big.txt": text(big) }, { "big.txt": text(change(big, edits)) });
    const { mutants, left_out } = buildMutants(r.gold);
    expect([mutants.length, left_out]).toEqual([8, 0]);
  });
});

test("every real gold patch splits into as many hunks as it has @@ lines", () => {
  for (const t of keptTasks(new URL("../tasks/tasks.json.gz", import.meta.url).pathname)) {
    const hunks = (t.patch.match(/^@@ /gm) ?? []).length;
    expect(splitHunks(t.patch).length).toBe(hunks);
    const { mutants, left_out } = buildMutants(t.patch);
    expect(mutants.length).toBe(hunks < 2 ? 0 : Math.min(hunks, MAX_MUTANTS));
    expect(mutants.length + left_out).toBe(hunks < 2 ? 0 : hunks);
  }
});

describe("mutantResult", () => {
  const side = (...runs: number[]) => ({ applied: true, runs });
  test("fails every run: killed; a timeout counts as failing", () => {
    expect(mutantResult(side(1, 1))).toBe("killed");
    expect(mutantResult(side(-1, 2))).toBe("killed");
  });
  test("passes every run: survived", () => {
    expect(mutantResult(side(0, 0))).toBe("survived");
  });
  test("runs that disagree: flaky", () => {
    expect(mutantResult(side(0, 1))).toBe("flaky");
    expect(mutantResult(side(1, 0))).toBe("flaky");
  });
  test("a patch that does not apply, or a rebuild that timed out: apply_failed", () => {
    expect(mutantResult({ applied: false, runs: [] })).toBe("apply_failed");
    expect(mutantResult({ applied: true, runs: [127, 127], rebuild_timed_out: true })).toBe("apply_failed");
  });
});

describe("mutation score", () => {
  const mutant = (result: "killed" | "survived" | "flaky" | "apply_failed") => ({ file: "f", hunk: "@@ -1 +1 @@", result, rebuild: [0], runs: [1, 1] });
  const report = (id: string, mutants?: ReturnType<typeof mutant>[], verdict: Report["verdict"] = "caught"): Report => ({
    instance_id: id,
    language: "c",
    verdict,
    mutants,
  });

  test("killed over killed plus survived, with the denominator and the other counts", () => {
    const s = mutationScore([
      report("a", [mutant("killed"), mutant("killed"), mutant("survived")]),
      report("b", [mutant("killed"), mutant("flaky"), mutant("apply_failed"), mutant("apply_failed")]),
      report("c", []),
    ]);
    expect(s).toEqual({
      score: 0.75,
      denominator: 4,
      killed: 3,
      survived: 1,
      flaky: 1,
      apply_failed: 2,
      tasks: 3,
      tasks_without_mutants: ["c"],
    });
  });
  test("tasks without mutation data never count as killed", () => {
    const withData = [report("a", [mutant("survived"), mutant("killed")])];
    const extra = [report("b", undefined), report("c", undefined, "passes_on_buggy")];
    expect(mutationScore([...withData, ...extra])).toEqual(mutationScore(withData));
    expect(mutationScore([...withData, ...extra])!.tasks_without_mutants).toEqual([]);
  });
  test("no data at all: no score, and no section in the report", () => {
    expect(mutationScore([report("a")])).toBeNull();
    const s = summarize([report("a")], []);
    expect(s.mutation).toBeNull();
    expect(markdown(s)).not.toContain("Mutation");
  });
  test("nothing killed or survived: no score instead of a division by zero", () => {
    const s = mutationScore([report("a", [mutant("flaky")])])!;
    expect(s.score).toBeNull();
    expect(s.denominator).toBe(0);
  });
  test("summarize carries the score and markdown prints it with the denominator", () => {
    const s = summarize([report("a", [mutant("killed"), mutant("survived"), mutant("survived"), mutant("flaky")]), report("b", [])], []);
    expect(s.mutation!.score).toBeCloseTo(1 / 3);
    expect(s.caught).toBe(2);
    const md = markdown(s);
    expect(md).toContain("Mutation score 33.3% (killed 1/3");
    expect(md).toContain("flaky 1, apply_failed 0");
    expect(md).toContain("no mutants (single hunk): b");
  });
});

describe("step0 workflow mutants input", () => {
  const wf = readFileSync(new URL("../../.github/workflows/step0.yml", import.meta.url), "utf8");
  test("a choice of false and true, default false", () => {
    expect(wf).toMatch(/\n {6}mutants:\n(?: {8}.*\n)*? {8}type: choice\n(?: {8}.*\n)*? {8}options: \["false", "true"\]\n/);
    expect(wf).toMatch(/\n {6}mutants:\n(?: {8}.*\n)*? {8}default: "false"\n/);
  });
  test("reaches grade.ts through STEP0_MUTANTS, never interpolated into the script", () => {
    const step = wf.split("      - name: Grade\n")[1]!.split("\n      - ")[0]!;
    expect(step).toContain("STEP0_MUTANTS: ${{ inputs.mutants }}");
    expect(step).toContain('"$STEP0_MUTANTS" = "true"');
    expect(step).toContain("--mutants");
    expect(step).toContain('"${flags[@]}"');
    expect(wf.match(/inputs\.mutants/g)!.length).toBe(1);
  });
});
