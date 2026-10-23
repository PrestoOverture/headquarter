import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { EXPECTED, verdicts } from "./check";
import { classify, codexCommand, codexSrtSettings, DENIALS, prepareCodexHome, probeLines } from "./codex-check";

const event = (item: object, type = "item.completed") => JSON.stringify({ type, item });

test("probe lines come from command results, not from the model's text", () => {
  const out = [
    event({ type: "agent_message", text: "PASS tests" }),
    event({ type: "command_execution", command: "bash scripts/sandbox/probe.sh", aggregated_output: "PASS commit\nnoise\nFAIL tests: 1 fail\nDONE\n", exit_code: 0 }),
    event({ type: "command_execution", aggregated_output: "PASS skipped" }, "item.started"),
    event({ type: "command_execution", aggregated_output: "PASS hooks_write" }),
    "not json",
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
  const lines = probeLines(out);
  expect(lines).toEqual(["PASS commit", "FAIL tests: 1 fail", "DONE", "PASS hooks_write"]);
  expect(verdicts(lines).get("tests")).toBe("FAIL: 1 fail");
});

test("settings are hq's executor rules plus a throwaway Codex home and the model API", () => {
  const s = codexSrtSettings({ worktree: "/wt", commonDir: "/repo/.git", codexHome: "/tmp/hq-codex-home-x" });
  expect(s.filesystem.allowWrite).toEqual(expect.arrayContaining(["/wt", "/repo/.git", "/tmp/hq-codex-home-x"]));
  expect(s.filesystem.denyWrite).toEqual(expect.arrayContaining(["/repo/.git/refs/heads/main", "/repo/.git/packed-refs", "/repo/.git/hooks", "/repo/.git/config"]));
  expect(s.filesystem.denyRead.some((p) => p.endsWith("/.ssh"))).toBe(true);
  expect(s.network.allowedDomains).toEqual(["api.openai.com", "chatgpt.com", "auth.openai.com"]);
});

test("~/.codex (and a CODEX_HOME it was copied from) is write-denied and never writable", () => {
  const real = join(homedir(), ".codex");
  const s = codexSrtSettings({ worktree: "/wt", commonDir: "/repo/.git", codexHome: "/tmp/hq-codex-home-x", sourceHome: "/elsewhere/codex" });
  expect(s.filesystem.allowWrite).not.toContain(real);
  expect(s.filesystem.allowWrite).not.toContain("/elsewhere/codex");
  expect(s.filesystem.denyWrite).toEqual(expect.arrayContaining([real, "/elsewhere/codex"]));
});

test("the temporary Codex home holds only the copied login and config, and removal leaves the source alone", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-home-test-"));
  try {
    const src = join(root, "src");
    mkdirSync(join(src, "sessions"), { recursive: true });
    writeFileSync(join(src, "auth.json"), '{"token":"t"}');
    writeFileSync(join(src, "config.toml"), 'approval_policy = "never"');
    writeFileSync(join(src, "history.jsonl"), "secret");
    const home = prepareCodexHome(src, root);
    expect(readdirSync(home).sort()).toEqual(["auth.json", "config.toml"]);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe('{"token":"t"}');
    writeFileSync(join(home, "auth.json"), '{"token":"refreshed"}');
    rmSync(home, { recursive: true, force: true });
    expect(existsSync(home)).toBe(false);
    expect(readFileSync(join(src, "auth.json"), "utf8")).toBe('{"token":"t"}');

    rmSync(join(src, "config.toml"));
    const bare = prepareCodexHome(src, root);
    expect(readdirSync(bare)).toEqual(["auth.json"]);
    rmSync(join(src, "auth.json"));
    expect(() => prepareCodexHome(src, root)).toThrow("codex login");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex runs non-interactively in the worktree with its own sandbox off", () => {
  const cmd = codexCommand("/wt", "it's the probe");
  expect(cmd).toStartWith('mkdir -p "$TMPDIR" && ');
  expect(cmd).toContain("'--dangerously-bypass-approvals-and-sandbox' '-C' '/wt' 'it'\\''s the probe'");
  expect(cmd).toContain("'codex' 'exec' '--json'");
});

test("a missing result counts as a failed check, and denials are separate from allowed checks", () => {
  const v = verdicts(["PASS tests", "FAIL commit: boom", "PASS hooks_write", "FAIL net_proxy: allowed, expected denied"]);
  const c = classify(v);
  expect(c.passed).toEqual(["tests", "hooks_write"]);
  expect(c.failed).toContain("commit");
  expect(c.failed).toContain("spawn_kill");
  expect(c.failed).not.toContain("net_proxy");
  expect(c.notDenied).toContain("net_proxy");
  expect(c.notDenied).toContain("config_write");
  expect(c.notDenied).not.toContain("hooks_write");
});

test("DENIALS match the probe's denied checks", async () => {
  const probe = await Bun.file(new URL("./probe.sh", import.meta.url)).text();
  const denied = [...probe.matchAll(/^(?:if .*; then )?denied (\w+) /gm)].map((m) => m[1]);
  expect([...DENIALS].sort()).toEqual(denied.sort());
  for (const n of DENIALS) expect(EXPECTED).toContain(n);
});
