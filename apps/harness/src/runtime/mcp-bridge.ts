import { createServer, request as httpRequest, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";

/** Only already-authorized session MCP URLs cross this bridge. The loopback handlers keep their checks. */
export class WorkerMcpBridge {
  private server: Server | null = null;
  private origin: string | null = null;
  private readonly routes = new Map<string, { sessionId: string; bearer: string }>();
  constructor(private readonly upstream: string) {
    const url = new URL(upstream);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/") throw new Error("Worker MCP upstream must be the Harness loopback origin.");
  }
  private async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => {
      const route = this.routes.get(request.url ?? ""), actual = request.headers.authorization ?? "";
      if (!route || Buffer.byteLength(actual) !== Buffer.byteLength(route.bearer)
        || !timingSafeEqual(Buffer.from(actual), Buffer.from(route.bearer))) { response.writeHead(403); response.end(); return; }
      if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) { response.writeHead(405); response.end(); return; }
      const upstream = httpRequest(new URL(request.url!, this.upstream), {
        method: request.method,
        headers: { authorization: route.bearer, "content-type": "application/json",
          accept: "application/json, text/event-stream", ...(typeof request.headers["mcp-session-id"] === "string" ? { "mcp-session-id": request.headers["mcp-session-id"] } : {}) },
      }, incoming => {
        response.writeHead(incoming.statusCode ?? 502, { "content-type": incoming.headers["content-type"] ?? "application/json", "cache-control": "no-store",
          ...(typeof incoming.headers["mcp-session-id"] === "string" ? { "mcp-session-id": incoming.headers["mcp-session-id"] } : {}) });
        incoming.pipe(response);
      });
      upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      response.once("close", () => upstream.destroy());
      let bytes = 0;
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { upstream.destroy(); if (!response.headersSent) response.writeHead(413); response.end(); }
        else upstream.write(chunk);
      });
      request.on("end", () => upstream.end());
      request.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(0, "0.0.0.0", resolve); });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Worker MCP listener has no port.");
    this.origin = `http://host.docker.internal:${address.port}`;
  }
  async rewrite(sessionId: string, servers: Record<string, unknown> | undefined): Promise<Record<string, unknown> | undefined> {
    await this.start();
    this.unregister(sessionId);
    if (!servers) return undefined;
    const rewritten: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(servers)) {
      const server = raw as { url?: string; headers?: { authorization?: string } };
      const url = new URL(server.url ?? "");
      const allowed = url.origin === new URL(this.upstream).origin && !url.search && !url.hash && !url.username && !url.password
        && (url.pathname === `/internal/workspaces/${encodeURIComponent(sessionId)}` || url.pathname.startsWith(`/internal/mcp/${encodeURIComponent(sessionId)}/`));
      if (!allowed || !server.headers?.authorization?.startsWith("Bearer ")) throw new Error("The worker received an unscoped MCP route.");
      this.routes.set(url.pathname, { sessionId, bearer: server.headers.authorization });
      rewritten[name] = { ...server, url: `${this.origin}${url.pathname}` };
    }
    return rewritten;
  }
  unregister(sessionId: string): void {
    for (const [key, value] of this.routes) if (value.sessionId === sessionId) this.routes.delete(key);
  }
  async close(): Promise<void> {
    this.routes.clear();
    this.server?.closeAllConnections();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = null; this.origin = null;
  }
}
