// HTTP(S) proxy that refuses hosts where the upstream fix could be found (ported from
// c2c-eval-runner's blockproxy.py). The writer agent runs with HTTP(S)_PROXY pointing
// here: the model APIs pass through as CONNECT tunnels, GitHub / code search / search
// engines get a 403, and every refusal is appended to a log.

import { appendFileSync } from "node:fs";
import net from "node:net";

export const BLOCKED = new RegExp(
  "(^|\\.)(" +
    "github\\.com|githubusercontent\\.com|githubassets\\.com|github\\.io|gitlab\\.com|bitbucket\\.org" +
    "|sourcegraph\\.com|grep\\.app|searchcode\\.com|codeberg\\.org" +
    "|stackoverflow\\.com|stackexchange\\.com|google\\.[a-z.]+|bing\\.com|duckduckgo\\.com|search\\.brave\\.com" +
    "|kagi\\.com|yandex\\.[a-z]+|baidu\\.com|perplexity\\.ai|you\\.com" +
    ")$",
  "i",
);

/** Host and port of a proxy request line, or null if it is not one. */
export function target(requestLine: string): { method: string; host: string; port: number } | null {
  const [method, t] = requestLine.split(/\s+/);
  if (!method || !t) return null;
  if (method === "CONNECT") {
    const i = t.lastIndexOf(":");
    return i < 0 ? { method, host: t, port: 443 } : { method, host: t.slice(0, i), port: Number(t.slice(i + 1)) || 443 };
  }
  const m = /^https?:\/\/([^/:]+)(?::(\d+))?/.exec(t);
  return m ? { method, host: m[1]!, port: Number(m[2] ?? 80) } : null;
}

export class BlockProxy {
  logPath: string | null = null;
  private server = net.createServer((c) => this.handle(c));

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return this;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as net.AddressInfo).port}`;
  }

  close() {
    this.server.close();
  }

  private log(msg: string) {
    if (this.logPath) appendFileSync(this.logPath, msg + "\n");
  }

  private handle(client: net.Socket) {
    let buf = Buffer.alloc(0);
    client.on("error", () => {});
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > 65536) client.destroy();
        return;
      }
      client.off("data", onData);
      const head = buf.subarray(0, end + 4);
      const rest = buf.subarray(end + 4);
      const t = target(head.toString("latin1").split("\r\n")[0]!);
      if (!t) return client.destroy();
      if (BLOCKED.test(t.host)) {
        this.log(`${new Date().toISOString()} BLOCKED ${t.method} ${t.host}`);
        return client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      }
      const upstream = net.connect(t.port, t.host, () => {
        if (t.method === "CONNECT") client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        else upstream.write(head); // plain HTTP: forward the request as received
        if (rest.length) upstream.write(rest);
        client.pipe(upstream).pipe(client);
      });
      upstream.setTimeout(300_000, () => upstream.destroy());
      upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
      client.on("close", () => upstream.destroy());
    };
    client.on("data", onData);
  }
}
