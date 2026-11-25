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

  const db = new DatabaseSync(path.join(store.directory, "installation-history.sqlite"));
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

it("recovers a committed outbox after interruption and replays the same cursors only once", async () => {
  const store = await openStore(), { session, run } = await admitted(store);
  const cursor = store.history.page(alice).through;
  const fault = vi.spyOn(store.history, "publish").mockImplementationOnce(() => { throw new Error("simulated interruption"); });
  store.emit(run, "message.completed", { messageId: "last", text: "final answer" });
  await expect(store.save(session)).resolves.toBeUndefined();
  expect((await store.run(run.snapshot.ref.id, alice)).record.historyOutbox?.at(-1)).toMatchObject({
    kind: "event", event: { type: "message.completed" },
  });
  fault.mockRestore();
  const restored = await openStore(store.directory);
  const backfill = restored.history.page(alice, cursor);
  expect(backfill.observations).toHaveLength(1);
  const reopened = await openStore(store.directory);
  expect(reopened.history.page(alice, cursor)).toEqual(backfill);
});

it("continues to serve committed execution and retries every unpublished fact without duplicating a committed page", async () => {
  const store = await openStore(), { session, run, runId } = await admitted(store);
  const cursor = store.history.page(alice).through, notify = vi.fn();
  const unsubscribe = store.subscribe(runId, notify);
  const publish = store.history.publish.bind(store.history);
  const fault = vi.spyOn(store.history, "publish")
    .mockImplementationOnce(() => { throw Object.assign(new Error("synthetic database lock"), { code: "SQLITE_BUSY" }); })
    .mockImplementationOnce(record => { publish(record); throw new Error("synthetic lost acknowledgement"); });
  store.emit(run, "message.completed", { messageId: "first", text: "first" });
  await store.save(session);
  expect(notify).toHaveBeenCalledOnce();
  const { session: current, record } = await store.run(runId, alice);
  expect(record.historyOutbox?.some(item => eventType(item) === "message.completed")).toBe(true);
  store.emit(record, "message.completed", { messageId: "second", text: "second" });
  await store.save(current);
  expect(notify).toHaveBeenCalledTimes(2);
  const committed = store.history.page(alice, cursor);
  expect(committed.observations.map(row => eventType(row.item))).toEqual(["message.completed", "message.completed"]);
  fault.mockRestore();
  await store.retryHistory();
  expect((await store.run(runId, alice)).record.historyOutbox).toBeUndefined();
  expect(store.history.page(alice, cursor)).toEqual(committed);
  unsubscribe();
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
  const states = upgraded.history.states(alice), state = states.sessions[0]!;
  expect(state.sourceHistoryIncomplete).toBe(true);
  expect(upgraded.history.range(alice, states.through, state.sessionId, state.epoch, 1, 2, 2)
    .observations.every(row => row.sourceHistoryIncomplete)).toBe(true);
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

it("migrates v1 per-installation history into stable session positions across runs and restarts", async () => {
  const store = await openStore(), { session, run } = await admitted(store);
  const another = await admitted(store, bob);
  store.emit(run, "message.completed", { messageId: "old", text: "from v1" }); await store.save(session);
  const original = store.history.page(alice);
  const database = new DatabaseSync(path.join(store.directory, "installation-history.sqlite"));
  try {
    database.exec(`
      DROP INDEX history_session_ordinal;
      DROP INDEX history_session_position;
      DROP INDEX history_session_state;
      ALTER TABLE history_facts DROP COLUMN ordinal;
      ALTER TABLE history_facts DROP COLUMN state_run_start;
    `);
  } finally { database.close(); }
  const reopened = await openStore(store.directory);
  const states = reopened.history.states(alice, original.through);
  const first = states.sessions.find(s => s.sessionId === session.id)!;
  expect(first.head).toBe(2);
  expect(states.sessions.find(s => s.sessionId === another.session.id)?.head).toBe(1);
  const later = reopened.makeRun(session, randomUUID(), alice, "{}");
  session.runs[later.snapshot.ref.id] = later;
  reopened.lifecycle(later); await reopened.save(session);
  // Late evidence about the previous run must not promote it above the newer run.
  reopened.lifecycle(run); await reopened.save(session);
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
  const options = { url: "http://127.0.0.1:" + address.port + "/api/agent/v1/history/events", token: "history", provider, signal: signal.signal };
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
    expect(transient.sessionId).toBe(session.id); expect(transient.sessionPosition).toBeUndefined();
    const complete = (await stream.next()).value!;
    expect(complete.sessionPosition).toBe(2); expect(complete.item).toMatchObject({ event: { type: "message.completed" } });
    const initial = await readAgentHistoryStates({ ...options, through, limit: 1 });
    const second = await readAgentHistoryStates({ ...options, through, afterSession: initial.nextSession!, limit: 1 });
    const sessions = [...initial.sessions, ...second.sessions];
    expect(sessions.map(s => s.userId).sort()).toEqual(["alice", "bob"]);
    const boundaryState = sessions.find(s => s.sessionId === session.id)!;
    expect(boundaryState.head).toBe(1); expect(boundaryState.snapshot.stopConfirmed).toBe(false);
    const current = await readAgentHistoryStates(options);
    const state = current.sessions.find(s => s.sessionId === session.id)!;
    expect(state).toMatchObject({ head: 3, snapshot: { state: "succeeded", stopConfirmed: true } });
    const range = { ...options, through: current.through, sessionId: session.id, epoch: state.epoch, from: 1, to: 3, limit: 2 };
    const page = await readAgentHistoryRange(range);
    expect(page.observations.map(f => f.sessionPosition)).toEqual([1, 2]);
    expect(page.observations[1]).toEqual(complete);
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
