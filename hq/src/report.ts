// Goal report (D31): what you read before approving. Five columns: what changed (one line
// per task), how it was tested (the raw test output, not a verdict), risk (sensitive paths,
// dependency changes, new kinds of files), how to take it back out, and what is not done.
// The tests run on a trial merge with the latest main, the same way hq merge runs them.
// Reports live in $HQ_HOME/reports, keyed by the goal commit they describe; hq approve
// refuses a commit that has no green report.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { goalBranch, hqHome, MAIN, repoId } from "./approval";
import { git, revParse, run } from "./git";
import { readConfig, trialMerge } from "./merge";

export const DEFAULT_SENSITIVE = [
  ".hq.json", ".github/**", "hq/**", "scripts/sandbox/**", ".claude/**", "CLAUDE.md", "AGENTS.md", "**/.env*",
];
const MANIFESTS = /(^|\/)(Cargo\.toml|go\.mod|pyproject\.toml|requirements[^/]*\.txt|Gemfile|pom\.xml|build\.gradle(\.kts)?)$/;
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const TEST_TAIL_LINES = 300;

export type GoalFile = { title?: string; shelved?: { task: string; why: string }[]; known_issues?: string[] };
export type ReportMeta = { goal: string; commit: string; base: string; trial_merge: string; test_code: number; generated_at: string };

export function reportsDir(cwd: string): string {
  return join(hqHome(), "reports", repoId(cwd));
}

const metaPath = (cwd: string, goal: string, commit: string) => join(reportsDir(cwd), `${goal}-${commit.slice(0, 12)}.json`);

export function readReportMeta(cwd: string, goal: string, commit: string): ReportMeta | null {
  const p = metaPath(cwd, goal, commit);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

export function writeReport(cwd: string, meta: ReportMeta, markdown: string, testOutput: string): string {
  mkdirSync(reportsDir(cwd), { recursive: true });
  const stem = join(reportsDir(cwd), `${meta.goal}-${meta.commit.slice(0, 12)}`);
  writeFileSync(`${stem}.md`, markdown);
  writeFileSync(`${stem}.test.log`, testOutput);
  writeFileSync(`${stem}.json`, JSON.stringify(meta, null, 2) + "\n");
  return `${stem}.md`;
}

type Change = { status: string; path: string };

export function changes(cwd: string, head: string): Change[] {
  return git(["diff", "--name-status", "--no-renames", `${MAIN}...${head}`], cwd)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [status, path] = l.split("\t");
      return { status: status!, path: path! };
    });
}

export function sensitiveHits(paths: string[], patterns: string[]): string[] {
  const globs = patterns.map((p) => new Bun.Glob(p));
  return paths.filter((p) => globs.some((g) => g.match(p)));
}

function showJson(cwd: string, rev: string, path: string): Record<string, any> | null {
  const r = run(["git", "show", `${rev}:${path}`], cwd);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

/** Added, removed and re-versioned npm dependencies between two package.json versions. */
export function dependencyChanges(before: Record<string, any> | null, after: Record<string, any> | null): string[] {
  const out: string[] = [];
  for (const field of DEP_FIELDS) {
    const a = before?.[field] ?? {};
    const b = after?.[field] ?? {};
    for (const name of Object.keys(b)) {
      if (!(name in a)) out.push(`+ ${name}@${b[name]} (${field})`);
      else if (a[name] !== b[name]) out.push(`~ ${name} ${a[name]} → ${b[name]} (${field})`);
    }
    for (const name of Object.keys(a)) if (!(name in b)) out.push(`- ${name} (${field})`);
  }
  return out;
}

/** New top-level directories and file types the goal brings in: a rough signal of new patterns. */
export function newKinds(cwd: string, added: string[]): string[] {
  const existing = git(["ls-tree", "-r", "--name-only", MAIN], cwd).split("\n").filter(Boolean);
  const dirs = new Set(existing.map((p) => p.split("/")[0]));
  const exts = new Set(existing.map((p) => extname(p)).filter(Boolean));
  const out = new Set<string>();
  for (const p of added) {
    const top = p.split("/")[0]!;
    if (p.includes("/") && !dirs.has(top)) out.add(`新目录 ${top}/`);
    const e = extname(p);
    if (e && !exts.has(e)) out.add(`新文件类型 ${e}（${p}）`);
  }
  return [...out];
}

function tail(text: string, n: number): { text: string; cut: number } {
  const lines = text.trimEnd().split("\n");
  return lines.length <= n ? { text: lines.join("\n"), cut: 0 } : { text: lines.slice(-n).join("\n"), cut: lines.length - n };
}

export function renderReport(r: {
  goal: string;
  head: string;
  base: string;
  trialMerge: string;
  title?: string;
  tasks: string[];
  testCommand: string;
  testCode: number;
  testOutput: string;
  logPath: string;
  sensitive: string[];
  deps: string[];
  kinds: string[];
  shelved: { task: string; why: string }[];
  knownIssues: string[];
}): string {
  const list = (items: string[], empty: string) => (items.length ? items.map((i) => `- ${i}`).join("\n") : `- ${empty}`);
  const t = tail(r.testOutput, TEST_TAIL_LINES);
  return [
    `# 目标报告：${r.goal}${r.title ? `：${r.title}` : ""}`,
    "",
    `\`${goalBranch(r.goal)}\` 在 \`${r.head.slice(0, 12)}\`，与 \`${MAIN}\` \`${r.base.slice(0, 12)}\` 的合并预演 \`${r.trialMerge.slice(0, 12)}\`。新提交会让这份报告和据它做的批准作废。`,
    "",
    "## 改了什么",
    "",
    list(r.tasks, "（没有提交）"),
    "",
    "## 怎么测的",
    "",
    `在合并预演上、执行者沙箱里跑 \`${r.testCommand}\`（命令取自 ${MAIN} 的 .hq.json），退出码 ${r.testCode}${r.testCode === 0 ? "" : "，**测试没过**"}。`,
    t.cut ? `\n只贴最后 ${TEST_TAIL_LINES} 行，前面 ${t.cut} 行在 \`${r.logPath}\`。` : "",
    "",
    "```text",
    t.text,
    "```",
    "",
    "## 风险",
    "",
    "敏感路径：",
    "",
    list(r.sensitive, "没碰"),
    "",
    "依赖变化：",
    "",
    list(r.deps, "没有"),
    "",
    "新写法（新目录、新文件类型；只是线索，要你看 diff）：",
    "",
    list(r.kinds, "没有"),
    "",
    "考场路径（D30）：M0 没有考场，不适用。",
    "",
    "## 怎么撤回",
    "",
    `合入后一条命令撤回整个目标：\`git revert -m 1 <合并提交>\`。\`hq merge ${r.goal}\` 会打印带确切提交号的命令。`,
    "",
    "## 没做完的",
    "",
    "搁置的任务：",
    "",
    list(r.shelved.map((s) => `${s.task}：${s.why}`), "没有"),
    "",
    "既有问题（D28，不记在本目标头上）：",
    "",
    list(r.knownIssues, "没有"),
    "",
  ].join("\n");
}

export function report(cwd: string, goal: string): { path: string; meta: ReportMeta; markdown: string } {
  const head = revParse(goalBranch(goal), cwd);
  if (!head) throw new Error(`no branch ${goalBranch(goal)}`);
  const config = readConfig(cwd);
  const files = changes(cwd, head);
  const paths = files.map((f) => f.path);
  const deps: string[] = [];
  for (const p of paths) {
    if (p === "package.json" || p.endsWith("/package.json"))
      deps.push(...dependencyChanges(showJson(cwd, MAIN, p), showJson(cwd, head, p)).map((d) => `${p}: ${d}`));
    else if (MANIFESTS.test(p)) deps.push(`${p}: 依赖清单变了，看 diff`);
  }
  const goalFile = (showJson(cwd, head, `goals/${goal}.json`) ?? {}) as GoalFile;
  const tasks = git(["log", "--first-parent", "--reverse", "--format=%h %s", `${MAIN}..${head}`], cwd).split("\n").filter(Boolean);
  return trialMerge(cwd, goal, head, (t) => {
    if (!t.ok) throw new Error(t.reason);
    const meta: ReportMeta = {
      goal, commit: head, base: t.base, trial_merge: t.merged, test_code: t.testCode, generated_at: new Date().toISOString(),
    };
    const logPath = join(reportsDir(cwd), `${goal}-${head.slice(0, 12)}.test.log`);
    const markdown = renderReport({
      goal, head, base: t.base, trialMerge: t.merged, title: goalFile.title, tasks,
      testCommand: config.test, testCode: t.testCode, testOutput: t.testOutput, logPath,
      sensitive: sensitiveHits(paths, config.sensitive ?? DEFAULT_SENSITIVE),
      deps, kinds: newKinds(cwd, files.filter((f) => f.status === "A").map((f) => f.path)),
      shelved: goalFile.shelved ?? [], knownIssues: goalFile.known_issues ?? [],
    });
    return { path: writeReport(cwd, meta, markdown, t.testOutput), meta, markdown };
  });
}
