import { homedir } from "node:os";
import { join } from "node:path";
import { addCi } from "./ci";
import { defaultCacheDir, SessionCache } from "./cache";
import { Repos } from "./git";
import { buildTasks } from "./link";
import { plugins } from "./plugins";

export type CollectOptions = {
  dirs?: Record<string, string>;
  since?: string;
  ci?: boolean;
  cacheDir?: string;
  noCache?: boolean;
};

export async function collect(options: CollectOptions, log = (s: string) => console.error(s)) {
  const t0 = Date.now();
  const counts: Record<string, number> = {};
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const cache = new SessionCache(options.noCache ? undefined : cacheDir);
  const sessions = plugins.flatMap(plugin => {
    const override = options.dirs?.[plugin.name];
    const paths = override === undefined ? plugin.defaultPaths(homedir()) : [override];
    const read = cache.read(plugin, paths);
    counts[plugin.name] = read.length;
    return read;
  });
  log(`read ${Object.entries(counts).map(([name, count]) => `${count} ${name}`).join(" and ")} sessions in ${((Date.now() - t0) / 1000).toFixed(1)}s (${cache.parsed} files parsed, ${cache.reused} reused)`);

  const gitStart = Date.now();
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
  return { tasks, meta: { generatedAt: Date.now(), sessions: counts, repos: repos.all().length, ci: !!options.ci } };
}
