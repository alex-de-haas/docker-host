import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { generateKeyPairSync, sign } from "node:crypto";
import { WebSocket } from "ws";
import { EventStreamTransport } from "./event-stream-transport.js";
import { createGatewayServer } from "./server.js";
import { SessionManager } from "./sessions/manager.js";
import { SessionStore, type StoredEvent } from "./sessions/store.js";
import { AuditReporter } from "./audit.js";
import { FakeHarnessAdapter } from "./harness/fake.js";
import { captureEnv } from "./test-env.js";
import { AppContextError } from "./sessions/app-context.js";

const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
function delegated() {
  const payload = Buffer.from(JSON.stringify({ sub: "owner", role: "host.admin", aud: "hosty.harness", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: "events-test" })).toString("base64url");
  const input = `hosty_delegated.1.${payload}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
type Admission = { ticket: string; protocol: string; path: string };
let dir: string, store: SessionStore, manager: SessionManager, server: Server, core: Server, origin: string, sessionId: string, restore: () => void;
let credentials: string[], activeUntil: string | null, role: string, validationStatus: number;
let hold: (() => Promise<void>) | undefined;
const sockets: WebSocket[] = [], extras: Server[] = [], transports: EventStreamTransport[] = [];
const listen = async (server: Server) => { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; };
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
beforeEach(async () => {
  credentials = []; activeUntil = null; role = "host.admin"; validationStatus = 200; hold = undefined;
  core = createServer((request, response) => { void (async () => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    credentials.push(String(JSON.parse(raw).accessToken));
    if (hold) await hold();
    if (response.destroyed) return;
    response.writeHead(validationStatus, { "content-type": "application/json" });
    response.end(JSON.stringify(validationStatus === 200 ? { active: true, userId: "owner", hostRole: role, activityRequired: activeUntil !== null, activeUntil } : { code: "token_revoked" }));
  })(); });
  const coreOrigin = await listen(core);
  restore = captureEnv({ HOSTY_APP_ID: "hosty.harness", HOSTY_APP_SERVICE_TOKEN: "test-service", HOSTY_CORE_ORIGIN: coreOrigin, HOSTY_DELEGATED_TOKEN_PUBLIC_KEY: publicKey });
  dir = mkdtempSync(path.join(os.tmpdir(), "hosty-event-stream-"));
  store = new SessionStore(dir, path.join(dir, "cache"));
  manager = new SessionManager(store, new FakeHarnessAdapter(), new AuditReporter(null, null, "hosty.harness"), dir);
  sessionId = (await manager.createSession({ createdBy: "owner" })).id;
  server = createGatewayServer(manager, new FakeHarnessAdapter()); origin = await listen(server);
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const transport of transports.splice(0)) transport.close();
  for (const extra of extras.splice(0)) await close(extra);
  await manager.shutdown(); await close(server); await close(core);
  vi.restoreAllMocks(); restore(); rmSync(dir, { recursive: true, force: true });
});
function mint(path = `/api/sessions/${sessionId}/events?after=0`, headers: Record<string, string> = {}) {
  return fetch(`${origin}/api/event-stream-tickets`, { method: "POST", headers: { authorization: "Bearer hostyg_owner", origin, "content-type": "application/json", ...headers }, body: JSON.stringify({ path }) });
}
async function ticket(path?: string, headers?: Record<string, string>): Promise<Admission> {
  const result = await mint(path, headers); expect(result.status).toBe(200); return await result.json() as Admission;
}
function socketFor(admission: Admission, base = origin, headers: Record<string, string> = {}) {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}${admission.path}`, [admission.protocol, `ticket.${admission.ticket}`], { origin: headers.origin ?? base, headers });
  socket.on("error", () => {}); sockets.push(socket); return socket;
}
async function connected(admission: Admission, base = origin) {
  const socket = socketFor(admission, base), chunks: string[] = [];
  socket.on("message", data => chunks.push(data.toString()));
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return { socket, chunks };
}
function refused(socket: WebSocket) {
  return new Promise<number>((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode!); socket.terminate(); });
    socket.once("open", () => reject(new Error("Unexpected accepted upgrade")));
  });
}
function events(chunks: string[]): StoredEvent[] {
  return chunks.join("").split("\n\n").filter(frame => frame.startsWith("data: ")).map(frame => JSON.parse(frame.slice(6)) as StoredEvent);
}

it("refuses unauthenticated, non-admin, cross-origin, missing and unsupported ticket requests", async () => {
  expect((await mint(undefined, { authorization: "" })).status).toBe(401);
  role = "host.user"; expect((await mint()).status).toBe(401); role = "host.admin";
  expect((await mint(undefined, { origin: "https://foreign.test" })).status).toBe(403);
  expect((await mint(undefined, { origin: "null" })).status).toBe(403);
  expect((await mint("/api/sessions/missing/events?after=0")).status).toBe(404);
  for (const route of ["https://foreign.test/events", "/api/sessions/../events", `/api/sessions/${sessionId}/events?after=0&other=1`, `/api/sessions/${sessionId}/events?after=-1`]) expect((await mint(route)).status).toBe(400);
});

it("revalidates the captured actor credential, ignores upgrade cookies and consumes tickets once", async () => {
  const admission = await ticket();
  const socket = socketFor(admission, origin, { cookie: "hosty_harness_identity=hostyg_other" });
  const seen: string[] = []; socket.on("message", data => seen.push(data.toString()));
  await vi.waitFor(() => expect(seen.join("")).toContain("session_status"));
  expect(socket.protocol).toBe("hosty-events-v1");
  expect(credentials).toEqual(["hostyg_owner", "hostyg_owner", "hostyg_owner"]);
  expect(await refused(socketFor(admission))).toBe(401);
  const noTicket = new WebSocket(`${origin.replace(/^http/, "ws")}/api/event-stream`, ["hosty-events-v1"], { origin, headers: { cookie: "hosty_harness_identity=hostyg_owner" } });
  noTicket.on("error", () => {}); sockets.push(noTicket); expect(await refused(noTicket)).toBe(401);
});

it("refuses an origin mismatch and a credential revoked after ticket admission", async () => {
  const admission = await ticket();
  expect(await refused(socketFor(admission, origin, { origin: "http://foreign.test" }))).toBe(403);
  const next = await ticket(); validationStatus = 401;
  expect(await refused(socketFor(next))).toBe(401);
});

it("preserves delegated credential casing and the durable cursor while closing live subscriptions", async () => {
  const old = { seq: 1, ts: new Date().toISOString(), type: "assistant_text", text: "old" };
  const recent = { ...old, seq: 2, text: "recent" };
  await store.appendEvent(sessionId, old); await store.appendEvent(sessionId, recent);
  const unsubscribe = vi.fn(), original = manager.subscribe.bind(manager);
  vi.spyOn(manager, "subscribe").mockImplementation(async (...args) => {
    const value = await original(...args); return { ...value, unsubscribe: () => { unsubscribe(); value.unsubscribe(); } };
  });
  const admission = await ticket(`/api/sessions/${sessionId}/events?after=1`, { authorization: `bearer ${delegated()}` });
  const view = await connected(admission);
  await vi.waitFor(() => expect(events(view.chunks).some(event => event.type === "session_status")).toBe(true));
  expect(events(view.chunks).filter(event => event.type === "assistant_text")).toEqual([recent]);
  view.socket.close(); await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
});

it("replays a durable Unicode record larger than one MiB without truncation or blocking ordinary API requests", async () => {
  const text = "prefix" + "🟢漢🙂".repeat(140_000);
  const record = { seq: 1, ts: new Date().toISOString(), type: "assistant_text", text };
  expect(Buffer.byteLength(JSON.stringify(record))).toBeGreaterThan(1_048_576);
  await store.appendEvent(sessionId, record);
  const view = await connected(await ticket());
  const ordinary = await fetch(`${origin}/api/sessions/${sessionId}`, { headers: { authorization: "Bearer hostyg_owner" } });
  expect(ordinary.status).toBe(200);
  await vi.waitFor(() => expect(view.chunks.join("")).toContain('"session_status"'), { timeout: 3000 });
  expect(events(view.chunks).find(event => event.type === "assistant_text")).toEqual(record);
  expect(view.chunks.length).toBeGreaterThan(2);
  expect(view.chunks.every(chunk => chunk.length <= 16_384)).toBe(true);
  expect(view.chunks.every(chunk => !chunk.includes("\uFFFD"))).toBe(true);
});

it.each([404, 405])("preserves older Core unsupported workspace streams (%s) without an HTTP stream fallback", async status => {
  const upstream = vi.spyOn(manager, "workspaceEvents").mockRejectedValue(new AppContextError(status, "workspace_stream_unavailable", "Unsupported"));
  const view = await connected(await ticket("/api/development-workspaces/events"));
  await vi.waitFor(() => expect(view.chunks.join("")).toBe("event: stream.unsupported\ndata: {}\n\n"));
  await vi.waitFor(() => expect(view.socket.readyState).toBe(WebSocket.CLOSED));
  expect(upstream).toHaveBeenCalledTimes(1);
});

it("aborts a Core workspace stream when its browser closes and forwards revocation without another subscription", async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>, signal!: AbortSignal;
  const cancel = vi.fn();
  vi.spyOn(manager, "workspaceEvents").mockImplementation(async (_credential, current) => {
    signal = current;
    return new Response(new ReadableStream({ start(controller) { source = controller; controller.enqueue(new TextEncoder().encode("event: stream.ready\ndata: {}\n\n")); }, cancel }), { headers: { "content-type": "text/event-stream" } });
  });
  const first = await connected(await ticket("/api/development-workspaces/events"));
  await vi.waitFor(() => expect(first.chunks.join("")).toContain("stream.ready"));
  source.enqueue(new TextEncoder().encode("event: stream.revoked\ndata: {}\n\n"));
  await vi.waitFor(() => expect(first.socket.readyState).toBe(WebSocket.CLOSED));
  expect(first.chunks.join("")).toContain("stream.revoked"); expect(signal.aborted).toBe(true); expect(cancel).toHaveBeenCalledTimes(1);
  const second = await connected(await ticket("/api/development-workspaces/events"));
  await vi.waitFor(() => expect(second.chunks.join("")).toContain("stream.ready"));
  second.socket.close(); await vi.waitFor(() => expect(signal.aborted).toBe(true));
  expect(cancel).toHaveBeenCalledTimes(2);
});

it("releases a subscription completing after WebSocket close and terminates active sockets on server close", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const unsubscribe = vi.fn();
  vi.spyOn(manager, "subscribe").mockImplementation(async () => { entered(); await gate; return { replay: [], unsubscribe }; });
  const view = await connected(await ticket()); await started; view.socket.close();
  await vi.waitFor(() => expect(view.socket.readyState).toBe(WebSocket.CLOSED));
  release(); await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
  const next = await connected(await ticket());
  await close(server); await vi.waitFor(() => expect(next.socket.readyState).toBe(WebSocket.CLOSED));
  expect(unsubscribe).toHaveBeenCalledTimes(2);
});

async function direct() {
  let clock = Date.now();
  const extra = createServer((_request, response) => response.end()); extras.push(extra);
  const base = await listen(extra), transport = new EventStreamTransport(manager, () => clock); transports.push(transport); transport.attach(extra);
  const issue = () => transport.issue({ path: `/api/sessions/${sessionId}/events?after=0` }, { headers: { origin: base, host: new URL(base).host, authorization: "Bearer hostyg_owner" } } as IncomingMessage,
    { userId: "owner", via: "app-session", expiresAtSeconds: null });
  return { base, transport, issue, advance: (delta: number) => { clock += delta; } };
}

it("ends an upgrade when ticket expiry occurs during credential validation", async () => {
  const view = await direct(), admission = await view.issue(); view.advance(29_000);
  let entered!: () => void, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  hold = async () => { entered(); await gate; };
  const rejection = refused(socketFor(admission, view.base)); await started;
  view.advance(2000); release(); expect(await rejection).toBe(401);
});

it("does not revive a ticket's expired activity deadline after its credential is renewed", async () => {
  const view = await direct(); activeUntil = new Date(Date.now() + 1000).toISOString();
  const admission = await view.issue(); view.advance(2000); activeUntil = new Date(Date.now() + 3_600_000).toISOString();
  expect(await refused(socketFor(admission, view.base))).toBe(401);
});

it("aborts pending credential validation on browser disconnect and refuses minting after shutdown", async () => {
  const view = await direct(), admission = await view.issue();
  let entered!: () => void, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  let coreClosed = false; core.once("request", (_request, response) => response.once("close", () => { coreClosed = true; }));
  hold = async () => { entered(); await gate; };
  const opening = socketFor(admission, view.base); await started; opening.terminate();
  await vi.waitFor(() => expect(coreClosed).toBe(true));
  release(); hold = undefined;
  let enteredAgain!: () => void, releaseAgain!: () => void;
  const nextGate = new Promise<void>(resolve => { releaseAgain = resolve; }), nextStarted = new Promise<void>(resolve => { enteredAgain = resolve; });
  hold = async () => { enteredAgain(); await nextGate; };
  const issuing = view.issue(); const refusedIssue = expect(issuing).rejects.toMatchObject({ status: 503 });
  await nextStarted; view.transport.close(); releaseAgain(); await refusedIssue;
});

it("recovers a bounded live queue overflow through durable replay without losing the record", async () => {
  const original = manager.subscribe.bind(manager);
  let live!: Parameters<SessionManager["subscribe"]>[2];
  const unsubscribe = vi.fn();
  vi.spyOn(manager, "subscribe").mockImplementation(async (...args) => {
    live = args[2]; const value = await original(...args);
    return { ...value, unsubscribe: () => { unsubscribe(); value.unsubscribe(); } };
  });
  const view = await connected(await ticket());
  await vi.waitFor(() => expect(view.chunks.join("")).toContain("session_status"));
  const record = { seq: 1, ts: new Date().toISOString(), type: "assistant_text", text: "🟢".repeat(300_000) };
  await store.appendEvent(sessionId, record);
  const ended = new Promise<number>(resolve => view.socket.once("close", resolve));
  live(record); expect(await ended).toBe(1013);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  const recovered = await connected(await ticket());
  await vi.waitFor(() => expect(recovered.chunks.join("")).toContain('"session_status"'), { timeout: 3000 });
  expect(events(recovered.chunks).find(event => event.type === "assistant_text")).toEqual(record);
});

it("contains socket resets during malformed or refused upgrades and keeps ordinary requests working", async () => {
  const target = new URL(origin);
  await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise<void>(resolve => {
    const socket = connect(Number(target.port), target.hostname);
    socket.on("error", () => {}); socket.once("close", () => resolve());
    socket.once("connect", () => socket.write(`GET ${index % 2 ? "/api/event-stream" : "/unknown"} HTTP/1.1\r\nHost: ${target.host}\r\nOrigin: http://foreign.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`, () => socket.resetAndDestroy()));
  })));
  expect((await fetch(`${origin}/api/sessions/${sessionId}`, { headers: { authorization: "Bearer hostyg_owner" } })).status).toBe(200);
});

it("destroys refused upgrade sockets after flushing the response even when the peer leaves its write half open", async () => {
  const target = new URL(origin);
  let accepted!: import("node:stream").Duplex;
  server.once("upgrade", (_request, socket) => { accepted = socket; });
  const peer = connect({ port: Number(target.port), host: target.hostname, allowHalfOpen: true });
  peer.on("error", () => {});
  let response = ""; peer.on("data", data => { response += data.toString(); });
  try {
    await new Promise<void>(resolve => peer.once("connect", resolve));
    const ended = new Promise<void>(resolve => peer.once("end", resolve));
    peer.write(`GET /api/event-stream HTTP/1.1\r\nHost: ${target.host}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    await ended;
    expect(response).toContain("HTTP/1.1 401");
    await vi.waitFor(() => expect(accepted.destroyed).toBe(true));
  } finally { peer.destroy(); }
});
