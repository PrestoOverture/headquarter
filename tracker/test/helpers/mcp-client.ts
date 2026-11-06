import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Raw wire client: every stdout line must be a JSON-RPC message. */
export function stdioClient(command: string, args: string[], timeoutMs = 25000) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  let id = 0, stderr = "", protocolError: Error | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  child.stderr.on("data", chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", line => {
    try {
      const message = JSON.parse(line);
      if (message.jsonrpc !== "2.0") throw new Error(`Non-protocol stdout: ${line}`);
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      }
    } catch (error) {
      protocolError = error as Error;
      for (const request of pending.values()) request.reject(protocolError);
      pending.clear();
    }
  });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  child.once("exit", code => {
    for (const request of pending.values()) request.reject(new Error(`MCP exited ${code}: ${stderr}`));
    pending.clear();
  });
  function request(method: string, params: unknown = {}) {
    if (protocolError) return Promise.reject(protocolError);
    return new Promise<any>((resolve, reject) => {
      const key = ++id;
      const timeout = setTimeout(() => { pending.delete(key); reject(new Error(`${method} timed out: ${stderr}`)); }, timeoutMs);
      pending.set(key, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n");
    });
  }
  return {
    request, child, get stderr() { return stderr; },
    async initialize() {
      const result = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "crewmeter-test", version: "1" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return result;
    },
    call: (name: string, args = {}) => request("tools/call", { name, arguments: args }),
    async close() {
      child.stdin.end();
      const timeout = setTimeout(() => child.kill("SIGTERM"), 3000);
      const code = await exited;
      clearTimeout(timeout);
      if (protocolError) throw protocolError;
      return code;
    },
  };
}
