import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { plugins } from '../src/plugins';
import { splitEpisodes } from '../src/episodes';

for (const plugin of plugins) {
  test(`${plugin.name} plugin reads fixtures with all five token fields`, () => {
    const path = join(import.meta.dir, 'fixtures', plugin.name);
    expect(plugin.defaultPaths('/home/test')).toEqual([join('/home/test', `.${plugin.name}`, plugin.name === 'claude' ? 'projects' : 'sessions')]);
    expect(plugin.detect(path)).toBe(true);
    expect(plugin.detect(join(path, 'missing'))).toBe(false);
    expect(plugin.read(join(path, 'missing'))).toEqual([]);
    const sessions = plugin.read(path);
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.vendor).toBe(plugin.name);
      expect(Object.keys(session.tokens).sort()).toEqual(['cacheRead', 'cacheWrite', 'input', 'output', 'reasoning']);
      for (const value of Object.values(session.tokens)) expect(Number.isFinite(value)).toBe(true);
      expect(splitEpisodes(session, [])[0]!.tokens).toEqual(session.tokens);
    }
  });
}

test('Claude usage is uncached input, cache read/write and output, once per message id', () => {
  const plugin = plugins.find(p => p.name === 'claude')!;
  const [session] = plugin.read(join(import.meta.dir, 'fixtures/claude'));
  expect(session!.tokens).toEqual({ input: 15, cacheRead: 20, cacheWrite: 30, output: 10, reasoning: 0 });
});

test('Codex usage separates cached input, preserves reasoning and ignores repeated totals', () => {
  const plugin = plugins.find(p => p.name === 'codex')!;
  const [session] = plugin.read(join(import.meta.dir, 'fixtures/codex'));
  expect(session!.tokens).toEqual({ input: 60, cacheRead: 40, cacheWrite: 0, output: 20, reasoning: 7 });
});
