import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "./store.js";
import { SessionManager } from "./manager.js";
import { FakeHarnessAdapter } from "../harness/fake.js";
import { AuditReporter } from "../audit.js";
import { WorkerClient } from "../worker/client.js";
import { WorkerApiError } from "../worker/contracts.js";
import { WorkerJournal } from "../worker/journal.js";
import { WorkerEngine } from "../worker/engine.js";
import { createWorkerServer } from "../worker/http.js";
import { ensureServiceIdentity } from "../worker/auth.js";
import { DevelopmentClient } from "./development.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); vi.restoreAllMocks(); });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
async function freshFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-recovery-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(path.join(root, "sessions"));
  const identity = await ensureServiceIdentity(path.join(root, "auth"));
  const journal = new WorkerJournal(path.join(root, "runs")); await journal.initialize();
  const adapter = new FakeHarnessAdapter(), started = vi.spyOn(adapter, "start");
  const engine = new WorkerEngine(journal, { reserve: async () => () => {}, validateSelection: async () => {}, cwd: async () => root, adapter: async () => adapter }, 1);
  const server = createWorkerServer(engine, async () => identity, { capabilities: async () => ({}), configure: async () => ({}), connection: async () => ({}), models: async () => ({}) });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await engine.close(); });
  const client = new WorkerClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`, identity);
  const development = new DevelopmentClient("http://core.test", "harness", "service");
  const released = vi.spyOn(development, "activity").mockResolvedValue({ workspaceId: null, revision: null, stopRequested: false, state: "unbound" });
  const binding = { connectionId: "fixture", connectionRevision: 1, harnessKind: "codex" as const };
  const build = () => new SessionManager(store, client.adapter(binding, adapter.capabilities, "codex"), new AuditReporter(null, null, "harness"), root,
    null, null, null, null, null, null, null, development, client, "native");
  let manager = build();
  cleanup.push(() => manager.shutdown());
  const session = await manager.createSession({ createdBy: "owner" });
  return { root, manager: () => manager, client, store, journal, session, released, started,
    restart: async () => { await manager.shutdown(); manager = build(); } };
}
async function fixture() {
  const f = await freshFixture();
  const { root, store, journal, session } = f;
  const runId = randomUUID();
  await journal.accept(runId, { conversationId: session.id, binding: { connectionId: "fixture", connectionRevision: 1, harnessKind: "codex" },
    selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id: session.id }, input: "Preserved request", options: {}, autoAllowedPrefixes: [] });
  await journal.update(runId, "running");
  await store.appendEvent(session.id, { seq: 2, ts: new Date().toISOString(), type: "user_message", text: "Preserved request" });
  const agentRunId = await f.manager().observations.begin({ ...session, harnessSessionId: "retained-native-session" }, true);
  await f.manager().shutdown();
  await store.saveRecord({ ...(await store.readRecord(session.id))!, agentRunId, harnessSessionId: "retained-native-session", status: "running", workerRun: { id: runId, sequence: 0 }, developmentLease: randomUUID(), developmentLeaseState: "admitting" });
  await new WorkerJournal(path.join(root, "runs")).initialize();
  await f.restart();
  const review = (await f.manager().executionRecovery(session.id, "owner"))!;
  const input = { requestId: randomUUID(), runId, generation: review.generation, expectedRevision: review.expectedRevision, consumerExitConfirmed: true };
  return { ...f, input, agentRunId };
}
it("waits through preparation and durable admission before reviewing a freshly submitted run", async () => {
  const f = await freshFixture(), prepared = deferred(), prepare = deferred(), submitting = deferred(), submit = deferred();
  const save = f.store.saveRecord.bind(f.store), request = f.client.request.bind(f.client);
  let held = false;
  vi.spyOn(f.store, "saveRecord").mockImplementation(async record => {
    await save(record);
    if (record.workerRun && !held) { held = true; prepared.resolve(); await prepare.promise; }
  });
  const calls = vi.spyOn(f.client, "request").mockImplementation(async (...args) => {
    if (args[1] === "PUT") { submitting.resolve(); await submit.promise; }
    return request(...args);
  });
  const posted = f.manager().postMessage(f.session.id, "ask before continuing");
  await prepared.promise;
  const review = f.manager().executionRecovery(f.session.id, "owner");
  let settled = false;
  void review.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(calls).not.toHaveBeenCalled();
    prepare.resolve(); await submitting.promise; await posted;
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(calls.mock.calls.filter(args => args[0].startsWith("/v1/runs/") && (!args[1] || args[1] === "GET"))).toHaveLength(0);
    // Another queued operation must not wait behind a slow admission review.
    await expect(f.manager().executionRecovery(f.session.id, "other")).rejects.toMatchObject({ code: "session_not_found" });
  } finally { prepare.resolve(); submit.resolve(); }
  await expect(review).resolves.toBeNull();
  await expect.poll(() => f.started.mock.calls.length).toBe(1);
  expect(calls.mock.calls.filter(args => args[1] === "PUT")).toHaveLength(1);
  expect((await f.store.readEvents(f.session.id)).filter(event => event.type === "error")).toEqual([]);
});
it.each([[409, "worker_busy"], [503, "worker_stopping"]] as const)("cleans up a definitive %s admission refusal without retrying execution", async (status, code) => {
  const f = await freshFixture(), submitting = deferred(), submit = deferred();
  const request = f.client.request.bind(f.client);
  const requests = vi.spyOn(f.client, "request").mockImplementation(async (...args) => {
    if (args[1] === "PUT") {
      submitting.resolve(); await submit.promise;
      throw new WorkerApiError(status, code, "Worker admission refused.");
    }
    return request(...args);
  });
  await f.manager().postMessage(f.session.id, "Continue"); await submitting.promise;
  const review = expect(f.manager().executionRecovery(f.session.id, "owner")).rejects.toMatchObject({ code });
  submit.resolve(); await review;
  await expect.poll(async () => (await f.store.readRecord(f.session.id))?.status).toBe("failed");
  await expect(f.manager().executionRecovery(f.session.id, "other")).rejects.toMatchObject({ code: "session_not_found" });
  expect(f.started).not.toHaveBeenCalled();
  expect((await f.store.readRecord(f.session.id))!.workerRun).toBeUndefined();
  expect(requests.mock.calls.filter(args => args[1] === "PUT")).toHaveLength(1);
});
it("allows Stop during a slow receipt review and discards the superseded review", async () => {
  const f = await freshFixture(), reading = deferred(), read = deferred();
  await f.manager().postMessage(f.session.id, "ask before continuing");
  await expect.poll(() => f.started.mock.calls.length).toBe(1);
  const request = f.client.request.bind(f.client);
  let held = false;
  vi.spyOn(f.client, "request").mockImplementation(async (...args) => {
    const result = await request(...args);
    if (!args[1] && args[0].startsWith("/v1/runs/") && !held) {
      held = true; reading.resolve(); await read.promise;
      return { ...result as object, state: "interrupted", exitConfirmed: false };
    }
    return result;
  });
  const review = f.manager().executionRecovery(f.session.id, "owner");
  await reading.promise;
  try { await f.manager().cancelSession(f.session.id); }
  finally { read.resolve(); }
  await expect(review).resolves.toBeNull();
  expect((await f.store.readRecord(f.session.id))!.workerRun).toBeUndefined();
});
it("requires explicit exact-generation recovery for a missing retained run and preserves its history", async () => {
  const f = await fixture();
  await rm(path.join(f.root, "runs", f.input.runId + ".json"));
  const review = (await f.manager().executionRecovery(f.session.id, "owner"))!;
  expect(review).toMatchObject({ runId: f.input.runId, generation: f.journal.generation, expectedRevision: 0, recoverable: true });
  expect(f.released).not.toHaveBeenCalled();
  const input = { requestId: randomUUID(), runId: review.runId, generation: review.generation, expectedRevision: review.expectedRevision, consumerExitConfirmed: true };
  await expect(f.manager().recoverExecution(f.session.id, "owner", { ...input, consumerExitConfirmed: false })).rejects.toMatchObject({ code: "recovery_invalid" });
  await expect(f.manager().recoverExecution(f.session.id, "owner", { ...input, generation: "old-worker" })).rejects.toMatchObject({ code: "recovery_stale" });
  await f.manager().recoverExecution(f.session.id, "owner", input, "fresh-grant");
  await f.manager().recoverExecution(f.session.id, "owner", input, "fresh-grant");
  expect((await f.store.readRecord(f.session.id))!).toMatchObject({ status: "cancelled", harnessSessionId: "retained-native-session", workerRecovery: { state: "completed" } });
  expect((await f.store.readRecord(f.session.id))!.workerRun).toBeUndefined();
  expect((await f.store.readEvents(f.session.id)).some(event => event.type === "user_message" && event.text === "Preserved request")).toBe(true);
  expect(f.released).toHaveBeenCalledTimes(1);
  expect(f.started).not.toHaveBeenCalled();
  expect((await f.journal.load(input.runId)).receipt).toMatchObject({ conversationId: f.session.id, state: "cancelled", exitConfirmed: true });
});
it("keeps source claims on failed Stop and recovers the exact owned run without losing its transcript", async () => {
  const f = await fixture();
  await expect(f.manager().cancelSession(f.session.id)).rejects.toMatchObject({ code: "exit_unconfirmed" });
  expect(f.released).not.toHaveBeenCalled();
  await expect(f.manager().recoverExecution(f.session.id, "other", f.input)).rejects.toMatchObject({ code: "session_not_found" });
  await expect(f.manager().recoverExecution(f.session.id, "owner", { ...f.input, consumerExitConfirmed: false })).rejects.toMatchObject({ code: "recovery_invalid" });
  await expect(f.manager().recoverExecution(f.session.id, "owner", { ...f.input, runId: randomUUID() })).rejects.toMatchObject({ code: "recovery_stale" });
  await f.manager().recoverExecution(f.session.id, "owner", f.input, "fresh-app-grant");
  expect(await f.manager().getSession(f.session.id)).toMatchObject({ status: "cancelled", workerRecovery: { state: "completed" } });
  expect((await f.store.readRecord(f.session.id))!.workerRun).toBeUndefined();
  expect((await f.store.readRecord(f.session.id))!.developmentLease).toBeUndefined();
  expect(f.released).toHaveBeenCalledWith(f.session.id, "fresh-app-grant", expect.objectContaining({ stopped: true }));
  expect((await f.store.readEvents(f.session.id)).some(e => e.type === "user_message" && e.text === "Preserved request")).toBe(true);
  await f.manager().recoverExecution(f.session.id, "owner", f.input, "fresh-app-grant");
  expect(f.released).toHaveBeenCalledTimes(1);
  await f.manager().observations.synchronize();
  expect(await f.manager().observations.change(state => state.runs.find(run => run.id === f.agentRunId)))
    .toMatchObject({ state: "cancelled", stopConfirmed: true });
});
it("replays the retained recovery after a lost worker reply and coordinator restart", async () => {
  const f = await fixture(); const request = f.client.request.bind(f.client);
  const spy = vi.spyOn(f.client, "request").mockImplementation(async (...args) => {
    const result = await request(...args);
    if (args[0].endsWith("/recover")) throw new Error("Response lost after durable recovery");
    return result;
  });
  await expect(f.manager().recoverExecution(f.session.id, "owner", f.input, "grant")).rejects.toThrow("Response lost");
  expect((await f.store.readRecord(f.session.id))!.workerRecovery?.state).toBe("pending");
  expect(f.released).not.toHaveBeenCalled(); spy.mockRestore();
  await f.restart();
  await f.manager().recoverExecution(f.session.id, "owner", f.input, "renewed-grant");
  expect((await f.store.readRecord(f.session.id))!.workerRecovery?.state).toBe("completed");
  expect((await f.journal.load(f.input.runId)).receipt.recovery?.requestId).toBe(f.input.requestId);
  expect(f.released).toHaveBeenCalledTimes(1);
});

it("blocks new turns until failed source cleanup finishes with the retained recovery request", async () => {
  const f = await fixture();
  f.released.mockRejectedValueOnce(new Error("Core cleanup unavailable"));
  await expect(f.manager().recoverExecution(f.session.id, "owner", f.input, "grant")).rejects.toThrow("Core cleanup unavailable");
  expect((await f.store.readRecord(f.session.id))!.workerRun).toBeUndefined();
  expect((await f.store.readRecord(f.session.id))!.workerRecovery?.state).toBe("pending");
  await expect(f.manager().postMessage(f.session.id, "Continue", "grant")).rejects.toMatchObject({ code: "recovery_pending" });
  expect((await f.manager().executionRecovery(f.session.id, "owner"))?.pending).toMatchObject({ requestId: f.input.requestId });
  await f.manager().recoverExecution(f.session.id, "owner", f.input, "fresh-grant");
  expect((await f.store.readRecord(f.session.id))!.workerRecovery?.state).toBe("completed");
  expect((await f.store.readRecord(f.session.id))!.developmentLease).toBeUndefined();
});

it("recovers a still-live unknown admission without resubmitting through its recovery tombstone", async () => {
  const f = await freshFixture(), request = f.client.request.bind(f.client);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const requests = vi.spyOn(f.client, "request").mockImplementation(async (...args) => {
    if (args[1] === "PUT") throw new WorkerApiError(503, "worker_error", "Admission reply is uncertain.");
    return request(...args);
  });
  await f.manager().postMessage(f.session.id, "Retain this uncertain request");
  await expect.poll(async () => (await f.store.readEvents(f.session.id)).some(event => event.type === "error")).toBe(true);
  expect((await f.store.readRecord(f.session.id))!.workerRun).toBeDefined();
  expect(f.released).not.toHaveBeenCalled();
  const review = (await f.manager().executionRecovery(f.session.id, "owner"))!;
  expect(review).toMatchObject({ generation: f.journal.generation, expectedRevision: 0, recoverable: true });
  const puts = requests.mock.calls.filter(args => args[1] === "PUT").length;
  const input = { requestId: randomUUID(), runId: review.runId, generation: review.generation, expectedRevision: 0, consumerExitConfirmed: true };
  await f.manager().recoverExecution(f.session.id, "owner", input, "fresh-grant");
  expect(requests.mock.calls.filter(args => args[1] === "PUT")).toHaveLength(puts);
  expect((await f.store.readRecord(f.session.id))!).toMatchObject({ status: "cancelled", workerRecovery: { state: "completed" } });
  expect((await f.store.readRecord(f.session.id))!.workerRun).toBeUndefined();
  expect(f.started).not.toHaveBeenCalled();
  expect((await f.store.readEvents(f.session.id)).some(event => event.type === "user_message" && event.text === "Retain this uncertain request")).toBe(true);
  await f.manager().observations.synchronize();
  expect(await f.manager().observations.change(state => state.runs.find(run => run.conversation === f.session.id)))
    .toMatchObject({ state: "cancelled", stopConfirmed: true });
  expect(JSON.stringify(warning.mock.calls)).not.toContain("run_conflict");
});

it("settles an unresolved source fence only from durable confirmed native exit without resending its UUID", async () => {
  const f = await freshFixture(), runId = randomUUID(), clientRequestId = randomUUID();
  await f.journal.accept(runId, { conversationId: f.session.id, binding: { connectionId: "fixture", connectionRevision: 1, harnessKind: "codex" },
    selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id: f.session.id }, input: "Retained input", options: {}, autoAllowedPrefixes: [] });
  await f.journal.update(runId, "failed");
  await f.store.appendEvent(f.session.id, { seq: 2, ts: new Date().toISOString(), type: "user_message", text: "Retained input", clientRequestId });
  await f.store.saveMessageReceipt(f.session.id, { clientRequestId, actorUserId: "owner", fingerprint: "a".repeat(64), state: "unknown", eventSeq: 2 });
  await f.store.saveRecord({ ...(await f.store.readRecord(f.session.id))!, status: "failed", sourceAdmission: { runId, clientRequestId, state: "dispatching" } });
  await f.restart();
  expect(await f.manager().executionRecovery(f.session.id, "owner")).toBeNull();
  expect((await f.store.readRecord(f.session.id))!.sourceAdmission).toBeUndefined();
  expect(await f.store.readMessageReceipt(f.session.id, clientRequestId)).toMatchObject({ state: "unknown", eventSeq: 2 });
  expect(f.started).not.toHaveBeenCalled();
});
