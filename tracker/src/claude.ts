// Claude Code session records: ~/.claude/projects/<dir>/<session>.jsonl, one JSON record per
// line; a session's subagents in <session>/subagents/agent-*.jsonl. The format is not a public
// contract, so unknown or broken lines are skipped, not fatal.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { COMMITS, commitShasIn, emptySession, finish, type Session, touch, WAIT_CAP_MS } from "./types";
import type { SessionFileReader, SourcePlugin } from "./plugins";
import { directoryNames } from "./files";

const HEADLESS_ENTRYPOINTS = new Set(["sdk-cli", "sdk-py", "sdk-ts"]);
const NOT_A_PROMPT = /^(<task-notification>|<local-command-|<system-reminder>|This session is being continued|Caveat: )/;
const INTERRUPT = /^\[Request interrupted by user/;
const THREAD_ID = /"thread_id"\s*:\s*"([0-9a-f-]{36})"/g;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && typeof c === "object" && typeof (c as any).text === "string" ? (c as any).text : "")).join("\n");
}

function toolResultText(block: any, record: any): string {
  const parts = [textOf(block.content)];
  const r = record.toolUseResult;
  if (typeof r === "string") parts.push(r);
  else if (r && typeof r === "object") {
    if (typeof r.stdout === "string") parts.push(r.stdout);
  }
  return parts.join("\n");
}

/** Whether a non-tool-result user record is something a person typed. */
export function isHumanPrompt(d: any, headless: boolean): boolean {
  if (d.isMeta || d.isCompactSummary || d.isVisibleInTranscriptOnly) return false;
  const kind = d.origin?.kind;
  if (typeof kind === "string") return kind === "human";
  if (headless) return false;
  return !NOT_A_PROMPT.test(textOf(d.message?.content).trimStart());
}

/** One session from one file's text. `parent` marks a subagent file. */
export function parseClaude(text: string, file: string, parent?: string): Session | null {
  const s = emptySession("claude", basename(file, ".jsonl"), file);
  if (parent) {
    s.role = "subagent";
    s.parent = parent;
  }
  const codexTools = new Map<string, string>(); // tool_use id -> name
  const commitTools = new Set<string>(); // tool_use ids whose command makes commits
  const costByProcess = new Map<number, number>(); // cost-state startTime -> highest total seen
  const usageMessages = new Set<string>();
  let lastAssistant: number | null = null;
  let seen = false;

  for (const line of text.split("\n")) {
    if (!line) continue;
    s.parse.records++;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      s.parse.unparsed++;
      continue;
    }
    if (!d || typeof d !== "object") continue;
    if (!parent && d.isSidechain) continue; // old layout: subagent turns inline in the main file
    const t = touch(s, d.timestamp);
    if (d.type === "cost-state") {
      s.parse.recognized++;
      if (typeof d.totalCostUSD === "number") {
        const key = typeof d.startTime === "number" ? d.startTime : 0;
        costByProcess.set(key, Math.max(costByProcess.get(key) ?? 0, d.totalCostUSD));
      }
      continue;
    }
    if (d.type !== "user" && d.type !== "assistant") continue;
    s.parse.recognized++;
    if (!seen) {
      seen = true;
      if (!parent && typeof d.sessionId === "string") s.id = d.sessionId;
      s.headless = HEADLESS_ENTRYPOINTS.has(d.entrypoint);
      if (parent && typeof d.agentId === "string") s.id = `${parent}/agent-${d.agentId}`;
    }
    if (!s.cwd && typeof d.cwd === "string") s.cwd = d.cwd;
    if (!s.gitBranch && typeof d.gitBranch === "string" && d.gitBranch) s.gitBranch = d.gitBranch;
    const content = d.message?.content;
    const event: Session['events'][number] = { at: t ?? s.end };
    s.events.push(event);

    if (d.type === "assistant") {
      s.parse.replies++;
      const usage = d.message?.usage;
      if (usage) event.usage = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      const messageId = d.message?.id;
      if (usage && (typeof messageId !== "string" || !usageMessages.has(messageId))) {
        if (typeof messageId === "string") usageMessages.add(messageId);
        event.tokens = {
          input: usage.input_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          reasoning: 0,
        };
        for (const key of Object.keys(s.tokens) as (keyof Session["tokens"])[]) s.tokens[key] += event.tokens[key];
      }
      const model = d.message?.model;
      if (typeof model === "string" && model !== "<synthetic>") s.models[model] = (s.models[model] ?? 0) + 1;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type !== "tool_use" || typeof c.name !== "string") continue;
          if (c.name.includes("codex")) codexTools.set(c.id, c.name);
          if (COMMITS.test(JSON.stringify(c.input ?? ""))) commitTools.add(c.id);
        }
      }
      if (t !== null) lastAssistant = t;
      continue;
    }

    // user record: tool results, or something a person or the harness said
    const blocks = Array.isArray(content) ? content : [];
    const results = blocks.filter((c: any) => c?.type === "tool_result");
    if (results.length) {
      for (const r of results) {
        const out = toolResultText(r, d);
        if (commitTools.has(r.tool_use_id)) s.commitShas.push(...commitShasIn(out));
        if (codexTools.has(r.tool_use_id)) for (const m of out.matchAll(THREAD_ID)) s.codexThreads.push(m[1]!);
      }
      continue;
    }
    if (parent) continue; // a subagent's prompts come from its parent
    if (INTERRUPT.test(textOf(content).trimStart())) {
      s.interrupts++;
      event.interrupts = 1;
      continue;
    }
    if (!isHumanPrompt(d, s.headless)) continue;
    s.humanPrompts++;
    event.humanPrompts = 1;
    if (t !== null && lastAssistant !== null && t > lastAssistant) s.waitMs += event.waitMs = Math.min(t - lastAssistant, WAIT_CAP_MS);
    lastAssistant = null;
  }
  if (!seen) return null;
  if (costByProcess.size) s.costUSD = [...costByProcess.values()].reduce((a, b) => a + b, 0);
  return finish(s);
}

/** Every session under `root` (default ~/.claude/projects), subagents included. */
export function readClaude(root: string, readFile: SessionFileReader = (_file, parse) => parse()): Session[] {
  const out: Session[] = [];
  let dirs: string[];
  try {
    dirs = directoryNames(root);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const path = join(root, dir);
    if (!statSync(path).isDirectory()) continue;
    for (const name of directoryNames(path)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(path, name);
      const [main] = readFile(file, () => {
        const s = parseClaude(readFileSync(file, "utf8"), file);
        return s ? [s] : [];
      });
      if (!main) continue;
      out.push(main);
      const subDir = join(path, basename(name, ".jsonl"), "subagents");
      let subs: string[] = [];
      try {
        subs = directoryNames(subDir).filter((n) => n.endsWith(".jsonl"));
      } catch {}
      for (const sub of subs) {
        const sf = join(subDir, sub);
        const [s] = readFile(sf, () => {
          const s = parseClaude(readFileSync(sf, "utf8"), sf, main.id);
          return s ? [s] : [];
        });
        // Parent metadata may change while the subagent file itself stays unchanged.
        if (s && s.parent !== main.id) {
          const prefix = `${s.parent}/agent-`;
          if (s.id.startsWith(prefix)) s.id = `${main.id}/agent-${s.id.slice(prefix.length)}`;
          s.parent = main.id;
        }
        if (s) out.push(s);
      }
    }
  }
  return out;
}

export const claudePlugin: SourcePlugin = {
  name: "claude",
  version: "2",
  defaultPaths: (home) => [join(home, ".claude/projects")],
  detect: (path) => {
    try {
      return readdirSync(path, { withFileTypes: true }).some(dir => dir.isDirectory() &&
        readdirSync(join(path, dir.name), { withFileTypes: true }).some(file => file.isFile() && file.name.endsWith(".jsonl")));
    } catch { return false; }
  },
  read: readClaude,
};
