// The Claude Code settings of an executor session (`hq work`): the sandbox from M0.0
// (tech_stacks.md 沙箱与安全) plus the merge-lock denials. File tools run outside the sandbox,
// so credential files are denied to the Read tool separately. ~/.hq is not denied for reads:
// Claude Code folds Read denials into the sandbox, and the guard hook every commit runs lives there.

import { join } from "node:path";

const CREDENTIALS = [".ssh", ".aws", ".gnupg", ".config/gh", ".netrc"];

export function executorSettings(commonDir: string, home: string) {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        // Not all of .git: commits write objects and the goal branch's ref.
        denyWrite: ["refs/heads/main", "packed-refs", "hooks", "config"].map((p) => join(commonDir, p)),
      },
      credentials: { files: CREDENTIALS.map((p) => ({ path: join(home, p), mode: "deny" })) },
      // Tests start local servers on 127.0.0.1. On macOS this also lets commands connect to
      // anything already listening on localhost.
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: true },
    },
    // A path with // is absolute; each entry may be a file (.netrc) or a directory.
    permissions: { deny: CREDENTIALS.flatMap((p) => [`Read(/${join(home, p)})`, `Read(/${join(home, p)}/**)`]) },
  };
}
