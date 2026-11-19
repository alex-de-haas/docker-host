import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentWatchItem } from "@hosty-sdk/app/agent";
import { validateAgentRunSnapshot } from "@hosty-sdk/app/agent/server";
import { ProviderStore, type VerifiedOperation } from "./store.js";
import { ProviderController } from "./controller.js";
import { fixtureCapabilities } from "./test-support/provider.js";
import { agentRoutes, json } from "./server.js";
import { AgentApiError } from "@hosty-sdk/app/agent";
import type { ProviderAuthority } from "./core.js";

const provider = { appId: "fixture.agent", installationId: "provider-A", key: "test" };
const alice: VerifiedOperation = { userId: "alice", principalId: "principal-a", callerAppId: "fixture.harness",
  callerInstallation: "install-1", operation: "runs.start", admissionRef: "private-admission", provider };
const bob = { ...alice, userId: "bob", principalId: "principal-b" };
const configuration = { connection: { id: "conn", revision: "1" } };
const stores: ProviderStore[] = [], directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.history.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function openStore(directory?: string) {
  if (!directory) { directory = await mkdtemp(path.join(os.tmpdir(), "result-delivery-")); directories.push(directory); }
  const store = new ProviderStore(directory, provider, 512);
  await store.initialize(); stores.push(store); return store;
}
async function admitted(store: ProviderStore, actor = alice) {
  const sessionId = randomUUID(), runId = randomUUID();
  await store.create(sessionId, actor, "request", { configuration }, { configuration, digest: "a".repeat(64), resolvedSkills: [] });
  const session = await store.load(sessionId, actor);
  const run = store.makeRun(session, runId, actor, "{}");
  session.runs[runId] = run;
  store.lifecycle(run); await store.save(session);
  return { session, run, runId };
}
const eventType = (item: AgentWatchItem) => item.kind === "event" ? item.event.type : item.kind;

it("recovers three offline conversations for two owners through one installation, retaining facts beyond replay", async () => {
  const store = await openStore();
  const foreign = { ...alice, callerInstallation: "install-2" };
  const runs = [];
  for (const owner of [alice, alice, bob, foreign]) {
    const { session, run, runId } = await admitted(store, owner); runs.push(runId);
    store.emit(run, "tool.started", { toolCallId: "call", name: "fixture-tool", input: {}, state: "running" });
    for (let i = 0; i < 35; i++) store.emit(run, "message.completed", { messageId: "answer-" + i, text: "output " + i });
    store.emit(run, "tool.completed", { toolCallId: "call", name: "fixture-tool", output: "ok", state: "completed", truncated: true });
    run.snapshot.state = "succeeded"; run.snapshot.stopConfirmed = true; run.snapshot.phase = "terminal";
    store.lifecycle(run);
    await store.save(session);
    expect(run.events.length).toBeLessThan(35);
  }
  const reopened = await openStore(store.directory);
  const first = reopened.history.page(alice, undefined, undefined, 2);
  expect(first.nextCursor).toBeTruthy();
  await admitted(reopened, alice);
  const all = [...first.observations];
  let next = first.nextCursor;
  while (next) {
    const page = reopened.history.page(alice, next, first.through, 7);
    all.push(...page.observations); next = page.nextCursor;
  }
  expect(new Set(all.map(row => row.runId))).toEqual(new Set(runs.slice(0, 3)));
  expect(new Set(all.map(row => row.cursor)).size).toBe(all.length);
  for (const [index, runId] of runs.slice(0, 3).entries()) {
    const group = all.filter(row => row.runId === runId);
    expect(group.every(row => row.userId === (index === 2 ? "bob" : "alice"))).toBe(true);
    expect(group.filter(row => eventType(row.item) === "message.completed")).toHaveLength(35);
    expect(group.filter(row => eventType(row.item) === "tool.completed")).toHaveLength(1);
    expect(group.at(-1)?.item).toMatchObject({ event: { data: { snapshot: { stopConfirmed: true } } } });
    expect(JSON.stringify(group)).not.toContain("private-admission");
  }
  expect(reopened.history.page(alice, first.through).observations).toHaveLength(1);
  expect(() => reopened.history.page(foreign, first.through)).toThrowError(expect.objectContaining({ status: 410 }));
  expect(reopened.history.page({ ...alice, callerAppId: "different.app" }).observations).toEqual([]);
});

it("retains an interrupted execution and its later confirmed outcome at distinct replay positions", async () => {
  const store = await openStore(), { session, run } = await admitted(store);
  const decision = { id: randomUUID(), revision: "1", kind: "approval", delivery: "continue_run" };
  store.emit(run, "decision.requested", { decisionId: decision.id, decision });
  store.emit(run, "decision.resolved", { decisionId: decision.id, decision, state: "resolved", response: { kind: "approval", decision: "deny" } });
  store.emit(run, "tool.started", { toolCallId: "pending", name: "Command", state: "running" });
  run.snapshot.state = "unknown"; run.snapshot.phase = "interrupted"; run.snapshot.stopConfirmed = false;
  store.lifecycle(run);
  await store.save(session);
  const interrupted = store.history.page(alice);
  expect(interrupted.observations.map(row => eventType(row.item))).toEqual([
    "run.updated", "decision.requested", "decision.resolved", "tool.started", "run.updated",
  ]);
  expect(interrupted.observations.at(-1)?.item).toMatchObject({ event: { data: { snapshot: { state: "unknown", stopConfirmed: false } } } });

  const restored = await openStore(store.directory);
  const retained = await restored.load(session.id, alice), resumed = retained.runs[run.snapshot.ref.id]!;
  restored.emit(resumed, "tool.completed", { toolCallId: "pending", name: "Command", output: "late evidence", state: "failed" });
  resumed.snapshot.state = "failed"; resumed.snapshot.phase = "terminal"; resumed.snapshot.stopConfirmed = true;
  restored.lifecycle(resumed);
  await restored.save(retained);
  const late = restored.history.page(alice, interrupted.through).observations;
  expect(late.map(row => eventType(row.item))).toEqual(["tool.completed", "run.updated"]);
  expect(late[0]?.item).toMatchObject({ event: { data: { toolCallId: "pending", state: "failed" } } });
  expect(late[1]?.item).toMatchObject({ event: { data: { snapshot: { state: "failed", stopConfirmed: true } } } });
});

it("recovers a committed outbox after interruption and replays the same cursors only once", async () => {
  const store = await openStore(), { session, run } = await admitted(store);
  const cursor = store.history.page(alice).through;
  const fault = vi.spyOn(store.history, "publish").mockImplementationOnce(() => { throw new Error("simulated interruption"); });
  store.emit(run, "message.completed", { messageId: "last", text: "final answer" });
  await expect(store.save(session)).rejects.toThrow("interruption");
  fault.mockRestore();
  const restored = await openStore(store.directory);
  const backfill = restored.history.page(alice, cursor);
  expect(backfill.observations).toHaveLength(1);
  const reopened = await openStore(store.directory);
  expect(reopened.history.page(alice, cursor)).toEqual(backfill);
});

it.each(["lost", "rolled back"])("recovers retained evidence and rejects obsolete cursors when the archive is %s", async damage => {
  const store = await openStore(), { session, run } = await admitted(store);
  const archive = path.join(store.directory, "installation-history.sqlite");
  const oldCursor = store.history.page(alice).through;
  await copyFile(archive, archive + ".backup");
  store.emit(run, "message.completed", { messageId: "old", text: "an older fact" });
  await store.save(session);
  run.snapshot.messages = [{ id: "latest", role: "assistant", state: "complete", text: "last known answer" }];
  run.snapshot.state = "failed"; run.snapshot.phase = "terminal"; run.snapshot.stopConfirmed = true;
  store.lifecycle(run);
  await store.save(session);
  await store.save(session); // Clear the crash outbox; the final snapshot and previous journal receipt still exist.
  store.history.close();
  if (damage === "lost") await rm(archive);
  else await copyFile(archive + ".backup", archive);
  const restored = await openStore(store.directory);
  expect(() => restored.history.page(alice, oldCursor)).toThrowError(expect.objectContaining({ status: 410 }));
  const page = restored.history.page(alice);
  expect(page.observations.at(-1)?.item).toMatchObject({ kind: "snapshot", snapshot: {
    state: "failed", stopConfirmed: true, messages: [{ text: "last known answer" }],
    coverage: { messages: "truncated", tools: "truncated", decisions: "truncated" },
  } });
  expect((await openStore(store.directory)).history.page(alice)).toEqual(page);
});

it("rejects a cursor from a discarded timeline after a consistent backup grows past its old position", async () => {
  const store = await openStore(), { session, run, runId } = await admitted(store);
  const files = [path.join(store.directory, "installation-history.sqlite"), path.join(store.directory, session.id + ".json")];
  for (const file of files) await copyFile(file, file + ".backup");
  const common = store.history.page(alice).through;
  store.emit(run, "message.completed", { messageId: "before", text: "old result" });
  await store.save(session);
  const discarded = store.history.page(alice).through;
  store.history.close();
  for (const file of files) await copyFile(file + ".backup", file);
  const restored = await openStore(store.directory);
  const retained = await restored.run(runId);
  restored.emit(retained.record, "message.completed", { messageId: "after", text: "new result" });
  await restored.save(retained.session);
  expect(() => restored.history.page(alice, discarded)).toThrowError(expect.objectContaining({ status: 410 }));
  expect(restored.history.page(alice, common).observations.map(row => row.item)).toMatchObject([
    { event: { data: { messageId: "after", text: "new result" } } },
  ]);
});

it("serves live deltas only while observed and retains the completed message across disconnect", async () => {
  const store = await openStore(), { session, run } = await admitted(store);
  const after = store.history.page(alice).through, changed = vi.fn();
  const close = store.history.subscribe(alice, changed);
  store.emit(run, "message.delta", { messageId: "answer", text: "draft" });
  store.emit(run, "message.completed", { messageId: "answer", text: "final" });
  await store.save(session);
  expect(changed).toHaveBeenCalledOnce();
  expect(store.history.page(alice, after, undefined, 4, true).observations.map(row => eventType(row.item))).toEqual(["message.delta", "message.completed"]);
  close();
  expect(store.history.page(alice, after).observations.map(row => eventType(row.item))).toEqual(["message.completed"]);
});

it("adopts legacy snapshots with an explicit coverage gap when detailed replay is unavailable", async () => {
  const store = await openStore(), { session, run } = await admitted(store);
  const old = await openStore();
  delete run.historyVersion; delete run.historyOutbox;
  run.events = []; run.firstSequence = "9"; run.snapshot.lastSequence = "8"; run.snapshot.cursor = store.cursor(run.snapshot.generation, "8");
  run.snapshot.messages = [{ id: "latest", role: "assistant", state: "complete", text: "last known answer" }];
  await writeFile(path.join(old.directory, session.id + ".json"), JSON.stringify(session));
  const upgraded = await openStore(old.directory);
  const entries = upgraded.history.page(alice).observations;
  expect(entries).toHaveLength(2);
  expect(entries[0]!.item).toMatchObject({ kind: "snapshot", snapshot: { lastSequence: "0", state: "unknown", freshness: "unavailable" } });
  expect(entries[1]!.item).toMatchObject({ kind: "snapshot", snapshot: { lastSequence: "8", coverage: { messages: "truncated" }, messages: [{ text: "last known answer" }] } });
  for (const entry of entries) if (entry.item.kind === "snapshot") validateAgentRunSnapshot(entry.item.snapshot);
});

it("reads a committed status even while native synchronization is awaiting further output", async () => {
  const store = await openStore(), { runId } = await admitted(store);
  const controller = new ProviderController(store, {} as never, {} as never, fixtureCapabilities);
  let settle!: () => void;
  controller.driver = { synchronize: () => new Promise<void>(resolve => { settle = resolve; }) } as never;
  try { expect((await controller.snapshot(runId, alice, { committedOnly: true })).ref.id).toBe(runId); }
  finally { settle(); }
});

it("serves the same scoped facts through HTTP paging and SSE, and closes a quiet subscription on revocation", async () => {
  const store = await openStore(), expected = await admitted(store);
  const clock = vi.spyOn(globalThis, "setInterval");
  const validate = vi.fn(async (token: string) => {
    if (token !== "history") throw new AgentApiError("permission_denied", "Wrong credential.", 403);
    return { ...alice, provider, expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() };
  });
  const authority = { history: validate, introspect: vi.fn(async () => { throw new AgentApiError("permission_denied", "Wrong credential.", 403); }) };
  const controller = new ProviderController(store, authority as unknown as ProviderAuthority, {} as never, fixtureCapabilities);
  const handler = agentRoutes(controller, {} as never);
  const server = createServer((request, response) => {
    void handler(request, response, new URL(request.url!, "http://test.invalid")).catch(error => json(response, error.status ?? 500, { error: error.code }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a test port.");
  const root = "http://127.0.0.1:" + address.port + "/api/agent/v1", url = root + "/history/events";
  const headers = { authorization: "Bearer history" };
  try {
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: "Bearer execution" } })).status).toBe(403);
    const page = await (await fetch(url + "?limit=1", { headers: { ...headers, accept: "application/json" } })).json() as ReturnType<typeof store.history.page>;
    expect(page.observations).toMatchObject([{ runId: expected.runId, userId: alice.userId }]);
    expect((await fetch(url + "?after=foreign.1", { headers })).status).toBe(410);
    expect((await fetch(root + "/runs/" + expected.runId, { headers })).status).toBe(403);
    const response = await fetch(url, { headers }), reader = response.body!.getReader();
    const decoder = new TextDecoder(); let text = "";
    while (!text.includes("event: observation")) text += decoder.decode((await reader.read()).value);
    expect(text).toContain("id: " + page.observations[0]!.cursor);
    expect(text).toContain(expected.runId);
    // Invoke the actual authority timer; a quiet stream has no producer writes to trigger it.
    const timer = clock.mock.calls.find(call => call[1] === 30_000);
    expect(timer).toBeDefined();
    validate.mockRejectedValueOnce(new AgentApiError("permission_denied", "Revoked.", 403));
    (timer![0] as () => void)();
    expect((await reader.read()).done).toBe(true);
    expect(validate).toHaveBeenLastCalledWith("history", provider.key);
    validate.mockResolvedValueOnce({ ...alice, provider, expiresAt: new Date(Date.now() - 1).toISOString() });
    expect((await fetch(url, { headers })).status).toBe(401);
    validate.mockResolvedValueOnce({ ...alice, provider, expiresAt: new Date(Date.now() + 150).toISOString() });
    const quiet = await fetch(url + "?after=" + page.through, { headers });
    expect(quiet.status).toBe(200);
    expect(await quiet.text()).toBe(": ready\n\n");
  } finally {
    const ended = once(server, "close"); server.close(); server.closeAllConnections(); await ended;
  }
});
