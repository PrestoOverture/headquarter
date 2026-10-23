// `hq env`: the real CLI against a real git repository, a temporary $HQ_HOME and a temporary $TMPDIR.

import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envPath, LOCK_STALE_MS } from "../src/env";
import { git, run } from "../src/git";

const CLI = join(import.meta.dir, "../src/cli.ts");
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

let root: string, repo: string, temp: string;

const hq = (...args: string[]) => run([process.execPath, CLI, ...args], repo, { TMPDIR: temp });

/** The three exported values of one `hq env` run. */
function env(task: string): { base: number; tmp: string; db: string } {
  const r = hq("env", task);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  const v = Object.fromEntries([...r.out.matchAll(/^export (\w+)='?([^'\n]*)'?$/gm)].map((m) => [m[1], m[2]]));
  return { base: Number(v.HQ_PORT_BASE), tmp: v.HQ_TMPDIR!, db: v.HQ_DB_NAME! };
}

const listen = (port: number) =>
  new Promise<Server>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hq-env-")));
  process.env.HQ_HOME = join(root, "home");
  temp = join(root, "tmp");
  repo = join(root, "repo");
  mkdirSync(temp);
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
});

test("allocates a port block, a temp dir and a database name, printed as export lines", () => {
  const r = hq("env", "t-1");
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/^export HQ_PORT_BASE=\d+\nexport HQ_TMPDIR='.+'\nexport HQ_DB_NAME='hq_t_1'\n$/);
  const e = env("t-1");
  expect(e.base).toBeGreaterThanOrEqual(20000);
  expect(e.base + 9).toBeLessThanOrEqual(29999);
  expect(e.tmp).toBe(join(temp, "hq-env", "t-1"));
  expect(existsSync(e.tmp)).toBe(true);
  expect(e.db).toBe("hq_t_1");
  expect(JSON.parse(readFileSync(envPath(repo), "utf8"))["t-1"].port_base).toBe(e.base);
});

test("the same task gets the same allocation again; another task gets a disjoint block", () => {
  const a = env("a");
  expect(env("a")).toEqual(a);
  const b = env("b");
  expect(Math.abs(b.base - a.base)).toBeGreaterThanOrEqual(10);
  expect(b.tmp).not.toBe(a.tmp);
});

test("release frees the ports, the database name and the temp dir for the next task", () => {
  const a = env("a");
  writeFileSync(join(a.tmp, "scratch"), "x");
  const r = hq("env", "a", "--release");
  expect(r.code).toBe(0);
  expect(existsSync(a.tmp)).toBe(false);
  expect(JSON.parse(readFileSync(envPath(repo), "utf8"))).toEqual({});
  expect(env("b").base).toBe(a.base);
  expect(hq("env", "a", "--release").code).toBe(0); // nothing left to release is not an error
});

test("rejects task names that are not safe in a path and a database name", () => {
  for (const bad of ["../x", "A", "a_b", "a b", "x".repeat(61)]) {
    const r = hq("env", bad);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/bad task name/);
  }
});

test("20 concurrent runs get 20 disjoint blocks", async () => {
  const procs = Array.from({ length: 20 }, (_, i) =>
    Bun.spawn([process.execPath, CLI, "env", `c${i}`], { cwd: repo, env: { ...process.env, TMPDIR: temp }, stdout: "pipe", stderr: "pipe" }));
  const bases: number[] = [];
  for (const p of procs) {
    expect(await p.exited).toBe(0);
    bases.push(Number((await new Response(p.stdout).text()).match(/HQ_PORT_BASE=(\d+)/)![1]));
  }
  bases.sort((a, b) => a - b);
  for (let i = 1; i < bases.length; i++) expect(bases[i]! - bases[i - 1]!).toBeGreaterThanOrEqual(10);
  expect(Object.keys(JSON.parse(readFileSync(envPath(repo), "utf8"))).length).toBe(20);
});

test("a stale lock is broken; a fresh one is waited for", async () => {
  const lock = `${envPath(repo)}.lock`;
  mkdirSync(join(lock, ".."), { recursive: true });
  writeFileSync(lock, "dead");
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
  utimesSync(lock, old, old);
  expect(env("a").base).toBeGreaterThanOrEqual(20000);
  expect(existsSync(lock)).toBe(false);

  writeFileSync(lock, "alive");
  const p = Bun.spawn([process.execPath, CLI, "env", "b"], { cwd: repo, env: { ...process.env, TMPDIR: temp }, stdout: "pipe", stderr: "pipe" });
  await Bun.sleep(500);
  expect(await Promise.race([p.exited, Bun.sleep(1)])).toBeUndefined(); // still waiting
  expect(existsSync(lock)).toBe(true);
  unlinkSync(lock);
  expect(await p.exited).toBe(0);
});

test("a block with a busy port is skipped", async () => {
  const probe = env("probe");
  expect(hq("env", "probe", "--release").code).toBe(0);
  const busy = await listen(probe.base + 3);
  try {
    const e = env("t");
    expect(e.base).toBeGreaterThan(probe.base);
    expect(e.base).not.toBe(probe.base);
  } finally {
    busy.close();
  }
  expect(env("u").base).toBe(probe.base); // free again, so the lowest block is back
});
