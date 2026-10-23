// `hq env`: the real CLI against a real git repository, a temporary $HQ_HOME and a temporary $TMPDIR.

import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoId } from "../src/approval";
import { envPath, lock, LOCK_STALE_MS, lockPath } from "../src/env";
import { git, run } from "../src/git";

const CLI = join(import.meta.dir, "../src/cli.ts");
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

let root: string, repo: string, temp: string;

const hqIn = (dir: string, ...args: string[]) => run([process.execPath, CLI, ...args], dir, { TMPDIR: temp });
const hq = (...args: string[]) => hqIn(repo, ...args);

/** A second git repository sharing $HQ_HOME and $TMPDIR with the first. */
function otherRepo(): string {
  const dir = join(root, "repo2");
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  return dir;
}

/** The three exported values of one `hq env` run. */
function env(task: string, dir = repo): { base: number; tmp: string; db: string } {
  const r = hqIn(dir, "env", task);
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
  expect(r.out).toMatch(/^export HQ_PORT_BASE=\d+\nexport HQ_TMPDIR='.+'\nexport HQ_DB_NAME='hq_[0-9a-f]{8}_t_1'\n$/);
  const e = env("t-1");
  expect(e.base).toBeGreaterThanOrEqual(20000);
  expect(e.base + 9).toBeLessThanOrEqual(29999);
  expect(e.tmp).toBe(join(temp, "hq-env", repoId(repo), "t-1"));
  expect(existsSync(e.tmp)).toBe(true);
  expect(e.db).toBe(`hq_${repoId(repo).slice(-8)}_t_1`);
  expect(JSON.parse(readFileSync(envPath(), "utf8"))[`${repoId(repo)}/t-1`].port_base).toBe(e.base);
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
  expect(JSON.parse(readFileSync(envPath(), "utf8"))).toEqual({});
  expect(env("b").base).toBe(a.base);
  expect(hq("env", "a", "--release").code).toBe(0); // nothing left to release is not an error
});

test("rejects task names that are not safe in a path and a database name", () => {
  for (const bad of ["../x", "A", "a_b", "a b", "x".repeat(52), "__proto__"]) {
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
  expect(Object.keys(JSON.parse(readFileSync(envPath(), "utf8"))).length).toBe(20);
});

const spawnEnv = (task: string, dir = repo) =>
  Bun.spawn([process.execPath, CLI, "env", task], { cwd: dir, env: { ...process.env, TMPDIR: temp }, stdout: "pipe", stderr: "pipe" });

/** A pid that has just stopped running. */
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"]);
  await p.exited;
  return p.pid;
}

const makeOld = (path: string) => {
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
  utimesSync(path, old, old);
};

test("a lock whose holder is dead is taken over; a lock held by a live pid is waited for even when old", async () => {
  const path = lockPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${await deadPid()}\nx\n`);
  expect(env("a").base).toBeGreaterThanOrEqual(20000);
  expect(existsSync(path)).toBe(false);

  const live = `${process.pid}\nalive\n`;
  writeFileSync(path, live);
  makeOld(path);
  const p = spawnEnv("b");
  await Bun.sleep(500);
  expect(await Promise.race([p.exited, Bun.sleep(1)])).toBeUndefined(); // still waiting
  expect(readFileSync(path, "utf8")).toBe(live);
  unlinkSync(path);
  expect(await p.exited).toBe(0);
});

test("a lock without a pid is stale only once it is older than 60 s", async () => {
  const path = lockPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "no pid");
  const p = spawnEnv("a");
  await Bun.sleep(500);
  expect(await Promise.race([p.exited, Bun.sleep(1)])).toBeUndefined();
  makeOld(path);
  expect(await p.exited).toBe(0);
});

test("waiters racing for a dead holder's lock never hold it together", async () => {
  const path = lockPath();
  mkdirSync(join(path, ".."), { recursive: true });
  for (let round = 0; round < 10; round++) {
    writeFileSync(path, `${await deadPid()}\nx\n`);
    let inside = 0, most = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      const unlock = await lock(path);
      most = Math.max(most, ++inside);
      await Bun.sleep(20);
      inside--;
      unlock();
    }));
    expect(most).toBe(1);
    expect(existsSync(path)).toBe(false);
  }
});

test("two env runs racing for a dead holder's lock both succeed with disjoint blocks", async () => {
  const path = lockPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${await deadPid()}\nx\n`);
  const procs = [spawnEnv("a"), spawnEnv("b")];
  const bases: number[] = [];
  for (const p of procs) {
    expect(await p.exited).toBe(0);
    bases.push(Number((await new Response(p.stdout).text()).match(/HQ_PORT_BASE=(\d+)/)![1]));
  }
  expect(Math.abs(bases[0]! - bases[1]!)).toBeGreaterThanOrEqual(10);
  expect(existsSync(path)).toBe(false);
});

test("two repositories sharing $HQ_HOME get disjoint blocks, temp dirs and database names; releasing one leaves the other", () => {
  const repo2 = otherRepo();
  const a = env("same");
  const b = env("same", repo2);
  expect(Math.abs(a.base - b.base)).toBeGreaterThanOrEqual(10);
  expect(a.tmp).not.toBe(b.tmp);
  expect(a.db).not.toBe(b.db);
  expect(a.db).toMatch(/^hq_[0-9a-f]{8}_same$/);
  expect(env("same")).toEqual(a);
  writeFileSync(join(b.tmp, "scratch"), "x");

  expect(hq("env", "same", "--release").code).toBe(0);
  expect(existsSync(a.tmp)).toBe(false);
  expect(existsSync(join(b.tmp, "scratch"))).toBe(true);
  expect(env("same", repo2)).toEqual(b);
  expect(env("same").base).toBe(a.base); // the freed block is the lowest again
});

test("a database name stays a valid Postgres identifier at the longest task name", () => {
  const e = env("a".repeat(51));
  expect(e.db).toMatch(/^[a-z_][a-z0-9_]*$/);
  expect(e.db.length).toBeLessThanOrEqual(63);
});

test("task names that are Object.prototype members work", () => {
  const a = env("constructor");
  const b = env("tostring");
  const c = env("constructor", otherRepo());
  expect(new Set([a.base, b.base, c.base]).size).toBe(3);
  expect(env("constructor")).toEqual(a);
  expect(hq("env", "constructor", "--release").code).toBe(0);
  expect(existsSync(a.tmp)).toBe(false);
  expect(env("tostring")).toEqual(b);
  expect(hq("env", "__proto__", "--release").out).toMatch(/had no env/); // never allocated, and no crash
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
