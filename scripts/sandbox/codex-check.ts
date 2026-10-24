// tech_stacks.md 待核实: can Codex be given the same isolation as a Claude executor by
// wrapping it in srt (sandbox-runtime), using hq's executor rules (hq/src/sandbox.ts)?
//
//   bun scripts/sandbox/codex-check.ts
//
// Makes a linked worktree on a throwaway branch, runs `codex exec` there inside srt, has
// Codex run probe.sh once, and reads the probe's output from the command results in
// `codex exec --json` (not from the model's summary). Then confirms from outside the
// sandbox that main, the hooks and the config are unchanged, and cleans up. Says which
// probe checks pass under srt-wrapped Codex; exits non-zero if an expected denial is not
// denied. Codex runs with a throwaway CODEX_HOME (a copy of its login); ~/.codex is
// write-denied. Codex's own sandbox is turned off: it cannot nest inside srt, and srt is the
// boundary being tested.

import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { srtSettings } from "../../hq/src/sandbox";
import { EXPECTED, git, hooksSnapshot, verdicts } from "./check";

const PROBE = "bash scripts/sandbox/probe.sh";

/** Checks the probe expects to be denied; the rest of EXPECTED must work. */
export const DENIALS = [
  "hooks_write", "config_write", "main_update_ref", "main_ref_file", "packed_refs_write",
  "home_write", "codex_home_write", "ssh_read", "net_direct", "net_proxy",
];

// The only hosts Codex needs: the model API and ChatGPT login.
const CODEX_HOSTS = ["api.openai.com", "chatgpt.com", "auth.openai.com"];

/**
 * hq's executor rules, plus what Codex itself needs: a throwaway home dir and its model API.
 * The real Codex home stays write-denied, so nothing inside can rewrite its config.toml.
 */
export function codexSrtSettings(opts: { worktree: string; commonDir: string; codexHome: string; sourceHome?: string }) {
  const s = srtSettings({ writable: [opts.worktree, opts.commonDir, opts.codexHome], commonDir: opts.commonDir });
  const real = new Set([join(homedir(), ".codex"), ...(opts.sourceHome ? [opts.sourceHome] : [])]);
  return {
    ...s,
    filesystem: { ...s.filesystem, denyWrite: [...s.filesystem.denyWrite, ...real] },
    network: { ...s.network, allowedDomains: CODEX_HOSTS },
  };
}

/** A fresh CODEX_HOME holding only copies of the login (and config, if any). Never copied back. */
export function prepareCodexHome(sourceHome: string, parent = tmpdir()): string {
  const auth = join(sourceHome, "auth.json");
  if (!existsSync(auth)) throw new Error(`no Codex login at ${auth}; run \`codex login\``);
  const dir = mkdtempSync(join(parent, "hq-codex-home-"));
  copyFileSync(auth, join(dir, "auth.json"));
  if (existsSync(join(sourceHome, "config.toml"))) copyFileSync(join(sourceHome, "config.toml"), join(dir, "config.toml"));
  return dir;
}

function quote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** The shell command srt runs: Codex non-interactively in `worktree`, events as JSONL. */
export function codexCommand(worktree: string, prompt: string): string {
  const args = [
    "codex", "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "--dangerously-bypass-approvals-and-sandbox", "-C", worktree, prompt,
  ];
  // srt points $TMPDIR at a directory it does not create.
  return `mkdir -p "$TMPDIR" && ${args.map(quote).join(" ")}`;
}

/** PASS/FAIL lines from the command results in `codex exec --json` output. */
export function probeLines(execJson: string): string[] {
  const out: string[] = [];
  for (const line of execJson.split("\n")) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type !== "item.completed" || m.item?.type !== "command_execution") continue;
    const text = String(m.item.aggregated_output ?? "");
    out.push(...text.split("\n").filter((l) => /^(PASS|FAIL) /.test(l) || l === "DONE"));
  }
  return out;
}

/** Splits EXPECTED by outcome. A check with no result counts as failed. */
export function classify(v: Map<string, string>) {
  const passed = EXPECTED.filter((n) => v.get(n) === "PASS");
  const failed = EXPECTED.filter((n) => v.get(n) !== "PASS" && !DENIALS.includes(n));
  const notDenied = DENIALS.filter((n) => v.get(n) !== "PASS");
  return { passed, failed, notDenied };
}

async function main() {
  const repo = git(["rev-parse", "--show-toplevel"], process.cwd());
  const commonDir = resolve(repo, git(["rev-parse", "--git-common-dir"], repo));
  const token = randomBytes(4).toString("hex");
  const branch = `sandbox-probe/${token}`;
  const wt = join(tmpdir(), `hq-codex-sandbox-${token}`);
  const srt = join(repo, "hq/node_modules/.bin/srt");
  const before = {
    main: git(["rev-parse", "refs/heads/main"], repo),
    hooks: hooksSnapshot(commonDir),
    config: readFileSync(join(commonDir, "config"), "utf8"),
  };
  git(["worktree", "add", "-q", "-b", branch, wt, "HEAD"], repo);
  const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  let codexHome: string | undefined;
  let failed = 0;
  try {
    // Dependencies come from outside the sandbox; only the model API is reachable inside.
    if (Bun.spawnSync(["bun", "install", "--frozen-lockfile"], { cwd: join(wt, "eval") }).exitCode !== 0) throw new Error("bun install failed");
    // The probe under test may not be committed yet; run this checkout's copy.
    mkdirSync(join(wt, "scripts/sandbox"), { recursive: true });
    writeFileSync(join(wt, "scripts/sandbox/probe.sh"), readFileSync(join(repo, "scripts/sandbox/probe.sh")));
    codexHome = prepareCodexHome(sourceHome);
    const settings = join(mkdtempSync(join(tmpdir(), "hq-srt-")), "srt-settings.json");
    writeFileSync(settings, JSON.stringify(codexSrtSettings({ worktree: wt, commonDir, codexHome, sourceHome })));
    const prompt = `Run this exact command once with the shell tool and nothing else, then stop: ${PROBE}`;
    const p = Bun.spawnSync([srt, "-s", settings, "-c", codexCommand(wt, prompt)], {
      cwd: wt, env: { ...process.env, CODEX_HOME: codexHome }, timeout: 10 * 60 * 1000, stdin: "ignore",
    });
    const stream = p.stdout.toString();
    const log = join(tmpdir(), `hq-codex-sandbox-${token}.jsonl`);
    writeFileSync(log, stream);
    const v = verdicts(probeLines(stream));
    const after = {
      main: git(["rev-parse", "refs/heads/main"], repo),
      hooks: hooksSnapshot(commonDir),
      config: readFileSync(join(commonDir, "config"), "utf8"),
    };
    const outside: [string, boolean][] = [
      ["main unchanged (checked outside)", after.main === before.main],
      ["hooks unchanged (checked outside)", after.hooks === before.hooks],
      ["config unchanged (checked outside)", after.config === before.config],
      ["probe commit landed on its branch", git(["log", "-1", "--format=%s", branch], repo) === "sandbox probe"],
    ];
    const c = classify(v);
    for (const name of EXPECTED) {
      const r = v.get(name) ?? "FAIL: no result (probe did not run in the sandbox?)";
      const denial = DENIALS.includes(name);
      console.log(`${r === "PASS" ? "PASS" : "FAIL"}  ${name}${denial ? " (denied)" : ""}${r === "PASS" ? "" : "  " + r.slice(4)}`);
    }
    for (const [name, ok] of outside) {
      if (!ok) failed++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    }
    failed += c.notDenied.length;
    console.log(`\nunder srt-wrapped Codex, pass: ${c.passed.join(", ") || "none"}`);
    console.log(`do not work (expected to): ${c.failed.join(", ") || "none"}`);
    console.log(`not denied (expected denied): ${c.notDenied.join(", ") || "none"}`);
    if (v.size === 0) console.log(`codex exit ${p.exitCode}; output saved to ${log}\n${p.stderr.toString().slice(-2000)}`);
  } finally {
    Bun.spawnSync(["git", "worktree", "remove", "--force", wt], { cwd: repo });
    Bun.spawnSync(["git", "branch", "-D", branch], { cwd: repo });
    if (codexHome) rmSync(codexHome, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall denials held");
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
