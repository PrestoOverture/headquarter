import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SourcePlugin } from "./plugins";
import type { Session } from "./types";

export function defaultCacheDir(home = homedir(), env = process.env): string {
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "crewmeter");
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

type Fingerprint = { size: number; mtimeMs: number; wal?: string | null };
const sameFingerprint = (a: Fingerprint, b: Fingerprint) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.wal === b.wal;

function fingerprint(file: string, plugin: SourcePlugin): Fingerprint {
  const { size, mtimeMs } = statSync(file);
  let wal: string | null | undefined;
  if (plugin.name === "opencode") {
    wal = null;
    try {
      const sidecar = statSync(file + "-wal");
      wal = JSON.stringify([sidecar.size, sidecar.mtimeMs]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { size, mtimeMs, wal };
}

// JSON normally loses explicit undefined fields and turns nonfinite numbers into null.
function encode(_key: string, value: unknown): unknown {
  if (value === undefined) return { $crewmeter: "undefined" };
  if (Object.is(value, -0)) return { $crewmeter: "-0" };
  if (typeof value === "number" && !Number.isFinite(value)) return { $crewmeter: String(value) };
  return value;
}

function decode(value: any): any {
  if (!value || typeof value !== "object") return value;
  if (Object.keys(value).length === 1 && "$crewmeter" in value) {
    switch (value.$crewmeter) {
      case "undefined": return undefined;
      case "-0": return -0;
      case "Infinity": return Infinity;
      case "-Infinity": return -Infinity;
      case "NaN": return NaN;
    }
  }
  // A JSON reviver returning undefined would delete the property instead of restoring it.
  for (const key of Object.keys(value)) value[key] = decode(value[key]);
  return value;
}

/** Only parsed source sessions are cached; traversal and all later computation run afresh. */
export class SessionCache {
  parsed = 0;
  reused = 0;

  constructor(private readonly dir?: string) {}

  read(plugin: SourcePlugin, paths: string[]): Session[] {
    return paths.flatMap(path => plugin.read(path, (file, parse) => {
      if (!this.dir) { this.parsed++; return parse(); }
      const before = fingerprint(file, plugin);
      // Keep the spelling too: Session.file must match an uncached read of this path.
      const source = resolve(file);
      const entryPath = join(this.dir, `${hash(JSON.stringify([plugin.name, source, file]))}.json`);
      try {
        const entry = JSON.parse(readFileSync(entryPath, "utf8"));
        if (entry.format === 1 && entry.plugin === plugin.name && entry.version === plugin.version
          && entry.source === source && entry.file === file && sameFingerprint(entry, before)
          && typeof entry.data === "string" && entry.checksum === hash(entry.data)) {
          const sessions = decode(JSON.parse(entry.data));
          if (Array.isArray(sessions)) { this.reused++; return sessions; }
        }
      } catch { /* Unreadable or corrupt entries are cache misses. */ }

      this.parsed++;
      const sessions = parse();
      let temp: string | undefined;
      try {
        const after = fingerprint(file, plugin);
        // A live session may have grown while being parsed. Never cache that partial read.
        if (!sameFingerprint(before, after)) return sessions;
        const data = JSON.stringify(sessions, encode);
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        temp = join(this.dir, `${randomUUID()}.tmp`);
        writeFileSync(temp, JSON.stringify({ format: 1, plugin: plugin.name, version: plugin.version,
          source, file, ...after, data, checksum: hash(data) }), { mode: 0o600, flag: "wx" });
        renameSync(temp, entryPath);
      } catch { /* Cache failures must not prevent collecting fresh sessions. */ }
      finally { if (temp) { try { unlinkSync(temp); } catch {} } }
      return sessions;
    }));
  }
}

// Bump whenever the git entry format or input fingerprint changes.
const GIT_CACHE_VERSION = "git-v2";
export type GitResult = { code: number; out: string };

/** Raw command output: parsing and all downstream computation still run afresh. */
export class GitCache {
  constructor(private readonly dir: string) {}

  read(inputs: unknown[], fresh: () => GitResult): GitResult {
    const key = hash(JSON.stringify([GIT_CACHE_VERSION, ...inputs]));
    const path = join(this.dir, GIT_CACHE_VERSION, `${key}.json`);
    try {
      const entry = JSON.parse(readFileSync(path, "utf8"));
      if (entry.key === key && typeof entry.data === "string" && entry.checksum === hash(entry.data)) {
        const result = JSON.parse(entry.data);
        if (Number.isInteger(result.code) && typeof result.out === "string") return result;
      }
    } catch { /* Unreadable or corrupt entries are misses. */ }
    const result = fresh();
    // Do not persist failures (missing objects, unavailable files, interrupted commands, etc.).
    if (result.code !== 0) return result;
    let temp: string | undefined;
    try {
      const dir = join(this.dir, GIT_CACHE_VERSION);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      temp = join(dir, `${randomUUID()}.tmp`);
      const data = JSON.stringify(result);
      writeFileSync(temp, JSON.stringify({ key, data, checksum: hash(data) }), { mode: 0o600, flag: "wx" });
      renameSync(temp, path);
    } catch { /* An unwritable cache must not prevent collection. */ }
    finally { if (temp) { try { unlinkSync(temp); } catch {} } }
    return result;
  }
}
