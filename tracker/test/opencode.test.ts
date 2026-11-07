import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTasks } from '../src/link';
import { Repos } from '../src/git';
import { plugins } from '../src/plugins';
import { sourceDiagnostics } from '../src/diagnostics';

const plugin = plugins.find(p => p.name === 'opencode')!;
test('OpenCode fixture: usage, parents, genuine prompts, interrupts and bash output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-oc-'));
  const db = new Database(join(dir, 'opencode.db'));
  try {
    db.exec(`CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, time_created INTEGER, data TEXT);`);
    db.query('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('root', '/repo/low_code', null, 1000, 10000);
    db.query('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('child', '/repo/low_code', 'root', 2000, 9000);
    function message(id: string, sid: string, at: number, data: object, parts: object[] = []) {
      db.query('INSERT INTO message VALUES (?, ?, ?, ?)').run(id, sid, at, JSON.stringify(data));
      parts.forEach((p, i) => db.query('INSERT INTO part VALUES (?, ?, ?, ?)').run(id + i, id, at, JSON.stringify(p)));
    }
    message('u1', 'root', 1000, { role: 'user' }, [{ type: 'text', text: 'build' }]);
    message('a1', 'root', 2000, { role: 'assistant', providerID: 'provider', modelID: 'model',
      time: { created: 2000, completed: 3000 }, cost: 0.25,
      tokens: { input: 11, cache: { read: 12, write: 13 }, output: 14, reasoning: 15 } },
      [{ type: 'tool', tool: 'bash', state: { input: { command: 'git commit -m done' }, output: '[main abc1234] done' } },
       { type: 'tool', tool: 'bash', state: { input: { command: 'echo unrelated' }, output: '[main bad1234] ignore' } }]);
    message('synthetic', 'root', 4000, { role: 'user' }, [{ type: 'text', text: 'injected', synthetic: true }]);
    message('compact', 'root', 5000, { role: 'user' }, [{ type: 'compaction', auto: true }]);
    message('u2', 'root', 7000, { role: 'user' }, [{ type: 'text', text: 'continue', synthetic: false }]);
    message('a2', 'root', 8000, { role: 'assistant', cost: 0.5, error: { name: 'MessageAbortedError' } });
    message('cu', 'child', 2000, { role: 'user' }, [{ type: 'text', text: 'delegated' }]);
    db.close();
    expect(plugin.defaultPaths('/home/test')).toEqual(['/home/test/.local/share/opencode']);
    expect(plugin.detect(dir)).toBe(true);
    expect(plugin.detect(join(dir, 'missing'))).toBe(false);
    expect(plugin.read(join(dir, 'missing'))).toEqual([]);
    const sessions = plugin.read(dir);
    expect(sessions).toHaveLength(2);
    const root = sessions.find(s => s.id === 'root')!;
    const child = sessions.find(s => s.id === 'child')!;
    expect(root.parse).toEqual({ records: 13, unparsed: 0, recognized: 10, replies: 2 });
    expect(child.parse).toEqual({ records: 3, unparsed: 0, recognized: 2, replies: 0 });
    expect(root.vendor).toBe('opencode');
    expect(root.cwd).toBe('/repo/low_code');
    expect(root.tokens).toEqual({ input: 11, cacheRead: 12, cacheWrite: 13, output: 29, reasoning: 15 });
    expect(root.models).toEqual({ 'provider/model': 1 });
    expect(root.costUSD).toBe(0.75);
    expect(root.humanPrompts).toBe(2);
    expect(root.events.filter(e => e.humanPrompts).map(e => e.at)).toEqual([1000, 7000]);
    expect(root.waitMs).toBe(4000);
    expect(root.interrupts).toBe(1);
    expect(root.commitShas).toEqual(['abc1234']);
    expect(child.parent).toBe('root');
    expect(child.role).toBe('subagent');
    expect(child.humanPrompts).toBe(0);
    const tasks = buildTasks(sessions, new Repos(dir));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.sessions).toBe(2);
    expect(tasks[0]!.combo).toBe('opencode → opencode-sub');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('OpenCode counts malformed message/part rows and replies without usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-oc-parse-'));
  const db = new Database(join(dir, 'opencode.db'));
  try {
    db.exec(`CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, time_created INTEGER, data TEXT);
      INSERT INTO session VALUES ('s', '', NULL, 1767225600000, 1767225600000);
      INSERT INTO message VALUES ('reply', 's', 1767225600000, '{"role":"assistant"}');
      INSERT INTO message VALUES ('bad', 's', 1767225600000, '{broken');
      INSERT INTO message VALUES ('unknown', 's', 1767225600000, '{"role":"future"}');
      INSERT INTO part VALUES ('p', 'reply', 1767225600000, '{broken');`);
    db.close();
    const sessions = plugin.read(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.parse).toEqual({ records: 5, unparsed: 2, recognized: 2, replies: 1 });
    const report = sourceDiagnostics([], sessions);
    expect(report.checks.unparsed.overall).toEqual({ k: 2, n: 5 });
    expect(report.checks.zeroTokens.overall).toEqual({ k: 1, n: 1 });
    expect(report.checks.noModel.overall).toEqual({ k: 1, n: 1 });
    expect(report.checks.emptyCwd.overall).toEqual({ k: 1, n: 1 });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('all detectors use file shape without parsing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-detect-'));
  try {
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'record.jsonl'), 'invalid JSON');
    writeFileSync(join(dir, 'opencode.db'), 'invalid sqlite');
    for (const plugin of plugins) expect(plugin.detect(dir)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('OpenCode coerces NULL directories before diagnostics, caching and task collection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-oc-null-directory-'));
  const db = new Database(join(dir, 'opencode.db'));
  try {
    db.exec(`CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, time_created INTEGER, data TEXT);
      INSERT INTO session VALUES ('null-cwd', NULL, NULL, 1767225600000, 1767225600000);`);
    db.close();
    const { collect } = await import('../src/collect');
    const { SessionCache } = await import('../src/cache');
    for (let i = 0; i < 2; i++) {
      const cache = new SessionCache(join(dir, 'cache'));
      const sessions = cache.read(plugin, [dir]);
      expect(sessions[0]!.cwd).toBe('');
      expect(cache.reused).toBe(i);
    }
    const data = await collect({ dirs: { opencode: dir, claude: join(dir, 'missing'), codex: join(dir, 'missing') } }, () => {});
    expect(data.tasks).toHaveLength(1);
    expect(data.meta.sources.opencode!.checks.emptyCwd.overall).toEqual({ k: 1, n: 1 });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('OpenCode empty database counts as one file yielding zero sessions, including cache hits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-oc-empty-file-'));
  const db = new Database(join(dir, 'opencode.db'));
  try {
    db.exec(`CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, time_created INTEGER, data TEXT);`);
    db.close();
    const { SessionCache } = await import('../src/cache');
    for (let i = 0; i < 2; i++) {
      const cache = new SessionCache(join(dir, 'cache'));
      const sessions = cache.read(plugin, [dir]);
      expect(sessions).toHaveLength(0);
      expect(cache.reused).toBe(i);
      expect(sourceDiagnostics([], sessions, cache.files.opencode).checks.unrecognized.overall).toEqual({ k: 1, n: 1 });
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
