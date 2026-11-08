// Repositories and their commits. A session's working directory may be a worktree that no longer
// exists, so the repository is found from the nearest existing ancestor; `<repo>.goals/<goal>`
// (hq's worktrees) and `.claude/worktrees/<name>` fall back to the repository they came from.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { GitCommands } from "./git-cache";

export type Commit = {
  sha: string;
  parents: string[];
  at: number; // committer time, ms
  author: string;
  subject: string;
  body: string;
  files: string[];
  fileLines: Record<string, number>; // added + deleted, excluding lockfiles and binary files
  added: number;
  deleted: number;
  mainline: boolean; // reachable from the repository's main branch
};

export type Repo = {
  key: string; // the shared .git directory, real path
  name: string;
  top: string; // a working tree of it
  remote?: string;
  commits: Map<string, Commit>;
  byPrefix: (short: string) => Commit | undefined;
  main?: string;
};

export function run(cmd: string[], cwd: string): { code: number; out: string } {
  const p = spawnSync(cmd[0]!, cmd.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 1024 * 1024 * 1024 });
  return { code: p.status ?? -1, out: p.stdout?.toString() ?? "" };
}

export const LOCKFILES = /(^|\/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|uv\.lock|poetry\.lock)$/;

function loadCommits(git: GitCommands): Map<string, Commit> {
  const commits = new Map<string, Commit>();
  const r = git.read(["log", "--exclude=refs/stash", "--all", "--numstat", "--no-renames", "--format=%x1e%H%x1f%P%x1f%ct%x1f%an%x1f%s%x1f%b%x1d"]);
  if (r.code !== 0) return commits;
  for (const rec of r.out.split("\x1e")) {
    if (!rec.trim()) continue;
    const [head, stat = ""] = rec.split("\x1d");
    const [sha, parents, ct, author, subject, body] = head!.split("\x1f");
    if (!sha) continue;
    const c: Commit = {
      sha, parents: parents ? parents.split(" ") : [], at: Number(ct) * 1000, author: author ?? "", subject: subject ?? "",
      body: body ?? "", files: [], fileLines: {}, added: 0, deleted: 0, mainline: false,
    };
    for (const line of stat.split("\n")) {
      const [a, d, ...path] = line.split("\t");
      if (!path.length) continue;
      const file = path.join("\t");
      c.files.push(file);
      if (a === "-" || d === "-" || LOCKFILES.test(file)) continue;
      c.fileLines[file] = (c.fileLines[file] ?? 0) + Number(a) + Number(d);
      c.added += Number(a);
      c.deleted += Number(d);
    }
    commits.set(sha, c);
  }
  return commits;
}

function mainRef(git: GitCommands): string | undefined {
  const head = git.read(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.out.trim()) return head.out.trim();
  for (const ref of ["main", "master", "origin/main", "origin/master"]) {
    if (git.read(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).code === 0) return ref;
  }
  return undefined;
}

function identify(dir: string, exec: typeof run): { key: string; top: string; gitDir: string } | null {
  const result = exec(["git", "rev-parse", "--path-format=absolute", "--git-common-dir", "--absolute-git-dir", "--show-toplevel"], dir);
  if (result.code !== 0) return null;
  const [common, gitDir, top] = result.out.trim().split("\n");
  if (!common || !gitDir || !top) return null;
  return { key: realpathSync(common), top, gitDir };
}

const commands = new WeakMap<Repo, GitCommands>();
function gitOf(repo: Repo): GitCommands {
  return commands.get(repo) ?? new GitCommands(repo.key, repo.top, repo.key, run);
}

function openRepo(key: string, top: string, git: GitCommands): Repo {
  const commits = loadCommits(git);
  const main = mainRef(git);
  if (main) {
    // the local main and its remote both count: work merged on either has landed
    const refs = [main, main.replace(/^origin\//, ""), `origin/${main.replace(/^origin\//, "")}`];
    const valid = refs.filter((ref) => git.read(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).code === 0);
    const list = git.read(["rev-list", ...new Set(valid)]);
    for (const sha of list.out.split("\n")) {
      const c = commits.get(sha);
      if (c) c.mainline = true;
    }
  }
  const remoteR = git.read(["config", "--get", "remote.origin.url"]);
  const remote = remoteR.code === 0 ? remoteR.out.trim() : undefined;
  const shas = [...commits.keys()];
  const prefixCache = new Map<string, Commit | undefined>();
  const byPrefix = (short: string) => {
    if (prefixCache.has(short)) return prefixCache.get(short);
    const hits = short.length === 40 ? (commits.has(short) ? [short] : []) : shas.filter((s) => s.startsWith(short));
    const c = hits.length === 1 ? commits.get(hits[0]!) : undefined;
    prefixCache.set(short, c);
    return c;
  };
  const name = basename(key.endsWith("/.git") ? dirname(key) : key.replace(/\.git$/, ""));
  const repo = { key, name, top, remote, commits, byPrefix, main };
  commands.set(repo, git);
  return repo;
}

/** Finds and caches repositories by working directory. */
export class Repos {
  private byDir = new Map<string, Repo | null>();
  private byKey = new Map<string, Repo>();
  private byRoot = new Map<string, Repo>();
  private unidentified = new Set<string>();
  private gitVersion?: ReturnType<typeof run>;

  constructor(private readonly home: string, private readonly cacheDir?: string, private readonly exec = run) {}

  all(): Repo[] {
    return [...this.byKey.values()];
  }

  /** The repository a session ran in, or null (no repository, or the home directory itself). */
  of(cwd: string): Repo | null {
    if (!cwd) return null;
    if (this.byDir.has(cwd)) return this.byDir.get(cwd)!;
    const repo = this.find(resolve(cwd));
    this.byDir.set(cwd, repo);
    return repo;
  }

  private find(cwd: string): Repo | null {
    const candidates: string[] = [];
    const goals = cwd.match(/^(.*)\.goals(\/|$)/);
    const claudeWt = cwd.match(/^(.*)\/\.claude\/worktrees\//);
    let p = cwd;
    while (p !== "/" && !existsSync(p)) p = dirname(p);
    candidates.push(p);
    if (goals) candidates.push(goals[1]!);
    if (claudeWt) candidates.push(claudeWt[1]!);
    for (const dir of candidates) {
      if (!existsSync(dir) || dir === "/") continue;
      // Check every ancestor for a nested repo/worktree before reusing a discovery. Do not
      // persist discovery: a later collection must notice moved/deleted/new repositories.
      const physical = realpathSync(dir);
      if (this.unidentified.has(physical)) continue;
      let root = physical;
      while (root !== "/" && !existsSync(join(root, ".git"))) root = dirname(root);
      const memoize = !Object.keys(process.env).some(name => /^GIT_(DIR|COMMON_DIR|WORK_TREE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)$/.test(name));
      if (memoize && this.byRoot.has(root)) {
        return this.byRoot.get(root)!;
      }
      const id = identify(dir, this.exec);
      if (!id) {
        this.unidentified.add(physical);
        continue;
      }
      if (realpathSync(id.top) === realpathSync(this.home)) return null;
      const known = this.byKey.get(id.key);
      if (known) {
        if (memoize) this.byRoot.set(root, known);
        return known;
      }
      if (this.cacheDir) this.gitVersion ??= this.exec(["git", "--version"], id.top);
      const repo = openRepo(id.key, id.top, new GitCommands(id.key, id.top, id.gitDir, this.exec, this.cacheDir, this.gitVersion));
      if (memoize) this.byRoot.set(root, repo);
      this.byKey.set(repo.key, repo);
      return repo;
    }
    return null;
  }
}

// Build the mainline chains and reverse edges only when a candidate pair needs them.
const landingIndexes = new WeakMap<Repo, { chains: Map<string, number>[]; children: Map<string, string[]>; cache: Map<string, string[]> }>();
function landings(repo: Repo, sha: string): string[] {
  let index = landingIndexes.get(repo);
  if (!index) {
    const chains: Map<string, number>[] = [];
    if (repo.main) {
      const local = repo.main.replace(/^origin\//, "");
      for (const ref of new Set([repo.main, local, `origin/${local}`])) {
        const result = gitOf(repo).read(["rev-list", "--first-parent", ref]);
        if (result.code === 0) chains.push(new Map(result.out.trim().split("\n").map((s, i) => [s, i])));
      }
    }
    const children = new Map<string, string[]>();
    for (const c of repo.commits.values()) for (const parent of c.parents) {
      const list = children.get(parent) ?? [];
      list.push(c.sha);
      children.set(parent, list);
    }
    index = { chains, children, cache: new Map() };
    landingIndexes.set(repo, index);
  }
  const cached = index.cache.get(sha);
  if (cached) return cached;
  const result = index.chains.map(chain => {
    // A chain commit lands via itself; otherwise find its earliest chain descendant.
    let landing: string | undefined;
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const rank = chain.get(next);
      if (rank !== undefined) {
        if (!landing || rank > chain.get(landing)!) landing = next;
      } else stack.push(...(index!.children.get(next) ?? []));
    }
    return landing;
  }).filter((s): s is string => !!s);
  index.cache.set(sha, result);
  return result;
}

/** Both commits first entered a local or remote mainline through the same commit. */
export function sameLanding(repo: Repo, a: string, b: string): boolean {
  const first = landings(repo, a);
  return landings(repo, b).some(sha => first.includes(sha));
}

export type ReworkLine = { file: string; text: string };
const normalizeLine = (text: string) => text.replace(/[\s;,]/g, "").replace(/["'`]/g, '"');
function isReflow(text: string, runs: string[][]): boolean {
  const target = normalizeLine(text);
  for (const run of runs) for (let start = 0; start < run.length; start++) {
    let joined = "";
    for (let end = start; end < run.length; end++) {
      joined += run[end]!;
      if (joined === target) return true;
      if (!target.startsWith(joined)) break;
    }
  }
  return false;
}
const originsCache = new WeakMap<Repo, Map<string, Map<string, ReworkLine[]>>>();

/**
 * Cached evidence from blame of the parent over deleted ranges. Text added anywhere in the
 * same diff is a move; equality with a normalized run of consecutive added lines within
 * one hunk of the same file is a formatter reflow. Short or punctuation-only deletions are ignored.
 */
export function originEvidence(repo: Repo, sha: string): Map<string, ReworkLine[]> {
  let cache = originsCache.get(repo);
  if (!cache) { cache = new Map(); originsCache.set(repo, cache); }
  const hit = cache.get(sha);
  if (hit) return hit;
  const origins = new Map<string, ReworkLine[]>();
  const diff = gitOf(repo).read(["diff", "-U0", "--no-renames", "--no-color", `${sha}^`, sha], true);
  if (diff.code === 0) {
    const added = new Set<string>();
    const addedByFile = new Map<string, string[][]>();
    let addedRun: string[] | undefined;
    const ranges = new Map<string, string[]>();
    let file: string | null = null;
    let inHunk = false;
    for (const line of diff.out.split("\n")) {
      if (line.startsWith("diff --git ")) inHunk = false;
      if (inHunk && line.startsWith("+")) {
        const text = line.slice(1).trim();
        added.add(text);
        if (file) {
          if (!addedRun) {
            addedRun = [];
            const runs = addedByFile.get(file) ?? [];
            runs.push(addedRun);
            addedByFile.set(file, runs);
          }
          addedRun.push(normalizeLine(text));
        }
      } else addedRun = undefined;
      if (!inHunk && line.startsWith("--- ")) file = line === "--- /dev/null" ? null : line.slice(6);
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? /);
      if (m) inHunk = true;
      if (m && file && !LOCKFILES.test(file)) {
        const start = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        if (count > 0) ranges.set(file, [...(ranges.get(file) ?? []), "-L", `${start},+${count}`]);
      }
    }
    for (const [f, ls] of ranges) {
      const blame = gitOf(repo).read(["blame", "--porcelain", ...ls, `${sha}^`, "--", f], true);
      if (blame.code !== 0) continue;
      let origin = "";
      for (const l of blame.out.split("\n")) {
        const m = l.match(/^([0-9a-f]{40}) \d+ \d+/);
        if (m) origin = m[1]!;
        if (!l.startsWith("\t")) continue;
        const text = l.slice(1).trim();
        if (!origin || text.length < 4 || !/[\p{L}\p{N}]/u.test(text) || added.has(text) || isReflow(text, addedByFile.get(f) ?? [])) continue;
        const lines = origins.get(origin) ?? [];
        if (lines.length < 5) lines.push({ file: f, text: text.slice(0, 160) });
        origins.set(origin, lines);
      }
    }
  }
  cache.set(sha, origins);
  return origins;
}

/** Origins of substantive deletions, excluding text added anywhere in the fix. */
export function originsOf(repo: Repo, sha: string): Set<string> {
  return new Set(originEvidence(repo, sha).keys());
}
