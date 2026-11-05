import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaude } from '../src/claude';
import { parseCodex } from '../src/codex';
import { buildTasks } from '../src/link';
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
  expect(tasks.map(t=>t.codexTokens)).toEqual([90,60]);
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
  const get=(id:string)=>elements[id]??=( {value:'',checked:id==='commits',innerHTML:'',addEventListener:()=>{}} );
  runInNewContext(page.match(/<script>([\s\S]*)<\/script>/)![1]!,{document:{getElementById:get}});
  expect(get('rework').innerHTML).toContain('file.txt: const old = &quot;&lt;tag&gt;&quot;;');
  expect(get('rework').innerHTML).toContain('fix text');
  get('repo').value='another repo';
  // Re-run render with the same filter state.
  const script=page.match(/<script>([\s\S]*)<\/script>/)![1]!;
  runInNewContext(script,{document:{getElementById:get}});
  expect(get('rework').innerHTML).not.toContain('fix text');
});
