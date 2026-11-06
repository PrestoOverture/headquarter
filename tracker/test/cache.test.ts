import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultCacheDir, SessionCache } from "../src/cache";
import { plugins, type SourcePlugin } from "../src/plugins";

function tempTest(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "crewmeter-cache-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function fixture(dir: string, plugin: SourcePlugin): { root: string; files: string[] } {
  const root = join(dir, plugin.name);
  if (plugin.name === "opencode") {
    const original = join(dir, "fixture.db");
    const db = new Database(original);
    db.exec(`CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, time_created INTEGER, data TEXT);
      INSERT INTO session VALUES ('root', '/fixture', NULL, 1000, 2000), ('child', '/fixture', 'root', 1500, 2000);`);
    db.close();
    mkdirSync(root);
    const file = join(root, "opencode.db");
    copyFileSync(original, file);
    return { root, files: [file] };
  }
  cpSync(join(import.meta.dir, "fixtures", plugin.name), root, { recursive: true });
  const first = plugin.name === "claude" ? join(root, "project/session.jsonl") : join(root, "2026/01/01/rollout.jsonl");
  const second = join(dirname(first), "second.jsonl");
  copyFileSync(first, second);
  return { root, files: [first, second] };
}

function read(plugin: SourcePlugin, root: string, dir?: string) {
  const cache = new SessionCache(dir);
  const sessions = cache.read(plugin, [root]);
  return { sessions, parsed: cache.parsed, reused: cache.reused };
}

for (const plugin of plugins) {
  test(`${plugin.name}: reuse, mtime, parser version and deletion on fixture copies`, () => tempTest(dir => {
    const { root, files } = fixture(dir, plugin);
    const cacheDir = join(dir, "cache");
    const first = read(plugin, root, cacheDir);
    expect(first.parsed).toBe(files.length);
    expect(first.reused).toBe(0);
    expect(first.sessions).toStrictEqual(plugin.read(root));
    const second = read(plugin, root, cacheDir);
    expect(second).toStrictEqual({ sessions: first.sessions, parsed: 0, reused: files.length });

    const stat = statSync(files[0]!);
    utimesSync(files[0]!, stat.atime, new Date(stat.mtimeMs + 2000));
    expect(read(plugin, root, cacheDir)).toStrictEqual({ sessions: first.sessions, parsed: 1, reused: files.length - 1 });

    const bumped = { ...plugin, version: plugin.version + ".next" };
    expect(read(bumped, root, cacheDir)).toStrictEqual({ sessions: first.sessions, parsed: files.length, reused: 0 });
    expect(read(bumped, root, cacheDir).parsed).toBe(0);

    unlinkSync(files[0]!);
    const deleted = read(bumped, root, cacheDir);
    expect(deleted.parsed).toBe(0);
    expect(deleted.reused).toBe(files.length - 1);
    expect(deleted.sessions).toStrictEqual(plugin.read(root));
    expect(deleted.sessions.every(s => s.file !== files[0])).toBe(true);
  }));
}

test("path and size changes invalidate only the changed file; empty parses are reused", () => tempTest(dir => {
  const plugin = plugins.find(p => p.name === "codex")!;
  const { root, files } = fixture(dir, plugin);
  const cacheDir = join(dir, "cache");
  read(plugin, root, cacheDir);
  const stat = statSync(files[0]!);
  writeFileSync(files[0]!, readFileSync(files[0]!, "utf8") + "\n");
  utimesSync(files[0]!, stat.atime, stat.mtime);
  expect(read(plugin, root, cacheDir).parsed).toBe(1);
  renameSync(files[0]!, join(dirname(files[0]!), "renamed.jsonl"));
  expect(read(plugin, root, cacheDir).parsed).toBe(1);
  writeFileSync(files[1]!, "invalid JSON");
  expect(read(plugin, root, cacheDir).parsed).toBe(1);
  expect(read(plugin, root, cacheDir)).toStrictEqual({ sessions: plugin.read(root), parsed: 0, reused: 2 });
}));

test("JSON preserves nonfinite timestamps, undefined fields, unique arrays and ordering", () => tempTest(dir => {
  for (const plugin of plugins.filter(p => p.name !== "opencode")) {
    const { root, files } = fixture(dir, plugin);
    const record = plugin.name === "codex"
      ? { type: "session_meta", payload: { id: "empty", cwd: "/fixture" } }
      : { type: "assistant", sessionId: "empty", message: { content: [], usage: { input_tokens: -0 } } };
    writeFileSync(files[0]!, JSON.stringify(record).replace('"input_tokens":0', '"input_tokens":-0'));
    const cacheDir = join(dir, "cache");
    const first = read(plugin, root, cacheDir);
    const empty = first.sessions.find(s => s.id === "empty")!;
    expect(empty.start).toBe(Infinity);
    expect(empty.end).toBe(-Infinity);
    expect(read(plugin, root, cacheDir)).toStrictEqual({ sessions: first.sessions, parsed: 0, reused: files.length });
    if (plugin.name === "codex") expect(Object.hasOwn(empty, "agentRole")).toBe(true);
    // Linking mutates sessions; that must not leak back into the parsed-session cache.
    first.sessions[0]!.parent = "linked-parent";
    expect(read(plugin, root, cacheDir).sessions).toStrictEqual(plugin.read(root));
  }
}));

test("Claude traversal and subagent parents match fresh reads even when only the parent changes", () => tempTest(dir => {
  const plugin = plugins.find(p => p.name === "claude")!;
  const { root, files } = fixture(dir, plugin);
  const subdir = join(dirname(files[0]!), "session/subagents");
  mkdirSync(subdir, { recursive: true });
  writeFileSync(join(subdir, "agent-one.jsonl"), JSON.stringify({ type: "assistant", agentId: "one", message: { content: [] } }));
  const cacheDir = join(dir, "cache");
  const first = read(plugin, root, cacheDir);
  expect(first.parsed).toBe(3);
  expect(read(plugin, root, cacheDir)).toStrictEqual({ sessions: plugin.read(root), parsed: 0, reused: 3 });
  writeFileSync(files[0]!, readFileSync(files[0]!, "utf8").replaceAll("claude-fixture", "new-parent"));
  expect(read(plugin, root, cacheDir)).toStrictEqual({ sessions: plugin.read(root), parsed: 1, reused: 2 });
  expect(read(plugin, root, cacheDir).sessions.find(s => s.role === "subagent")!.id).toBe("new-parent/agent-one");
  writeFileSync(files[0]!, "invalid JSON");
  expect(read(plugin, root, cacheDir)).toStrictEqual({ sessions: plugin.read(root), parsed: 1, reused: 1 });
}));

test("compressed Codex files are cached without decompression on reuse", () => tempTest(dir => {
  const plugin = plugins.find(p => p.name === "codex")!;
  const { root, files } = fixture(dir, plugin);
  const compressed = spawnSync("zstd", ["-q", "-c", files[0]!]);
  expect(compressed.status).toBe(0);
  writeFileSync(files[0]! + ".zst", compressed.stdout);
  unlinkSync(files[0]!);
  const cacheDir = join(dir, "cache");
  const first = read(plugin, root, cacheDir);
  expect(read(plugin, root, cacheDir)).toStrictEqual({ sessions: first.sessions, parsed: 0, reused: 2 });
}));

test("corrupt and unreadable entries fall back to parsing; writes leave only atomic JSON entries", () => tempTest(dir => {
  const plugin = plugins.find(p => p.name === "codex")!;
  const { root } = fixture(dir, plugin);
  const cacheDir = join(dir, "cache");
  const first = read(plugin, root, cacheDir);
  const entries = readdirSync(cacheDir);
  expect(entries.every(name => name.endsWith(".json"))).toBe(true);
  const entry = join(cacheDir, entries[0]!);
  for (const bad of ["{", "{}", JSON.stringify({ ...JSON.parse(readFileSync(entry, "utf8")), data: "[{}]" })]) {
    writeFileSync(entry, bad);
    expect(read(plugin, root, cacheDir)).toStrictEqual({ sessions: first.sessions, parsed: 1, reused: 1 });
  }
  unlinkSync(entry);
  mkdirSync(entry);
  expect(read(plugin, root, cacheDir)).toStrictEqual({ sessions: first.sessions, parsed: 1, reused: 1 });
  expect(readdirSync(cacheDir).some(name => name.endsWith(".tmp"))).toBe(false);
  const blocked = join(dir, "blocked");
  writeFileSync(blocked, "not a directory");
  expect(read(plugin, root, blocked)).toStrictEqual({ sessions: first.sessions, parsed: 2, reused: 0 });
}));

test("cache defaults and bypass do not read or create cache files", () => tempTest(dir => {
  expect(defaultCacheDir("/home/test", {})).toBe("/home/test/.cache/crewmeter");
  expect(defaultCacheDir("/home/test", { XDG_CACHE_HOME: "/custom" })).toBe("/custom/crewmeter");
  const plugin = plugins.find(p => p.name === "codex")!;
  const { root } = fixture(dir, plugin);
  const cacheDir = join(dir, "cache");
  expect(read(plugin, root)).toStrictEqual({ sessions: plugin.read(root), parsed: 2, reused: 0 });
  expect(existsSync(cacheDir)).toBe(false);
  const first = read(plugin, root, cacheDir);
  const before = readdirSync(cacheDir).map(name => [name, readFileSync(join(cacheDir, name), "utf8")]);
  expect(read(plugin, root).sessions).toStrictEqual(first.sessions);
  expect(readdirSync(cacheDir).map(name => [name, readFileSync(join(cacheDir, name), "utf8")])).toStrictEqual(before);
}));

test("OpenCode cache invalidates on WAL-only mtime and size changes", () => tempTest(dir => {
  const plugin = plugins.find(p => p.name === "opencode")!;
  const { root, files } = fixture(dir, plugin);
  const file = files[0]!, wal = file + "-wal", cacheDir = join(dir, "cache");
  read(plugin, root, cacheDir);
  const db = new Database(file);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    // Populate only the WAL, then warm the cache with the WAL present.
    db.exec("INSERT INTO session VALUES ('wal-one', '/fixture', NULL, 3000, 4000)");
    const main = statSync(file);
    expect(read(plugin, root, cacheDir).sessions).toHaveLength(3);
    expect(read(plugin, root, cacheDir).parsed).toBe(0);
    const before = statSync(wal);
    utimesSync(wal, before.atime, new Date(before.mtimeMs + 2000));
    expect(statSync(wal).size).toBe(before.size);
    expect(statSync(file).mtimeMs).toBe(main.mtimeMs);
    expect(read(plugin, root, cacheDir).parsed).toBe(1);
    expect(read(plugin, root, cacheDir).reused).toBe(1);
    db.exec("INSERT INTO session VALUES ('wal-two', '/fixture', NULL, 5000, 6000)");
    const afterWrite = statSync(wal);
    utimesSync(wal, before.atime, new Date(before.mtimeMs + 2000));
    expect(afterWrite.size).toBeGreaterThan(before.size);
    expect(statSync(file).size).toBe(main.size);
    expect(statSync(file).mtimeMs).toBe(main.mtimeMs);
    const changed = read(plugin, root, cacheDir);
    expect(changed.parsed).toBe(1);
    expect(changed.sessions).toHaveLength(4);
  } finally { db.close(); }
}));

test("OpenCode WAL appearance and disappearance invalidate an otherwise unchanged source", () => tempTest(dir => {
  const file = join(dir, "opencode.db"), cacheDir = join(dir, "cache");
  writeFileSync(file, "fixture");
  const plugin: SourcePlugin = { ...plugins.find(p => p.name === "opencode")!,
    read: (_path, readFile) => readFile!(file, () => []) };
  expect(read(plugin, file, cacheDir).parsed).toBe(1);
  expect(read(plugin, file, cacheDir).reused).toBe(1);
  writeFileSync(file + "-wal", "");
  expect(read(plugin, file, cacheDir).parsed).toBe(1);
  expect(read(plugin, file, cacheDir).reused).toBe(1);
  unlinkSync(file + "-wal");
  expect(read(plugin, file, cacheDir).parsed).toBe(1);
}));
