import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Task } from "../src/link";
import { html } from "../src/report";
import { trend } from "../src/trend.js";
import { evaluateDashboard } from "./helpers/dashboard";

const monday = Date.parse("2026-01-05T00:00:00Z"), week = 7 * 86400000;
function task(i: number): Task {
  return {
    id: String(i), combo: "solo", vendor: i % 3 ? "claude" : "codex", repo: i % 4 ? "repo-a" : "repo-b", cwd: "/fixture",
    start: monday + Math.floor(i / 7) * week, end: monday + Math.floor(i / 7) * week + 1000,
    headless: i % 17 === 0, empty: i % 13 === 0, model: i % 11 ? Math.floor(i / 14) % 2 ? "B" : "A" : undefined, models: [], kinds: [], sessions: 1,
    costUSD: 0, tokens: { input: i * 10, cacheRead: i * 20, cacheWrite: i * 30, output: i % 9 ? i * 7 : 0, reasoning: 0 },
    humanPrompts: 1, interrupts: 0, waitMs: 0, kind: "代码", size: "<100", landed: i % 5 !== 0, reworked: i % 3 === 0, mature: i < 32, reverted: false,
    commits: [{ sha: String(i), at: monday, subject: "work", added: 1, deleted: 0, fileLines: {}, mainline: true, how: "exact", reworkedBy: [], reworkEvidence: [], mature: i < 32 }],
  };
}

test("extracted trend points and both complete SVGs match the pre-extraction dashboard", () => {
  const tasks = Array.from({ length: 49 }, (_, i) => task(i));
  tasks.splice(14, 7); // An entirely empty bucket.
  const meta = { generatedAt: monday + 50 * 86400000, sessions: { claude: tasks.length }, repos: 2, ci: false };
  const page = html(tasks, meta);
  const frozen = readFileSync(new URL("./fixtures/trends-before.js", import.meta.url), "utf8");
  const start = page.indexOf("const DAY = 86400000;", page.indexOf("function keyFn"));
  const end = page.indexOf("function rate", start);
  const beforePage = page.slice(0, start) + frozen + "\n" + page.slice(end);
  expect(beforePage).not.toBe(page);
  const before = evaluateDashboard(beforePage), after = evaluateDashboard(page);
  for (const bucket of ["week", "4week"] as const) for (const metric of ["input", "output"] as const) {
    for (const view of [before, after]) { view.change("bucket", bucket); view.change("token-metric", metric); }
    for (const [control, value] of [["repo", ""], ["repo", "repo-a"], ["repo", "repo-b"], ["agent", "codex"], ["from", "2026-01-26"], ["markers", false], ["to", "2025-01-01"]] as const) {
      before.change(control, value); after.change(control, value);
      for (const id of ["trend-rework", "trend-tokens"]) expect(after.get(id).innerHTML).toBe(before.get(id).innerHTML);
      expect(after.read("modelSwitches(filtered())")).toEqual(before.read("modelSwitches(filtered())"));
      expect(after.read(`trend(filtered(), '${bucket}', '${metric}')`)).toEqual(trend(after.read("filtered()"), bucket, metric));
    }
    for (const view of [before, after]) {
      view.change("repo", ""); view.change("agent", ""); view.change("from", ""); view.change("to", ""); view.change("markers", true);
    }
  }
});
