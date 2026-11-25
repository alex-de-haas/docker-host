import { WorkerJournal } from "./internal/worker/journal.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { watchLiveAgentHistory, readAgentHistoryStates, readAgentHistoryRange } from "@hosty-sdk/app/agent/client";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentWatchItem } from "@hosty-sdk/app/agent";
import { validateAgentRunSnapshot } from "@hosty-sdk/app/agent/server";
import { ProviderStore, type VerifiedOperation } from "./store.js";
import { projectEvent, publicSource, publicToolId } from "./projection.js";
import type { HarnessEvent } from "./internal/harness/adapter.js";
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

it("throttles only the chat with an unacknowledged backlog and releases it after a durable receipt", async () => {
  const store = await openStore();
  const { session, run } = await admitted(store);
  store.emit(run, "message.completed", { messageId: "large", text: "content".repeat(64) });
  await store.save(session);
  expect(() => store.history.requireDeliveryCapacity(alice, session.id, 32)).toThrow(/durable delivery/);
  expect(() => store.history.requireDeliveryCapacity(alice, randomUUID(), 32)).not.toThrow();
  const state = store.history.states(alice, store.history.currentBoundary(alice), undefined, 10).sessions[0]!;
  store.history.acknowledgeThrough(alice, session.id, state.epoch, state.head);
  store.history.acknowledgeThrough(alice, session.id, state.epoch, state.head);
  expect(() => store.history.requireDeliveryCapacity(alice, session.id, 32)).not.toThrow();
});

it("keeps recording an active chat past its admission watermark and commits its Stop while the receiver is offline", async () => {
  const store = await openStore(), active = await admitted(store), sibling = await admitted(store);
  for (const [index, text] of ["before the watermark", "after the watermark"].entries()) {
    store.emit(active.run, "message.completed", { messageId: "message-" + index, text });
    await store.save(active.session);
    expect(() => store.history.requireDeliveryCapacity(alice, active.session.id, 32)).toThrow(/durable delivery/);
  }
  const before = store.history.states(alice, store.history.currentBoundary(alice), undefined, 10);
  const owner = before.sessions.find(chat => chat.sessionId === active.session.id)!;
  const rows = store.history.range(alice, before.through, active.session.id, owner.epoch, 1, owner.head, 10);
  expect(rows.observations.flatMap(({ item }) => item.kind === "event" && item.event.type === "message.completed" ? [item.event.data.text] : []))
    .toEqual(["before the watermark", "after the watermark"]);
  store.emit(sibling.run, "message.completed", { messageId: "healthy", text: "independent" }); await store.save(sibling.session);
  active.run.snapshot.stopConfirmed = true; active.run.snapshot.state = "cancelled"; active.run.snapshot.phase = "terminal";
  store.lifecycle(active.run); await store.save(active.session);
  const after = store.history.states(alice, store.history.currentBoundary(alice), undefined, 10);
  const stopped = after.sessions.find(chat => chat.sessionId === active.session.id)!;
  expect(stopped.head).toBeGreaterThan(owner.head);
  expect((await store.run(active.runId)).record.snapshot.stopConfirmed).toBe(true);
  store.history.acknowledgeThrough(alice, active.session.id, stopped.epoch, stopped.head);
  expect(() => store.history.requireDeliveryCapacity(alice, active.session.id, 32)).not.toThrow();
});

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

it("recovers evicted tool names for isolated live and range completions without copying protected output", async () => {
  const store = await openStore(), { run, session, runId } = await admitted(store);
  const append = (event: HarnessEvent) => projectEvent(store, session, run, {
    runId, generation: "native", sequence: run.nativeSequence + 1, event,
  });
  const child = { agentId: "child", parentAgentId: "root" }, setup = "mcp__hosty-workspaces__environment_setup";
  append({ type: "tool_use", toolUseId: "long", toolName: "Command", input: {} });
  append({ type: "tool_use", toolUseId: "long", toolName: setup, input: {}, source: child });
  for (let i = 0; i < 16; i++) append({ type: "tool_use", toolUseId: "other-" + i, toolName: "Read", input: {} });
  expect(run.snapshot.tools?.every(tool => tool.name === "Read")).toBe(true);
  await store.save(session);
  const before = store.history.currentBoundary(alice);
  append({ type: "tool_result", toolUseId: "long", output: "public result", status: "completed" });
  append({ type: "tool_result", toolUseId: "long", output: "private setup result", status: "completed", source: child });
  // A v1 completion can omit its name. A matching call ID from another agent cannot identify it.
  const otherSource = { agentId: "another-agent" }, id = publicToolId("long");
  store.emit(run, "tool.completed", { toolCallId: id, output: "unclassified result", state: "failed" }, otherSource);
  store.emit(run, "tool.started", { toolCallId: id, name: "Later" }, otherSource);
  store.emit(run, "tool.completed", { toolCallId: id, output: "named from start", state: "completed" });
  await store.save(session);
  const live = store.history.page(alice, before, undefined, 10, true, true).observations;
  expect(live[0]?.item).toMatchObject({ event: { data: { toolCallId: id, name: "Command", output: "public result" } } });
  expect(live[1]?.item).toMatchObject({ event: { source: publicSource(child), data: { name: setup, state: "completed" } } });
  expect(live[2]?.item).toMatchObject({ event: { source: otherSource, data: { state: "failed" } } });
  expect(live[4]?.item).toMatchObject({ event: { data: { name: "Command", output: "named from start" } } });
  expect(JSON.stringify(live)).not.toMatch(/private setup result|unclassified result/);

  const db = new DatabaseSync(store.databasePath);
  try { db.exec("DROP INDEX history_tool_start"); } finally { db.close(); }
  const reopened = await openStore(store.directory);
  const inventory = reopened.history.states(alice), state = inventory.sessions[0]!;
  for (const completion of live.filter(row => eventType(row.item) === "tool.completed")) {
    const n = completion.sessionPosition!;
    expect(reopened.history.range(alice, inventory.through, session.id, state.epoch, n, n, 1).observations).toEqual([completion]);
  }
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

it("retries the entire transition after a failed history insert and publishes one event", async () => {
  const store = await openStore(), { session, run, runId } = await admitted(store);
  const cursor = store.history.page(alice).through;
  store.emit(run, "message.completed", { messageId: "last", text: "final answer" });
  store.history.database(db => db.exec("CREATE TRIGGER block_history BEFORE INSERT ON history_facts BEGIN SELECT RAISE(ABORT,'simulated I/O failure'); END"));
  await expect(store.save(session)).rejects.toMatchObject({ code: "storage_unavailable" });
  const reopened = await openStore(store.directory);
  expect(reopened.history.page(alice, cursor).observations).toEqual([]);
  expect((await reopened.run(runId)).record.snapshot.lastSequence).not.toEqual(run.snapshot.lastSequence);
  reopened.history.database(db => db.exec("DROP TRIGGER block_history"));
  await store.save(session);
  const committed = reopened.history.page(alice, cursor);
  expect(committed.observations.map(row => eventType(row.item))).toEqual(["message.completed"]);
  await store.save(session);
  expect(reopened.history.page(alice, cursor)).toEqual(committed);
});

it("discards only the closed run's public replay and fenced delivery, including lost responses and late writes", async () => {
  const store = await openStore(), closed = await admitted(store);
  const other = await admitted(store, bob);
  const controller = (value: ProviderStore) => new ProviderController(value, {} as never, {} as never, fixtureCapabilities);
  const actor = { ...alice, cleanupOnly: true, operation: "runs.discard", runId: closed.runId, sessionId: closed.session.id };
  const request = randomUUID();
  await expect(controller(store).discardDelivery(closed.runId, request, { ...actor, cleanupOnly: false })).rejects.toMatchObject({ status: 403 });
  await expect(controller(store).discardDelivery(closed.runId, request, actor)).rejects.toMatchObject({ code: "discard_pending" });
  store.emit(closed.run, "message.completed", { messageId: "last", text: "private answer" });
  closed.run.snapshot.state = "cancelled"; closed.run.snapshot.phase = "terminal"; closed.run.snapshot.stopConfirmed = true;
  store.lifecycle(closed.run); await store.save(closed.session);
  const journal = new WorkerJournal(store.directory, undefined, undefined, "local", store.databasePath);
  const raw = journal.observations(closed.runId)!;
  raw.write({ retained: "private callback" });
  expect(raw.read()).toEqual({ retained: "private callback" });
  const sibling = store.makeRun(closed.session, randomUUID(), alice, "{}");
  closed.session.runs[sibling.snapshot.ref.id] = sibling;
  store.lifecycle(sibling); await store.save(closed.session);
  const stale = await store.load(closed.session.id);
  await expect(controller(store).discardDelivery(closed.runId, request, { ...actor, admissionRef: "other-admission" })).rejects.toMatchObject({ status: 403 });
  const proof = { runId: closed.runId, requestId: request, state: "discarded" };
  expect(await controller(store).discardDelivery(closed.runId, request, actor)).toEqual(proof);
  const next = await openStore(store.directory);
  expect(await controller(next).discardDelivery(closed.runId, request, actor)).toEqual(proof);
  expect(next.history.page(alice).observations.map(item => item.runId)).toEqual([other.runId, sibling.snapshot.ref.id]);
  await expect(next.run(closed.runId, alice)).rejects.toMatchObject({ status: 404 });
  store.emit(stale.runs[closed.runId]!, "message.completed", { messageId: "late", text: "delayed private answer" });
  await expect(store.save(stale)).rejects.toMatchObject({ code: "state_changed" });
  expect(next.history.page(alice).observations.map(item => item.runId)).toEqual([other.runId, sibling.snapshot.ref.id]);
  const statePage = next.history.states(alice);
  const state = statePage.sessions.find(session => session.sessionId === closed.session.id)!;
  const remaining = next.history.range(alice, statePage.through, closed.session.id, state.epoch, state.head, state.head, 1);
  expect(remaining.observations[0]?.runId).toBe(sibling.snapshot.ref.id);
  expect(next.historicalRunIds.has(closed.runId)).toBe(true);
  expect(raw.read()).toBeNull();
  expect(() => raw.write({ retained: "late callback" })).toThrow("was discarded");
  journal.close();
});

it("retains unacknowledged facts and prunes only the owning installation's acknowledged window", async () => {
  const store = await openStore(), { session, run } = await admitted(store);
  const foreign = { ...alice, callerInstallation: "other-installation" };
  for (let i = 0; i < 300; i++) store.emit(run, "message.delta", { messageId: "draft", text: String(i) });
  await store.save(session);
  const page = store.history.states(alice), state = page.sessions[0]!;
  expect(state.head).toBe(301);
  const current = await openStore(store.directory);
  for (const owner of [foreign, alice]) {
    if (owner === foreign) expect(() => current.history.acknowledgeThrough(owner, session.id, state.epoch, 301)).toThrow();
    else expect(current.history.range(owner, page.through, session.id, state.epoch, 2, 2, 1).observations[0]!.item)
      .toMatchObject({ event: { data: { text: "0" } } });
  }
  for (const ack of [301, 280, 301]) current.history.acknowledgeThrough(alice, session.id, state.epoch, ack);
  expect(() => current.history.range(alice, page.through, session.id, state.epoch, 2, 2, 1))
    .toThrowError(expect.objectContaining({ status: 410 }));
  expect(current.history.range(alice, page.through, session.id, state.epoch, 301, 301, 1).observations[0]!.item)
    .toMatchObject({ event: { data: { text: "299" } } });
});

it("rejects a cursor from a discarded timeline after a consistent backup grows past its old position", async () => {
  const store = await openStore(), { session, run, runId } = await admitted(store);
  const files = [store.databasePath];
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

it("retains acknowledged-order deltas and the completed message across disconnect", async () => {
  const store = await openStore(), { session, run } = await admitted(store);
  const after = store.history.page(alice).through, changed = vi.fn();
  const close = store.history.subscribe(alice, changed);
  store.emit(run, "message.delta", { messageId: "answer", text: "draft" });
  store.emit(run, "message.completed", { messageId: "answer", text: "final" });
  await store.save(session);
  expect(changed).toHaveBeenCalledOnce();
  expect(store.history.page(alice, after, undefined, 4, true).observations.map(row => eventType(row.item))).toEqual(["message.delta", "message.completed"]);
  close();
  expect(store.history.page(alice, after).observations.map(row => eventType(row.item))).toEqual(["message.delta", "message.completed"]);
});

it("opens an empty generation beside legacy data and never imports an old writer", async () => {
  const store = await openStore(), { session } = await admitted(store);
  const other = await openStore();
  await writeFile(path.join(other.directory, session.id + ".json"), JSON.stringify(session));
  const clean = await openStore(other.directory);
  expect(clean.history.page(alice).observations).toEqual([]);
  expect(clean.occupiedSlots()).toBe(0);
  await expect(clean.load(session.id, alice)).rejects.toMatchObject({ code: "session_not_found" });
});

it("reads a committed status even while native synchronization is awaiting further output", async () => {
  const store = await openStore(), { runId } = await admitted(store);
  const controller = new ProviderController(store, {} as never, {} as never, fixtureCapabilities);
  let settle!: () => void;
  controller.driver = { synchronize: () => new Promise<void>(resolve => { settle = resolve; }) } as never;
  try { expect((await controller.snapshot(runId, alice, { committedOnly: true })).ref.id).toBe(runId); }
  finally { settle(); }
});

it("keeps session positions stable across runs and restarts", async () => {
  const store = await openStore(), { session, run } = await admitted(store);
  const another = await admitted(store, bob);
  store.emit(run, "message.completed", { messageId: "old", text: "from v1" }); await store.save(session);
  const original = store.history.page(alice);
  const reopened = await openStore(store.directory);
  const states = reopened.history.states(alice, original.through);
  const first = states.sessions.find(s => s.sessionId === session.id)!;
  expect(first.head).toBe(2);
  expect(states.sessions.find(s => s.sessionId === another.session.id)?.head).toBe(1);
  const retained = await reopened.load(session.id, alice);
  const later = reopened.makeRun(retained, randomUUID(), alice, "{}");
  retained.runs[later.snapshot.ref.id] = later;
  reopened.lifecycle(later); await reopened.save(retained);
  // Late evidence about the previous run must not promote it above the newer run.
  reopened.lifecycle(retained.runs[run.snapshot.ref.id]!); await reopened.save(retained);
  expect(reopened.history.states(alice).sessions.find(s => s.sessionId === session.id)).toMatchObject({ head: 4, snapshot: { ref: later.snapshot.ref } });
  expect(reopened.history.states(alice, original.through).sessions.find(s => s.sessionId === session.id)).toEqual(first);
  const data = reopened.history.range(alice, original.through, session.id, first.epoch, 1, 2, 10);
  expect(data.observations.map(f => f.sessionPosition)).toEqual([1, 2]);
  expect(data.observations.map(f => f.item)).toEqual(original.observations.filter(f => f.sessionId === session.id).map(f => f.item));
});

it("streams new observations across a fixed boundary while the SDK independently pages older session records", async () => {
  const store = await openStore(), { session, run } = await admitted(store);
  await admitted(store, bob);
  const foreign = await admitted(store, { ...alice, callerInstallation: "another-installation" });
  const history = async () => ({ ...alice, provider, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const controller = new ProviderController(store, { history } as unknown as ProviderAuthority, {} as never, fixtureCapabilities);
  const handler = agentRoutes(controller, {} as never);
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url!, "http://test.invalid")).catch(err => json(res, err.status ?? 500, { error: { code: err.code } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected test port");
  const signal = new AbortController();
  const options = { url: "http://127.0.0.1:" + address.port + "/api/agent/v2/history/events", token: "history", provider, signal: signal.signal };
  let onReady!: (boundary: string) => void;
  const ready = new Promise<string>(resolve => { onReady = resolve; });
  const stream = watchLiveAgentHistory({ ...options, onReady });
  try {
    const first = stream.next();
    const through = await ready;
    store.emit(run, "message.delta", { messageId: "new", text: "n" });
    store.emit(run, "message.completed", { messageId: "new", text: "new" });
    run.snapshot.state = "succeeded"; run.snapshot.phase = "terminal"; run.snapshot.stopConfirmed = true;
    store.lifecycle(run); await store.save(session);
    const transient = (await first).value!;
    expect(transient.sessionId).toBe(session.id); expect(transient.sessionPosition).toBe(2);
    const complete = (await stream.next()).value!;
    expect(complete.sessionPosition).toBe(3); expect(complete.item).toMatchObject({ event: { type: "message.completed" } });
    const initial = await readAgentHistoryStates({ ...options, through, limit: 1 });
    const second = await readAgentHistoryStates({ ...options, through, afterSession: initial.nextSession!, limit: 1 });
    const sessions = [...initial.sessions, ...second.sessions];
    expect(sessions.map(s => s.userId).sort()).toEqual(["alice", "bob"]);
    const boundaryState = sessions.find(s => s.sessionId === session.id)!;
    expect(boundaryState.head).toBe(1); expect(boundaryState.snapshot.stopConfirmed).toBe(false);
    const current = await readAgentHistoryStates(options);
    const state = current.sessions.find(s => s.sessionId === session.id)!;
    expect(state).toMatchObject({ head: 4, snapshot: { state: "succeeded", stopConfirmed: true } });
    const range = { ...options, through: current.through, sessionId: session.id, epoch: state.epoch, from: 1, to: 4, limit: 2 };
    const page = await readAgentHistoryRange(range);
    expect(page.observations.map(f => f.sessionPosition)).toEqual([1, 2]);
    expect(page.observations[1]).toEqual(transient);
    expect(page.observations[1]).not.toHaveProperty("sourceHistoryIncomplete");
    expect(page.nextPosition).toBe(3);
    expect((await readAgentHistoryRange({ ...range, from: 3 })).nextPosition).toBeNull();
    await expect(readAgentHistoryRange({ ...range, epoch: randomUUID() })).rejects.toMatchObject({ code: "history_cursor_invalid" });
    await expect(readAgentHistoryRange({ ...range, sessionId: foreign.session.id })).rejects.toMatchObject({ code: "history_range_unavailable" });
  } finally {
    signal.abort(); await stream.return(undefined);
    const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed;
  }
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
  const root = "http://127.0.0.1:" + address.port + "/api/agent/v2", url = root + "/history/events";
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


it("delivers the original native message independently of its clipped snapshot, using one stable completion", async () => {
  const store = await openStore(), { session, run } = await admitted(store);
  const text = "α🦋".repeat(50_000) + "exact terminal suffix";
  projectEvent(store, session, run, { runId: run.snapshot.ref.id, generation: run.snapshot.generation, sequence: 1, event: { type: "assistant_delta", text } });
  projectEvent(store, session, run, { runId: run.snapshot.ref.id, generation: run.snapshot.generation, sequence: 2, event: { type: "assistant_text", text } });
  await store.save(session);
  expect(run.snapshot.messages?.[0]?.text.length).toBeLessThan(text.length);
  expect(run.snapshot.coverage?.messages).toBe("truncated");
  const page = store.history.page(alice, undefined, undefined, 40);
  const events = page.observations.flatMap(({ item }) => item.kind === "event" ? [item.event] : []);
  const final = events.filter(e => e.type === "message.completed");
  expect(final).toHaveLength(1);
  expect(final[0]?.data.text === text).toBe(true);
  const deltas = events.filter(e => e.type === "message.delta");
  expect(deltas.map(e => e.data.text).join("") === text).toBe(true);
  expect(deltas.every(e => e.data.messageId === final[0]!.data.messageId)).toBe(true);
});


it("replays the exact near-limit final on its original ID after a different streamed draft", async () => {
  const store = await openStore(), { session, run } = await admitted(store);
  const frame = { runId: run.snapshot.ref.id, generation: run.snapshot.generation, sequence: 1, event: { type: "assistant_delta" as const, text: "" } };
  const limit = 1024 * 1024;
  frame.event.text = "x".repeat(limit - Buffer.byteLength(JSON.stringify(frame)) - 3) + "α";
  expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(limit);
  projectEvent(store, session, run, frame);
  const original = "z" + frame.event.text.slice(1);
  projectEvent(store, session, run, { ...frame, sequence: 2, event: { type: "assistant_text", text: original } });
  await store.save(session);
  let page = store.history.page(alice, undefined, undefined, 40);
  const observations = [...page.observations];
  while (page.nextCursor) {
    page = store.history.page(alice, page.nextCursor, page.through, 40);
    observations.push(...page.observations);
  }
  const events = observations.flatMap(({ item }) => item.kind === "event" ? [item.event] : []);
  const finals = events.filter(e => e.type === "message.completed");
  expect(finals).toHaveLength(1);
  const same = events.filter(e => e.data.messageId === finals[0]!.data.messageId);
  let result = "";
  for (const event of same) {
    if (event.type === "message.started" && typeof event.data.text === "string") result = event.data.text;
    if (event.type === "message.delta") result += String(event.data.text);
    if (event.type === "message.completed" && typeof event.data.text === "string") result = event.data.text;
  }
  expect(result === original).toBe(true);
  expect(same.filter(event => event.type === "message.started" && event.data.text === "")).toHaveLength(1);
  expect(events.every(e => Buffer.byteLength(JSON.stringify(e)) <= limit)).toBe(true);
});
