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

it("preserves negotiated MCP headers and SSE resume cursors without forwarding unrelated credentials", async () => {
  const seen: string[] = [];
  const upstream = createServer((req, res) => {
    if (req.headers["mcp-protocol-version"] !== "2025-03-26" || req.headers["mcp-session-id"] !== "session-1"
      || req.headers.cookie || req.headers["x-docker-host-identity"]) {
      res.writeHead(400); res.end(); return;
    }
    seen.push(req.method!);
    res.setHeader("mcp-session-id", "session-1");
    if (req.method === "GET") {
      if (req.headers["last-event-id"] !== "event-41") { res.writeHead(400); res.end(); return; }
      res.setHeader("content-type", "text/event-stream");
      res.end('id: event-42\ndata: {"resumed":true}\n\n');
    } else { res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); }
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const bridge = new WorkerMcpBridge(origin);
  try {
    const servers = await bridge.rewrite("chat", { provider: { type: "http", url: `${origin}/internal/mcp/chat/provider`, headers: { authorization: "Bearer scoped" } } });
    const url = new URL((servers!.provider as { url: string }).url); url.hostname = "127.0.0.1";
    for (const method of ["POST", "GET", "DELETE"]) {
      const response = await fetch(url, { method, headers: {
        authorization: "Bearer scoped", "mcp-protocol-version": "2025-03-26", "mcp-session-id": "session-1",
        ...(method === "GET" ? { "last-event-id": "event-41" } : {}), cookie: "host-secret=bad", "x-docker-host-identity": "unrelated",
      }, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBe("session-1");
      if (method === "GET") {
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        expect(await response.text()).toBe('id: event-42\ndata: {"resumed":true}\n\n');
      } else expect(await response.json()).toEqual({ ok: true });
    }
    expect(seen).toEqual(["POST", "GET", "DELETE"]);
  } finally { await bridge.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
