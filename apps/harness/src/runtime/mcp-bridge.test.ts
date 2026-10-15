import { expect, it } from "vitest";
import { createServer } from "node:http";
import { WorkerMcpBridge } from "./mcp-bridge.js";

it("bridges only registered authenticated MCP routes and revokes them", async () => {
  const seen: string[] = [];
  const upstream = createServer((req, res) => { seen.push(req.url!); res.end(JSON.stringify({ local: req.socket.remoteAddress, bearer: req.headers.authorization, cookie: req.headers.cookie ?? null })); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const bridge = new WorkerMcpBridge(origin);
  try {
    const servers = await bridge.rewrite("chat", { workspaces: { type: "http", url: `${origin}/internal/workspaces/chat`, headers: { authorization: "Bearer scoped" } } });
    const url = new URL((servers!.workspaces as { url: string }).url); url.hostname = "127.0.0.1";
    expect((await fetch(url, { method: "POST" })).status).toBe(403);
    const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer scoped", cookie: "host-secret=bad" }, body: "{}" });
    expect(await response.json()).toEqual({ local: "127.0.0.1", bearer: "Bearer scoped", cookie: null });
    expect((await fetch(new URL("/api/settings", url), { headers: { authorization: "Bearer scoped" } })).status).toBe(403);
    bridge.unregister("chat");
    expect((await fetch(url, { method: "POST", headers: { authorization: "Bearer scoped" } })).status).toBe(403);
    expect(seen).toEqual(["/internal/workspaces/chat"]);
    await expect(bridge.rewrite("chat", { bad: { url: `${origin}/api/settings`, headers: { authorization: "Bearer scoped" } } })).rejects.toThrow(/unscoped/);
  } finally { await bridge.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
