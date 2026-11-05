import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repos } from '../src/git';
import { addCi, fetchVerdict, type CheckRun, type Fetcher } from '../src/ci';
import type { Task } from '../src/link';
import { aggregate } from '../src/aggregate.js';
import { terminalTable, html } from '../src/report';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, {recursive:true,force:true})));
function fixture(n = 4) {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-ci-')); dirs.push(dir);
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {cwd:dir,env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.test',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.test'}});
    if (p.exitCode) throw Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  git('init','-b','main'); git('remote','add','origin','https://github.com/test/fixture.git');
  const shas = Array.from({length:n}, (_, i) => {git('commit','--allow-empty','-m',String(i)); return git('rev-parse','HEAD');});
  const repos = new Repos(tmpdir()); const repo = repos.of(dir)!;
  const task = (...indices: number[]) => ({repoKey:repo.key,combo:'test',commits:indices.map(i=>repo.commits.get(shas[i]!)!)} as unknown as Task);
  return {dir,shas,repos,task,cache:join(dir,'ci.json')};
}
test('checked commits use nearest checked first-parent baseline and task precedence', async () => {
  const f = fixture(6);
  const values = ['none','fail','pass','none','fail','fail'] as const;
  const fetcher: Fetcher = (_,sha) => values[f.shas.indexOf(sha)]!;
  const tasks = [f.task(1),f.task(2),f.task(4),f.task(5),f.task(2,4,5),f.task(2,5),f.task(0,5)];
  await addCi(tasks,f.repos,f.cache,()=>{},fetcher);
  expect(tasks.map(t=>t.ci)).toEqual(['unknown','pass','broke','inherited','broke','pass','inherited']);
});
test('unknown cache expires after seven days; legacy definite entries never expire', async () => {
  const f = fixture(); const key = (i:number) => `test/fixture@${f.shas[i]}`;
  writeFileSync(f.cache,JSON.stringify({[key(0)]:{verdict:'unknown',at:Date.now()-8*86400000},[key(1)]:{verdict:'unknown',at:Date.now()-86400000},[key(2)]:'pass',[key(3)]:'none'}));
  const calls: string[] = [];
  const tasks = [0,1,2,3].map(i=>f.task(i));
  await addCi(tasks,f.repos,f.cache,()=>{},(_,sha)=>{calls.push(sha);return null;});
  expect(calls).toEqual([f.shas[0]!]);
  expect(tasks.map(t=>t.ci)).toEqual(['unknown','unknown','pass','unknown']);
  expect(JSON.parse(readFileSync(f.cache,'utf8'))[key(0)].at).toBeGreaterThan(Date.now()-10000);
});
test('fetches are deduplicated and bounded to eight concurrent calls; errors are cached', async () => {
  const f=fixture(16); let active=0, peak=0, calls=0;
  const tasks=Array.from({length:32},(_,i)=>f.task(i%16));
  const fetcher: Fetcher=async()=>{calls++;active++;peak=Math.max(peak,active);await Bun.sleep(5);active--;throw Error('offline');};
  await addCi(tasks,f.repos,f.cache,()=>{},fetcher);
  expect(peak).toBe(8);expect(calls).toBe(16);
  await addCi(tasks,f.repos,f.cache,()=>{},fetcher);expect(calls).toBe(16);
});
test('baseline search stops at twenty ancestors', async()=>{
  const f=fixture(22);const t=f.task(21);
  await addCi([t],f.repos,f.cache,()=>{},(_,sha)=>sha===f.shas[21]?'fail':sha===f.shas[0]?'pass':'none');
  expect(t.ci).toBe('unknown');
});
test('aggregate and both reports count only pass and broke in the rate',()=>{
  const tasks=['pass','broke','inherited','unknown'].map(ci=>({ci,combo:'test',commits:[],costUSD:0,codexTokens:0,humanPrompts:0,interrupts:0,waitMs:0} as unknown as Task));
  expect(aggregate(tasks,t=>t.combo)[0]).toMatchObject({ci:2,ciPass:1,ciBroke:1,ciInherited:1,ciBreakRate:0.5});
  for(const output of [terminalTable(tasks),html(tasks,{generatedAt:0,sessions:{claude:0,codex:0},repos:0,ci:true})]){
    expect(output).toContain('CI 新失败 (n)');expect(output).toContain('原本就红');expect(output).not.toContain('CI首过');
  }
});


test('rerun verdicts use highest-id non-cancelled attempt per name with a stub fetcher', async () => {
  const run = (id: number, conclusion: string | null, name = 'build', status = 'completed'): CheckRun => ({id, name, status, conclusion, completed_at: status === 'completed' ? '2026-11-05T00:00:00Z' : null});
  const verdict = (runs: CheckRun[]) => fetchVerdict('test/fixture', 'sha', Date.parse('2026-11-05T00:00:00Z'), async () => runs);
  expect(await verdict([run(1,'failure'),run(2,'success')])).toEqual({build:'pass'});
  expect(await verdict([run(1,'success'),run(2,'cancelled')])).toEqual({build:'pass'});
  expect(await verdict([run(2,'failure'),run(1,'success')])).toEqual({build:'fail'});
  expect(await verdict([run(1,'cancelled')])).toBe('none');
  expect(await verdict([run(1,'success'),run(2,null,'build','in_progress')])).toBeNull();
  expect(await verdict([run(1,'success'),run(2,'failure','lint')])).toEqual({build:'pass',lint:'fail'});
  expect(await verdict([run(1,'skipped'),run(2,'neutral','lint')])).toEqual({build:'pass',lint:'pass'});
  expect(await fetchVerdict('test/fixture','sha',0,async()=>null)).toBeNull();
});


test('completed checks outside the 72-hour window are ignored', async () => {
  const at = Date.parse('2026-07-31T00:00:00Z');
  const run = (id: number, hours: number, conclusion: string): CheckRun => ({id,name:'build',status:'completed',conclusion,completed_at:new Date(at+hours*3600000).toISOString()});
  const verdict = (runs: CheckRun[]) => fetchVerdict('test/fixture','sha',at,async()=>runs);
  expect(await verdict([run(1,1,'success'),run(2,30*24,'failure')])).toEqual({build:'pass'});
  expect(await verdict([run(1,30*24,'failure')])).toBe('none');
  expect(await verdict([run(1,-1,'failure')])).toBe('none');
  expect(await verdict([run(1,72,'success')])).toEqual({build:'pass'});
});
test('attribution compares failing names to the nearest checked baseline and caches names', async () => {
  const f=fixture(4);
  const values = [{build:'pass'}, {build:'pass',release:'fail'}, {build:'fail',release:'fail'}, {build:'fail',release:'fail'}] as const;
  const fetcher: Fetcher=(_,sha,at)=>{expect(at).toBeGreaterThan(0);return values[f.shas.indexOf(sha)]!;};
  const tasks=[f.task(1),f.task(2),f.task(3)];
  await addCi(tasks,f.repos,f.cache,()=>{},fetcher);
  expect(tasks.map(t=>t.ci)).toEqual(['pass','broke','inherited']);
  expect(JSON.parse(readFileSync(f.cache,'utf8'))[`test/fixture@${f.shas[1]}`]).toEqual({checks:{build:'pass',release:'fail'}});
  await addCi(tasks,f.repos,f.cache,()=>{},()=>{throw Error('cache must be reused');});
  expect(tasks.map(t=>t.ci)).toEqual(['pass','broke','inherited']);
});
