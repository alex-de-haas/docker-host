import { pullRequestEvents } from "./pull-requests-proxy.js";
import type { ConnectionService } from "./connections/service.js";
import { UsageSubscriptions } from "./connections/usage-subscriptions.js";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { validateDelegatedToken } from "@hosty-sdk/app/delegated";
import type { AdminActor } from "./auth.js";
import { readAppCredential, resolveAppSession } from "./app-session.js";
import { AppContextError } from "./sessions/app-context.js";
import type { SessionManager } from "./sessions/manager.js";
import type { StoredEvent } from "./sessions/store.js";

const PROTOCOL = "hosty-events-v1";
const SOCKET_PATH = "/api/event-stream";
const TICKET_LIFETIME = 30_000;
const STREAM_LIFETIME = 3_600_000;
const QUEUE_LIMIT = 1_048_576;
type Target = { kind: "usage"; connectionId: string } | { kind: "session"; sessionId: string; after: number } | { kind: "workspaces" } | { kind: "pullRequests"; subscriptionId: string };
type Ticket = { actor: AdminActor; credential: string; origin: string; target: Target; expires: number; deadline: number };
const failure = (status: number, code: string, message: string): never => { throw new AppContextError(status, code, message); };

/** One-use, actor-bound admission; cookies on a WebSocket upgrade never establish authority. */
export class EventStreamTransport {
  private readonly tickets = new Map<string, Ticket>();
  private readonly pending = new Map<Duplex, AbortController>();
  private readonly sockets = new Set<WebSocket>();
  private closed = false;
  private readonly sweep: ReturnType<typeof setInterval>;
  private readonly websocket = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has(PROTOCOL) ? PROTOCOL : false });

  private readonly usageStreams?: UsageSubscriptions;
  constructor(private readonly manager: SessionManager, private readonly now: () => number = Date.now, private readonly connections?: ConnectionService | null) {
    if (connections) this.usageStreams = new UsageSubscriptions(connections);
    this.sweep = setInterval(() => this.prune(), 15_000); this.sweep.unref();
  }
  private prune() { for (const [key, ticket] of this.tickets) if (ticket.expires <= this.now()) this.tickets.delete(key); }
  private origin(request: IncomingMessage): string {
    const origin = request.headers.origin;
    try {
      const parsed = new URL(origin ?? "");
      if (origin !== parsed.origin || !["http:", "https:"].includes(parsed.protocol) || parsed.host !== request.headers.host)
        throw new Error("Origin mismatch");
      return parsed.origin;
    } catch { return failure(403, "cross_site_request_blocked", "Open event streams from this application's own page."); }
  }
  private target(value: unknown): Target {
    const path = value && typeof value === "object" ? (value as { path?: unknown }).path : undefined;
    if (typeof path !== "string" || path.length > 2048) return failure(400, "event_stream_invalid", "Select a supported event stream.");
    const usage = /^\/api\/connections\/([A-Za-z0-9-]{1,128})\/usage\/events$/.exec(path);
    if (usage && this.connections) return { kind: "usage", connectionId: usage[1]! };
    if (path === "/api/development-workspaces/events") return { kind: "workspaces" };
    const pr = /^\/api\/pull-requests\/events\?subscriptionId=([a-f0-9]{32})$/.exec(path);
    if (pr) return { kind: "pullRequests", subscriptionId: pr[1]! };
    const match = /^\/api\/sessions\/([A-Za-z0-9_-]{1,128})\/events(?:\?after=(\d{1,16}))?$/.exec(path);
    const after = Number(match?.[2] ?? 0);
    if (!match || !Number.isSafeInteger(after) || after < 0) return failure(400, "event_stream_invalid", "Select a supported event stream.");
    return { kind: "session", sessionId: match[1]!, after };
  }
  private async validate(actor: AdminActor, credential: string, signal: AbortSignal): Promise<number> {
    if (actor.via === "delegated-token") {
      const claims = validateDelegatedToken(credential);
      if (!claims || claims.sub !== actor.userId || claims.role !== "host.admin")
        return failure(401, "unauthorized", "The event stream credential has expired.");
      return claims.exp * 1000;
    }
    const session = await resolveAppSession(credential, signal);
    if (session.status !== "active") return failure(session.status === "unavailable" ? 503 : session.status === "forbidden" ? 403 : 401,
      "event_stream_identity_unavailable", "Hosty could not validate this event stream.");
    if (session.identity.userId !== actor.userId || session.identity.hostRole !== "host.admin")
      return failure(403, "event_stream_actor_changed", "The event stream account changed.");
    const activeUntil = Date.parse(session.identity.activeUntil ?? "");
    if ((session.identity.activityRequired && !Number.isFinite(activeUntil)) || (Number.isFinite(activeUntil) && activeUntil <= this.now()))
      return failure(401, "reauth_required", "Renew Hosty access before opening event streams.");
    return Number.isFinite(activeUntil) ? Math.min(this.now() + STREAM_LIFETIME, activeUntil) : this.now() + STREAM_LIFETIME;
  }
  private async admitted(target: Target, actor: AdminActor) {
    if (target.kind === "usage") { await this.connections!.get(target.connectionId); return; }
    if (target.kind === "workspaces" || target.kind === "pullRequests") {
      if (actor.via !== "app-session") failure(401, "reauth_required", "Open Harness through Core to inspect workspaces.");
      return;
    }
    const session = await this.manager.getSession(target.sessionId);
    if (!session || session.createdBy !== actor.userId) failure(404, "session_not_found", "Session not found.");
    if (session!.handoffPending) failure(409, "handoff_pending", "Finalize or cancel the prepared handoff first.");
  }
  async issue(body: unknown, request: IncomingMessage, actor: AdminActor) {
    if (this.closed) failure(503, "event_stream_unavailable", "Event streams are shutting down.");
    const origin = this.origin(request), target = this.target(body);
    const credential = actor.via === "app-session" ? readAppCredential(request)
      : request.headers.authorization?.toLowerCase().startsWith("bearer ") ? request.headers.authorization.slice(7).trim() : null;
    if (!credential) failure(401, "unauthorized", "An event stream credential is required.");
    const deadline = await this.validate(actor, credential!, AbortSignal.timeout(5_000));
    await this.admitted(target, actor);
    if (this.closed) failure(503, "event_stream_unavailable", "Event streams are shutting down.");
    if (deadline <= this.now()) failure(401, "reauth_required", "Renew Hosty access before opening event streams.");
    this.prune();
    if (this.tickets.size >= 512 || [...this.tickets.values()].filter(ticket => ticket.actor.userId === actor.userId).length >= 32)
      failure(429, "event_stream_busy", "Too many event stream connections are pending. Try again shortly.");
    const ticket = randomBytes(32).toString("hex");
    this.tickets.set(ticket, { actor, credential: credential!, origin, target,
      expires: this.now() + TICKET_LIFETIME, deadline: Math.min(deadline, this.now() + STREAM_LIFETIME) });
    return { ticket, protocol: PROTOCOL, path: SOCKET_PATH };
  }
  attach(server: Server) {
    server.on("upgrade", (request, socket, head) => {
      // Upgraded sockets no longer have HTTP's error handler, including during early refusals.
      const failed = () => socket.destroy();
      socket.on("error", failed); socket.once("close", () => socket.off("error", failed));
      void this.upgrade(request, socket, head).catch(error => this.reject(socket, error instanceof AppContextError ? error.status : 503));
    });
  }
  private reject(socket: Duplex, status: number) {
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Event stream unavailable\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  }
  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    if (this.closed || request.url !== SOCKET_PATH) { this.reject(socket, 404); return; }
    const protocols = request.headers["sec-websocket-protocol"]?.split(",").map(value => value.trim()) ?? [];
    const names = protocols.filter(value => /^ticket\.[a-f0-9]{64}$/.test(value));
    const key = names[0]?.slice(7), ticket = key ? this.tickets.get(key) : undefined;
    if (key) this.tickets.delete(key);
    if (!ticket || names.length !== 1 || !protocols.includes(PROTOCOL) || ticket.expires <= this.now()) { this.reject(socket, 401); return; }
    try { if (this.origin(request) !== ticket.origin) { this.reject(socket, 403); return; } }
    catch { this.reject(socket, 403); return; }
    const abort = new AbortController(); this.pending.set(socket, abort);
    const cancel = () => { abort.abort(); if (!socket.destroyed) socket.destroy(); };
    socket.once("close", cancel); socket.once("end", cancel); socket.on("error", cancel);
    const timeout = setTimeout(() => { abort.abort(); socket.destroy(); }, 5_000);
    try {
      const deadline = await this.validate(ticket.actor, ticket.credential, abort.signal);
      await this.admitted(ticket.target, ticket.actor);
      if (abort.signal.aborted || this.closed || socket.destroyed || ticket.expires <= this.now() || Math.min(ticket.deadline, deadline) <= this.now()) {
        this.reject(socket, 401); return;
      }
      this.websocket.handleUpgrade(request, socket, head, connection => {
        this.sockets.add(connection);
        void this.stream(connection, ticket, Math.min(ticket.deadline, deadline));
      });
    } catch (error) { if (!socket.destroyed) this.reject(socket, error instanceof AppContextError ? error.status : 503); }
    finally {
      clearTimeout(timeout); this.pending.delete(socket); socket.off("close", cancel); socket.off("end", cancel); socket.off("error", cancel);
    }
  }
  private async stream(socket: WebSocket, ticket: Ticket, deadline: number) {
    const abort = new AbortController(); let unsubscribe: (() => void) | undefined;
    let cancelUpstream: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false, alive = true;
    const cleanup = () => {
      if (stopped) return;
      stopped = true; abort.abort(); cancelUpstream?.(); clearInterval(heartbeat); clearTimeout(expiry);
      const release = unsubscribe; unsubscribe = undefined; release?.();
    };
    const finish = (code = 1000) => { cleanup(); if (socket.readyState === WebSocket.OPEN) socket.close(code); };
    socket.once("close", () => { cleanup(); this.sockets.delete(socket); }); socket.on("error", cleanup); socket.on("pong", () => { alive = true; });
    socket.on("message", () => finish(1008));
    const send = async (text: string) => {
      // Every message is valid Unicode text; SSE records may span several WebSocket messages.
      for (let offset = 0; offset < text.length;) {
        if (stopped || socket.readyState !== WebSocket.OPEN) return false;
        let end = Math.min(offset + 16_384, text.length);
        const last = text.charCodeAt(end - 1);
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
        const chunk = text.slice(offset, end); offset = end;
        if (socket.bufferedAmount + Buffer.byteLength(chunk) > QUEUE_LIMIT) { finish(1013); return false; }
        const sent = await new Promise<boolean>(resolve => socket.send(chunk, { binary: false }, error => resolve(!error)));
        if (!sent) { finish(1011); return false; }
      }
      return !stopped;
    };
    heartbeat = setInterval(() => { if (!alive) { socket.terminate(); cleanup(); } else { alive = false; socket.ping(); } }, 25_000);
    expiry = setTimeout(() => finish(), Math.max(0, deadline - this.now()));
    try {
      if (ticket.target.kind === "usage") {
        unsubscribe = this.usageStreams!.subscribe(ticket.target.connectionId, usage => { void send(`data: ${JSON.stringify(usage)}\n\n`); });
      } else if (ticket.target.kind === "session") {
        const queued: StoredEvent[] = []; let queuedBytes = 0, replaying = true, draining = false;
        const frame = (event: StoredEvent) => `data: ${JSON.stringify(event)}\n\n`;
        const deliver = async (event: StoredEvent) => {
          const ok = await send(frame(event));
          if (ok && event.type === "session_deleted") finish();
          return ok;
        };
        const drain = async () => {
          if (draining || replaying) return;
          draining = true;
          try {
            while (queued.length && !stopped) {
              const event = queued.shift()!; queuedBytes -= Buffer.byteLength(frame(event));
              if (!await deliver(event)) break;
            }
          } finally { draining = false; }
        };
        const subscription = await this.manager.subscribe(ticket.target.sessionId, ticket.target.after, event => {
          if (stopped) return;
          const bytes = Buffer.byteLength(frame(event));
          if (queuedBytes + bytes > QUEUE_LIMIT) { finish(1013); return; }
          queued.push(event); queuedBytes += bytes; void drain();
        });
        if (stopped) { subscription.unsubscribe(); return; }
        unsubscribe = subscription.unsubscribe;
        for (const event of subscription.replay) if (!await deliver(event)) return;
        replaying = false; await drain();
      } else {
        const upstream = ticket.target.kind === "pullRequests"
          ? await pullRequestEvents(ticket.credential, ticket.target.subscriptionId, abort.signal)
          : await this.manager.workspaceEvents(ticket.credential, abort.signal);
        if (stopped) { await upstream.body?.cancel().catch(() => {}); return; }
        const reader = upstream.body!.getReader(), decoder = new TextDecoder(); let tail = "";
        cancelUpstream = () => { void reader.cancel().catch(() => {}); };
        try {
          while (!stopped) {
            const chunk = await reader.read(); if (chunk.done) break;
            const text = decoder.decode(chunk.value, { stream: true });
            if (!await send(text)) break;
            tail = (tail + text).slice(-128);
            if (/event:\s*stream\.revoked\r?\n/.test(tail)) break;
          }
          if (!stopped) { const text = decoder.decode(); if (text) await send(text); }
        } finally { cancelUpstream = undefined; await reader.cancel().catch(() => {}); reader.releaseLock(); }
        finish();
      }
    } catch (error) {
      if (!stopped && ticket.target.kind === "workspaces" && error instanceof AppContextError && [404, 405].includes(error.status)) {
        await send("event: stream.unsupported\ndata: {}\n\n"); finish();
      } else finish(1011);
    }
  }
  close() {
    if (this.closed) return;
    this.usageStreams?.close();
    this.closed = true; clearInterval(this.sweep); this.tickets.clear();
    for (const [socket, abort] of this.pending) { abort.abort(); socket.destroy(); }
    this.pending.clear();
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear(); this.websocket.close();
  }
}
