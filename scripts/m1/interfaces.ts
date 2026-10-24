// M1 interface list (D34): a fresh Claude session, in the task's sanitized repository, lists
// every interface the task's tests will touch, from the acceptance criteria and the code at the
// starting point only. It cannot read M0's code (sessions.ts). Writer and answerer both get the
// list; neither may change it.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claude, examDir, git } from "./common";
import { readerOf } from "./sessions";

export function criteriaOf(dir: string, task: string): { title: string; text: string } {
  const g = JSON.parse(readFileSync(join(dir, "goals", `${task}.json`), "utf8"));
  return { title: g.title, text: (g.acceptance as (string | { text: string })[]).map((a, i) => `${i + 1}. ${typeof a === "string" ? a : a.text}`).join("\n") };
}

/** Writes interfaces.md into the exam and goals/<task>.interfaces.md into the repository (committed). */
export function interfaces(dir: string, task: string, log: string): { cost: number } {
  const c = criteriaOf(dir, task);
  const prompt = `You are preparing a task in this repository (the working directory, at the task's starting point). Do not implement anything and do not edit files.

Task: ${c.title}

Acceptance criteria:
${c.text}

List every interface that tests of these criteria will touch, so that a test writer and an implementer who never talk to each other agree on them exactly: commands and their arguments and flags, exit codes, the exact output lines or message fragments tests will check, exported functions with module paths and TypeScript signatures, files and directories read or written, JSON fields and their types, environment variables. Mark each as existing (already in the code here) or new. Choose names and shapes that fit the existing code; decide nothing else about the implementation.

Reply with the list only, as Markdown, nothing before or after it.`;
  const r = claude(["--model", "claude-sonnet-5-5", "--effort", "high", "--settings", JSON.stringify(readerOf(task, dir)), "--allowedTools", "Read", "Grep", "Glob", "--disallowedTools", "Bash", "Edit", "Write", "WebFetch", "WebSearch"], prompt, dir);
  writeFileSync(log, r.log);
  const cost = r.result?.total_cost_usd ?? 0;
  if (r.limited || !r.result || r.result.is_error) throw Object.assign(new Error(`interfaces session failed: ${r.result?.result ?? "no result"}`), { cost });
  const list = String(r.result.result).trim();
  writeFileSync(join(examDir(task), "interfaces.md"), list + "\n");
  const file = join(dir, "goals", `${task}.interfaces.md`);
  writeFileSync(file, `# Interfaces for ${task}\n\nFixed before work starts (D34). Writer and answerer both use them; neither changes them.\n\n${list}\n`);
  git(["add", file], dir);
  git(["-c", "user.name=m1-interfaces", "-c", "user.email=m1@hq.invalid", "commit", "-q", "-m", `${task}: interface list (D34)`], dir);
  return { cost };
}
