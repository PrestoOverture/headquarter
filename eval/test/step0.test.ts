import { describe, expect, test } from "bun:test";
import net from "node:net";
import { patchFiles, SCRIPT, verdict } from "../src/judge";
import { BLOCKED, BlockProxy, target } from "../src/proxy";
import { run } from "../src/sh";
import { summarize } from "../src/summarize";
import { keptTasks, PUBLIC_FIELDS, stripGold } from "../src/tasks";
import { binaryPaths, buildOutputExcludes, claudeResult, promptFor } from "../src/write";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const diff = (...files: string[]) => files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n`).join("");
const GOLD = diff("src/lib.rs");
const WRITER = diff("tests/issue.rs", SCRIPT);
const side = (...runs: number[]) => ({ applied: true, runs });

describe("verdict", () => {
  test("caught: fails on buggy, passes on fixed", () => {
    expect(verdict(WRITER, GOLD, side(1, 1), side(0, 0))).toBe("caught");
  });
  test("a timeout on the buggy side still counts as failing", () => {
    expect(verdict(WRITER, GOLD, side(-1, -1), side(0, 0))).toBe("caught");
  });
  test("too weak", () => {
    expect(verdict(WRITER, GOLD, side(0, 0), side(0, 0))).toBe("passes_on_buggy");
  });
  test("wrong test", () => {
    expect(verdict(WRITER, GOLD, side(1, 1), side(1, 1))).toBe("fails_on_fixed");
  });
  test("reruns disagree on either side", () => {
    expect(verdict(WRITER, GOLD, side(1, 0), side(0, 0))).toBe("flaky");
    expect(verdict(WRITER, GOLD, side(1, 1), side(0, 2))).toBe("flaky");
  });
  test("submission problems come before running", () => {
    expect(verdict("", GOLD, null, null)).toBe("no_submission");
    expect(verdict(diff("tests/issue.rs"), GOLD, null, null)).toBe("no_script");
    expect(verdict(diff("src/lib.rs", SCRIPT), GOLD, null, null)).toBe("touches_fix");
    expect(verdict(WRITER, GOLD, null, null)).toBe("patch_failed");
    expect(verdict(WRITER, GOLD, { applied: false, runs: [] }, side(0, 0))).toBe("patch_failed");
  });
  test("patchFiles reads the b/ side", () => {
    expect(patchFiles(diff("a/x.c", SCRIPT))).toEqual(["a/x.c", SCRIPT]);
  });
});

describe("proxy", () => {
  test("blocks routes to the fix, passes the model APIs", () => {
    for (const h of ["github.com", "api.github.com", "raw.githubusercontent.com", "www.google.co.uk", "stackoverflow.com"])
      expect(BLOCKED.test(h)).toBe(true);
    for (const h of ["api.anthropic.com", "notgithub.com.example.org", "registry.npmjs.org"]) expect(BLOCKED.test(h)).toBe(false);
  });
  test("parses CONNECT and absolute-URI request lines", () => {
    expect(target("CONNECT api.github.com:443 HTTP/1.1")).toEqual({ method: "CONNECT", host: "api.github.com", port: 443 });
    expect(target("GET http://example.com:8080/x HTTP/1.1")).toEqual({ method: "GET", host: "example.com", port: 8080 });
    expect(target("GET /relative HTTP/1.1")).toBeNull();
  });
  test("refuses a blocked CONNECT with 403 and logs it", async () => {
    const proxy = await new BlockProxy().start();
    const logs: string[] = [];
    (proxy as unknown as { log: (m: string) => void }).log = (m) => logs.push(m);
    const port = Number(proxy.url.split(":").at(-1));
    const reply = await new Promise<string>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write("CONNECT github.com:443 HTTP/1.1\r\nHost: github.com\r\n\r\n"));
      let buf = "";
      s.on("data", (d) => (buf += d));
      s.on("close", () => resolve(buf));
    });
    proxy.close();
    expect(reply.startsWith("HTTP/1.1 403")).toBe(true);
    expect(logs[0]).toContain("BLOCKED CONNECT github.com");
  });
});

describe("tasks", () => {
  const tasks = keptTasks(new URL("../tasks/tasks.json.gz", import.meta.url).pathname);
  test("every task is post-cutoff", () => {
    expect(tasks.length).toBe(61);
    expect(tasks.every((t) => t.created_at >= "2026-07-01")).toBe(true);
  });
  test("the public task has no gold data", () => {
    const pub = stripGold(tasks[0]!);
    expect(Object.keys(pub).sort()).toEqual([...PUBLIC_FIELDS].sort());
    expect(JSON.stringify(pub)).not.toContain(tasks[0]!.patch.slice(0, 200));
  });
  test("the prompt fills every placeholder", () => {
    const p = promptFor(stripGold(tasks[0]!), "/tmp/ws/x/testbed", "/tmp/ws/x/bin/envrun");
    expect(p).not.toMatch(/\{(repo|workdir|envrun|rebuild_cmds|problem_statement)\}/);
    expect(p).toContain(tasks[0]!.rebuild_cmds[0]!);
  });
});

test("claudeResult takes the last result line", () => {
  const log = ['{"type":"system"}', "not json", '{"type":"result","num_turns":7,"total_cost_usd":1.5,"extra":1}'].join("\n");
  expect(claudeResult(log)).toMatchObject({ num_turns: 7, total_cost_usd: 1.5 });
  expect(claudeResult("")).toBeNull();
});

test("summarize: invalid submissions count as misses", () => {
  const s = summarize(
    [
      { instance_id: "a", language: "c", verdict: "caught" },
      { instance_id: "b", language: "c", verdict: "no_script" },
      { instance_id: "c", language: "c", verdict: "passes_on_buggy" },
      { instance_id: "d", language: "c", verdict: "caught" },
    ],
    ["e"],
  );
  expect(s.catch_rate).toBe(0.5);
  expect(s.passes_stop_line).toBe(true);
  expect(s.missing).toEqual(["e"]);
});

test("run merges output and reports timeouts", () => {
  expect(run(["bash", "-c", "echo a; echo b >&2; exit 3"])).toEqual({ code: 3, out: "a\nb\n", timedOut: false });
  expect(run(["sleep", "5"], { timeoutMs: 200 }).timedOut).toBe(true);
});

test("build outputs stay out of the writer patch, new tests and fixtures stay in", () => {
  const ws = mkdtempSync(join(tmpdir(), "step0-"));
  const git = (...a: string[]) => run(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: ws });
  const put = (f: string, data: string | Uint8Array) => {
    mkdirSync(join(ws, f, ".."), { recursive: true });
    writeFileSync(join(ws, f), data);
  };
  put("src/lib.c", "int f;\n");
  put("build/test/t.o", new Uint8Array([0, 1, 2]));
  put("tree/test/old.o", new Uint8Array([0, 1, 2]));
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  put("build/test/t.o", new Uint8Array([0, 9, 9])); // rebuilt under a build dir
  put("build/.ninja_log", "log\n");
  put("tree/test/old.o", new Uint8Array([0, 7, 7])); // rebuilt binary outside a build dir
  put("tree/test/new_test.cxx", "TEST() {}\n");
  put("tree/test/fixture.bin", new Uint8Array([0, 5])); // new binary fixture
  put(SCRIPT, "#!/bin/bash\n");
  git("add", "-A");
  const modified = binaryPaths(git("diff", "--cached", "--numstat", "--diff-filter=M", "HEAD").out);
  expect(modified.sort()).toEqual(["build/test/t.o", "tree/test/old.o"]);
  const patch = git("diff", "--cached", "--binary", "HEAD", "--", ".", ...buildOutputExcludes(modified)).out;
  expect(patchFiles(patch).sort()).toEqual([SCRIPT, "tree/test/fixture.bin", "tree/test/new_test.cxx"]);
});

test("a rebuild timeout is a grade error, not a miss", () => {
  expect(verdict(WRITER, GOLD, side(1, 1), { applied: true, runs: [127, 127], rebuild_timed_out: true })).toBe("grade_error");
  const s = summarize(
    [
      { instance_id: "a", language: "c", verdict: "caught" },
      { instance_id: "b", language: "c", verdict: "grade_error" },
    ],
    [],
  );
  expect(s.graded).toBe(1);
  expect(s.catch_rate).toBe(1);
});
