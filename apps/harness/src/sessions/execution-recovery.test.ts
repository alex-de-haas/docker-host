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
import { WorkerJournal } from "../worker/journal.js";
import { WorkerEngine } from "../worker/engine.js";
import { createWorkerServer } from "../worker/http.js";
import { ensureServiceIdentity } from "../worker/auth.js";
import { DevelopmentClient } from "./development.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); vi.restoreAllMocks(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-recovery-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(path.join(root, "sessions"));
  const identity = await ensureServiceIdentity(path.join(root, "auth"));
  const journal = new WorkerJournal(path.join(root, "runs")); await journal.initialize();
  const engine = new WorkerEngine(journal, { reserve: async () => () => {}, validateSelection: async () => {}, cwd: async () => root, adapter: async () => new FakeHarnessAdapter() }, 1);
  const server = createWorkerServer(engine, async () => identity, { capabilities: async () => ({}), configure: async () => ({}), connection: async () => ({}), models: async () => ({}) });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await engine.close(); });
  const client = new WorkerClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`, identity);
  const development = new DevelopmentClient("http://core.test", "harness", "service");
  const released = vi.spyOn(development, "activity").mockResolvedValue({ workspaceId: null, revision: null, stopRequested: false, state: "unbound" });
  const build = () => new SessionManager(store, new FakeHarnessAdapter(), new AuditReporter(null, null, "harness"), root,
    null, null, null, null, null, null, null, development, client, "native");
  let manager = build();
  cleanup.push(() => manager.shutdown());
  const session = await manager.createSession({ createdBy: "owner" });
  const runId = randomUUID();
  await journal.accept(runId, { conversationId: session.id, binding: { connectionId: "fixture", connectionRevision: 1, harnessKind: "codex" },
    selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id: session.id }, input: "Preserved request", options: {}, autoAllowedPrefixes: [] });
  await journal.update(runId, "running");
  await store.appendEvent(session.id, { seq: 2, ts: new Date().toISOString(), type: "user_message", text: "Preserved request" });
  const agentRunId = await manager.observations.begin({ ...session, harnessSessionId: "retained-native-session" }, true);
  await manager.shutdown();
  await store.saveRecord({ ...(await store.readRecord(session.id))!, agentRunId, harnessSessionId: "retained-native-session", status: "running", workerRun: { id: runId, sequence: 0 }, developmentLease: randomUUID(), developmentLeaseState: "admitting" });
  await new WorkerJournal(path.join(root, "runs")).initialize();
  manager = build();
  const review = (await manager.executionRecovery(session.id, "owner"))!;
  const input = { requestId: randomUUID(), runId, generation: review.generation, expectedRevision: review.expectedRevision, consumerExitConfirmed: true };
  return { manager: () => manager, client, store, journal, session, input, released, agentRunId,
    restart: async () => { await manager.shutdown(); manager = build(); } };
}
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
