import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, sh } from "../src/sh";
import type { PublicTask } from "../src/tasks";
import { DEFAULT_MODEL, EFFORT } from "../src/write";

// write.ts end to end in a subprocess. `docker`, `claude` and `sudo` are scripts on a PATH
// that holds nothing else: docker records its calls and serves a small /testbed, claude
// edits its working directory and prints a stream-json result. Nothing leaves the machine.

const root = realpathSync(mkdtempSync(join(tmpdir(), "write-"))); // pwd in the fake claude prints the resolved path
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const WRITE_TS = new URL("../src/write.ts", import.meta.url).pathname;
const ID = "acme__widget-4217";
const TASK: PublicTask = {
  instance_id: ID,
  repo: "acme/widget",
  language: "rust",
  image: "registry.invalid/widget:base",
  platform: "linux/amd64",
  base_commit: "0".repeat(40),
  created_at: "2026-08-01T00:00:00Z",
  problem_statement: "Widget panics on empty input.",
  rebuild_cmds: ["cargo build"],
  env_activate: "true",
  sanitize_git: true,
};

const FAKE_DOCKER = `#!/bin/bash
IFS=$'\\t'; echo "docker$IFS$*" >> "$FAKE_LOG"; IFS=$' \\t\\n'
case "$1" in
  create) echo fake-tmp-ctr ;;
  cp) cp -R "$FAKE_TESTBED" "$3" ;;
  image|pull|tag|rm|rmi|run) ;;
  *) exit 97 ;;
esac
`;

const FAKE_SUDO = `#!/bin/bash
IFS=$'\\t'; echo "sudo$IFS$*" >> "$FAKE_LOG"
`;

const FAKE_CLAUDE = `#!/bin/bash
mkdir -p "$FAKE_OUT"
printf '%s\\0' "$@" > "$FAKE_OUT/argv"
pwd > "$FAKE_OUT/pwd"
env > "$FAKE_OUT/env"
git log --all --format=%s > "$FAKE_OUT/git-log"
case "$FAKE_CLAUDE_MODE" in
  auth) echo '{"type":"result","subtype":"success","is_error":true,"error":"authentication_failed"}'; exit 1 ;;
  rate) echo '{"type":"assistant","message":{},"error":"rate_limit"}'; exit 1 ;;
  limit) echo "You've hit your limit"; exit 1 ;;
esac
mkdir -p tests .step0 build sub/target node_modules/pkg
echo 'fn issue() {}' > tests/issue.rs
printf '#!/bin/bash\\ncargo test\\n' > .step0/run_tests.sh
printf '\\0\\1\\2' > tests/fixture.bin
printf '\\0\\377' > lib/prebuilt.bin
echo obj > build/out.o
echo obj > sub/target/out.o
echo js > node_modules/pkg/index.js
echo '{"type":"system","subtype":"init"}'
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"total_cost_usd":0.25,"usage":{"input_tokens":10,"output_tokens":20},"modelUsage":{"claude-test":{"costUSD":0.25}},"result":"done","session_id":"s1"}'
`;

let testbed: string;
beforeAll(() => {
  testbed = join(root, "image-testbed");
  mkdirSync(join(testbed, "lib"), { recursive: true });
  mkdirSync(join(testbed, "src"));
  writeFileSync(join(testbed, "src/lib.rs"), "pub fn widget() {}\n");
  writeFileSync(join(testbed, "lib/prebuilt.bin"), Buffer.from([0, 9, 9]));
  const git = (...a: string[]) => sh(["git", "-c", "user.name=t", "-c", "user.email=t@invalid", ...a], { cwd: testbed });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "upstream base");
  writeFileSync(join(testbed, "src/lib.rs"), "pub fn widget() { /* the upstream fix */ }\n");
  git("commit", "-q", "-am", "upstream fix");
});

// One output dir and one set of fakes; `go` runs write.ts again against the same results.
function rig(task: Partial<PublicTask> = {}) {
  const dir = join(root, `r${n++}`);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [["docker", FAKE_DOCKER], ["sudo", FAKE_SUDO], ["claude", FAKE_CLAUDE]] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const tasksFile = join(dir, "tasks.json");
  writeFileSync(tasksFile, JSON.stringify([{ ...TASK, ...task }]));
  const results = join(dir, "results");
  const calls = join(dir, "calls.log");
  const captured = join(dir, "captured");
  const wsRoot = join(dir, "ws");
  const runDir = join(results, ID);
  const read = (p: string) => readFileSync(p, "utf8");
  return {
    wsRoot,
    runDir,
    go(mode = "ok", extra: string[] = []) {
      rmSync(calls, { force: true });
      rmSync(captured, { recursive: true, force: true });
      const env = {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        TMPDIR: dir,
        HQ_WS_ROOT: wsRoot,
        FAKE_LOG: calls,
        FAKE_OUT: captured,
        FAKE_TESTBED: testbed,
        FAKE_CLAUDE_MODE: mode,
        // what a workflow runner would have in its environment
        STEP0_RUNNER: "ci-1",
        STEP0_TASKS: "tasks/public.json",
        GH_TOKEN: "gh-secret",
        GITHUB_TOKEN: "gh-secret",
        GH_ENTERPRISE_TOKEN: "gh-secret",
        UPSTREAM_REF: `https://github.com/acme/widget/pull/${ID}`,
        HTTPS_PROXY: "http://corp.example:3128",
        KEEP_ME: "yes",
      };
      const r = run([process.execPath, WRITE_TS, "--tasks", tasksFile, "--id", ID, "--out", results, ...extra], { env, timeoutMs: 60_000 });
      return { ...r, ...this };
    },
    docker: () => read(calls).split("\n").filter((l) => l.startsWith("docker\t")).map((l) => l.split("\t").slice(1)),
    sudo: () => read(calls).split("\n").filter((l) => l.startsWith("sudo\t")),
    argv: () => read(join(captured, "argv")).split("\0").slice(0, -1),
    pwd: () => read(join(captured, "pwd")).trim(),
    gitLog: () => read(join(captured, "git-log")).split("\n").filter(Boolean),
    env: () => Object.fromEntries(read(join(captured, "env")).split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])),
    patch: () => read(join(runDir, "writer.patch")),
    writeJson: () => JSON.parse(read(join(runDir, "write.json"))),
  };
}

describe("writer flow", () => {
  test("the workspace has an opaque name, no instance id anywhere the agent can look", () => {
    const r = rig();
    const out = r.go();
    expect(out.code).toBe(0);
    expect(r.pwd()).toMatch(new RegExp(`^${r.wsRoot}/[0-9a-f]{12}/testbed$`));
    expect(r.pwd()).not.toContain(ID);
    const token = r.pwd().split("/").at(-2)!;
    const docker = r.docker();
    expect(docker).toContainEqual(["tag", TASK.image, `ws-image:${token}`]);
    const started = docker.find((c) => c[0] === "run")!;
    expect(started).toContain(`ws-${token}`);
    expect(started).toContain(`ws-image:${token}`);
    expect(started).toContain(`${r.pwd()}:/testbed`);
    // the argv the agent gets, its prompt included, and every docker call carry no id
    expect(r.argv().join("\n")).not.toContain(ID);
    expect(docker.flat().join("\n")).not.toContain(ID);
    expect(out.out).toContain(ID); // only the job's own log names the task
  });

  test("the workspace and its container are removed afterwards", () => {
    const r = rig();
    r.go();
    const token = r.pwd().split("/").at(-2)!;
    expect(existsSync(join(r.wsRoot, token))).toBe(false);
    const docker = r.docker();
    expect(docker).toContainEqual(["rm", "-f", `ws-${token}`]);
    expect(docker).toContainEqual(["rmi", `ws-image:${token}`]);
  });

  test("sanitize_git squashes the history to one commit; otherwise it stays", () => {
    const squashed = rig();
    squashed.go();
    expect(squashed.gitLog()).toEqual(["base"]);
    const kept = rig({ sanitize_git: false });
    kept.go();
    expect(kept.gitLog()).toEqual(["upstream fix", "upstream base"]);
  });

  test("the work container has no network", () => {
    const r = rig();
    r.go();
    const started = r.docker().find((c) => c[0] === "run")!;
    const i = started.indexOf("--network");
    expect(started[i + 1]).toBe("none");
    expect(started).toContain("-d");
    expect(started.slice(started.indexOf("--platform"), started.indexOf("--platform") + 2)).toEqual(["--platform", TASK.platform]);
  });

  test("the agent sees no STEP0_*, no GitHub token, and the proxy variables", () => {
    const r = rig();
    r.go();
    const env = r.env();
    expect(env.KEEP_ME).toBe("yes"); // the rest of the environment passes through
    expect(Object.keys(env).filter((k) => k.startsWith("STEP0_"))).toEqual([]);
    for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "UPSTREAM_REF"]) expect(env[k]).toBeUndefined();
    expect(Object.values(env).join("\n")).not.toContain("gh-secret");
    expect(Object.values(env).join("\n")).not.toContain(ID);
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) expect(env[k]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GH_CONFIG_DIR).not.toBe(undefined);
  });

  test("the writer patch has the writer's files and no build outputs", () => {
    const r = rig();
    r.go();
    const patch = r.patch();
    for (const f of ["tests/issue.rs", ".step0/run_tests.sh", "tests/fixture.bin"]) expect(patch).toContain(`diff --git a/${f} b/${f}`);
    for (const f of ["build/out.o", "sub/target/out.o", "node_modules/pkg/index.js", "lib/prebuilt.bin"]) expect(patch).not.toContain(f);
    const rec = r.writeJson();
    expect(rec.patch_files).toEqual([".step0/run_tests.sh", "tests/fixture.bin", "tests/issue.rs"]);
    expect(rec.dropped_build_outputs.sort()).toEqual(["build/out.o", "lib/prebuilt.bin", "node_modules/pkg/index.js", "sub/target/out.o"]);
    expect(rec.has_script).toBe(true);
  });

  test("write.json has the model, prompt version and claude result", () => {
    const r = rig();
    r.go("ok", ["--model", "claude-test-model", "--prompt", "v2"]);
    expect(r.writeJson()).toMatchObject({
      instance_id: ID,
      model: "claude-test-model",
      prompt: "v2",
      effort: EFFORT,
      exit_code: 0,
      timed_out: false,
      claude: {
        subtype: "success",
        is_error: false,
        num_turns: 3,
        total_cost_usd: 0.25,
        usage: { input_tokens: 10, output_tokens: 20 },
        modelUsage: { "claude-test": { costUSD: 0.25 } },
      },
    });
    const argv = r.argv();
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-test-model");
    expect(argv.at(-1)).toContain("Assert only the behavior the issue describes");
    expect(argv.at(-1)).toContain(TASK.problem_statement);
  });

  test("without flags the default model and prompt v1 are used", () => {
    const r = rig();
    r.go();
    expect(r.writeJson()).toMatchObject({ model: DEFAULT_MODEL, prompt: "v1" });
    const argv = r.argv();
    expect(argv[argv.indexOf("--model") + 1]).toBe(DEFAULT_MODEL);
    expect(argv.at(-1)).not.toContain("Assert only the behavior the issue describes");
  });

  test("a task already written is not run again", () => {
    const r = rig();
    r.go();
    const again = r.go();
    expect(again.out).toContain("already written");
    expect(existsSync(join(r.wsRoot))).toBe(true);
    expect(() => r.pwd()).toThrow(); // claude was not started the second time
  });
});

describe("refusals leave no write.json", () => {
  const cases: [string, string][] = [
    ["an authentication failure", "auth"],
    ["a rate limit", "rate"],
    ["the plan's usage limit message", "limit"],
  ];
  for (const [name, mode] of cases) {
    test(name, () => {
      const r = rig();
      const out = r.go(mode);
      expect(out.code).not.toBe(0);
      expect(existsSync(join(r.runDir, "write.json"))).toBe(false);
      expect(existsSync(join(r.runDir, "writer.patch"))).toBe(false);
      expect(existsSync(join(r.runDir, "agent.jsonl"))).toBe(true);
      // the workspace and container are cleaned up even so
      const token = r.pwd().split("/").at(-2)!;
      expect(existsSync(join(r.wsRoot, token))).toBe(false);
      expect(r.docker()).toContainEqual(["rm", "-f", `ws-${token}`]);
      // so the task can be run again
      const again = r.go("ok");
      expect(again.code).toBe(0);
      expect(existsSync(join(r.runDir, "write.json"))).toBe(true);
    });
  }

  test("the error is named", () => {
    expect(rig().go("auth").out).toContain("claude could not authenticate");
    expect(rig().go("rate").out).toContain("usage limit");
  });
});
