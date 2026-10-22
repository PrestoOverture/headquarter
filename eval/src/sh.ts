export type Result = { code: number; out: string; timedOut: boolean };

/** Runs a command to completion; stdout and stderr are merged into `out` in arrival order. */
export function run(
  cmd: string[],
  opts: { cwd?: string; input?: string; timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Result {
  const p = Bun.spawnSync(["bash", "-c", '"$@" 2>&1', "_", ...cmd], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.input === undefined ? "ignore" : Buffer.from(opts.input),
    timeout: opts.timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  const timedOut = Boolean(p.exitedDueToTimeout);
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), timedOut };
}

/** Like run, but throws on a non-zero exit; returns stdout. */
export function sh(cmd: string[], opts: Parameters<typeof run>[1] = {}): string {
  const r = run(cmd, opts);
  if (r.code !== 0) throw new Error(`${cmd.join(" ")} exited ${r.code}${r.timedOut ? " (timeout)" : ""}\n${r.out}`);
  return r.out;
}

/** The last `n` characters, for reports that link to the full log. */
export function tail(s: string, n = 4000): string {
  return s.length <= n ? s : "…" + s.slice(-n);
}
