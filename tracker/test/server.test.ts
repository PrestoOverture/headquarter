import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../src/collect";
import { serve } from "../src/server";

const empty = () => ({ tasks: [], meta: { generatedAt: Date.now(), sessions: {}, repos: 0, ci: false } });
const portOf = (server: Server) => (server.address() as { port: number }).port;
const urlOf = (server: Server) => `http://127.0.0.1:${portOf(server)}`;
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const refresh = (server: Server) => fetch(urlOf(server) + "/api/refresh", { method: "POST", headers: { "X-Crewmeter": "1" } });

test("GET dashboard and POST refresh re-read an edited fixture with the incremental cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crewmeter-serve-"));
  let server: Server | undefined;
  try {
    const root = join(dir, "claude");
    cpSync(join(import.meta.dir, "fixtures/claude"), root, { recursive: true });
    const options = { port: 0, cacheDir: join(dir, "cache"), dirs: { claude: root, codex: join(dir, "missing"), opencode: join(dir, "missing") } };
    const logs: string[] = [];
    let count = 0;
    server = await serve(options, () => { count++; return collect(options, line => logs.push(line)); });
    expect(count).toBe(1);
    const page = await fetch(urlOf(server));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Agent 效果追踪");
    expect(html).toContain('id="refresh"');
    const first = JSON.parse(html.match(/let DATA = (.*);/)![1]!);
    expect(first.tasks[0].tokens.output).toBe(10);
    const file = join(root, "project/session.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace('"output_tokens": 6', '"output_tokens": 600'));
    const response = await refresh(server);
    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.tasks[0].tokens.output).toBe(604);
    expect(data.meta.generatedAt).toBeGreaterThan(first.meta.generatedAt);
    expect(count).toBe(2);
    expect(logs.filter(line => line.includes("1 files parsed, 0 reused"))).toHaveLength(2);
    await refresh(server);
    expect(logs.some(line => line.includes("0 files parsed, 1 reused"))).toBe(true);
    const callsBefore = count;
    const concurrent = await Promise.all([refresh(server), refresh(server)]);
    expect(concurrent.every(response => response.status === 200)).toBe(true);
    expect(count).toBe(callsBefore + 1);
    const latest = await (await fetch(urlOf(server))).text();
    expect(latest).toContain('"output":604');
  } finally {
    if (server) await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent refresh requests share one running collect", async () => {
  let count = 0;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const server = await serve({ port: 0 }, async () => {
    if (++count > 1) { entered(); await blocked; }
    return { ...empty(), meta: { ...empty().meta, generatedAt: count } };
  });
  try {
    let requests = 0;
    let secondArrived!: () => void;
    const received = new Promise<void>(resolve => { secondArrived = resolve; });
    server.prependListener("request", req => { if (req.url === "/api/refresh" && ++requests === 2) secondArrived(); });
    const first = refresh(server);
    await started;
    const second = refresh(server);
    await received;
    expect(count).toBe(2); // startup plus one refresh
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
    expect(count).toBe(2);
    await refresh(server);
    expect(count).toBe(3);
  } finally { release(); await close(server); }
});

test("Host guard requires a loopback hostname with the server port; refresh requires POST and custom header", async () => {
  let count = 0;
  const server = await serve({ port: 0 }, async () => { count++; return empty(); });
  const requestWithHost = (host?: string) => new Promise<number>(resolve => {
    const req = request({ hostname: "127.0.0.1", port: portOf(server), path: "/", setHost: false,
      headers: host === undefined ? {} : { Host: host } }, res => { res.resume(); resolve(res.statusCode!); });
    req.end();
  });
  try {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) expect(await requestWithHost(`${host}:${portOf(server)}`)).toBe(200);
    for (const host of ["evil.test", `evil.test:${portOf(server)}`, "localhost", `localhost:${portOf(server) + 1}`, `127.0.0.1.evil.test:${portOf(server)}`]) {
      expect(await requestWithHost(host)).toBe(403);
    }
    // Bun rejects missing HTTP/1.1 Host at the parser; Node lets the guard reject it.
    expect([400, 403]).toContain(await requestWithHost());
    expect((await fetch(urlOf(server) + "/api/refresh", { method: "POST" })).status).toBe(403);
    expect((await fetch(urlOf(server) + "/api/refresh", { method: "POST", headers: { "X-Crewmeter": "0" } })).status).toBe(403);
    for (const method of ["GET", "OPTIONS", "PUT"]) {
      const response = await fetch(urlOf(server) + "/api/refresh", { method, headers: { "X-Crewmeter": "1" } });
      expect(response.status).toBe(403);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
    }
    expect(count).toBe(1);
    expect((await refresh(server)).status).toBe(200);
    expect(count).toBe(2);
  } finally { await close(server); }
});

test("a failed refresh retains the previous dashboard and permits a retry", async () => {
  let count = 0;
  const server = await serve({ port: 0 }, async () => {
    if (++count === 2) throw new Error("fixture collect failure");
    return empty();
  });
  try {
    expect((await refresh(server)).status).toBe(500);
    expect((await fetch(urlOf(server))).status).toBe(200);
    expect((await refresh(server)).status).toBe(200);
    expect(count).toBe(3);
  } finally { await close(server); }
});
