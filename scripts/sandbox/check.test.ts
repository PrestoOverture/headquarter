import { expect, test } from "bun:test";
import { EXPECTED, probeLines, sandboxSettings, verdicts } from "./check";

test("probe lines come from Bash tool results, not from the model's text", () => {
  const stream = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "PASS tests" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "PASS commit\nnoise\nFAIL tests: 1 fail\nDONE" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "PASS hooks_write" }] }] } }),
    "not json",
  ].join("\n");
  const lines = probeLines(stream);
  expect(lines).toEqual(["PASS commit", "FAIL tests: 1 fail", "DONE", "PASS hooks_write"]);
  const v = verdicts(lines);
  expect(v.get("commit")).toBe("PASS");
  expect(v.get("tests")).toBe("FAIL: 1 fail");
});

test("settings are strict and lock main without making .git read-only", () => {
  const s = sandboxSettings("/repo/.git", "/home/me").sandbox;
  expect(s.failIfUnavailable).toBe(true);
  expect(s.allowUnsandboxedCommands).toBe(false);
  expect(s.filesystem.denyWrite).toEqual(["/repo/.git/refs/heads/main", "/repo/.git/packed-refs"]);
  expect(s.credentials.files.map((f) => f.path)).toContain("/home/me/.ssh");
});

test("probe.sh reports every expected check", async () => {
  const probe = await Bun.file(new URL("./probe.sh", import.meta.url)).text();
  for (const name of EXPECTED) expect(probe).toMatch(new RegExp(`(allowed|denied) ${name} |${name} \\(no`));
});
