import { fixtureCapabilities } from "./test-support/provider.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { AgentClient } from "@hosty-sdk/app/agent/client";
import type { AgentAuthorizationRequest, AgentRunInput, AgentSessionCreate } from "@hosty-sdk/app/agent";
import type { AgentConnections } from "./internal/connections/registry.js";
import type { ProviderAuthority } from "./core.js";
import { ProviderController, type ExecutionDriver } from "./controller.js";
import { ProviderStore, bytesHash, type VerifiedOperation } from "./store.js";
import { AttachmentStore } from "./attachments.js";
import { agentRoutes, json } from "./server.js";
import { projectEvent } from "./projection.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const provider = { appId: "third.party.agent", installationId: "opaque-provider-installation", key: "independent" };
const actor: VerifiedOperation = { userId: "user", principalId: "original-principal", callerAppId: "unrelated.consumer", callerInstallation: "consumer-installation", admissionRef: "admission-ref", operation: "runs.start", provider };
const configuration = { connection: { id: "connection", revision: "1" }, skills: [{ skillId: "f".repeat(64) }] };
const create: AgentSessionCreate = { configuration };
const input = (revision: string): AgentRunInput => ({ expectedSessionRevision: revision, configurationRevision: "1", continuation: "start", input: { text: "Hello" } });
async function fixture(capacity = 4, sessionId: string = randomUUID()) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hosty-provider-test-")); directories.push(dir); const skillsPath = path.join(dir, "skills"); await mkdir(skillsPath);
  const store = new ProviderStore(path.join(dir, "sessions"), provider); await store.initialize();
  const authority = { skills: vi.fn(async () => ({ id: "a".repeat(64), path: skillsPath, digest: "a".repeat(64), skills: [] })), admit: vi.fn(), renew: vi.fn() } as unknown as ProviderAuthority;
  const connections = { binding: vi.fn(async () => ({ connectionId: "connection", connectionRevision: 1, harnessKind: "fixture-engine" })) } as unknown as AgentConnections;
  const controller = new ProviderController(store, authority, connections, fixtureCapabilities, capacity);
  const driver: ExecutionDriver = { start: vi.fn(async () => {}), cancel: vi.fn(async () => {}), respond: vi.fn(async () => {}), control: vi.fn(async () => {}), synchronize: vi.fn(async () => {}), close: vi.fn(async () => {}) }; controller.driver = driver;
  await controller.createSession(sessionId, create, JSON.stringify(create), actor);
  return { dir, store, authority, connections, controller, driver, sessionId };
}
describe("independent provider admission", () => {
  it("creates durable metadata without starting an SDK and pins one immutable configuration", async () => {
    const f = await fixture(); expect(f.driver.start).not.toHaveBeenCalled(); expect(f.authority.admit).not.toHaveBeenCalled();
    const again = await f.controller.createSession(f.sessionId, create, JSON.stringify(create), actor);
    expect(again.nativeState).toBe("not_created"); expect(f.authority.skills).toHaveBeenCalledTimes(1);
    const restarted = new ProviderStore(f.store.directory, provider); await restarted.initialize(); expect((await restarted.load(f.sessionId, actor)).session).toEqual(again);
  });
  it("deduplicates exact run bytes before the busy/revision checks and rejects changed bytes", async () => {
    const f = await fixture(), runId = randomUUID(), command = input("1"), bytes = JSON.stringify(command);
    const first = await f.controller.startRun(f.sessionId, runId, command, bytes, actor);
    expect(await f.controller.startRun(f.sessionId, runId, command, bytes, actor)).toEqual(first);
    expect(f.driver.start).toHaveBeenCalledTimes(1);
    await expect(f.controller.startRun(f.sessionId, runId, command, bytes + " ", actor)).rejects.toMatchObject({ code: "request_conflict", status: 409 });
    await expect(f.controller.startRun(f.sessionId, randomUUID(), command, bytes, actor)).rejects.toMatchObject({ code: "session_busy" });
    await expect(f.store.run(runId, { ...actor, callerInstallation: "replacement" })).rejects.toMatchObject({ status: 404 });
    expect(first.cursor).toBe(f.store.cursor(first.generation, first.lastSequence));
    expect((await f.store.run(runId)).record.events.at(-1)?.data.snapshot).toEqual(first);
  });
  it("a before-admission cancellation fences a delayed identical start without a native effect", async () => {
    const f = await fixture(), id = randomUUID(), command = input("1"), body = JSON.stringify(command);
    const cancel = { requestId: randomUUID(), fenceIfNotAdmitted: { sessionId: f.sessionId, startDigest: bytesHash(body) } };
    const receipt = await f.controller.cancel(id, cancel, JSON.stringify(cancel), actor);
    expect(receipt.state).toBe("applied");
    const delayed = await f.controller.startRun(f.sessionId, id, command, body, actor);
    expect(delayed).toMatchObject({ state: "cancelled", stopConfirmed: true }); expect(f.driver.start).not.toHaveBeenCalled();
    expect((await f.store.load(f.sessionId)).session.activeRun).toBeNull();
  });
  it("retains unknown-stop capacity after process restart", async () => {
    const f = await fixture(1), command = input("1"), id = randomUUID(); await f.controller.startRun(f.sessionId, id, command, JSON.stringify(command), actor);
    await f.store.exclusive(async () => { const { session, record } = await f.store.run(id); record.snapshot.state = "unknown"; record.snapshot.phase = "interrupted"; await f.store.save(session); });
    const another = randomUUID(); await f.controller.createSession(another, create, JSON.stringify(create), actor);
    await expect(f.controller.startRun(another, randomUUID(), command, JSON.stringify(command), actor)).rejects.toMatchObject({ code: "provider_busy" });
  });
  it("does not advance the control revision for text deltas", async () => {
    const f = await fixture(), command = input("1"), id = randomUUID(); await f.controller.startRun(f.sessionId, id, command, JSON.stringify(command), actor);
    const { session, record } = await f.store.run(id), revision = record.snapshot.revision, sequence = record.snapshot.lastSequence;
    projectEvent(f.store, session, record, { runId: id, generation: "native", sequence: 1, event: { type: "assistant_delta", text: "Chunk" } });
    expect(record.snapshot.revision).toBe(revision); expect(BigInt(record.snapshot.lastSequence)).toBeGreaterThan(BigInt(sequence));
    expect(record.snapshot.messages?.[0]?.text).toBe("Chunk");
  });
  it("reserves cancellation after the ordinary control quota", async () => {
    const f = await fixture(), command = input("1"), id = randomUUID(); const run = await f.controller.startRun(f.sessionId, id, command, JSON.stringify(command), actor);
    await f.store.exclusive(async () => { const { session, record } = await f.store.run(id); for (let n = 0; n < 10000; n++) record.controls[String(n)] = { hash: "x", receipt: { requestId: String(n), run: run.ref, state: "applied", revision: run.revision } }; await f.store.save(session); });
    const cancel = { requestId: randomUUID(), expectedGeneration: run.generation, expectedRevision: run.revision };
    expect((await f.controller.cancel(id, cancel, JSON.stringify(cancel), actor)).state).toBe("accepted"); expect(f.driver.cancel).toHaveBeenCalledTimes(1);
    await f.controller.close();
  });
});
async function httpClient(f: Awaited<ReturnType<typeof fixture>>) {
  const proofs = new Map<string, AgentAuthorizationRequest>();
  f.authority.introspect = vi.fn(async (token, operation, method, route, hash) => {
    const proof = proofs.get(token); expect(proof).toMatchObject({ operation, method, path: route, bodyHash: hash });
    return { ...actor, operation, sessionId: proof?.sessionId, runId: proof?.runId };
  });
  const route = agentRoutes(f.controller, new AttachmentStore(path.join(f.dir, "assets"), provider));
  const server = createServer((req, res) => { void route(req, res, new URL(req.url!, "http://test.invalid"))
    .catch(error => json(res, error.status ?? 500, { error: { code: error.code, message: error.message, retryable: false } })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent/v1`;
  const client = new AgentClient({ provider, authorize: async request => {
    const token = randomUUID(); proofs.set(token, request);
    return { provider, baseUrl, token, expiresAt: new Date(Date.now() + 120000).toISOString() };
  } });
  return { client, baseUrl, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
describe("provider-owned assets and transport", () => {
  it("publishes immutable exact attachment bytes and hides another consumer's assets", async () => {
    const f = await fixture(), store = new AttachmentStore(path.join(f.dir, "assets"), provider), id = randomUUID(), bytes = Buffer.from("A user-owned document");
    const chunk = { digest: bytesHash(bytes), sizeBytes: bytes.length, mediaType: "text/plain", count: 1, data: bytes.toString("base64") };
    const result = await store.chunk(id, 0, chunk, actor); expect(result.attachment).not.toBeNull(); expect(await store.chunk(id, 0, chunk, actor)).toEqual(result);
    await expect(store.chunk(id, 0, { ...chunk, data: Buffer.from("B user-owned document").toString("base64") }, actor)).rejects.toMatchObject({ code: "request_conflict" });
    await expect(store.resolve(result.attachment!, { ...actor, userId: "another" })).rejects.toMatchObject({ status: 404 });
    const file = await store.resolve(result.attachment!, actor); await writeFile(file, "corrupted"); await expect(store.resolve(result.attachment!, actor)).rejects.toMatchObject({ code: "attachment_unavailable" });
  });
  it.each(["sessions", "connections"] as const)("paginates mixed-case %s identities through HTTP without omissions or duplicates", async kind => {
    const ids = kind === "sessions" ? [
      "0000000a-0000-4000-8000-000000000001",
      "0000000B-0000-4000-8000-000000000002",
      "0000000c-0000-4000-8000-000000000003",
      "0000000D-0000-4000-8000-000000000004",
      "0000000b-0000-4000-8000-000000000005",
    ] : ["account_a", "account_B", "account_c", "account_D", "account_b"];
    const f = await fixture(4, kind === "sessions" ? ids[0]! : randomUUID());
    f.connections.list = vi.fn(async () => ({ connections: ids.map(id => ({ id, revision: 1, name: id,
      kind: "fixture-engine" as const, auth: "api-key" as const, secretKey: "agent.fixture", available: true })),
      defaultId: ids[0]!, defaultBaseUrl: "" })) as typeof f.connections.list;
    const http = await httpClient(f);
    try {
      if (kind === "sessions") for (const id of ids) expect((await http.client.createSession(id, create)).ref.id).toBe(id);
      const list = async (query: { cursor?: string; limit?: number }) => {
        if (kind === "sessions") { const page = await http.client.sessions(query); return { ids: page.sessions.map(session => session.ref.id), nextCursor: page.nextCursor }; }
        const page = await http.client.connections(query); return { ids: page.connections.map(connection => connection.id), nextCursor: page.nextCursor };
      };
      const seen: string[] = [], cursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex <= ids.length; pageIndex++) {
        const page = await list({ limit: 1, cursor }); expect(page.ids).toHaveLength(1); seen.push(...page.ids);
        if (page.nextCursor === null) { cursor = undefined; break; }
        expect(cursors.has(page.nextCursor)).toBe(false); cursors.add(page.nextCursor); cursor = page.nextCursor;
      }
      expect(cursor).toBeUndefined();
      expect(seen).toEqual([ids[1], ids[3], ids[0], ids[4], ids[2]]);
      expect(new Set(seen).size).toBe(ids.length);
      for (const malformed of ["not-json", Buffer.from(JSON.stringify({ id: ids[0] })).toString("base64url")])
        await expect(list({ limit: 1, cursor: malformed })).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
      const tooLong = await fetch(`${http.baseUrl}/${kind}?limit=1&cursor=${"a".repeat(8193)}`, { headers: { authorization: "Bearer bounded-query" } });
      expect(tooLong.status).toBe(400); expect(await tooLong.json()).toMatchObject({ error: { code: "invalid_input" } });
    } finally { await http.close(); }
  });
  it("serves an unrelated SDK consumer through operation-bound HTTP and replay SSE", async () => {
    const f = await fixture(); const proofs = new Map<string, { method: string; path: string; bodyHash: string; operation: string; sessionId?: string; runId?: string }>();
    f.authority.introspect = vi.fn(async (token, operation, method, route, hash) => { const proof = proofs.get(token); expect(proof).toMatchObject({ operation, method, path: route, bodyHash: hash }); return { ...actor, operation, sessionId: proof?.sessionId, runId: proof?.runId }; });
    f.connections.list = vi.fn(async () => ({ connections: [{ id: "connection", revision: 1, name: "Configured", kind: "fixture-engine" as const, auth: "api-key" as const, secretKey: "agent.fixture", available: true }], defaultId: "connection", defaultBaseUrl: "" })) as typeof f.connections.list;
    const route = agentRoutes(f.controller, new AttachmentStore(path.join(f.dir, "assets"), provider));
    const server = createServer((req, res) => { void route(req, res, new URL(req.url!, "http://test.invalid")).catch(error => json(res, error.status ?? 500, { error: { code: error.code, message: error.message, retryable: false } })); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address() as { port: number };
    const statuses: Array<{ method?: string; path: string; status: number }> = [];
    const client = new AgentClient({ provider, fetch: async (url, init) => { const response = await fetch(url, init); statuses.push({ method: init?.method, path: new URL(String(url)).pathname, status: response.status }); return response; }, authorize: async request => { const token = randomUUID(); proofs.set(token, request); return { provider, baseUrl: `http://127.0.0.1:${address.port}/api/agent/v1`, token, expiresAt: new Date(Date.now() + 120000).toISOString() }; } });
    const abort = new AbortController();
    try {
      expect((await client.capabilities()).version).toBe(1); expect((await client.connections()).connections[0]?.name).toBe("Configured");
      const createdId = randomUUID(); await client.createSession(createdId, create); await client.createSession(createdId, create);
      const id = randomUUID(), command = input("1"), snapshot = await client.startRun(f.sessionId, id, command);
      await client.startRun(f.sessionId, id, command);
      expect(statuses.filter(value => value.method === "PUT").map(value => value.status)).toEqual([201, 200, 202, 200]);
      const stream = client.events(id, { signal: abort.signal }); const event = await stream.next();
      expect(event.value?.event).toMatchObject({ type: "run.updated", data: { snapshot: { ref: { id } } } });
      expect(snapshot.lastSequence).toBe("1"); abort.abort(); await stream.return(undefined);
      await f.store.exclusive(async () => { const { session, record } = await f.store.run(id); record.events = []; record.firstSequence = "2"; await f.store.save(session); });
      const expired = client.events(id, { cursor: f.store.cursor(snapshot.generation, "0") });
      await expect(expired.next()).rejects.toMatchObject({ status: 410, code: "replay_expired" });
    } finally { abort.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

async function asyncQuestion(f: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID(), command = input("1"); await f.controller.startRun(f.sessionId, id, command, JSON.stringify(command), actor);
  await f.store.exclusive(async () => {
    const { session, record } = await f.store.run(id); session.nativeId = "native-session"; session.session.nativeState = "available"; session.session.activeRun = null; session.session.revision = "3";
    record.snapshot.state = "succeeded"; record.snapshot.phase = "terminal"; record.snapshot.stopConfirmed = true;
    record.snapshot.pending = [{ id: "async-question", revision: "1", kind: "question", delivery: "next_turn", questions: [{ id: "choice", text: "Continue?", allowText: false, options: [{ id: "yes", label: "Yes" }] }] }];
    f.store.lifecycle(record); await f.store.save(session);
  });
  const snapshot = await f.controller.snapshot(id);
  const response = { requestId: randomUUID(), expectedGeneration: snapshot.generation, expectedRevision: snapshot.revision, decisionId: "async-question", decisionRevision: "1", response: { kind: "question" as const, answers: { choice: ["yes"] } } };
  return { id, snapshot, response };
}
describe("durable next-turn decisions", () => {
  it("reserves its own run and requires fresh explicit admission rather than replaying history", async () => {
    const f = await fixture(), q = await asyncQuestion(f);
    const receipt = await f.controller.respond(q.id, q.response, JSON.stringify(q.response), actor);
    expect(receipt.continuation?.state).toBe("awaiting_authorization"); expect(f.driver.start).toHaveBeenCalledTimes(1);
    const runId = receipt.continuation!.run.id, reserved = await f.controller.snapshot(runId);
    expect(reserved).toMatchObject({ state: "queued", stopConfirmed: true });
    const restarted = new ProviderStore(f.store.directory, provider); await restarted.initialize();
    expect((await restarted.run(q.id, actor)).record.snapshot.pendingContinuations).toContainEqual({ requestId: q.response.requestId, ...receipt.continuation });
    const command: AgentRunInput = { expectedSessionRevision: "3", configurationRevision: "1", continuation: "resume", input: { decisionResponseRef: { runId: q.id, requestId: q.response.requestId } } };
    await expect(f.controller.startRun(f.sessionId, randomUUID(), command, JSON.stringify(command), actor)).rejects.toMatchObject({ code: "decision_continuation_missing" });
    const started = await f.controller.startRun(f.sessionId, runId, command, JSON.stringify(command), actor);
    expect(started.generation).toBe(reserved.generation); expect(started.stopConfirmed).toBe(false); expect(f.driver.start).toHaveBeenCalledTimes(2);
    expect((await f.store.run(q.id)).record.controls[q.response.requestId]?.receipt.continuation?.state).toBe("admitted");
    expect(await f.controller.startRun(f.sessionId, runId, command, JSON.stringify(command), actor)).toEqual(started);
  });
  it("fences a delayed response after Stop even when no continuation was reserved yet", async () => {
    const f = await fixture(), q = await asyncQuestion(f), cancel = { requestId: randomUUID(), expectedGeneration: q.snapshot.generation, expectedRevision: q.snapshot.revision };
    await f.controller.cancel(q.id, cancel, JSON.stringify(cancel), actor);
    await expect(f.controller.respond(q.id, q.response, JSON.stringify(q.response), actor)).rejects.toMatchObject({ code: "run_fenced" });
    expect((await f.store.run(q.id)).record.snapshot.pending).toEqual([]); expect(f.driver.start).toHaveBeenCalledTimes(1);
  });
  it("cancels the reserved attempt without a native process and blocks its delayed start", async () => {
    const f = await fixture(), q = await asyncQuestion(f), receipt = await f.controller.respond(q.id, q.response, JSON.stringify(q.response), actor), id = receipt.continuation!.run.id;
    const reserved = await f.controller.snapshot(id), cancel = { requestId: randomUUID(), expectedGeneration: reserved.generation, expectedRevision: reserved.revision };
    await f.controller.cancel(id, cancel, JSON.stringify(cancel), actor);
    expect((await f.controller.snapshot(id)).state).toBe("cancelled");
    const command: AgentRunInput = { expectedSessionRevision: "3", configurationRevision: "1", continuation: "resume", input: { decisionResponseRef: { runId: q.id, requestId: q.response.requestId } } };
    await expect(f.controller.startRun(f.sessionId, id, command, JSON.stringify(command), actor)).rejects.toMatchObject({ code: "request_conflict" });
    expect(f.driver.start).toHaveBeenCalledTimes(1);
  });
  it("rejects undeclared question choices before allocating a response intent", async () => {
    const f = await fixture(), q = await asyncQuestion(f), invalid = { ...q.response, response: { kind: "question" as const, answers: { choice: ["undeclared"] } } };
    await expect(f.controller.respond(q.id, invalid, JSON.stringify(invalid), actor)).rejects.toMatchObject({ code: "invalid_response" });
    expect((await f.store.run(q.id)).record.controls).not.toHaveProperty(q.response.requestId);
  });
});
