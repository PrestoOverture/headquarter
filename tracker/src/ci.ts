// CI on a task's first commit that has checks: GitHub check runs through `gh api`, cached on disk
// (a finished commit's checks do not change). Optional: off unless --ci, and repositories without a
// GitHub remote are skipped.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Repos } from "./git";
import type { Task } from "./link";

type Verdict = "pass" | "fail" | "none";
const OK = new Set(["success", "skipped", "neutral"]);

export function githubSlug(remote?: string): string | null {
  const m = remote?.match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function fetchVerdict(slug: string, sha: string): Verdict | null {
  const p = Bun.spawnSync(["gh", "api", `repos/${slug}/commits/${sha}/check-runs?per_page=100`, "--jq", "[.check_runs[] | {status, conclusion}]"], { stdin: "ignore" });
  if (p.exitCode !== 0) return null; // unknown (no access, not pushed): ask again next time
  const runs = JSON.parse(p.stdout.toString() || "[]") as { status: string; conclusion: string | null }[];
  if (!runs.length) return "none";
  if (runs.some((r) => r.status !== "completed")) return null;
  return runs.every((r) => OK.has(r.conclusion ?? "")) ? "pass" : "fail";
}

export function addCi(tasks: Task[], repos: Repos, cacheFile: string, log: (s: string) => void) {
  const cache: Record<string, Verdict> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const slugOf = new Map(repos.all().map((r) => [r.key, githubSlug(r.remote)]));
  let asked = 0;
  for (const t of tasks) {
    const slug = t.repoKey ? slugOf.get(t.repoKey) : null;
    if (!slug) continue;
    for (const c of t.commits.filter((c) => c.mainline)) {
      const key = `${slug}@${c.sha}`;
      if (!(key in cache)) {
        const v = fetchVerdict(slug, c.sha);
        asked++;
        if (v === null) continue;
        cache[key] = v;
      }
      if (cache[key] === "none") continue;
      t.ci = cache[key] as "pass" | "fail";
      break;
    }
  }
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(cache));
  log(`ci: ${asked} commits asked on GitHub, cache ${cacheFile}`);
}
