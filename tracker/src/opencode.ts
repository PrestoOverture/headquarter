// OpenCode's local database. Only session, message and part are read.
import { statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { SessionFileReader, SourcePlugin } from "./plugins";
import { COMMITS, commitShasIn, emptySession, finish, type Session, WAIT_CAP_MS } from "./types";

function openDatabase(file: string) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major! < 22 || (major === 22 && minor! < 13)) throw new Error("Reading OpenCode needs Node 22.13 or newer");
  // Loading node:sqlite emits this warning synchronously. Forward all other warnings,
  // and restore the original handler before opening or reading the database.
  const emitWarning = process.emitWarning;
  let sqlite: typeof import("node:sqlite");
  try {
    process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
      if (warning === "SQLite is an experimental feature and might change at any time" && args[0] === "ExperimentalWarning") return;
      Reflect.apply(emitWarning, process, [warning, ...args]);
    }) as typeof process.emitWarning;
    sqlite = createRequire(import.meta.url)("node:sqlite");
  } finally { process.emitWarning = emitWarning; }
  return new sqlite.DatabaseSync(file, { readOnly: true });
}

function databasePath(path: string): string {
  try { if (statSync(path).isDirectory()) return join(path, "opencode.db"); } catch {}
  return path;
}

export function readOpenCode(path: string, readFile: SessionFileReader = (_file, parse) => parse()): Session[] {
  const file = databasePath(path);
  if (!opencodePlugin.detect(file)) return [];
  return readFile(file, () => parseOpenCode(file));
}

function parseOpenCode(file: string): Session[] {
  const db = openDatabase(file);
  try {
    const sessions = db.prepare("SELECT id, directory, parent_id, time_created, time_updated FROM session ORDER BY time_created, id").all() as any[];
    const messages = db.prepare("SELECT id, session_id, time_created, data FROM message ORDER BY time_created, id").all() as any[];
    const parts = db.prepare("SELECT message_id, data FROM part ORDER BY time_created, id").all() as any[];
    const partsByMessage = new Map<string, any[]>();
    for (const row of parts) {
      const list = partsByMessage.get(row.message_id) ?? [];
      list.push(JSON.parse(row.data));
      partsByMessage.set(row.message_id, list);
    }
    const byId = new Map<string, Session>();
    for (const row of sessions) {
      const s = emptySession("opencode", row.id, file);
      s.cwd = row.directory;
      s.start = row.time_created;
      s.end = row.time_updated;
      s.times.push(s.start, s.end);
      if (row.parent_id) { s.parent = row.parent_id; s.role = "subagent"; }
      byId.set(s.id, s);
    }
    const lastAssistant = new Map<string, number>();
    for (const row of messages) {
      const s = byId.get(row.session_id);
      if (!s) continue;
      const d = JSON.parse(row.data);
      const at = d.time?.created ?? row.time_created;
      const completed = d.time?.completed ?? at;
      s.start = Math.min(s.start, at);
      s.end = Math.max(s.end, completed);
      s.times.push(at, completed);
      const event: Session["events"][number] = { at };
      s.events.push(event);
      const parts = partsByMessage.get(row.id) ?? [];
      if (d.role === "assistant") {
        if (typeof d.modelID === "string") {
          const model = d.providerID ? `${d.providerID}/${d.modelID}` : d.modelID;
          s.models[model] = (s.models[model] ?? 0) + 1;
        }
        const u = d.tokens ?? {};
        event.tokens = { input: u.input ?? 0, cacheRead: u.cache?.read ?? 0, cacheWrite: u.cache?.write ?? 0,
          output: (u.output ?? 0) + (u.reasoning ?? 0), reasoning: u.reasoning ?? 0 };
        for (const key of Object.keys(s.tokens) as (keyof Session["tokens"])[]) s.tokens[key] += event.tokens[key];
        event.usage = event.tokens.input + event.tokens.cacheRead + event.tokens.cacheWrite + event.tokens.output;
        if (typeof d.cost === "number") s.costUSD = (s.costUSD ?? 0) + d.cost;
        if (d.error?.name === "MessageAbortedError") { s.interrupts++; event.interrupts = 1; }
        lastAssistant.set(s.id, completed);
        for (const p of parts) {
          if (p.type === "tool" && p.tool === "bash" && typeof p.state?.input?.command === "string"
            && COMMITS.test(p.state.input.command) && typeof p.state.output === "string") {
            s.commitShas.push(...commitShasIn(p.state.output));
          }
        }
      } else if (d.role === "user" && !s.parent && parts.some(p => p.type === "text" && !p.synthetic)) {
        s.humanPrompts++;
        event.humanPrompts = 1;
        const previous = lastAssistant.get(s.id);
        if (previous !== undefined && at > previous) s.waitMs += event.waitMs = Math.min(at - previous, WAIT_CAP_MS);
        lastAssistant.delete(s.id);
      }
    }
    return [...byId.values()].map(finish);
  } finally { db.close(); }
}

export const opencodePlugin: SourcePlugin = {
  name: "opencode",
  version: "1",
  defaultPaths: home => [join(home, ".local/share/opencode")],
  detect: path => { try { return statSync(databasePath(path)).isFile(); } catch { return false; } },
  read: readOpenCode,
};
