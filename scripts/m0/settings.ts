// The answerer's Claude Code settings: the executor sandbox from M0.0 plus, for M1, paths it
// may not read (the exam) or write (test configuration, D30). Shared by answer.ts and the M1
// sandbox check, so the check tests exactly what the answerer runs under.

import { join } from "node:path";
import { sandboxSettings } from "../sandbox/check";

const CREDENTIALS = [".ssh", ".aws", ".gnupg", ".config/gh", ".netrc"];

export function answererSettings(commonDir: string, home: string, denyRead: string[] = [], denyWrite: string[] = []) {
  const base = sandboxSettings(commonDir, home);
  return {
    ...base,
    sandbox: { ...base.sandbox, filesystem: { ...base.sandbox.filesystem, denyRead, denyWrite: [...base.sandbox.filesystem.denyWrite, ...denyWrite] } },
    permissions: {
      deny: [
        // File tools are outside the sandbox: deny them separately (tech_stacks 沙箱与安全).
        ...CREDENTIALS.map((p) => `Read(//${join(home, p).slice(1)}/**)`),
        ...denyRead.map((p) => `Read(/${p}/**)`),
        ...denyWrite.flatMap((p) => [`Edit(/${p})`, `Edit(/${p}/**)`, `Write(/${p})`, `Write(/${p}/**)`]),
      ],
    },
  };
}
