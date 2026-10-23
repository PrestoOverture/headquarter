import { expect, test } from "bun:test";
import { EXPECTED, verdicts } from "./check";
import { classify, codexCommand, codexSrtSettings, DENIALS, probeLines } from "./codex-check";

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

test("settings are hq's executor rules plus Codex's home and model API", () => {
  const s = codexSrtSettings({ worktree: "/wt", commonDir: "/repo/.git", codexHome: "/home/me/.codex" });
  expect(s.filesystem.allowWrite).toEqual(expect.arrayContaining(["/wt", "/repo/.git", "/home/me/.codex"]));
  expect(s.filesystem.denyWrite).toEqual(expect.arrayContaining(["/repo/.git/refs/heads/main", "/repo/.git/packed-refs", "/repo/.git/hooks", "/repo/.git/config"]));
  expect(s.filesystem.denyRead.some((p) => p.endsWith("/.ssh"))).toBe(true);
  expect(s.network.allowedDomains).toEqual(["api.openai.com", "chatgpt.com", "auth.openai.com"]);
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
