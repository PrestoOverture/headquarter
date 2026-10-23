// A task's cost from the session record: Claude Code's `--output-format stream-json` log
// (one JSON message per line) or `--output-format json` result (one object, or an array of
// messages). Each session ends in a `result` message with its total_cost_usd; a file with
// several sessions' results records their sum. The file's path and sha256 go in the event,
// and the same content is not recorded twice for a task.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { append, type Event, readEvents } from "./ledger";

export type Session = { usd: number; models: string[] };

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

/** Each `result` message's cost, with the models it ran on (modelUsage keys; else the session's init message). */
export function parseSessions(text: string): Session[] {
  const sessions: Session[] = [];
  let initModel: string | undefined;
  for (const m of messages(text)) {
    if (m?.type === "system" && m.subtype === "init" && typeof m.model === "string") initModel = m.model;
    if (m?.type !== "result") continue;
    if (typeof m.total_cost_usd !== "number" || !(m.total_cost_usd >= 0)) continue;
    const used = m.modelUsage && typeof m.modelUsage === "object" ? Object.keys(m.modelUsage) : [];
    sessions.push({ usd: m.total_cost_usd, models: used.length ? used : initModel ? [initModel] : [] });
    initModel = undefined;
  }
  return sessions;
}

/** Appends a `task.cost` event for the sessions in `file`; refuses a file with no result or one already recorded for `task`. */
export function recordCostFrom(cwd: string, task: string, file: string, model?: string): Extract<Event, { type: "task.cost" }> {
  const path = resolve(cwd, file);
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sessions = parseSessions(bytes.toString("utf8"));
  if (!sessions.length) throw new Error(`no result line with total_cost_usd in ${path}`);
  const dup = readEvents(cwd).find((e) => e.type === "task.cost" && e.task === task && e.source?.sha256 === sha256);
  if (dup) throw new Error(`${path} is already recorded for task ${task} (${dup.at})`);
  const models = [...new Set(sessions.flatMap((s) => s.models))];
  return append(cwd, {
    type: "task.cost", task, usd: sessions.reduce((s, x) => s + x.usd, 0), model: model ?? (models.join(", ") || undefined),
    source: { path, sha256 },
  }) as Extract<Event, { type: "task.cost" }>;
}
