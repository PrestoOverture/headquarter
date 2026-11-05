// Codex session records: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, older ones compressed to
// .jsonl.zst. Each line is {timestamp, type, payload}; the first is session_meta. Fields come and
// go between Codex versions, so every one is optional here.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { COMMITS, commitShasIn, emptySession, finish, type Session, touch, WAIT_CAP_MS } from "./types";

const HEADLESS_ORIGINATORS = new Set(["codex_exec", "claude2codex", "c2c-mcp"]);
const DELEGATED_ORIGINATORS = new Set(["claude2codex", "c2c-mcp"]);
const HUMAN_TRIGGERS = new Set(["composer", "edit_user_message", "send_user_message_async_question"]);

function outputText(o: unknown): string {
  if (typeof o === "string") return o;
  if (o && typeof o === "object") return JSON.stringify(o);
  return "";
}

function userText(p: any): string {
  return Array.isArray(p.content) ? p.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n") : "";
}

/** Old sessions have no turn attribution: a user message is a prompt unless it is injected context. */
function looksTyped(text: string): boolean {
  const t = text.trimStart();
  return !!t && !t.startsWith("<") && !t.startsWith("# AGENTS.md");
}

export function parseCodex(text: string, file: string): Session | null {
  const s = emptySession("codex", "", file);
  let lastAssistant: number | null = null;
  let attributed = false; // a task_started with turn_attribution was seen
  const oldPrompts: number[] = [];
  const oldWaits: number[] = [];
  let lastAssistantOld: number | null = null;
  const commitCalls = new Set<string>(); // call ids whose command makes commits

  for (const line of text.split("\n")) {
    if (!line) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const p = d.payload && typeof d.payload === "object" ? d.payload : {};
    const t = touch(s, d.timestamp);

    if (d.type === "session_meta") {
      s.id = p.id ?? p.session_id ?? s.id;
      if (typeof p.cwd === "string") s.cwd = p.cwd;
      if (p.git?.repository_url) s.gitRemote = p.git.repository_url;
      if (p.git?.branch) s.gitBranch = p.git.branch;
      const spawn = p.source?.subagent?.thread_spawn;
      s.headless = HEADLESS_ORIGINATORS.has(p.originator) || p.source === "exec" || !!p.source?.subagent;
      if (p.source?.subagent === "review") s.role = "review";
      else if (spawn || p.thread_source === "subagent") s.role = "subagent";
      else if (DELEGATED_ORIGINATORS.has(p.originator)) s.role = "delegated";
      const parent = spawn?.parent_thread_id ?? p.parent_thread_id;
      if (typeof parent === "string") s.parent = parent;
      s.agentRole = spawn?.agent_role ?? p.agent_role ?? undefined;
      continue;
    }
    if (d.type === "turn_context" && typeof p.model === "string") {
      s.models[p.model] = (s.models[p.model] ?? 0) + 1;
      continue;
    }
    if (d.type === "event_msg") {
      if (p.type === "token_count" && p.info?.total_token_usage) {
        const u = p.info.total_token_usage;
        s.tokens = { input: u.input_tokens ?? 0, cached: u.cached_input_tokens ?? 0, output: u.output_tokens ?? 0 };
      } else if (p.type === "task_started" && p.turn_attribution) {
        attributed = true;
        if (HUMAN_TRIGGERS.has(p.turn_attribution.turn_trigger) && !s.headless) {
          s.humanPrompts++;
          if (t !== null && lastAssistant !== null && t > lastAssistant) s.waitMs += Math.min(t - lastAssistant, WAIT_CAP_MS);
          lastAssistant = null;
        }
      } else if (p.type === "turn_aborted") {
        if (!s.headless) s.interrupts++;
      } else if (p.type === "task_complete" && t !== null) {
        lastAssistant = t;
      }
      continue;
    }
    if (d.type === "response_item") {
      if (p.type === "function_call" || p.type === "custom_tool_call") {
        if (COMMITS.test(outputText(p.arguments ?? p.input))) commitCalls.add(p.call_id);
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        if (commitCalls.has(p.call_id)) s.commitShas.push(...commitShasIn(outputText(p.output)));
      } else if (p.type === "message" && t !== null) {
        if (p.role === "assistant") lastAssistantOld = t;
        if (p.role === "user" && looksTyped(userText(p))) {
          oldPrompts.push(t);
          oldWaits.push(lastAssistantOld !== null && t > lastAssistantOld ? Math.min(t - lastAssistantOld, WAIT_CAP_MS) : 0);
          lastAssistantOld = null;
        }
      }
    }
  }
  if (!s.id) return null;
  if (!attributed && !s.headless) {
    s.humanPrompts = oldPrompts.length;
    s.waitMs = oldWaits.reduce((a, b) => a + b, 0);
  }
  return finish(s);
}

function decompress(file: string): string {
  if (!file.endsWith(".zst")) return readFileSync(file, "utf8");
  const p = Bun.spawnSync(["zstd", "-dc", file], { stdin: "ignore" });
  if (p.exitCode !== 0) return "";
  return p.stdout.toString();
}

function walk(dir: string, out: string[]) {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith(".jsonl") || n.endsWith(".jsonl.zst")) out.push(p);
  }
}

/** Every session under `root` (default ~/.codex/sessions). */
export function readCodex(root: string): Session[] {
  const files: string[] = [];
  walk(root, files);
  const out: Session[] = [];
  for (const f of files) {
    const s = parseCodex(decompress(f), f);
    if (s) out.push(s);
  }
  return out;
}
