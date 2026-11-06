import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodex } from "../src/codex";
import { run } from "../src/git";

test("subprocess output larger than Node's default buffer is preserved", () => {
  const result = run([process.execPath, "-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"], tmpdir());
  expect(result.code).toBe(0);
  expect(result.out.length).toBe(2 * 1024 * 1024);
  const env = run([process.execPath, "-e", "console.log(process.env.GIT_OPTIONAL_LOCKS); process.stdin.resume();"], tmpdir());
  expect(env).toEqual({ code: 0, out: "0\n" });
});

test("compressed Codex logs larger than Node's default buffer keep all records", () => {
  const dir = mkdtempSync(join(tmpdir(), "crewmeter-zstd-"));
  try {
    const plain = join(dir, "plain"), compressed = join(dir, "compressed");
    mkdirSync(plain);
    mkdirSync(compressed);
    const file = join(plain, "rollout.jsonl");
    const fixture = readFileSync(new URL("./fixtures/codex/2026/01/01/rollout.jsonl", import.meta.url), "utf8");
    writeFileSync(file, fixture.split("\n")[0] + "\n" + "\n".repeat(2 * 1024 * 1024) + fixture.split("\n").slice(1).join("\n"));
    const zstd = spawnSync("zstd", ["-q", "-c", file]);
    expect(zstd.status).toBe(0);
    writeFileSync(join(compressed, "rollout.jsonl.zst"), zstd.stdout);
    const expected = readCodex(plain);
    const actual = readCodex(compressed);
    expect(actual).toHaveLength(1);
    expect(actual.map(s => ({ ...s, file: "" }))).toEqual(expected.map(s => ({ ...s, file: "" })));
    expect(actual[0]!.tokens.output).toBe(20);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
