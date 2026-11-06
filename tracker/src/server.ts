import { createServer } from "node:http";
import { setTimeout } from "node:timers/promises";
import { collect, type CollectOptions } from "./collect";
import { dashboardData, html } from "./report";

type Collection = Awaited<ReturnType<typeof collect>>;

export async function serve(options: CollectOptions & { host?: string; port?: number },
  collectData: () => Promise<Collection> = () => collect(options),
  snapshot?: () => Collection) {
  let current = await collectData();
  let running: Promise<Collection> | undefined;
  function refresh() {
    if (!running) {
      running = (async () => {
        // Coalesce requests sent together before starting synchronous parsing.
        await setTimeout(10);
        try { current = await collectData(); return current; }
        finally { await setTimeout(0); running = undefined; }
      })();
    }
    return running;
  }
  const server = createServer(async (req, res) => {
    const port = (server.address() as { port: number }).port;
    const allowedHosts = ["localhost", "127.0.0.1", "[::1]"].map(host => `${host}:${port}`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!allowedHosts.includes(req.headers.host?.toLowerCase() ?? "")) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    try {
      if (req.url === "/" && req.method === "GET") {
        const data = snapshot?.() ?? current;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html(data.tasks, data.meta, true));
      } else if (req.url === "/api/refresh") {
        if (req.method !== "POST" || req.headers["x-crewmeter"] !== "1") {
          res.writeHead(403).end("Forbidden");
          return;
        }
        const data = await refresh();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(dashboardData(data.tasks, data.meta)));
      } else if (req.url === "/favicon.ico" && req.method === "GET") {
        res.writeHead(204).end();
      } else {
        res.writeHead(404).end("Not found");
      }
    } catch (error) {
      console.error("refresh failed:", error);
      res.writeHead(500).end("Collection failed; try refreshing again.");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4317, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
