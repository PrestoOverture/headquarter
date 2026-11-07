import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionCache } from "../src/cache";
import { plugins } from "../src/plugins";
import { collect } from "../src/collect";
import { sourceHealthFixture } from "./helpers/source-health";
import { join } from "node:path";
import { parseClaude } from "../src/claude";
import { parseCodex } from "../src/codex";
import { flagMonths, sourceDiagnostics, type Ratio } from "../src/diagnostics";
import { emptySession } from "../src/types";

test("Claude fixture counts one malformed line, unknown records, sidechains and replies without usage", () => {
  const fixture = readFileSync(join(import.meta.dir, "fixtures/claude/project/session.jsonl"), "utf8");
  const s = parseClaude(fixture + '\n{broken\nnull\n{"type":"unknown"}\n{"type":"assistant","isSidechain":true}\n', "fixture")!;
  expect(s.parse).toEqual({ records: 8, unparsed: 1, recognized: 4, replies: 4 });
  const check = sourceDiagnostics([], [s]).checks.unparsed;
  expect(check.overall).toEqual({ k: 1, n: 8 });
  expect(check.months).toEqual([{ month: "2026-01", k: 1, n: 8, baseline: null, flagged: false }]);
  expect(s.tokens).toEqual({ input: 15, cacheRead: 20, cacheWrite: 30, output: 10, reasoning: 0 });
});

test("assistant without usage triggers tokens-zero and no-model checks before task filtering", () => {
  const s = parseClaude(JSON.stringify({ type: "assistant", timestamp: "2026-02-01T00:30:00+01:00", message: { content: [] } }), "fixture")!;
  expect(s.parse).toEqual({ records: 1, unparsed: 0, recognized: 1, replies: 1 });
  const withModel = structuredClone(s);
  withModel.models = { known: 1 };
  const withTokens = structuredClone(s);
  withTokens.tokens.reasoning = 1;
  const silent = emptySession("claude", "silent", "fixture");
  silent.start = Date.parse("2026-02-01T00:00:00Z");
  silent.cwd = "/fixture";
  const invalidDate = structuredClone(s);
  invalidDate.start = Infinity;
  const report = sourceDiagnostics([], [s, withModel, withTokens, silent, invalidDate]);
  expect(report.sessions).toBe(5);
  expect(report.first).toBe("2026-01-31");
  expect(report.last).toBe("2026-02-01");
  expect(report.checks.unparsed.overall).toEqual({ k: 0, n: 4 });
  expect(report.checks.unrecognized.overall).toEqual({ k: 0, n: 0 });
  expect(report.checks.zeroTokens.overall).toEqual({ k: 3, n: 5 });
  expect(report.checks.noModel.overall).toEqual({ k: 3, n: 5 });
  expect(report.checks.emptyCwd.overall).toEqual({ k: 4, n: 5 });
  expect(report.checks.zeroTokens.months).toEqual([
    { month: "2026-01", k: 2, n: 3, baseline: null, flagged: false },
    { month: "2026-02", k: 0, n: 1, baseline: null, flagged: false },
  ]);
});

test("Codex counts malformed, unknown and handled records and assistant replies independently of usage", () => {
  const rows = [
    { type: "session_meta", payload: { id: "test" } },
    { type: "turn_context", payload: { model: "known" } },
    { type: "response_item", payload: { type: "message", role: "assistant" } },
    { type: "event_msg", payload: { type: "future_event" } },
    { type: "future_record" },
  ];
  const s = parseCodex(rows.map(row => JSON.stringify(row)).join("\n") + '\n{broken\nnull\n', "fixture")!;
  expect(s.parse).toEqual({ records: 7, unparsed: 1, recognized: 2, replies: 1 });
  expect(sourceDiagnostics([], [s]).checks.zeroTokens.overall).toEqual({ k: 1, n: 1 });
});

const cases: { name: string; months: Ratio[]; flagged: boolean; baseline: number | null }[] = [
  { name: "flags a jump", months: [{ k: 0, n: 10 }, { k: 3, n: 10 }], flagged: true, baseline: 0 },
  { name: "ignores k below three", months: [{ k: 0, n: 10 }, { k: 2, n: 3 }], flagged: false, baseline: 0 },
  { name: "no baseline", months: [{ k: 3, n: 10 }], flagged: false, baseline: null },
  { name: "ignores small baseline", months: [{ k: 0, n: 4 }, { k: 3, n: 10 }], flagged: false, baseline: null },
  { name: "exactly five percentage points", months: [{ k: 2, n: 20 }, { k: 3, n: 20 }], flagged: true, baseline: 0.1 },
  { name: "less than five points", months: [{ k: 2, n: 20 }, { k: 3, n: 21 }], flagged: false, baseline: 0.1 },
  { name: "even median, not mean", months: [{ k: 0, n: 10 }, { k: 0, n: 10 }, { k: 0, n: 10 }, { k: 10, n: 10 }, { k: 3, n: 20 }], flagged: true, baseline: 0 },
  { name: "average middle pair", months: [{ k: 1, n: 10 }, { k: 3, n: 10 }, { k: 5, n: 20 }], flagged: true, baseline: 0.2 },
  { name: "only last six eligible months", months: [{ k: 10, n: 10 }, ...Array.from({ length: 6 }, () => ({ k: 0, n: 5 })), { k: 3, n: 10 }], flagged: true, baseline: 0 },
  { name: "uses all six eligible months", months: [...Array.from({ length: 3 }, () => ({ k: 5, n: 5 })), ...Array.from({ length: 3 }, () => ({ k: 0, n: 5 })), { k: 3, n: 10 }], flagged: false, baseline: 0.5 },
  { name: "skip ineligible months, no calendar cutoff", months: [{ k: 0, n: 5 }, ...Array.from({ length: 7 }, () => ({ k: 4, n: 4 })), { k: 3, n: 10 }], flagged: true, baseline: 0 },
];
for (const c of cases) test(`month flags: ${c.name}`, () => {
  const input = Object.fromEntries(c.months.map((ratio, i) => [`2026-${String(i + 1).padStart(2, "0")}`, ratio]).reverse());
  const before = JSON.stringify(input);
  const result = flagMonths(input);
  expect(result.at(-1)).toEqual({ month: `2026-${String(c.months.length).padStart(2, "0")}`, ...c.months.at(-1)!, baseline: c.baseline, flagged: c.flagged });
  expect(JSON.stringify(input)).toBe(before);
});

test("Codex exec uses thread settings only when no turn_context model exists", () => {
  const fixture = readFileSync(join(import.meta.dir, "fixtures/codex-thread-settings.jsonl"), "utf8");
  expect(parseCodex(fixture, "fixture")!.models).toEqual({ "gpt-6-sol": 1 });
  const context = JSON.stringify({ type: "turn_context", payload: { model: "turn-model" } });
  for (const rows of [fixture + context, context + "\n" + fixture]) {
    expect(parseCodex(rows, "fixture")!.models).toEqual({ "turn-model": 1 });
  }
});

test("noModel counts replies with tokens independently of zeroTokens", () => {
  const s = parseClaude(JSON.stringify({ type: "assistant", timestamp: "2026-10-27T00:00:00Z",
    message: { usage: { input_tokens: 100, output_tokens: 10 } } }), "fixture")!;
  const checks = sourceDiagnostics([], [s]).checks;
  expect(checks.zeroTokens.overall).toEqual({ k: 0, n: 1 });
  expect(checks.noModel.overall).toEqual({ k: 1, n: 1 });
  expect(checks.noModel.months[0]).toMatchObject({ month: "2026-10", k: 1, n: 1 });
});

for (const vendor of ["claude", "codex"]) test(`${vendor}: file diagnostics count unknown formats on fresh, reused and uncached reads`, () => {
  const dir = mkdtempSync(join(tmpdir(), "tracker-file-health-"));
  try {
    const options = sourceHealthFixture(dir);
    const plugin = plugins.find(p => p.name === vendor)!;
    for (const mode of ["fresh", "reused", "uncached"]) {
      const cache = new SessionCache(mode === "uncached" ? undefined : options.cacheDir);
      const sessions = cache.read(plugin, [options.dirs[vendor as "claude" | "codex"]]);
      expect(sessions).toHaveLength(5);
      expect(cache.parsed).toBe(mode === "reused" ? 0 : 8);
      expect(cache.reused).toBe(mode === "reused" ? 8 : 0);
      const check = sourceDiagnostics([], sessions, cache.files[vendor]).checks.unrecognized;
      expect(check.overall).toEqual({ k: 3, n: 8 });
      expect(check.months).toEqual([
        { month: "2026-01", k: 0, n: 5, baseline: null, flagged: false },
        { month: "2026-02", k: 3, n: 3, baseline: 0, flagged: true },
      ]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("empty cwd diagnostics tolerate non-string source values", () => {
  const sessions = [null, undefined, 42, {}, "  ", "/valid"].map(cwd => ({ ...emptySession("opencode", "s", "fixture"), cwd })) as any;
  expect(sourceDiagnostics([], sessions).checks.emptyCwd.overall).toEqual({ k: 5, n: 6 });
});

test("collection emits one warning per flagged plugin/month on every collection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tracker-health-collect-"));
  try {
    const options = sourceHealthFixture(dir);
    for (let i = 0; i < 2; i++) {
      const log: string[] = [];
      const data = await collect(options, line => log.push(line));
      const warnings = log.filter(line => line.startsWith("Warning:"));
      expect(warnings).toHaveLength(2);
      for (const vendor of ["claude", "codex"]) {
        expect(warnings).toContain(`Warning: ${vendor} 2026-02 UTC — 未产生会话的来源文件 / 来源文件 3/3`);
        expect(data.meta.sources[vendor]!.checks.unrecognized.overall).toEqual({ k: 3, n: 8 });
      }
      expect(log.some(line => line.includes(i ? "16 reused" : "16 files parsed"))).toBe(true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
