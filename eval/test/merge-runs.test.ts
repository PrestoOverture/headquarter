import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeRuns } from "../src/merge-runs";
import { markdown, readResults, summarize } from "../src/summarize";

const root = mkdtempSync(join(tmpdir(), "merge-runs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `d${n++}`);

type Spec = { verdict?: string; at?: string; written?: boolean; layout?: "direct" | "graded" };

// A run dir holding the given ids; no verdict means no report.json.
function makeRun(specs: Record<string, Spec>): string {
  const run = fresh();
  mkdirSync(run);
  for (const [id, { verdict, at, written = true, layout = "direct" }] of Object.entries(specs)) {
    const dir = layout === "direct" ? join(run, id) : join(run, `graded-${id}`, id);
    mkdirSync(dir, { recursive: true });
    if (written) writeFileSync(join(dir, "write.json"), "{}");
    writeFileSync(join(dir, "marker.txt"), `${run}\n`);
    if (verdict) writeFileSync(join(dir, "report.json"), JSON.stringify({ instance_id: id, language: "c", verdict, graded_at: at }));
  }
  return run;
}

const read = (...p: string[]) => JSON.parse(readFileSync(join(...p), "utf8"));
const marker = (out: string, id: string) => readFileSync(join(out, id, "marker.txt"), "utf8").trim();

describe("mergeRuns", () => {
  test("reads both layouts and takes each id whole from its run", () => {
    const a = makeRun({ x: { verdict: "caught", layout: "graded" }, y: { verdict: "passes_on_buggy" } });
    const b = makeRun({ z: { verdict: "caught", layout: "graded" } });
    const out = fresh();
    mergeRuns(out, [a, b]);
    expect(readdirSync(out).sort()).toEqual(["sources.json", "summary.json", "summary.md", "x", "y", "z"]);
    expect(marker(out, "x")).toBe(a);
    expect(existsSync(join(out, "x", "write.json"))).toBe(true);
    expect(read(out, "sources.json").sources).toEqual({ x: a, y: a, z: b });
  });

  test("newest graded_at wins whatever the argument order", () => {
    const old = makeRun({ x: { verdict: "passes_on_buggy", at: "2026-10-01T10:00:00.000Z" } });
    const recent = makeRun({ x: { verdict: "caught", at: "2026-10-02T10:00:00.000Z" } });
    for (const runs of [[old, recent], [recent, old]]) {
      const out = fresh();
      mergeRuns(out, runs);
      expect(marker(out, "x")).toBe(recent);
      expect(read(out, "summary.json").by_task).toEqual({ x: "caught" });
    }
  });

  test("without graded_at the later run dir wins; a report with graded_at beats one without", () => {
    const a = makeRun({ x: { verdict: "passes_on_buggy" }, y: { verdict: "passes_on_buggy", at: "2026-10-01T00:00:00.000Z" } });
    const b = makeRun({ x: { verdict: "caught" }, y: { verdict: "caught" } });
    const out = fresh();
    mergeRuns(out, [a, b]);
    expect(marker(out, "x")).toBe(b);
    expect(marker(out, "y")).toBe(a);
  });

  test("a later run with a writer output but no grade does not replace an earlier grade", () => {
    const graded = makeRun({ x: { verdict: "caught", at: "2026-10-01T00:00:00.000Z" } });
    const ungraded = makeRun({ x: {} });
    const out = fresh();
    mergeRuns(out, [graded, ungraded]);
    expect(marker(out, "x")).toBe(graded);
    expect(read(out, "sources.json").ungraded).toEqual([]);
  });

  test("sources.json lists ids with a writer output but no grade anywhere", () => {
    const a = makeRun({ x: { verdict: "caught" }, u: {}, v: {}, empty: { written: false } });
    const b = makeRun({ u: {} });
    const out = fresh();
    const { summary } = mergeRuns(out, [a, b]);
    const sources = read(out, "sources.json");
    expect(sources.sources).toEqual({ empty: a, u: b, v: a, x: a });
    expect(sources.ungraded).toEqual(["u", "v"]);
    expect(summary.missing.sort()).toEqual(["empty", "u", "v"]);
  });

  test("the merged summary is summarize() over the chosen reports", () => {
    const a = makeRun({
      p: { verdict: "passes_on_buggy", at: "2026-10-01T00:00:00.000Z" },
      q: { verdict: "caught", at: "2026-10-01T00:00:00.000Z" },
      r: { verdict: "no_script" },
    });
    const b = makeRun({ p: { verdict: "caught", at: "2026-10-02T00:00:00.000Z" }, s: {} });
    const out = fresh();
    const { summary } = mergeRuns(out, [a, b]);
    const expected = summarize(
      [
        { instance_id: "p", language: "c", verdict: "caught" },
        { instance_id: "q", language: "c", verdict: "caught" },
        { instance_id: "r", language: "c", verdict: "no_script" },
      ],
      ["s"],
    );
    expect(summary).toEqual(expected);
    expect(read(out, "summary.json")).toEqual(expected);
    expect(readFileSync(join(out, "summary.md"), "utf8")).toBe(markdown(expected) + "\n");
    const { reports, missing } = readResults(out);
    expect(summarize(reports, missing)).toEqual(expected);
  });

  test("refuses a non-empty out and a missing run dir, writing nothing", () => {
    const run = makeRun({ x: { verdict: "caught" } });
    const full = fresh();
    mkdirSync(full);
    writeFileSync(join(full, "keep.txt"), "mine");
    expect(() => mergeRuns(full, [run])).toThrow("not empty");
    expect(readdirSync(full)).toEqual(["keep.txt"]);

    const out = fresh();
    expect(() => mergeRuns(out, [run, join(root, "nope")])).toThrow("does not exist");
    expect(existsSync(out)).toBe(false);
  });

  test("an empty out directory is fine", () => {
    const run = makeRun({ x: { verdict: "caught" } });
    const out = fresh();
    mkdirSync(out);
    mergeRuns(out, [run]);
    expect(existsSync(join(out, "x", "report.json"))).toBe(true);
  });
});
