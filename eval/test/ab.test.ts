import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, markdown, parseIds } from "../src/ab";
import { run } from "../src/sh";

const root = mkdtempSync(join(tmpdir(), "ab-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

// A results dir; a null verdict is an id directory without report.json.
function makeResults(specs: Record<string, string | null>): string {
  const dir = join(root, `r${n++}`);
  mkdirSync(dir);
  for (const [id, verdict] of Object.entries(specs)) {
    mkdirSync(join(dir, id));
    if (verdict) writeFileSync(join(dir, id, "report.json"), JSON.stringify({ instance_id: id, language: "c", verdict }));
  }
  return dir;
}

describe("compare", () => {
  test("fixed, broken and unchanged, with catch rates over the shared ids", () => {
    const a = makeResults({ f: "fails_on_fixed", b: "caught", s: "caught", m: "passes_on_buggy", m2: "fails_on_fixed" });
    const b = makeResults({ f: "caught", b: "flaky", s: "caught", m: "passes_on_buggy", m2: "no_script" });
    const c = compare(a, b);
    expect(c.fixed).toEqual(["f"]);
    expect(c.broken).toEqual(["b"]);
    expect(c.unchanged).toEqual(["m", "m2", "s"]); // a miss changing to another miss is unchanged
    expect(c.compared).toBe(5);
    expect([c.a_caught, c.b_caught]).toEqual([2, 2]);
    expect(c.a_rate).toBe(0.4);
    expect(c.b_rate).toBe(0.4);
    expect(c.by_task.f).toEqual({ a: "fails_on_fixed", b: "caught" });
    expect(c.missing).toEqual([]);
  });

  test("ids missing on either side are listed and never counted", () => {
    const a = makeResults({ both: "caught", onlyA: "caught", noReportB: "caught", gradeErrorA: "grade_error" });
    const b = makeResults({ both: "caught", onlyB: "caught", noReportB: null, gradeErrorA: "caught" });
    const c = compare(a, b);
    expect(c.compared).toBe(1);
    expect(c.a_rate).toBe(1);
    expect(c.b_rate).toBe(1);
    expect(c.fixed.length + c.broken.length + c.unchanged.length).toBe(1);
    expect(c.missing).toEqual([
      { id: "gradeErrorA", in: ["a"] },
      { id: "noReportB", in: ["b"] },
      { id: "onlyA", in: ["b"] },
      { id: "onlyB", in: ["a"] },
    ]);
  });

  test("--ids restricts the comparison; an id absent from both sides is missing on both", () => {
    const a = makeResults({ x: "fails_on_fixed", y: "caught", z: "caught" });
    const b = makeResults({ x: "caught", y: "caught", z: "passes_on_buggy" });
    const c = compare(a, b, ["x", "y", "ghost", "x"]);
    expect(c.compared).toBe(2);
    expect(c.fixed).toEqual(["x"]);
    expect(c.broken).toEqual([]);
    expect(c.a_rate).toBe(0.5);
    expect(c.b_rate).toBe(1);
    expect(c.missing).toEqual([{ id: "ghost", in: ["a", "b"] }]);
  });

  test("no shared id gives no rates", () => {
    const c = compare(makeResults({ x: "caught" }), makeResults({ y: "caught" }));
    expect(c.compared).toBe(0);
    expect(c.a_rate).toBeNull();
    expect(c.b_rate).toBeNull();
    expect(markdown(c)).toContain("Catch rate A: n/a");
  });

  test("a missing results directory is an error", () => {
    expect(() => compare(join(root, "nope"), makeResults({}))).toThrow("does not exist");
  });
});

test("markdown shows denominators, verdicts per task and the missing ids", () => {
  const a = makeResults({ f: "fails_on_fixed", b: "caught", gone: "caught" });
  const b = makeResults({ f: "caught", b: "fails_on_fixed" });
  const md = markdown(compare(a, b));
  expect(md).toContain("2 tasks graded on both sides");
  expect(md).toContain("Catch rate A: 50.0% (1/2)");
  expect(md).toContain("Catch rate B: 50.0% (1/2)");
  expect(md).toContain("Fixed (miss to caught): 1, broken (caught to miss): 1, unchanged: 0");
  expect(md).toContain("| f | fails_on_fixed | caught | fixed |");
  expect(md).toContain("| b | caught | fails_on_fixed | broken |");
  expect(md).toContain("- gone: B");
});

test("parseIds skips blank lines and comments", () => {
  expect(parseIds("a\n\n# note\n  b  \n")).toEqual(["a", "b"]);
});

describe("ab.ts command line", () => {
  const cwd = new URL("..", import.meta.url).pathname;
  test("compares two dirs with --ids", () => {
    const a = makeResults({ x: "fails_on_fixed", y: "caught" });
    const b = makeResults({ x: "caught", y: "caught" });
    const ids = join(root, "ids.txt");
    writeFileSync(ids, "x\n");
    const r = run(["bun", "src/ab.ts", a, b, "--ids", ids], { cwd });
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 tasks graded on both sides");
    expect(r.out).toContain("Fixed (miss to caught): 1");
  });
  test("usage error without two directories", () => {
    const r = run(["bun", "src/ab.ts", makeResults({})], { cwd });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("usage: bun src/ab.ts");
  });
});

describe("the A/B lists", () => {
  const read = (f: string) => parseIds(readFileSync(new URL(`../ab/${f}`, import.meta.url), "utf8"));
  test("9 misses and 9 controls, disjoint", () => {
    const [missed, controls] = [read("missed.txt"), read("controls.txt")];
    expect(missed).toHaveLength(9);
    expect(controls).toHaveLength(9);
    expect(new Set([...missed, ...controls]).size).toBe(18);
    expect(readdirSync(new URL("../ab", import.meta.url).pathname)).toContain("README.md");
  });
});
