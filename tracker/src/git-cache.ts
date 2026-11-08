import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GitCache, type GitResult } from "./cache";

type Run = (cmd: string[], cwd: string) => GitResult;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function contents(path: string): string | null {
  try { return readFileSync(path).toString("base64"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** One collection's command cache for one working tree. Nothing is written into the repo. */
export class GitCommands {
  private cache?: GitCache;
  private refs = "";
  private objects = "";

  constructor(private readonly key: string, private readonly top: string, gitDir: string,
    private readonly run: Run, cacheDir?: string, gitVersion?: GitResult) {
    if (!cacheDir) return;
    try {
      // Alternate Git storage/attribute locations may carry mutable inputs outside this repo.
      if (["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_ATTR_SOURCE"]
        .some(name => process.env[name] !== undefined)) return;
      const refs = run(["git", "for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"], top);
      const config = run(["git", "config", "--null", "--list"], top);
      const attrs = run(["git", "ls-files", "--stage", "-z", "--", ".gitattributes", "**/.gitattributes", ".gitmodules"], top);
      const version = gitVersion ?? run(["git", "--version"], top);
      if ([refs, config, attrs, version].some(r => r.code !== 0)) return;
      // These commands can depend on arbitrary external programs or mutable external objects.
      // Run fresh rather than guessing at their inputs.
      if (process.env.GIT_EXTERNAL_DIFF || process.env.GIT_DIFF_OPTS
        || /(?:^|\0)(?:diff\.(?:external|.*\.(?:command|textconv))|mailmap\.blob|log\.showsignature)\n/i.test(config.out)
        || /(?:^|\0)diff\.submodule\n(?:log|diff)\0/i.test(config.out)) return;
      const settings = config.out.split("\0").map(line => line.split("\n"));
      const fileSettings = [...new Set(settings.map(([name]) => name!).filter(name =>
        /^(core\.attributesfile|mailmap\.file|diff\.orderfile|blame\.ignorerevsfile)$/i.test(name)))];
      const externalFiles = fileSettings.map(name => {
          const path = run(["git", "config", "--null", "--path", "--get-all", name], top);
          if (path.code !== 0) throw new Error("Cannot resolve Git input path");
          return path.out.split("\0").filter(Boolean).map(file => contents(resolve(top, file)));
        });
      const env = Object.entries(process.env).filter(([name]) => /^(GIT_|LC_)|^(HOME|PATH|LANG|LANGUAGE|TZ|TERM|XDG_CONFIG_HOME)$/.test(name)).sort();
      const context = [top, gitDir, version.out, config.out, env, externalFiles,
        contents(join(key, "info/attributes")), contents(join(key, "info/grafts")), contents(join(key, "shallow")),
        contents(join(top, ".mailmap")), contents(join(top, ".gitmodules")),
        contents(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "git/attributes")),
        // Stage entries fingerprint the index fallback for deleted attribute files.
        attrs.out];
      const refContext = [context, refs.out, contents(join(gitDir, "HEAD")), contents(join(key, "packed-refs")),
        // for-each-ref omits dangling symbolic refs, but mainRef still reads this one.
        contents(join(key, "refs/remotes/origin/HEAD"))];
      const cache = new GitCache(cacheDir);
      // Discover only directories that can affect these historical diffs. Scanning untracked
      // trees would walk ignored dependency/build folders on every refresh.
      const pathsArgs = ["log", "--exclude=refs/stash", "--all", "--format=", "--name-only", "-z", "--no-renames"];
      const paths = cache.read([key, "attribute-paths", hash(refContext), pathsArgs], () => run(["git", ...pathsArgs], top));
      if (paths.code !== 0) return;
      const dirs = new Set<string>(["."]);
      for (const file of paths.out.split("\0").filter(Boolean)) {
        let dir = dirname(file);
        while (!dirs.has(dir)) { dirs.add(dir); dir = dirname(dir); }
      }
      const files = [...dirs].sort().map(dir => [dir, contents(join(top, dir, ".gitattributes"))]);
      const replaceBase = process.env.GIT_REPLACE_REF_BASE || "refs/replace/";
      this.objects = hash([context, files, refs.out.split("\n").filter(line => line.startsWith(replaceBase))]);
      this.refs = hash([refContext, files]);
      this.cache = cache;
    } catch { /* If inputs cannot be fingerprinted, run fresh. */ }
  }

  read(args: string[], immutable = false): GitResult {
    const fresh = () => this.run(["git", ...args], this.top);
    return this.cache ? this.cache.read([this.key, immutable ? this.objects : this.refs, args], fresh) : fresh();
  }
}
