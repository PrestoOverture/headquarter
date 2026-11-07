import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Five known files followed by three files from an unrecognized log format. */
export function sourceHealthFixture(dir: string) {
  const dirs = { claude: join(dir, "claude"), codex: join(dir, "codex"), opencode: join(dir, "missing") };
  for (const vendor of ["claude", "codex"] as const) {
    const root = vendor === "claude" ? join(dirs[vendor], "project") : dirs[vendor];
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < 8; i++) {
      const known = i < 5;
      const row = !known ? { type: "renamed_record", timestamp: "2026-02-01T00:00:00Z" }
        : vendor === "claude" ? { type: "assistant", sessionId: String(i), cwd: dir, timestamp: "2026-01-01T00:00:00Z",
          message: { model: "known", usage: { output_tokens: 1 } } }
        : { type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { id: String(i), cwd: dir } };
      const file = join(root, `${i}.jsonl`);
      writeFileSync(file, JSON.stringify(row));
      const mtime = new Date(known ? "2026-01-15T00:00:00Z" : "2026-03-01T00:30:00+01:00");
      utimesSync(file, mtime, mtime);
    }
  }
  return { dirs, cacheDir: join(dir, "cache") };
}
