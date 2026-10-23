// A task's cost from the session record: Claude Code's `--output-format stream-json` log
// (one JSON message per line) or `--output-format json` result (one object, or an array of
// messages). Each session ends in a `result` message with its session_id and total_cost_usd;
// sessions are what get counted: a session id already recorded for any task is skipped, and
// a session that reports several results (a resumed one, with a running total) counts once,
// at its last result. The event keeps the session ids, and the file's path and sha256.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { append, type Event, readEvents } from "./ledger";

export type Session = { id: string; usd: number; models: string[] };

function messages(text: string): any[] {
  try {
    const whole = JSON.parse(text);
    return Array.isArray(whole) ? whole : [whole];
  } catch {}
  const out: any[] = [];
  for (const l of text.split("\n")) {
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
}

/** One session per session_id: its last `result` message's cost, with the models it ran on (modelUsage keys; else the session's init message). */
export function parseSessions(text: string): Session[] {
  const sessions = new Map<string, Session>();
  let initModel: string | undefined;
  for (const m of messages(text)) {
    if (m?.type === "system" && m.subtype === "init" && typeof m.model === "string") initModel = m.model;
    if (m?.type !== "result") continue;
    if (typeof m.total_cost_usd !== "number" || !(m.total_cost_usd >= 0)) continue;
    if (typeof m.session_id !== "string" || !m.session_id) {
      throw new Error("a result line has no session_id, so its session cannot be told from one already recorded");
    }
    const used = m.modelUsage && typeof m.modelUsage === "object" ? Object.keys(m.modelUsage) : [];
    sessions.set(m.session_id, { id: m.session_id, usd: m.total_cost_usd, models: used.length ? used : initModel ? [initModel] : [] });
    initModel = undefined;
  }
  return [...sessions.values()];
}

/** Appends a `task.cost` event for the sessions in `file` not yet recorded for any task; refuses a file with no result or nothing new. */
export function recordCostFrom(
  cwd: string, task: string, file: string, model?: string,
): { event: Extract<Event, { type: "task.cost" }>; skipped: string[] } {
  const path = resolve(cwd, file);
  const bytes = readFileSync(path);
  const sessions = parseSessions(bytes.toString("utf8"));
  if (!sessions.length) throw new Error(`no result line with total_cost_usd in ${path}`);
  const seen = new Set(readEvents(cwd).flatMap((e) => (e.type === "task.cost" ? (e.sessions ?? []) : [])));
  const fresh = sessions.filter((s) => !seen.has(s.id));
  const skipped = sessions.filter((s) => seen.has(s.id)).map((s) => s.id);
  if (!fresh.length) throw new Error(`every session in ${path} is already recorded: ${skipped.join(", ")}`);
  const models = [...new Set(fresh.flatMap((s) => s.models))];
  const event = append(cwd, {
    type: "task.cost", task, usd: fresh.reduce((s, x) => s + x.usd, 0), model: model ?? (models.join(", ") || undefined),
    sessions: fresh.map((s) => s.id), source: { path, sha256: createHash("sha256").update(bytes).digest("hex") },
  }) as Extract<Event, { type: "task.cost" }>;
  return { event, skipped };
}
