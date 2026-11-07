import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { addCi } from "./ci";
import { defaultCacheDir, SessionCache } from "./cache";
import { Repos } from "./git";
import { buildTasks } from "./link";
import { plugins } from "./plugins";
import { checkLabels, sourceDiagnostics, type SourceDiagnostics } from "./diagnostics";

export type CollectOptions = {
  dirs?: Record<string, string>;
  since?: string;
  ci?: boolean;
  cacheDir?: string;
  noCache?: boolean;
};

export type CollectProgress = { plugin: string; parsed: number; reused: number; elapsedSeconds: number };

export async function collect(options: CollectOptions, log = (s: string) => console.error(s), progress?: (value: CollectProgress) => void) {
  const t0 = Date.now();
  const counts: Record<string, number> = {};
  const sources: Record<string, SourceDiagnostics> = {};
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  let pluginName = "准备", lastProgress = 0;
  const reportProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgress < 100) return;
    lastProgress = now;
    progress?.({ plugin: pluginName, parsed: cache.parsed, reused: cache.reused, elapsedSeconds: (now - t0) / 1000 });
  };
  const cache = new SessionCache(options.noCache ? undefined : cacheDir, reportProgress);
  const sessions = plugins.flatMap(plugin => {
    pluginName = plugin.name;
    reportProgress(true);
    const override = options.dirs?.[plugin.name];
    const paths = override === undefined ? plugin.defaultPaths(homedir()) : [override];
    const read = cache.read(plugin, paths);
    reportProgress(true);
    counts[plugin.name] = read.length;
    sources[plugin.name] = sourceDiagnostics(paths.map(path => ({ path, exists: existsSync(path), detected: plugin.detect(path) })), read, cache.files[plugin.name]);
    return read;
  });
  log(`read ${Object.entries(counts).map(([name, count]) => `${count} ${name}`).join(" and ")} sessions in ${((Date.now() - t0) / 1000).toFixed(1)}s (${cache.parsed} files parsed, ${cache.reused} reused)`);

  const gitStart = Date.now();
  pluginName = "git/link";
  reportProgress(true);
  const repos = new Repos(homedir(), options.noCache ? undefined : cacheDir);
  let tasks = buildTasks(sessions, repos);
  log(`git/link in ${((Date.now() - gitStart) / 1000).toFixed(1)}s`);
  if (options.since) {
    const since = Date.parse(options.since);
    tasks = tasks.filter(t => t.start >= since);
  }
  const commits = tasks.flatMap(t => t.commits);
  log(`${tasks.length} tasks in ${repos.all().length} repositories; ${commits.length} commits linked (${commits.filter(c => c.how === "exact").length} exact)`);
  if (options.ci) await addCi(tasks, repos, options.noCache ? undefined : join(cacheDir, "ci-v3.json"), log);
  const generatedAt = Date.now();
  for (const task of tasks) task.ongoing = Math.abs(generatedAt - task.end) <= 30 * 60_000;
  reportProgress(true);
  for (const [name, source] of Object.entries(sources)) {
    const flagged = new Map<string, string[]>();
    for (const [check, value] of Object.entries(source.checks)) for (const month of value.months) {
      if (!month.flagged) continue;
      const details = flagged.get(month.month) ?? [];
      details.push(`${checkLabels[check as keyof typeof checkLabels]} ${month.k}/${month.n}`);
      flagged.set(month.month, details);
    }
    for (const [month, details] of flagged) log(`Warning: ${name} ${month} UTC — ${details.join("; ")}`);
  }
  return { tasks, meta: { generatedAt, sessions: counts, repos: repos.all().length, ci: !!options.ci, sources } };
}
