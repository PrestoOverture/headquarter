// Risk-column clues: imports of modules main never imports, and process or network calls,
// found in the lines a goal adds. Clues only: a regex per language, so some will be missed
// and some will be wrong; the reader still has to look at the diff.

import { extname } from "node:path";
import { git, run } from "./git";
import { countsForSize } from "./lines";
import { MAIN } from "./approval";

export type Clues = { source: string[]; test: string[] };
export type Added = { path: string; line: number; text: string };

export const noClues: Clues = { source: [], test: [] };

const TS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const C = new Set([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp"]);
const CODE = new Set([...TS, ...C, ".rs"]);
const NOT_CODE = new Set([".md", ".txt"]);
const MAX_TEXT = 120;

const TS_FROM = /^\s*(?:(?:import|export)\b[^"'`]*?|\})\s*from\s*["']([^"']+)["']/;
const TS_BARE = /^\s*import\s*["']([^"']+)["']/;
const TS_CALL = /\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
const RS_USE = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+?)\s*;?\s*$/;
const C_INCLUDE = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/;

// A bare name: `re.exec(` and `cache.fetch(` are not process or network calls.
const CALLS = [
  /\bchild_process\b/, /\bBun\.spawn(?:Sync)?\b/, /\bhttps?\.request\s*\(/, /\bnet\.connect\s*\(/, /\b(?:curl|wget)\b/,
  /(?<![.\w])(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fetch)\s*\(/,
];
const RUST_CALLS = [/\bCommand::new\b/, /\bTcpStream::connect\b/];
const C_CALLS = [/(?<![.\w])(?:system|popen|fork|execv|execvp|execve|execl|execlp|socket|connect)\s*\(/];

/** The module a line imports, or none: the quoted specifier (TS), the path without its last segment (Rust), the header (C). */
export function importedModules(path: string, text: string): string[] {
  const ext = extname(path);
  if (TS.has(ext)) {
    const m = TS_FROM.exec(text) ?? TS_BARE.exec(text);
    return [...(m ? [m[1]!] : []), ...[...text.matchAll(TS_CALL)].map((c) => c[1]!)];
  }
  if (C.has(ext)) return [C_INCLUDE.exec(text)?.[1]].filter((m): m is string => !!m);
  const use = ext === ".rs" ? RS_USE.exec(text)?.[1] : undefined;
  if (!use) return [];
  if (use.includes("{")) return [use.slice(0, use.indexOf("{")).replace(/::$/, "")].filter(Boolean);
  const segs = use.replace(/\s+as\s+\w+$/, "").split("::");
  return [(segs.at(-1) === "*" || segs.length < 2 ? segs.filter((s) => s !== "*") : segs.slice(0, -1)).join("::")];
}

export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(path) || /\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|(^|\/)test_[^/]*$/.test(path);
}

/** Lines added between main and head, with their line numbers in head's file. A line removed elsewhere in the same file (a move) is not added. */
export function addedLines(cwd: string, head: string): Added[] {
  const diff = git(["-c", "core.quotepath=off", "diff", "-U0", "--no-renames", "--no-color", `${MAIN}...${head}`], cwd);
  const out: Added[] = [];
  let path: string | null = null;
  let line = 0;
  let inHunk = false;
  let removed = new Map<string, number>();
  const pending: Added[] = [];
  const flush = () => {
    for (const a of pending.splice(0)) {
      const n = removed.get(a.text.trim()) ?? 0;
      if (n > 0) removed.set(a.text.trim(), n - 1);
      else out.push(a);
    }
    removed = new Map();
  };
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) {
      flush();
      path = null;
      inHunk = false;
    } else if (!inHunk && l.startsWith("+++ ")) {
      const raw = l.slice(4).replace(/\t$/, "");
      path = raw === "/dev/null" ? null : (raw.startsWith('"') ? (JSON.parse(raw) as string) : raw).slice(2);
    } else if (l.startsWith("@@ ")) {
      inHunk = true;
      line = Number(/\+(\d+)/.exec(l)![1]);
    } else if (inHunk && path && l.startsWith("+")) pending.push({ path, line: line++, text: l.slice(1) });
    else if (inHunk && path && l.startsWith("-")) removed.set(l.slice(1).trim(), (removed.get(l.slice(1).trim()) ?? 0) + 1);
  }
  flush();
  return out.filter((a) => countsForSize(a.path));
}

/** Every module some file on main imports. */
function mainModules(cwd: string): Set<string> {
  const exts = [...CODE].map((e) => `*${e}`);
  const re = "import|require|from|use[[:space:]]|#[[:space:]]*include";
  const r = run(["git", "grep", "-I", "-z", "-n", "-E", "-e", re, MAIN, "--", ...exts], cwd);
  const mods = new Set<string>();
  for (const rec of r.out.split("\n")) {
    const [file, , ...text] = rec.split("\0");
    if (file) for (const m of importedModules(file.slice(MAIN.length + 1), text.join("\0"))) mods.add(m);
  }
  return mods;
}

const show = (a: Added) => {
  const t = a.text.trim();
  return `${a.path}:${a.line}：\`${t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t}\``;
};
const split = (items: Added[]): Clues => ({
  source: items.filter((a) => !isTestPath(a.path)).map(show),
  test: items.filter((a) => isTestPath(a.path)).map(show),
});

function callsOut(a: Added): boolean {
  const ext = extname(a.path);
  const res = ext === ".rs" ? [...CALLS, ...RUST_CALLS] : C.has(ext) ? [...CALLS, ...C_CALLS] : CALLS;
  return !NOT_CODE.has(ext) && res.some((re) => re.test(a.text));
}

export function riskClues(cwd: string, head: string): { imports: Clues; calls: Clues } {
  const added = addedLines(cwd, head);
  const known = mainModules(cwd);
  return {
    imports: split(added.filter((a) => importedModules(a.path, a.text).some((m) => !known.has(m)))),
    calls: split(added.filter((a) => callsOut(a))),
  };
}
