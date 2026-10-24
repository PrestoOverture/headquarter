// A task's cost from the session record: Claude Code's `--output-format stream-json` log
// (one JSON message per line) or `--output-format json` result (one object, or an array of
// messages). Each run (`claude -p`, also a `--resume` of an earlier session) ends in a `result`
// message with its own uuid and total_cost_usd, for that run alone, not a running total. Runs
// are what get counted: a task's cost from a file is the sum over its results, and a uuid
// already recorded for any task is skipped. The event keeps the run uuids, the session ids
// (for reference only), and the file's path and sha256.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { append, type Event, readEvents } from "./ledger";

export type Run = { uuid: string; session?: string; usd: number; models: string[] };

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

/** One run per result uuid, with the models it ran on (modelUsage keys; else the init message before it). */
export function parseRuns(text: string): Run[] {
  const runs = new Map<string, Run>();
  let initModel: string | undefined;
  for (const m of messages(text)) {
    if (m?.type === "system" && m.subtype === "init" && typeof m.model === "string") initModel = m.model;
    if (m?.type !== "result") continue;
    if (typeof m.total_cost_usd !== "number" || !(m.total_cost_usd >= 0)) continue;
    if (typeof m.uuid !== "string" || !m.uuid) {
      throw new Error("a result line has no uuid, so its run cannot be told from one already recorded");
    }
    const used = m.modelUsage && typeof m.modelUsage === "object" ? Object.keys(m.modelUsage) : [];
    const session = typeof m.session_id === "string" && m.session_id ? m.session_id : undefined;
    runs.set(m.uuid, { uuid: m.uuid, session, usd: m.total_cost_usd, models: used.length ? used : initModel ? [initModel] : [] });
    initModel = undefined;
  }
  return [...runs.values()];
}

/** Appends a `task.cost` event for the runs in `file` not yet recorded for any task; refuses a file with no result or nothing new. */
export function recordCostFrom(
  cwd: string, task: string, file: string, model?: string,
): { event: Extract<Event, { type: "task.cost" }>; skipped: string[] } {
  const path = resolve(cwd, file);
  const bytes = readFileSync(path);
  const runs = parseRuns(bytes.toString("utf8"));
  if (!runs.length) throw new Error(`no result line with total_cost_usd in ${path}`);
  const seen = new Set(readEvents(cwd).flatMap((e) => (e.type === "task.cost" ? (e.runs ?? []) : [])));
  const fresh = runs.filter((r) => !seen.has(r.uuid));
  const skipped = runs.filter((r) => seen.has(r.uuid)).map((r) => r.uuid);
  if (!fresh.length) throw new Error(`every run in ${path} is already recorded: ${skipped.join(", ")}`);
  const models = [...new Set(fresh.flatMap((r) => r.models))];
  const sessions = [...new Set(fresh.flatMap((r) => (r.session ? [r.session] : [])))];
  const event = append(cwd, {
    type: "task.cost", task, usd: fresh.reduce((s, x) => s + x.usd, 0), model: model ?? (models.join(", ") || undefined),
    runs: fresh.map((r) => r.uuid), sessions, source: { path, sha256: createHash("sha256").update(bytes).digest("hex") },
  }) as Extract<Event, { type: "task.cost" }>;
  return { event, skipped };
}
