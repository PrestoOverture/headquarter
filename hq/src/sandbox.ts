// Sandbox rules for everything an executor writes or runs (tech_stacks.md 沙箱与安全, D35):
// writes only to its worktree and temp dirs; main's ref, packed-refs, git hooks/config
// and the approvals store are write-denied; credential files unreadable; no network,
// local ports allowed (M0.0: this repo's tests listen on 127.0.0.1).

import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { hqHome } from "./approval";
import { run, type Run } from "./git";

const CREDENTIALS = [".ssh", ".aws", ".gnupg", ".config/gh", ".netrc"];

export function srtSettings(opts: { writable: string[]; commonDir: string }) {
  const home = homedir();
  return {
    filesystem: {
      denyRead: CREDENTIALS.map((p) => join(home, p)),
      allowWrite: [...opts.writable, tmpdir()],
      denyWrite: [
        join(opts.commonDir, "refs/heads/main"),
        join(opts.commonDir, "packed-refs"),
        join(opts.commonDir, "hooks"),
        join(opts.commonDir, "config"),
        hqHome(),
      ],
    },
    network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: true },
  };
}

const SRT = join(import.meta.dir, "../node_modules/.bin/srt");

/** Runs `cmd` with bash inside srt, cwd `cwd`. */
export function sandboxed(cmd: string, cwd: string, opts: { writable: string[]; commonDir: string }): Run {
  const dir = mkdtempSync(join(tmpdir(), "hq-srt-"));
  const settings = join(dir, "srt-settings.json");
  writeFileSync(settings, JSON.stringify(srtSettings(opts)));
  // srt points $TMPDIR at a directory it does not create; tests that mkdtemp need it.
  return run([SRT, "-s", settings, "-c", `mkdir -p "$TMPDIR" && ${cmd}`], cwd);
}
