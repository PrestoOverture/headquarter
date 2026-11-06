import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaude } from '../src/claude';
import { parseCodex } from '../src/codex';
import { buildTasks, isFixSubject } from '../src/link';
import { splitEpisodes } from '../src/episodes';
import { Repos, originsOf } from '../src/git';
import { emptySession, type Session } from '../src/types';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, {recursive:true,force:true}); });
const base = Date.parse('2026-01-01T00:00:00Z');
const at = (n: number) => new Date(base+n*1000).toISOString();
const jsonl = (rows: any[]) => rows.map(r => JSON.stringify(r)).join('\n');
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-test-')); dirs.push(dir);
  const git = (args: string[], n=0) => {
    const p = Bun.spawnSync(['git', ...args], {cwd:dir, env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null', GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.test',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.test',GIT_AUTHOR_DATE:at(n),GIT_COMMITTER_DATE:at(n)}});
    if (p.exitCode) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  git(['init','-b','main']);
  const commit = (text:string, title:string, n:number) => { writeFileSync(join(dir,'file.txt'),text); git(['add','file.txt']); git(['commit','-m',title],n); return git(['rev-parse','HEAD']); };
  return {dir,git,commit};
}
function session(dir:string, prompts:number[], end:number, shas:string[]=[]):Session {
  const s = emptySession('claude','root','fixture');
  Object.assign(s,{cwd:dir,start:base,end:base+end*1000,times:[0,...prompts,end].map(n=>base+n*1000),humanPrompts:prompts.length,commitShas:shas,events:prompts.map(n=>({at:base+n*1000,humanPrompts:1}))});
  return s;
}

test('prompts split only after a commit; exact commit belongs to first episode', () => {
  const r=repo(); const sha=r.commit('a\n','work',10);
  const s=session(r.dir,[0,20],30,[sha.slice(0,7)]);
  const tasks=buildTasks([s],new Repos(tmpdir()));
  expect(tasks).toHaveLength(2); expect(tasks[0]!.commits.map(c=>c.sha)).toEqual([sha]);
  expect(tasks[0]!.commits[0]!.how).toBe('exact'); expect(tasks.map(t=>t.humanPrompts)).toEqual([1,1]);
});
test('prompts without an intervening commit merge; time linking works', () => {
  const r=repo(); const sha=r.commit('a\n','work',20);
  const tasks=buildTasks([session(r.dir,[0,10],30)],new Repos(tmpdir()));
  expect(tasks).toHaveLength(1); expect(tasks[0]!.humanPrompts).toBe(2);
  expect(tasks[0]!.commits.map(c=>[c.sha,c.how])).toEqual([[sha,'time']]);
});
test('exact candidates must exist and fall within session slack; exact wins over closer time', () => {
  const r=repo(); const old=r.commit('old\n','old',-2000); const sha=r.commit('new\n','work',10);
  const a=session(r.dir,[0],30,[old,sha,'deadbeef']);
  const b=session(r.dir,[10],10); b.id='other'; b.times=[base+10000];
  const tasks=buildTasks([b,a],new Repos(tmpdir()));
  expect(tasks.flatMap(t=>t.commits).map(c=>c.sha)).toEqual([sha]);
  expect(tasks.find(t=>t.id.startsWith('root/'))!.commits[0]!.how).toBe('exact');
});
test('blame marks rewritten/deleted lines, not unrelated lines in the same file', () => {
  const r=repo(); r.commit('base\nother\n','base',0);
  const a=r.commit('work\nother\n','feature A',10);
  const unrelated=r.commit('work\nfixed other\n','fix other',20);
  const fix=r.commit('fixed work\nfixed other\n','fix A',30);
  const repos=new Repos(tmpdir()); const loaded=repos.of(r.dir)!;
  expect(originsOf(loaded,unrelated).has(a)).toBe(false); expect(originsOf(loaded,fix).has(a)).toBe(true);
  const task=buildTasks([session(r.dir,[10,25,40],45,[a,unrelated,fix])],repos,base+20*86400000)[0]!;
  expect(task.reworked).toBe(true); expect(task.commits.find(c=>c.sha===a)!.reworkedBy).toEqual([fix]);
});

test('Codex old and attributed formats count human prompts once and ignore harness messages', () => {
  const meta={timestamp:at(0),type:'session_meta',payload:{id:'codex',cwd:'/fixture',source:'vscode'}};
  const msg=(n:number,text:string,role='user')=>({timestamp:at(n),type:'response_item',payload:{type:'message',role,content:[{type:'input_text',text}]}});
  const old=parseCodex(jsonl([meta,msg(1,'<environment_context/>'),msg(2,'# AGENTS.md instructions'),msg(3,'do work'),msg(4,'done','assistant'),msg(5,'next work')]),'fixture')!;
  expect(old.humanPrompts).toBe(2); expect(old.waitMs).toBe(1000);
  const started=(n:number,trigger:string)=>({timestamp:at(n),type:'event_msg',payload:{type:'task_started',turn_attribution:{turn_trigger:trigger}}});
  const modern=parseCodex(jsonl([meta,started(1,'composer'),msg(1,'do work'),started(2,'agent'),msg(2,'injected'),started(3,'edit_user_message'),msg(3,'edit')]),'fixture')!;
  expect(modern.humanPrompts).toBe(2); expect(modern.events.filter(e=>e.humanPrompts)).toHaveLength(2);
});
test('Claude parser records usage, human prompts, interrupts and commit output', () => {
  const row=(n:number,type:string,content:any,extra:any={})=>({timestamp:at(n),type,sessionId:'claude',cwd:'/fixture',entrypoint:'cli',message:{content,...extra}});
  const s=parseClaude(jsonl([row(0,'user','work'),row(1,'assistant',[{type:'tool_use',id:'call',name:'Bash',input:{command:'git commit -m work'}}],{usage:{input_tokens:10,output_tokens:5}}),row(2,'user',[{type:'tool_result',tool_use_id:'call',content:'[main abc1234] work'}]),row(3,'user','[Request interrupted by user]'),row(4,'user','continue'),{type:'cost-state',totalCostUSD:3}]),'fixture.jsonl')!;
  expect(s.humanPrompts).toBe(2); expect(s.interrupts).toBe(1); expect(s.commitShas).toEqual(['abc1234']); expect(s.events.reduce((n,e)=>n+(e.usage??0),0)).toBe(15); expect(s.costUSD).toBe(3);
});

test('children join their parent episode, including MCP delegation and nested reviews', () => {
  const r=repo(); const first=r.commit('a\n','first',10); const second=r.commit('b\n','second',40);
  const root=session(r.dir,[0,20],50,[first,second]); root.codexThreads=['mcp'];
  const child=session(r.dir,[],15); child.id='mcp'; child.vendor='codex'; child.role='delegated'; child.headless=true; child.start=base+5000;
  const sub=session(r.dir,[],45); sub.id='sub'; sub.parent='root'; sub.role='subagent'; sub.start=base+30000;
  const review=session(r.dir,[],60); review.id='review'; review.parent='sub'; review.vendor='codex'; review.role='review'; review.start=base+35000;
  const tasks=buildTasks([root,child,sub,review],new Repos(tmpdir()));
  expect(tasks).toHaveLength(2); expect(tasks.map(t=>t.sessions)).toEqual([2,3]);
  expect(tasks[0]!.kinds).toEqual(['codex']); expect(tasks[1]!.kinds).toEqual(['claude-sub','codex-review']);
});

test('Claude cost, prompts, interrupts and wait are apportioned to episode records', () => {
  const r=repo(); const sha=r.commit('a\n','first',10);
  const row=(n:number,type:string,content:any,usage?:any)=>({timestamp:at(n),type,sessionId:'root',entrypoint:'cli',cwd:r.dir,message:{content,usage}});
  const s=parseClaude(jsonl([row(0,'user','first'),row(5,'assistant','done',{input_tokens:10,output_tokens:10}),row(20,'user','second'),row(21,'user','[Request interrupted by user]'),row(30,'assistant','done',{input_tokens:60,output_tokens:0}),{type:'cost-state',totalCostUSD:8}]),'fixture')!;
  s.commitShas=[sha];
  const tasks=buildTasks([s],new Repos(tmpdir()));
  expect(tasks.map(t=>t.costUSD)).toEqual([2,6]); expect(tasks.map(t=>t.humanPrompts)).toEqual([1,1]);
  expect(tasks.map(t=>t.interrupts)).toEqual([0,1]); expect(tasks.map(t=>t.waitMs)).toEqual([0,15000]);
  expect(tasks.map(t=>[t.start,t.end])).toEqual([[base,base+5000],[base+20000,base+30000]]);
});

test('Codex cumulative tokens use deltas across episodes, duplicate totals do not double count', () => {
  const r=repo(); const sha=r.commit('a\n','first',10);
  const event=(n:number,payload:any)=>({timestamp:at(n),type:'event_msg',payload});
  const prompt=(n:number)=>event(n,{type:'task_started',turn_attribution:{turn_trigger:'composer'}});
  const tokens=(n:number,input:number,cached:number,output:number)=>event(n,{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:output}}});
  const s=parseCodex(jsonl([{timestamp:at(0),type:'session_meta',payload:{id:'root',cwd:r.dir}},prompt(1),tokens(5,100,20,10),tokens(6,100,20,10),prompt(20),tokens(30,160,30,20)]),'fixture')!;
  s.commitShas=[sha];
  const tasks=buildTasks([s],new Repos(tmpdir()));
  expect(tasks.map(t=>t.tokens)).toEqual([
    {input:80,cacheRead:20,cacheWrite:0,output:10,reasoning:0},
    {input:50,cacheRead:10,cacheWrite:0,output:10,reasoning:0},
  ]);
  for (const key of Object.keys(s.tokens) as (keyof Session['tokens'])[]) {
    expect(tasks.reduce((n,t)=>n+t.tokens[key],0)).toBe(s.tokens[key]);
  }
});

test('headless session without human prompts remains one episode', () => {
  const r=repo(); const sha=r.commit('a\n','work',10);
  const s=session(r.dir,[],30,[sha]); s.headless=true;
  const tasks=buildTasks([s],new Repos(tmpdir()));
  expect(tasks).toHaveLength(1); expect(tasks[0]!.headless).toBe(true); expect(tasks[0]!.commits).toHaveLength(1);
});

test('fixes and reverts in the same episode are self-correction, not rework', () => {
  const r=repo(); const a=r.commit('work\n','feature A',10);
  const fix=r.commit('fixed\n','fix A',20);
  const task=buildTasks([session(r.dir,[0],30,[a,fix])],new Repos(tmpdir()))[0]!;
  expect(task.commits.find(c=>c.sha===a)!.reworkedBy).toEqual([]); expect(task.reworked).toBe(false);
  r.git(['revert','--no-edit',fix],40);
  const reverted=r.git(['rev-parse','HEAD']);
  const next=buildTasks([session(r.dir,[0],50,[a,fix,reverted])],new Repos(tmpdir()))[0]!;
  expect(next.commits.find(c=>c.sha===fix)!.revertedBy).toBeUndefined(); expect(next.reverted).toBe(false);
  expect(next.reworked).toBe(false);
});

test('Claude episode ends at the last record, including non-message progress records', () => {
  const s=parseClaude(jsonl([
    {timestamp:at(0),type:'user',entrypoint:'cli',message:{content:'work'}},
    {timestamp:at(5),type:'assistant',message:{content:'done'}},
    {timestamp:at(8),type:'progress'},
    {timestamp:at(20),type:'user',message:{content:'next'}},
    {timestamp:at(25),type:'progress'},
  ]),'fixture')!;
  const slices=splitEpisodes(s,[{at:base+6000}]);
  expect(slices.map(s=>s.end)).toEqual([base+8000,base+25000]);
});

test('a child continuing an earlier episode does not split a later commit-free episode', () => {
  const r=repo(); const first=r.commit('a\n','first',10); const late=r.commit('b\n','child finishes',30);
  const root=session(r.dir,[0,20,40],50,[first]);
  const child=session(r.dir,[],45,[late]); child.id='child'; child.parent='root'; child.start=base+5000;
  const tasks=buildTasks([root,child],new Repos(tmpdir()));
  expect(tasks).toHaveLength(2); expect(tasks.map(t=>t.humanPrompts)).toEqual([1,2]);
  expect(tasks[0]!.commits.map(c=>c.sha)).toEqual([first,late]); expect(tasks[1]!.commits).toHaveLength(0);
});


test('a fix in the next episode of the same session, or unlinked, counts as rework', () => {
  const r=repo(); const a=r.commit('work\n','feature A',10);
  const fix=r.commit('fixed\n','fix A',2000);
  const tasks=buildTasks([session(r.dir,[0,1800],2100,[a,fix])],new Repos(tmpdir()));
  expect(tasks).toHaveLength(2);
  expect(tasks[0]!.commits.map(c=>c.sha)).toEqual([a]);
  expect(tasks[1]!.commits.map(c=>c.sha)).toEqual([fix]);
  expect(tasks[0]!.commits[0]!.reworkedBy).toEqual([fix]); expect(tasks[0]!.reworked).toBe(true);
  const unlinked=buildTasks([session(r.dir,[0],30,[a])],new Repos(tmpdir()));
  expect(unlinked.flatMap(t=>t.commits).map(c=>c.sha)).toEqual([a]);
  expect(unlinked[0]!.commits[0]!.reworkedBy).toEqual([fix]); expect(unlinked[0]!.reworked).toBe(true);
});

test('linked commits before the first prompt and after the last record are kept exactly once', () => {
  const r=repo(); const before=r.commit('before\n','before prompt',10);
  const work=r.commit('work\n','work',2100);
  const after=r.commit('after\n','after record',2300);
  const s=session(r.dir,[2000,2200],2250,[before,work]);
  const tasks=buildTasks([s],new Repos(tmpdir()));
  expect(tasks).toHaveLength(2);
  expect(tasks[0]!.commits.map(c=>c.sha)).toEqual([before,work]);
  expect(tasks[1]!.commits.map(c=>[c.sha,c.how])).toEqual([[after,'time']]);
  const shas=tasks.flatMap(t=>t.commits.map(c=>c.sha));
  expect(shas).toHaveLength(3); expect(new Set(shas).size).toBe(3);
});

test('a time-linked commit in a record gap stays in the episode before the next prompt', () => {
  const r=repo(); const first=r.commit('first\n','first',10);
  const gap=r.commit('gap\n','work in gap',1500);
  const tasks=buildTasks([session(r.dir,[0,2000],2100,[first])],new Repos(tmpdir()));
  expect(tasks).toHaveLength(2);
  expect(tasks[0]!.commits.map(c=>[c.sha,c.how])).toEqual([[first,'exact'],[gap,'time']]);
  expect(tasks[1]!.commits).toHaveLength(0);
});

test('rework ignores re-indented moves across files, but records changed old text', () => {
  const r=repo(); const a=r.commit('const original = "<old>";\n','feature A',10);
  writeFileSync(join(r.dir,'file.txt'),'');
  writeFileSync(join(r.dir,'new.txt'),'if (ready) {\n  const original = "<old>";\n}\n');
  r.git(['add','.']); r.git(['commit','-m','fix move'],2000);
  const move=r.git(['rev-parse','HEAD']);
  const repos=new Repos(tmpdir());
  const first=buildTasks([session(r.dir,[0],30,[a])],repos)[0]!.commits[0]!;
  expect(first.reworkedBy).toEqual([]);
  expect(originsOf(repos.of(r.dir)!,move).has(a)).toBe(false);

  const changed=repo(); const original=changed.commit('const original = "<old>";\n','feature A',10);
  const fix=changed.commit('const original = "new";\n','fix text',2000);
  const c=buildTasks([session(changed.dir,[0],30,[original])],new Repos(tmpdir()))[0]!.commits[0]!;
  expect(c.reworkedBy).toEqual([fix]);
  expect(c.reworkEvidence).toEqual([{sha:fix,subject:'fix text',days:1990/86400,lines:[{file:'file.txt',text:'const original = "<old>";'}]}]);
});

test('deleting only a lone closing brace does not count as rework', () => {
  const r=repo(); r.commit('const retained = true;\n','base',-2000);
  const a=r.commit('const retained = true;\n}\n','feature A',10);
  r.commit('const retained = true;\n','fix brace',2000);
  const c=buildTasks([session(r.dir,[0],30,[a])],new Repos(tmpdir()))[0]!.commits[0]!;
  expect(c.reworkedBy).toEqual([]); expect(c.reworkEvidence).toEqual([]);
});

test('report renders filtered rework details with escaped evidence', async () => {
  const {html}=await import('../src/report');
  const {runInNewContext}=await import('node:vm');
  const r=repo(); const a=r.commit('const old = "<tag>";\n','feature A',10);
  r.commit('const old = "new";\n','fix text',2000);
  const tasks=buildTasks([session(r.dir,[0],30,[a])],new Repos(tmpdir()));
  const page=html(tasks,{generatedAt:base,sessions:{claude:1,codex:0},repos:1,ci:false});
  expect(page).toContain('<h2>返工明细</h2>');
  const elements:Record<string,any>={};
  // These commit-only fixtures have no recorded assistant; opt into empty tasks.
  const get=(id:string)=>elements[id]??=( {value:'',checked:id==='commits'||id==='empty',innerHTML:'',addEventListener:()=>{}} );
  runInNewContext(page.match(/<script>([\s\S]*)<\/script>/)![1]!,{document:{getElementById:get}});
  expect(get('rework').innerHTML).toContain('file.txt: const old = &quot;&lt;tag&gt;&quot;;');
  expect(get('rework').innerHTML).toContain('fix text');
  get('repo').value='another repo';
  // Re-run render with the same filter state.
  const script=page.match(/<script>([\s\S]*)<\/script>/)![1]!;
  runInNewContext(script,{document:{getElementById:get}});
  expect(get('rework').innerHTML).not.toContain('fix text');
});


test('fix subjects distinguish leading fixes, bugs anywhere, and style work', () => {
  const cases: [string, boolean][] = [
    ['fix(ui): x', true], ['Fix repo-wide x', true], ['Cleanup: fix turn count', true],
    ['4.7: validation and fix loop', false], ['Phase 2: bug in parser', true],
    ['chore: run biome format', false], ['feat: add prefix', false],
    ['fixes: x', true], ['fixed x', true], ['work: nested: fix x', false],
    [`${'x'.repeat(60)}: fix x`, true], [`${'x'.repeat(61)}: fix x`, false],
    ['work fixes x', false], ['fix lint issue', false], ['bug in formatting', false],
    ['fix biome issue', false], ['fix eslint issue', false], ['fix prettier issue', false],
    ['fix format issue', false], ['work regression', true], ['work hotfix', true],
    ['work bugs', true], ['work revert', true], ['work 修复', true], ['work 修正', true], ['work 回滚', true],
  ];
  for (const [subject, expected] of cases) expect(isFixSubject(subject)).toBe(expected);
});

test.each([
  ["v1.0.x delta (A'/B'): Codex-review fixes; credential isolation de-escalated", true],
  ['P8 fix: stand points clear', true],
  ['M1.0 review round 6 fixes: feedback trusts only known test names', true],
  ['Typo fix', true],
  ['Step 26.0.1: TTL contract bulk forward fix (5 issues)', true],
  ['commit README, dedup backend_api, fix MQTT compute ref', true],
  ['test(ui): wait for measured frame instead of a fixed delay', false],
  ['4.5 fix loop and 4.6 failure path', false],
  ['Prompt hardening + native loop mechanism for compile-fix recovery', false],
  ['goal hq-m12-fixes: start', false],
  ["Merge branch 'fix/turn-recovery' into main", false],
  ['Phase B: Task 5 campaign results (fully-fixed system)', false],
  ['format fix', false],
  ['Replace the fixed 30-min job cap with an idle timeout', false],
])('label and clause fix subject: %s → %s', (subject, expected) => {
  expect(isFixSubject(subject)).toBe(expected);
});

test('formatter reflow into three lines does not rework the original line', () => {
  const r=repo(); const a=r.commit('const values = ["alpha", "beta", "gamma"];\n','feature A',10);
  const fix=r.commit("const values = [\n  'alpha', 'beta',\n  'gamma',]\n",'fix layout',2000);
  const repos=new Repos(tmpdir());
  expect(originsOf(repos.of(r.dir)!,fix).has(a)).toBe(false);
  expect(buildTasks([session(r.dir,[0],30,[a])],repos)[0]!.commits[0]!.reworkedBy).toEqual([]);
});

test('same PR fixes are excluded, but a later mainline fix counts', () => {
  const r=repo(); r.commit('base content\n','base',-2000);
  r.git(['checkout','-b','feature']);
  const a=r.commit('original content\nsurviving content\n','feature A',10);
  // Rewrite A on the branch so the same-landing exclusion has actual blame evidence.
  const rewrite=r.commit('corrected content\nsurviving content\n','fix A',2100);
  r.git(['checkout','main']); r.git(['merge','--no-ff','feature','-m','merge feature'],2200);
  const later=r.commit('corrected content\nmainline correction\n','fix later',4000);
  const repos=new Repos(tmpdir());
  expect(originsOf(repos.of(r.dir)!,rewrite).has(a)).toBe(true);
  expect(originsOf(repos.of(r.dir)!,later).has(a)).toBe(true);
  expect(buildTasks([session(r.dir,[0],30,[a])],repos)[0]!.commits[0]!.reworkedBy).toEqual([later]);
});

test('reflow matches a complete subrun of added lines, with extra additions around it', () => {
  const r=repo(); const a=r.commit('const values = ["alpha", "beta"];\n','feature A',10);
  const fix=r.commit("const before = true;\nconst values = [\n  'alpha', 'beta',\n];\nconst after = true;\n",'fix layout',2000);
  expect(originsOf(new Repos(tmpdir()).of(r.dir)!,fix).has(a)).toBe(false);
});

test('reflow cannot concatenate additions from separate hunks', () => {
  const r=repo(); const retained='retained one\nretained two\nretained three\nretained four\n';
  const a=r.commit('const values = ["alpha", "beta"];\n'+retained,'feature A',10);
  const fix=r.commit("const values = [\n"+retained+"'alpha', 'beta'];\n",'fix content',2000);
  expect(originsOf(new Repos(tmpdir()).of(r.dir)!,fix).has(a)).toBe(true);
});

test('classifier uses line shares, ordered path rules, and size boundaries', async () => {
  const {classifyTask}=await import('../src/link');
  const classify=(fileLines:Record<string,number>)=>classifyTask([{mainline:true,fileLines}]);
  expect(classify({'docs/guide.ts':60,'README.md':39})).toEqual({kind:'文档',size:'<100'});
  expect(classify({'src/engine.test.ts':80,'src/engine.ts':20}).kind).toBe('测试');
  expect(classify({'src/ui/App.tsx':80,'src/cli.ts':20}).kind).toBe('界面');
  expect(classify({'src/query/engine.ts':1000})).toEqual({kind:'代码',size:'≥1k'});
  for (const [lines,size] of [[99,'<100'],[100,'100–300'],[299,'100–300'],[300,'300–1k'],[999,'300–1k'],[1000,'≥1k']] as const) {
    expect(classify({'src/engine.ts':lines}).size).toBe(size);
  }
  expect(classify({'bun.lock':5000})).toEqual({kind:'代码',size:'<100'});
  expect(classifyTask([])).toEqual({kind:'–',size:'–'});
  const commits: {mainline:boolean;fileLines:Record<string,number>}[]=[{mainline:false,fileLines:{'README.md':1000}},{mainline:true,fileLines:{'src/core.ts':99}}];
  expect(classifyTask(commits)).toEqual({kind:'代码',size:'<100'});
  expect(classifyTask(commits.map(c=>({...c,mainline:false})))).toEqual({kind:'文档',size:'≥1k'});
  for (const path of ['a.mdx','a.rst','a.txt','nested/docs/a.ts']) expect(classify({[path]:10}).kind).toBe('文档');
  for (const path of ['test/a.ts','tests/a.ts','__tests__/a.ts','spec/a.ts','a.spec.ts','a_test.go','test_a.py']) expect(classify({[path]:10}).kind).toBe('测试');
  for (const path of ['components/a.ts','pages/a.ts','views/a.ts','screens/a.ts','styles/a.ts','frontend/a.ts','a.jsx','a.vue','a.svelte','a.css','a.scss','a.html']) expect(classify({[path]:10}).kind).toBe('界面');
  expect(classify({'docs/a.test.ts':60,'src/core.ts':40}).kind).toBe('文档');
  expect(classify({'a.test.tsx':80,'src/core.ts':20}).kind).toBe('测试');
  expect(classify({'a.tsx':40,'src/core.ts':60}).kind).toBe('界面');
  expect(classify({'test/App.test.tsx':64,'src/ui/App.tsx':36}).kind).toBe('界面');
  expect(classify({'test/App.test.tsx':79,'src/ui/App.tsx':21}).kind).toBe('界面');
  expect(classify({'test/App.test.tsx':80,'src/ui/App.tsx':20}).kind).toBe('测试');
  expect(classify({'test/App.test.tsx':64,'src/core.ts':36}).kind).toBe('代码');
  expect(classify({'README.md':20,'tests/core.ts':30,'src/ui/App.tsx':20,'src/core.ts':30}).kind).toBe('界面');
  expect(classify({'README.md':20,'tests/core.ts':30,'src/ui/App.tsx':19,'src/core.ts':31}).kind).toBe('代码');
  expect(classify({'README.md':55,'tests/core.ts':45}).kind).toBe('文档');
  expect(classify({'README.md':45,'tests/core.ts':55}).kind).toBe('测试');
  expect(classify({'docs/a.test.ts':30,'tests/core.ts':30,'src/ui/App.tsx':40}).kind).toBe('界面');
});

test('numstat keeps per-file additions plus deletions and excludes lockfiles', () => {
  const r=repo(); r.commit('old\n','base',-2000);
  writeFileSync(join(r.dir,'file.txt'),'new\nextra\n');
  writeFileSync(join(r.dir,'bun.lock'),'lock\n'.repeat(1000));
  r.git(['add','.']); r.git(['commit','-m','work'],10);
  const sha=r.git(['rev-parse','HEAD']);
  const repos=new Repos(tmpdir());
  const commit=repos.of(r.dir)!.commits.get(sha)!;
  expect(commit.fileLines).toEqual({'file.txt':3});
  expect(commit.added+commit.deleted).toBe(3);
  const task=buildTasks([session(r.dir,[0],30,[sha])],repos)[0]!;
  expect(task.kind).toBe('文档'); expect(task.size).toBe('<100');
  writeFileSync(join(r.dir,'bun.lock'),'only lock\n');
  r.git(['add','.']); r.git(['commit','-m','lock only'],40);
  const lockSha=r.git(['rev-parse','HEAD']);
  const lock=new Repos(tmpdir()).of(r.dir)!.commits.get(lockSha)!;
  expect(lock.fileLines).toEqual({}); expect(lock.added+lock.deleted).toBe(0);
});

test('report kind and size filters and groupings use task classifications', async () => {
  const {html}=await import('../src/report');
  const {runInNewContext}=await import('node:vm');
  const r=repo(); const sha=r.commit('work\n','work',10);
  const tasks=buildTasks([session(r.dir,[0],30,[sha])],new Repos(tmpdir()));
  const page=html(tasks,{generatedAt:base,sessions:{claude:1,codex:0},repos:1,ci:false});
  expect(page).toContain('组合 × 类型'); expect(page).toContain('组合 × 规模');
  expect(page).toContain('类型 <select id="kind">'); expect(page).toContain('规模 <select id="size">');
  const elements:Record<string,any>={};
  // These commit-only fixtures have no recorded assistant; opt into empty tasks.
  const get=(id:string)=>elements[id]??={value:'',checked:id==='commits'||id==='empty',innerHTML:'',addEventListener:()=>{}};
  const context={document:{getElementById:get}};
  const script=page.match(/<script>([\s\S]*)<\/script>/)![1]!;
  const vm=await import('node:vm'); const ctx=vm.createContext(context);
  runInNewContext(script,ctx);
  expect(get('kind').innerHTML).toStartWith('<option value="">全部</option>');
  expect(get('size').innerHTML).toStartWith('<option value="">全部</option>');
  expect(get('tasks').innerHTML).toContain('<th>类型</th><th>规模</th>');
  expect(get('tasks').innerHTML).toContain('<td>文档</td><td>&lt;100</td>');
  for (const [group,label] of [['combo+kind','文档'],['combo+size','&lt;100'],['combo+agent','claude'],['combo+model','?']]) {
    get('group').value=group; vm.runInContext('render()',ctx);
    expect(get('summary').innerHTML).toContain(' · '+label);
  }
  get('kind').value='界面'; vm.runInContext('render()',ctx);
  expect(get('tasks').innerHTML).not.toContain('<td>文档</td>');
  get('kind').value='文档'; get('size').value='≥1k'; vm.runInContext('render()',ctx);
  expect(get('tasks').innerHTML).not.toContain('<td>文档</td>');
  get('size').value='<100'; vm.runInContext('render()',ctx);
  expect(get('tasks').innerHTML).toContain('<td>文档</td>');
});


test('aggregate averages each token category over all tasks', async () => {
  const {aggregate}=await import('../src/aggregate.js');
  const tasks=[
    {combo:'test',commits:[],costUSD:0,humanPrompts:0,interrupts:0,waitMs:0,tokens:{input:1200,cacheRead:8000,cacheWrite:600,output:400,reasoning:100}},
    {combo:'test',commits:[],costUSD:0,humanPrompts:0,interrupts:0,waitMs:0,tokens:{input:0,cacheRead:0,cacheWrite:0,output:0,reasoning:0}},
  ];
  const [row]=aggregate(tasks,t=>t.combo);
  expect(row).toMatchObject({tasks:2,inputPerTask:600,cacheReadPerTask:4000,cacheWritePerTask:300,outputPerTask:200});
  expect(row).not.toHaveProperty('codexMTokPerTask');
});


test('episode slices preserve all five session token categories', () => {
  const s=emptySession('test','root','fixture');
  s.start=0; s.end=40; s.times=[0,10,20,30,40];
  const first={input:10,cacheRead:20,cacheWrite:30,output:40,reasoning:5};
  const second={input:50,cacheRead:60,cacheWrite:70,output:80,reasoning:9};
  s.events=[{at:0,tokens:first},{at:10,humanPrompts:1},{at:30,humanPrompts:1},{at:40,tokens:second}];
  for (const key of Object.keys(s.tokens) as (keyof Session['tokens'])[]) s.tokens[key]=first[key]+second[key];
  const slices=splitEpisodes(s,[{at:20}]);
  expect(slices.map(slice=>slice.tokens)).toEqual([first,second]);
  for (const key of Object.keys(s.tokens) as (keyof Session['tokens'])[]) {
    expect(slices.reduce((n,slice)=>n+slice.tokens[key],0)).toBe(s.tokens[key]);
  }
});

// Execute the page's embedded script offline, with the actual control defaults.
async function dashboard(tasks: import('../src/link').Task[], generatedAt = Date.parse('2026-03-31T00:00:00Z')) {
  const {html} = await import('../src/report');
  const {createContext, runInContext} = await import('node:vm');
  const page = html(tasks, {generatedAt, sessions:{claude:tasks.length}, repos:1, ci:false});
  const elements: Record<string, any> = {};
  const get = (id: string) => elements[id] ??= {
    value: ({group:'combo', bucket:'4week', 'token-metric':'output'} as Record<string,string>)[id] || '',
    checked: id === 'commits' || id === 'markers', innerHTML:'', textContent:'',
    addEventListener(_event: string, handler: () => void) { this.change = handler; },
  };
  const ctx = createContext({document:{getElementById:get}});
  runInContext(page.match(/<script>([\s\S]*)<\/script>/)![1]!, ctx);
  return {page, get, read:(expression:string) => runInContext(expression, ctx), change:(id:string, value:string|boolean) => {
    get(id)[typeof value === 'boolean' ? 'checked' : 'value'] = value;
    get(id).change();
  }};
}

function dashboardTask(overrides: Partial<import('../src/link').Task> = {}): import('../src/link').Task {
  return {
    id:'task', vendor:'claude', combo:'claude solo', headless:false, empty:false, repo:'repo-a', cwd:'/fixture',
    start:base, end:base+10000, model:'root-model', models:['root-model','child-model'], kinds:[], sessions:1,
    costUSD:2, tokens:{input:100,cacheRead:200,cacheWrite:300,output:400,reasoning:10},
    humanPrompts:2, interrupts:1, waitMs:60000, kind:'代码', size:'<100', landed:true, reworked:true, reverted:false, mature:true,
    commits:[{sha:'abc1234',at:base,subject:'work',added:1,deleted:0,fileLines:{'src/a.ts':1},mainline:true,how:'exact',reworkedBy:[],reworkEvidence:[],mature:true}],
    ...overrides,
  };
}

test('task with only a human prompt is empty; normal assistant evidence is not', () => {
  const row = (type:string, extra = {}) => ({timestamp:at(type === 'user' ? 0 : 1), type, sessionId:'root', cwd:'/no-such-dashboard-repo', entrypoint:'cli', message:{content:type === 'user' ? 'work' : 'done', ...extra}});
  const promptOnly = parseClaude(jsonl([row('user')]), 'fixture')!;
  const normal = parseClaude(jsonl([row('user'), row('assistant', {model:'model-a', usage:{input_tokens:10,output_tokens:5}})]), 'fixture')!;
  expect(buildTasks([promptOnly],new Repos(tmpdir()))[0]).toMatchObject({empty:true,humanPrompts:1});
  expect(buildTasks([normal],new Repos(tmpdir()))[0]!.empty).toBe(false);
  const modelOnly = parseClaude(jsonl([row('user'), row('assistant',{model:'model-a'})]),'fixture')!;
  expect(buildTasks([modelOnly],new Repos(tmpdir()))[0]!.empty).toBe(false);
  for (const field of ['input','cacheRead','cacheWrite','output','reasoning'] as const) {
    const s = structuredClone(promptOnly); s.tokens[field] = 1;
    s.events.push({at:base+1000,tokens:{...s.tokens}});
    expect(buildTasks([s],new Repos(tmpdir()))[0]!.empty).toBe(false);
  }
  const child = structuredClone(normal); child.id='child'; child.parent=promptOnly.id;
  expect(buildTasks([promptOnly,child],new Repos(tmpdir()))[0]).toMatchObject({empty:false,sessions:2});
});

test('aggregate medians use per-task categories, zeros, and even / odd sample sizes', async () => {
  const {aggregate} = await import('../src/aggregate.js');
  const tasks = [90,0,10,20].map(n => dashboardTask({tokens:{input:n,cacheRead:n*2,cacheWrite:n*3,output:n*4,reasoning:999}}));
  expect(aggregate(tasks,t=>t.combo)[0]).toMatchObject({tasks:4,medianInput:15,medianCacheRead:30,medianCacheWrite:45,medianOutput:60,
    inputPerTask:30,cacheReadPerTask:60,cacheWritePerTask:90,outputPerTask:120});
  expect(aggregate(tasks.slice(0,3),t=>t.combo)[0]).toMatchObject({medianInput:10,medianCacheRead:20,medianCacheWrite:30,medianOutput:40});
  expect(aggregate([tasks[0]!],t=>t.combo)[0]!.medianInput).toBe(90);
  expect(aggregate([],()=> 'all')).toEqual([]);
});

test('html stays self-contained, including URL strings and hostile recorded text', async () => {
  const {html} = await import('../src/report');
  for (const tasks of [[], [dashboardTask({model:'https://example.test/<script src="bad">', repo:'http://example.test/</script><link href="bad">'})]]) {
    const page = html(tasks,{generatedAt:base,sessions:{claude:1},repos:1,ci:false});
    expect(page).not.toMatch(/<script\s+src|<link|http:\/\/|https:\/\//i);
    expect(page.match(/<script>/g)).toHaveLength(1);
    expect(page.match(/<\/script>/g)).toHaveLength(1);
  }
  const view = await dashboard([dashboardTask({model:'https://example.test/model'})]);
  expect(view.read('DATA.tasks[0].model')).toBe('https://example.test/model');
});

test('dashboard cards, medians, optional columns, and all filters share one task set', async () => {
  const view = await dashboard([dashboardTask(),
    dashboardTask({id:'other',vendor:'codex',combo:'codex solo',repo:'repo-b',model:'other-root',start:base+7*86400000,landed:false,mature:false,reworked:false,humanPrompts:4}),
    dashboardTask({id:'empty',empty:true,commits:[],landed:false,mature:false}),
    dashboardTask({id:'headless',headless:true}),
    dashboardTask({id:'norepo',repo:undefined,commits:[],landed:false,mature:false}),
  ]);
  expect(view.page).toContain('含空任务（无回复）');
  expect(view.get('empty-count').textContent).toBe('（1）');
  expect(view.get('cards').innerHTML.match(/class="card"/g)).toHaveLength(4);
  for (const value of ['2','2 / 1','100%','3.0']) expect(view.get('cards').innerHTML).toContain('<strong>'+value+'</strong>');
  expect(view.get('cards').innerHTML).toContain('1/1 (n=1)');
  expect(view.get('summary').innerHTML).toContain('样本少');
  expect(view.get('summary').innerHTML).toContain('0/1 (n=1)');
  expect(view.get('summary').innerHTML).toContain('width:100%');
  expect(view.get('summary').innerHTML).toContain('<td>0.10</td><td>0.20</td><td>0.30</td><td>0.40</td>');
  expect(view.get('summary').innerHTML).not.toMatch(/\$\/任务|CI 新失败/);
  view.change('more',true);
  expect(view.get('summary').innerHTML).toContain('$/任务');
  expect(view.get('summary').innerHTML).toContain('CI 新失败');
  view.change('group','model');
  expect(view.get('summary').innerHTML).toContain('<td>root-model</td>');
  expect(view.get('summary').innerHTML).not.toContain('<td>child-model</td>');
  view.change('group','agent');
  expect(view.get('summary').innerHTML).toContain('<td>claude</td>');
  for (const [id,value] of [['agent','codex'],['repo','repo-b'],['from','2026-01-08'],['to','2026-01-01']] as const) {
    view.change(id,value);
    expect(view.read('filtered().length')).toBe(1);
    expect(view.get('trend-tokens').innerHTML.match(/data-series="tokens"/g)).toHaveLength(1);
    view.change(id,'');
  }
  view.change('commits',false); expect(view.read('filtered().length')).toBe(2);
  view.change('empty',true); expect(view.read('filtered().length')).toBe(3);
  view.change('headless',true); expect(view.read('filtered().length')).toBe(4);
  view.change('norepo',true); expect(view.read('filtered().length')).toBe(5);
  view.change('kind','界面'); expect(view.read('filtered().length')).toBe(0);
  expect(view.get('trend-rework').innerHTML).toContain('n=0');
  expect(view.get('cards').innerHTML).not.toMatch(/NaN|Infinity/);
  view.change('kind',''); view.change('size','≥1k'); expect(view.read('filtered().length')).toBe(0);
});

test('SVG trends use vendor buckets, mature n gates, cache-inclusive medians, and model switches', async () => {
  const DAY=86400000, monday=Date.parse('2026-01-05T00:00:00Z');
  const tasks = [100,200,900].map((output,i) => dashboardTask({start:monday,model:i===2?'new-model':'old-model',reworked:i===0,tokens:{input:output,cacheRead:output*2,cacheWrite:output*3,output,reasoning:output}}));
  tasks.push(...[0,1].map(i=>dashboardTask({vendor:'codex',model:'same-name',start:monday,reworked:i===0})));
  tasks.push(dashboardTask({start:monday+7*DAY,model:'old-model',mature:false}));
  tasks.push(dashboardTask({start:monday+14*DAY,model:'new-model',reworked:false}));
  tasks.push(dashboardTask({start:monday+35*DAY,model:'latest-model',mature:false}));
  const view=await dashboard(tasks,monday+40*DAY);
  expect(view.get('bucket').value).toBe('4week');
  expect(view.get('trend-rework').innerHTML).toContain('返工 1/3（成熟 n）');
  expect(view.get('trend-rework').innerHTML.match(/data-series="rework"/g)).toHaveLength(1);
  view.change('bucket','week');
  const a=view.get('trend-rework').innerHTML, b=view.get('trend-tokens').innerHTML;
  expect(a).toContain('<svg'); expect(a).toContain('stroke-dasharray="5 4"');
  expect(a).toContain('未满 14 天'); expect(a).toContain('返工 1/3（成熟 n）');
  expect(a).toContain('返工 1/2（成熟 n）'); // n is retained in bars even if no point is drawn.
  expect(a.match(/data-series="rework"/g)).toHaveLength(1);
  expect(a.match(/data-series="mature"/g)).toHaveLength(3);
  expect(b).toContain('claude · 2026-01-05 · 中位数 200 · n=3');
  expect(b).not.toContain('data-model-marker="codex:');
  expect(a.match(/data-model-marker=/g)).toHaveLength(2);
  expect(b.match(/data-model-marker=/g)).toHaveLength(2);
  expect(a).toContain('data-model-marker="claude: old-model → new-model"');
  view.change('token-metric','input');
  expect(view.get('trend-tokens').innerHTML).toContain('claude · 2026-01-05 · 中位数 1200 · n=3');
  view.change('markers',false);
  expect(view.get('trend-rework').innerHTML).not.toContain('data-model-marker');
  expect(view.get('trend-tokens').innerHTML).not.toContain('data-model-marker');
  view.change('markers',true); view.change('from','2026-01-19');
  expect(view.get('trend-rework').innerHTML).not.toContain('data-model-marker="claude: old-model');
  expect(view.get('trend-rework').innerHTML).toContain('data-model-marker="claude: new-model → latest-model"');
  view.change('from',''); view.change('agent','codex');
  expect(view.get('trend-tokens').innerHTML).toContain('codex');
  expect(view.get('trend-tokens').innerHTML).not.toContain('claude');
  const zeros=await dashboard([dashboardTask({tokens:{input:0,cacheRead:0,cacheWrite:0,output:0,reasoning:0}})]);
  expect(zeros.get('trend-tokens').innerHTML).not.toMatch(/NaN|Infinity|data-series="tokens"/);
});

test('dominant root-model switches skip first and empty buckets, minor models, and follow filters', async () => {
  const monday=Date.parse('2026-01-05T00:00:00Z'), week=7*86400000;
  const tasks: import('../src/link').Task[]=[];
  const add=(bucket:number,model:string,n:number,vendor='claude',repo='repo-a') => {
    for(let i=0;i<n;i++) tasks.push(dashboardTask({start:monday+bucket*week,model,vendor,repo,models:['ignored-child-model']}));
  };
  add(0,'A',3); add(0,'minor',1);
  add(1,'A',3); add(1,'B',1);
  // Bucket 2 is empty. Dominant buckets A,A,B produce just A → B.
  add(3,'B',3); add(3,'minor',1);
  add(0,'C',2,'codex'); add(3,'D',2,'codex');
  const view=await dashboard(tasks.reverse());
  view.change('bucket','week');
  expect(view.page).toContain('checked> 主模型切换');
  expect(view.read('modelSwitches(filtered())')).toEqual([
    {vendor:'claude',at:monday+3*week,old:'A',model:'B'},
    {vendor:'codex',at:monday+3*week,old:'C',model:'D'},
  ]);
  for(const id of ['trend-rework','trend-tokens']) {
    const svg=view.get(id).innerHTML;
    expect(svg.match(/data-model-marker=/g)).toHaveLength(2);
    expect(svg).toContain('data-model-marker="claude: A → B"');
    expect(svg).toContain('data-model-marker="codex: C → D"');
    const ys=[...svg.matchAll(/data-model-marker="[^"]+"[\s\S]*?<text x="[^"]+" y="([^"]+)"/g)].map(m=>Number(m[1]));
    expect(new Set(ys).size).toBe(2);
  }
  view.change('agent','claude');
  expect(view.read('modelSwitches(filtered()).length')).toBe(1);
  view.change('from','2026-01-26');
  expect(view.read('modelSwitches(filtered())')).toEqual([]);
  expect(view.get('trend-rework').innerHTML).not.toContain('data-model-marker');
  // A repository filter changes bucket dominance, rather than preserving a global switch.
  const byRepo=await dashboard([
    ...[0,1].flatMap(bucket=>Array.from({length:2},()=>dashboardTask({start:monday+bucket*week,model:'A',repo:'repo-a'}))),
    dashboardTask({start:monday,model:'A',repo:'repo-b'}),
    ...Array.from({length:3},()=>dashboardTask({start:monday+week,model:'B',repo:'repo-b'})),
  ]);
  byRepo.change('bucket','week');
  expect(byRepo.read('modelSwitches(filtered())')).toEqual([{vendor:'claude',at:monday+week,old:'A',model:'B'}]);
  byRepo.change('repo','repo-a');
  expect(byRepo.read('modelSwitches(filtered())')).toEqual([]);
  // Ties retain the previous dominant model, independent of task order.
  const tie=await dashboard([dashboardTask({start:monday,model:'B'}),dashboardTask({start:monday+week,model:'A'}),dashboardTask({start:monday+week,model:'B'})]);
  tie.change('bucket','week');
  expect(tie.read('modelSwitches(filtered())')).toEqual([]);
});


test('sample warnings stop at n=20 and token trend positions use a logarithmic axis', async () => {
  for (const n of [19,20]) {
    const view=await dashboard(Array.from({length:n},()=>dashboardTask()));
    expect(view.get('summary').innerHTML.includes('样本少')).toBe(n<20);
  }
  const view=await dashboard([100,1000,10000].map((output,i)=>dashboardTask({start:base+i*7*86400000,tokens:{input:0,cacheRead:0,cacheWrite:0,output,reasoning:0}})));
  view.change('bucket','week');
  const ys=[...view.get('trend-tokens').innerHTML.matchAll(/data-series="tokens" cx="[^"]+" cy="([^"]+)"/g)].map(m=>Number(m[1]));
  expect(ys).toHaveLength(3);
  expect(ys[0]!-ys[1]!).toBeCloseTo(ys[1]!-ys[2]!);
});
