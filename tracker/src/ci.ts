// Attribute failed checks to a task only when its nearest checked first-parent ancestor passed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Repos } from "./git";
import type { Task } from "./link";

type Verdict = "pass" | "fail" | "none";
type Checks = Record<string, "pass" | "fail">;
type Result = Checks | Verdict | null;
type CacheEntry = Verdict | { checks: Checks } | { verdict: "unknown"; at: number };
export type Fetcher = (slug: string, sha: string, at: number) => Promise<Result> | Result;
const OK = new Set(["success", "skipped", "neutral"]);
const WEEK = 7 * 86400000;

export function githubSlug(remote?: string): string | null {
  const m = remote?.match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export type CheckRun = { name: string; id: number; status: string; conclusion: string | null; completed_at: string | null };
type RunsFetcher = (slug: string, sha: string) => Promise<CheckRun[] | null>;

const fetchRuns: RunsFetcher = async (slug, sha) => {
  const p = Bun.spawn(["gh", "api", "--method", "GET", `repos/${slug}/commits/${sha}/check-runs?per_page=100`, "--jq", "[.check_runs[] | {name, status, conclusion, id, completed_at}]"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const output = await new Response(p.stdout).text();
  if (await p.exited !== 0) return null;
  return JSON.parse(output || "[]") as CheckRun[];
};

export async function fetchVerdict(slug: string, sha: string, at: number, fetcher: RunsFetcher = fetchRuns): Promise<Checks | "none" | null> {
  const runs = await fetcher(slug, sha);
  if (runs === null) return null;
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    // Cancelled reruns do not replace the last meaningful attempt.
    if (run.conclusion === "cancelled") continue;
    if (run.completed_at !== null) {
      const completed = Date.parse(run.completed_at);
      if (!(completed >= at && completed <= at + 72 * 3600000)) continue;
    }
    if (!latest.has(run.name) || run.id > latest.get(run.name)!.id) latest.set(run.name, run);
  }
  const kept = [...latest.values()];
  if (!kept.length) return "none";
  if (kept.some((r) => r.status !== "completed")) return null;
  return Object.fromEntries(kept.map((r) => [r.name, OK.has(r.conclusion ?? "") ? "pass" : "fail"]));
}

export async function addCi(tasks: Task[], repos: Repos, cacheFile: string, log: (s: string) => void, fetcher: Fetcher = fetchVerdict) {
  const cache: Record<string, CacheEntry> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const repoOf = new Map(repos.all().map((r) => [r.key, r]));
  const pending = new Map<string, Promise<Result>>();
  let active = 0, asked = 0;
  const waiting: (() => void)[] = [];
  async function lookup(slug: string, sha: string, at: number): Promise<Result> {
    const key = `${slug}@${sha}`;
    const hit = cache[key];
    if (typeof hit === "string") return hit;
    if (hit && "checks" in hit) return hit.checks;
    if (hit && "at" in hit && Date.now() - hit.at < WEEK) return null;
    if (pending.has(key)) return pending.get(key)!;
    const request = (async () => {
      if (active >= 8) await new Promise<void>((resolve) => waiting.push(resolve));
      else active++;
      let verdict: Result = null;
      try { asked++; verdict = await fetcher(slug, sha, at); } catch { /* Retry unknown lookups after a week. */ }
      finally {
        const next = waiting.shift();
        if (next) next(); else active--;
      }
      cache[key] = verdict === null ? { verdict: "unknown", at: Date.now() } : typeof verdict === "string" ? verdict : { checks: verdict };
      return verdict;
    })();
    pending.set(key, request);
    return request;
  }
  await Promise.all(tasks.map(async (t) => {
    t.ci = "unknown";
    const repo = t.repoKey ? repoOf.get(t.repoKey) : undefined;
    const slug = githubSlug(repo?.remote);
    if (!repo || !slug) return;
    const verdicts = await Promise.all(t.commits.filter((c) => c.mainline).map(async (c) => {
      const commit = repo.commits.get(c.sha);
      if (!commit) return "unknown";
      const asChecks = (v: Result): Checks | null => v === null || v === "none" ? null : typeof v === "string" ? { legacy: v } : v;
      const checks = asChecks(await lookup(slug, c.sha, commit.at));
      if (!checks) return "unknown";
      const failed = Object.keys(checks).filter((name) => checks[name] === "fail");
      if (!failed.length) return "pass";
      let parent = commit.parents[0];
      for (let step = 0; parent && step < 20; step++) {
        const ancestor = repo.commits.get(parent);
        if (!ancestor) break;
        const baseline = asChecks(await lookup(slug, parent, ancestor.at));
        if (baseline && Object.keys(baseline).length) {
          if (failed.some((name) => baseline[name] === "pass")) return "broke";
          if (failed.some((name) => baseline[name] === "fail")) return "inherited";
          return "pass";
        }
        parent = ancestor.parents[0];
      }
      return "unknown";
    }));
    t.ci = verdicts.includes("broke") ? "broke" : verdicts.includes("pass") ? "pass" : verdicts.includes("inherited") ? "inherited" : "unknown";
  }));
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(cache));
  log(`ci: ${asked} commits asked on GitHub, cache ${cacheFile}`);
}
