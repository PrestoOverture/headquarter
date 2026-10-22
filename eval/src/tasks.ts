// Task set: post-cutoff SWE-bench-Live/MultiLang instances, copied from c2c-eval-runner
// (eval/fresh/tasks.json.gz). The writer job only ever sees PUBLIC_FIELDS; the gold
// patch and the official tests stay in the grade job.

import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export type Task = {
  instance_id: string;
  repo: string;
  language: string;
  image: string;
  platform: string;
  base_commit: string;
  created_at: string;
  problem_statement: string;
  rebuild_cmds: string[];
  env_activate: string;
  sanitize_git: boolean;
  screening: { decision: string } | null;
  patch: string; // gold fix
  test_patch: string; // official tests
  FAIL_TO_PASS: string;
};

export type PublicTask = Pick<
  Task,
  | "instance_id"
  | "repo"
  | "language"
  | "image"
  | "platform"
  | "base_commit"
  | "created_at"
  | "problem_statement"
  | "rebuild_cmds"
  | "env_activate"
  | "sanitize_git"
>;

export const PUBLIC_FIELDS = [
  "instance_id",
  "repo",
  "language",
  "image",
  "platform",
  "base_commit",
  "created_at",
  "problem_statement",
  "rebuild_cmds",
  "env_activate",
  "sanitize_git",
] as const;

export function readTasks(path: string): Task[] {
  const raw = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  return JSON.parse(text);
}

export function keptTasks(path: string): Task[] {
  return readTasks(path).filter((t) => t.screening?.decision === "keep");
}

export function findTask<T extends { instance_id: string }>(tasks: T[], id: string): T {
  const t = tasks.find((x) => x.instance_id === id);
  if (!t) throw new Error(`unknown task ${id}`);
  return t;
}

export function stripGold(t: Task): PublicTask {
  return Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, t[k]])) as PublicTask;
}

// bun src/tasks.ts strip <in.json.gz> <out.json>   — public task file for the writer job
// bun src/tasks.ts ids <in.json.gz>                — JSON array of every kept id
if (import.meta.main) {
  const [cmd, input, output] = process.argv.slice(2);
  if (cmd === "strip" && input && output) {
    writeFileSync(output, JSON.stringify(keptTasks(input).map(stripGold)));
  } else if (cmd === "ids" && input) {
    console.log(JSON.stringify(keptTasks(input).map((t) => t.instance_id)));
  } else {
    console.error("usage: bun src/tasks.ts strip <in> <out> | ids <in>");
    process.exit(2);
  }
}
