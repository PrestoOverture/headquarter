// Main-ref guard: a git reference-transaction hook that refuses any update of main that
// is not an approved goal's merge commit. The sandbox already denies executors writes to
// main's ref (M0.0); this catches the same move from a session that is not sandboxed,
// before git commits the transaction. A human updating main by hand sets HQ_ALLOW_MAIN=1.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAIN, openApprovals } from "./approval";
import { commonDir, run } from "./git";

const ZERO = /^0+$/;
const MARK = "# installed by hq install-hook";

export type Update = { old: string; new: string; ref: string };

export function parseUpdates(stdin: string): Update[] {
  return stdin
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [o, n, ref] = l.split(" ");
      return { old: o!, new: n!, ref: ref! };
    });
}

/** Why an update of main is refused, or null when it is allowed. */
export function refusal(u: Update, parents: (commit: string) => string[], approved: string[]): string | null {
  if (u.ref !== `refs/heads/${MAIN}`) return null;
  if (ZERO.test(u.new)) return `deleting ${MAIN} is not allowed`;
  if (u.old === u.new) return null;
  const p = parents(u.new);
  if (p.length === 2 && p[0] === u.old && approved.includes(p[1]!)) return null;
  return `${MAIN} only moves to the merge commit of an approved goal (hq approve, then hq merge)`;
}

/** Hook entry: reads the transaction on stdin; a non-zero exit aborts it. */
export async function guard(cwd: string): Promise<number> {
  if (process.env.HQ_ALLOW_MAIN === "1") return 0;
  const updates = parseUpdates(await Bun.stdin.text());
  const approved = openApprovals(cwd).map((a) => a.commit);
  const parents = (c: string) => run(["git", "rev-list", "--parents", "-n", "1", c], cwd).out.trim().split(" ").slice(1);
  for (const u of updates) {
    const why = refusal(u, parents, approved);
    if (why) {
      console.error(`hq guard: refused ${u.ref} ${u.old.slice(0, 12)} -> ${u.new.slice(0, 12)}: ${why}.\nUpdating ${MAIN} by hand on purpose? Rerun with HQ_ALLOW_MAIN=1.`);
      return 1;
    }
  }
  return 0;
}

/** The hook runs the installed launcher (M0.4), not the source in this repository. */
export function hookScript(launcher: string): string {
  return `#!/bin/bash\n${MARK}\n[ "$1" = prepared ] || exit 0\nexec "${launcher}" guard\n`;
}

export function installHook(cwd: string, launcher: string): string {
  if (!existsSync(launcher)) throw new Error(`no launcher at ${launcher}: run \`hq install\` first`);
  const path = join(commonDir(cwd), "hooks", "reference-transaction");
  if (existsSync(path) && !readFileSync(path, "utf8").includes(MARK)) throw new Error(`${path} exists and is not hq's; merge it by hand`);
  writeFileSync(path, hookScript(launcher));
  chmodSync(path, 0o755);
  return path;
}
