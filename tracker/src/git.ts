// Repositories and their commits. A session's working directory may be a worktree that no longer
// exists, so the repository is found from the nearest existing ancestor; `<repo>.goals/<goal>`
// (hq's worktrees) and `.claude/worktrees/<name>` fall back to the repository they came from.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export type Commit = {
  sha: string;
  parents: string[];
  at: number; // committer time, ms
  author: string;
  subject: string;
  body: string;
  files: string[];
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
  const p = Bun.spawnSync(cmd, { cwd, stdin: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  return { code: p.exitCode ?? -1, out: p.stdout.toString() };
}

const LOCKFILES = /(^|\/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|uv\.lock|poetry\.lock)$/;

function loadCommits(top: string): Map<string, Commit> {
  const commits = new Map<string, Commit>();
  const r = run(["git", "log", "--all", "--numstat", "--no-renames", "--format=%x1e%H%x1f%P%x1f%ct%x1f%an%x1f%s%x1f%b%x1d"], top);
  if (r.code !== 0) return commits;
  for (const rec of r.out.split("\x1e")) {
    if (!rec.trim()) continue;
    const [head, stat = ""] = rec.split("\x1d");
    const [sha, parents, ct, author, subject, body] = head!.split("\x1f");
    if (!sha) continue;
    const c: Commit = {
      sha, parents: parents ? parents.split(" ") : [], at: Number(ct) * 1000, author: author ?? "", subject: subject ?? "",
      body: body ?? "", files: [], added: 0, deleted: 0, mainline: false,
    };
    for (const line of stat.split("\n")) {
      const [a, d, ...path] = line.split("\t");
      if (!path.length) continue;
      const file = path.join("\t");
      c.files.push(file);
      if (a === "-" || d === "-" || LOCKFILES.test(file)) continue;
      c.added += Number(a);
      c.deleted += Number(d);
    }
    commits.set(sha, c);
  }
  return commits;
}

function mainRef(top: string): string | undefined {
  const head = run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], top);
  if (head.code === 0 && head.out.trim()) return head.out.trim();
  for (const ref of ["main", "master", "origin/main", "origin/master"]) {
    if (run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], top).code === 0) return ref;
  }
  return undefined;
}

function identify(dir: string): { key: string; top: string } | null {
  const common = run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
  const top = run(["git", "rev-parse", "--show-toplevel"], dir);
  if (common.code !== 0 || top.code !== 0) return null;
  return { key: realpathSync(common.out.trim()), top: top.out.trim() };
}

function openRepo(key: string, top: string): Repo {
  const commits = loadCommits(top);
  const main = mainRef(top);
  if (main) {
    // the local main and its remote both count: work merged on either has landed
    const refs = [main, main.replace(/^origin\//, ""), `origin/${main.replace(/^origin\//, "")}`];
    const valid = refs.filter((ref) => run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], top).code === 0);
    const list = run(["git", "rev-list", ...new Set(valid)], top);
    for (const sha of list.out.split("\n")) {
      const c = commits.get(sha);
      if (c) c.mainline = true;
    }
  }
  const remoteR = run(["git", "config", "--get", "remote.origin.url"], top);
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
  return { key, name, top, remote, commits, byPrefix, main };
}

/** Finds and caches repositories by working directory. */
export class Repos {
  private byDir = new Map<string, Repo | null>();
  private byKey = new Map<string, Repo>();

  constructor(private readonly home: string) {}

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
      const id = identify(dir);
      if (!id) continue;
      if (realpathSync(id.top) === realpathSync(this.home)) return null;
      const known = this.byKey.get(id.key);
      if (known) return known;
      const repo = openRepo(id.key, id.top);
      this.byKey.set(repo.key, repo);
      return repo;
    }
    return null;
  }
}

export type ReworkLine = { file: string; text: string };
const originsCache = new Map<string, Map<string, ReworkLine[]>>();

/**
 * Cached evidence from blame of the parent over deleted ranges. Text added anywhere in the
 * same diff is a move, and short or punctuation-only deletions are ignored.
 */
export function originEvidence(repo: Repo, sha: string): Map<string, ReworkLine[]> {
  const key = `${repo.key}@${sha}`;
  const hit = originsCache.get(key);
  if (hit) return hit;
  const origins = new Map<string, ReworkLine[]>();
  const diff = run(["git", "diff", "-U0", "--no-renames", "--no-color", `${sha}^`, sha], repo.top);
  if (diff.code === 0) {
    const added = new Set<string>();
    const ranges = new Map<string, string[]>();
    let file: string | null = null;
    let inHunk = false;
    for (const line of diff.out.split("\n")) {
      if (line.startsWith("diff --git ")) inHunk = false;
      if (inHunk && line.startsWith("+")) added.add(line.slice(1).trim());
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
      const blame = run(["git", "blame", "--porcelain", ...ls, `${sha}^`, "--", f], repo.top);
      if (blame.code !== 0) continue;
      let origin = "";
      for (const l of blame.out.split("\n")) {
        const m = l.match(/^([0-9a-f]{40}) \d+ \d+/);
        if (m) origin = m[1]!;
        if (!l.startsWith("\t")) continue;
        const text = l.slice(1).trim();
        if (!origin || text.length < 4 || !/[\p{L}\p{N}]/u.test(text) || added.has(text)) continue;
        const lines = origins.get(origin) ?? [];
        if (lines.length < 5) lines.push({ file: f, text: text.slice(0, 160) });
        origins.set(origin, lines);
      }
    }
  }
  originsCache.set(key, origins);
  return origins;
}

/** Origins of substantive deletions, excluding text added anywhere in the fix. */
export function originsOf(repo: Repo, sha: string): Set<string> {
  return new Set(originEvidence(repo, sha).keys());
}
