import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WorkerClient } from "../worker/client.js";
import { WorkerEngine } from "../worker/engine.js";
import { WorkerJournal } from "../worker/journal.js";
import { createWorkerServer } from "../worker/http.js";
import { ensureServiceIdentity } from "../worker/auth.js";
import type { HarnessEvent, HarnessStartOptions } from "../harness/adapter.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function fixture(reserve: () => Promise<() => void> = async () => () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-remote-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const identity = await ensureServiceIdentity(path.join(root, "auth"));
  const journal = new WorkerJournal(path.join(root, "independent-provider-storage")); await journal.initialize();
  let options: HarnessStartOptions | undefined, stopped = 0, starts = 0;
  const capabilities = { questions: true, appMcp: true, autoAllow: true, denyReason: true, liveReconfigure: true };
  const engine = new WorkerEngine(journal, { validateSelection: async () => {}, cwd: async () => root, reserve,
    adapter: async () => ({ name: "fixture", capabilities, probe: async () => ({ available: true }), start: input => {
      options = input; starts++;
      return { send() {}, resolveApproval: () => true, resolveQuestion: () => true, setMcpServers: async () => true,
        interrupt: async () => {}, stop: async () => { stopped++; }, stopAndWait: async () => { stopped++; } };
    } }),
  }, 1);
  const server = createWorkerServer(engine, async () => identity, { capabilities: async () => ({ capacity: 1 }), configure: async () => ({}), models: async () => ({}), connection: async () => ({}) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { await engine.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const client = new WorkerClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`, identity);
  const adapter = client.adapter({ connectionId: "account", connectionRevision: 1, harnessKind: "codex" }, capabilities, "fixture");
  const events: HarnessEvent[] = [];
  const run = adapter.start({ sessionId: "conversation", cwd: "/coordinator-only-path", model: "model-a", reasoningEffort: "high", onEvent: event => events.push(event) });
  cleanups.push(() => run.stop());
  return { root, adapter, client, run, events, journal, starts: () => starts, options: () => options, stopped: () => stopped };
}
it("executes through an independent endpoint, applies selection and reports completion after native exit", async () => {
  const f = await fixture(); f.run.send("first turn");
  await expect.poll(f.options).toBeDefined();
  expect(f.options()).toMatchObject({ model: "model-a", reasoningEffort: "high" });
  expect(f.options()!.cwd).not.toBe("/coordinator-only-path");
  f.options()!.onEvent({ type: "harness_session", harnessSessionId: "native-context" });
  f.options()!.onEvent({ type: "assistant_text", text: "done" });
  f.options()!.onEvent({ type: "result", status: "success" });
  await expect.poll(() => f.events.some(e => e.type === "result")).toBe(true);
  expect(f.stopped()).toBe(1);
  f.run.send("next turn");
  await expect.poll(() => f.options()?.resumeHarnessSessionId).toBe("native-context");
});
it("cancels only the run and keeps the provider endpoint available", async () => {
  const f = await fixture(); f.run.send("work"); await expect.poll(f.options).toBeDefined();
  await f.run.stopAndWait!();
  expect(f.stopped()).toBe(1);
  expect(await f.client.capabilities()).toMatchObject({ capacity: 1 });
});

it("reattaches after coordinator shutdown without cancel, resubmit or lost approval", async () => {
  const f = await fixture();
  const received: HarnessEvent[] = [];
  const run = f.client.adapter({ connectionId: "account", connectionRevision: 1, harnessKind: "codex" },
    { questions: true, appMcp: true, autoAllow: true, denyReason: true, liveReconfigure: true }, "fixture")
    .start({ sessionId: "conversation", workerRunId: "durable-run", cwd: "/unused", onEvent: () => {} });
  run.send("only once"); await expect.poll(f.starts).toBe(1);
  f.options()!.onEvent({ type: "approval_request", approvalId: "approval", toolName: "write", input: {} });
  await expect.poll(async () => (await f.journal.load("durable-run")).receipt.state).toBe("awaiting_input");
  await run.detach!(); expect(f.stopped()).toBe(0);
  const attached = f.client.attach("durable-run", { sessionId: "conversation", cwd: "/unused", onEvent: e => received.push(e) });
  cleanups.push(() => attached.stop());
  await expect.poll(() => received.some(e => e.type === "approval_request")).toBe(true);
  expect(await attached.resolveApproval("approval", "allow")).toBe(true);
  f.options()!.onEvent({ type: "assistant_text", text: "continued" });
  f.options()!.onEvent({ type: "result", status: "success" });
  await expect.poll(() => received.some(e => e.type === "result")).toBe(true);
  expect(f.starts()).toBe(1); expect(f.stopped()).toBe(1);
});

it("restores the real coordinator cursor without duplicating transcript events or resubmitting", async () => {
  const { SessionManager } = await import("./manager.js");
  const { SessionStore } = await import("./store.js");
  const { AuditReporter } = await import("../audit.js");
  const f = await fixture();
  const store = new SessionStore(path.join(f.root, "coordinator"), path.join(f.root, "cache"));
  const make = () => new SessionManager(store, f.adapter, new AuditReporter(null, null, "hosty.harness"), f.root,
    null, null, null, null, null, null, null, null, f.client, "docker");
  const first = make(); cleanups.push(() => first.shutdown());
  const record = await first.createSession({ createdBy: "owner" });
  await first.postMessage(record.id, "run only once"); await expect.poll(f.starts).toBe(1);
  f.options()!.onEvent({ type: "assistant_text", text: "before restart" });
  await expect.poll(async () => (await store.readEvents(record.id)).filter(e=>e.type === "assistant_text").length).toBe(1);
  await first.shutdown(); expect(f.stopped()).toBe(0);
  const saved = (await store.readRecord(record.id))!;
  saved.workerRun!.sequence = 0; await store.saveRecord(saved); // Simulate append persisted before cursor save.
  const next = make(); cleanups.push(() => next.shutdown());
  await next.recoverWorkerRuns();
  await next.getSession(record.id);
  f.options()!.onEvent({ type: "assistant_text", text: "after restart" });
  f.options()!.onEvent({ type: "result", status: "success" });
  await expect.poll(async () => (await store.readRecord(record.id))!.status).toBe("idle");
  expect((await store.readEvents(record.id)).filter(e=>e.type === "assistant_text").map(e=>e.text)).toEqual(["before restart", "after restart"]);
  expect(f.starts()).toBe(1); expect(f.stopped()).toBe(1);
  expect((await store.readRecord(record.id))!.workerRun).toBeUndefined();
});

it("reconnects after temporary SSE unavailability without starting another execution", async () => {
  const f = await fixture(); const fetch = globalThis.fetch; let interrupted = false;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (String(input).includes("/events") && !interrupted) { interrupted = true; return Promise.resolve(new Response("unavailable", {status:503})); }
    return fetch(input, init);
  });
  f.run.send("one execution"); await expect.poll(f.starts).toBe(1);
  f.options()!.onEvent({ type: "assistant_text", text: "replayed" });
  f.options()!.onEvent({ type: "result", status: "success" });
  await expect.poll(() => f.events.some(e=>e.type === "result")).toBe(true);
  expect(interrupted).toBe(true); expect(f.starts()).toBe(1);
  expect(f.events.filter(e=>e.type === "assistant_text")).toHaveLength(1);
});

it.each(["stop", "detach"] as const)("%s does not wait on an event callback queued behind coordinator cleanup", async operation => {
  const f = await fixture();
  let releaseCallback!: () => void, entered = false;
  const blocked = new Promise<void>(resolve => { releaseCallback = resolve; });
  const run = f.adapter.start({ sessionId: "conversation", cwd: "/unused", onEvent: () => {},
    onWorkerEvent: async () => { entered = true; await blocked; } });
  cleanups.push(() => run.stop());
  run.send("work"); await expect.poll(f.starts).toBe(1);
  f.options()!.onEvent({ type: "assistant_text", text: "queued behind cleanup" });
  await expect.poll(() => entered).toBe(true);
  let finished = false;
  const cleanup = run[operation]!().then(() => { finished = true; });
  try {
    // The coordinator releases its session queue only after stop/detach returns.
    await expect.poll(() => finished, { timeout: 1500 }).toBe(true);
    expect(f.stopped()).toBe(operation === "stop" ? 1 : 0);
  } finally { releaseCallback(); await cleanup; }
});

it("waits for an admitted run to finish cancellation during slow startup", async () => {
  let releaseReservation!: () => void, entered = false, finished = false, released = 0;
  const reservation = new Promise<void>(resolve => { releaseReservation = resolve; });
  const f = await fixture(async () => { entered = true; await reservation; return () => { released++; }; });
  const run = f.adapter.start({ sessionId: "conversation", workerRunId: "slow-run", cwd: "/unused", onEvent: () => {} });
  cleanups.push(() => run.stop());
  run.send("cancel before native startup"); await expect.poll(() => entered).toBe(true);
  const stopping = run.stopAndWait!().then(() => { finished = true; });
  try {
    await expect.poll(async () => (await f.journal.load("slow-run")).receipt.state).toBe("cancelling");
    expect(finished).toBe(false);
  } finally { releaseReservation(); }
  await stopping;
  expect((await f.journal.load("slow-run")).receipt).toMatchObject({ state: "cancelled", exitConfirmed: true });
  expect(f.starts()).toBe(0); expect(released).toBe(1);
  expect(await f.client.capabilities()).toMatchObject({ capacity: 1 });
});

it("preserves a failed provider's actionable terminal error", async () => {
  const f = await fixture(); f.run.send("work"); await expect.poll(f.starts).toBe(1);
  f.options()!.onEvent({ type: "error", message: "Provider quota exceeded; renew this account." });
  await expect.poll(() => f.events.find(event => event.type === "error")).toMatchObject({
    type: "error", message: "Provider quota exceeded; renew this account.",
  });
  expect(f.stopped()).toBe(1);
});

it.each(["result", "error"] as const)("retries durable %s persistence without duplicating its terminal transcript", async type => {
  const { SessionManager } = await import("./manager.js");
  const { SessionStore } = await import("./store.js");
  const { AuditReporter } = await import("../audit.js");
  const f = await fixture();
  const store = new SessionStore(path.join(f.root, "coordinator"), path.join(f.root, "cache"));
  const manager = new SessionManager(store, f.adapter, new AuditReporter(null, null, "hosty.harness"), f.root,
    null, null, null, null, null, null, null, null, f.client, "docker");
  cleanups.push(() => manager.shutdown());
  const record = await manager.createSession({ createdBy: "owner" });
  await manager.postMessage(record.id, "work"); await expect.poll(f.starts).toBe(1);
  let appendFailed = false, clearFailed = false;
  const append = store.appendEvent.bind(store), save = store.saveRecord.bind(store);
  vi.spyOn(store, "appendEvent").mockImplementation(async (id, event) => {
    if (event.type === type && !appendFailed) { appendFailed = true; throw new Error("temporary append failure"); }
    return append(id, event);
  });
  vi.spyOn(store, "saveRecord").mockImplementation(async value => {
    if (value.id === record.id && !value.workerRun && !clearFailed) { clearFailed = true; throw new Error("temporary receipt-clear failure"); }
    return save(value);
  });
  f.options()!.onEvent(type === "result" ? { type, status: "success" } : { type, message: "Native provider error" });
  await expect.poll(async () => {
    const saved = (await store.readRecord(record.id))!;
    return saved.status === (type === "result" ? "idle" : "failed") && !saved.workerRun;
  }, { timeout: 5000 }).toBe(true);
  const terminals = (await store.readEvents(record.id)).filter(event => event.type === type);
  expect(terminals).toHaveLength(1);
  expect(terminals[0]).toMatchObject({ workerRunId: expect.any(String), workerSequence: expect.any(Number) });
  expect(appendFailed).toBe(true); expect(clearFailed).toBe(true);
  expect(f.starts()).toBe(1); expect(f.stopped()).toBe(1);
});

it.each(["result", "error"] as const)("recovers a persisted %s after a crash before clearing the run receipt", async type => {
  const { SessionManager } = await import("./manager.js");
  const { SessionStore } = await import("./store.js");
  const { AuditReporter } = await import("../audit.js");
  const f = await fixture();
  const store = new SessionStore(path.join(f.root, "coordinator"), path.join(f.root, "cache"));
  const make = () => new SessionManager(store, f.adapter, new AuditReporter(null, null, "hosty.harness"), f.root,
    null, null, null, null, null, null, null, null, f.client, "docker");
  const first = make(); cleanups.push(() => first.shutdown());
  const record = await first.createSession({ createdBy: "owner" });
  await first.postMessage(record.id, "work"); await expect.poll(f.starts).toBe(1);
  const active = (await store.readRecord(record.id))!;
  f.options()!.onEvent(type === "result" ? { type, status: "success" } : { type, message: "Native provider error" });
  await expect.poll(async () => (await store.readRecord(record.id))!.workerRun).toBeUndefined();
  await first.shutdown();
  // Transcript append survived, but the coordinator record still points at the original run.
  await store.saveRecord({ ...(await store.readRecord(record.id))!, status: "running", workerRun: active.workerRun });
  const next = make(); cleanups.push(() => next.shutdown()); await next.recoverWorkerRuns();
  await expect.poll(async () => {
    const saved = (await store.readRecord(record.id))!;
    return saved.status === (type === "result" ? "idle" : "failed") && !saved.workerRun;
  }, { timeout: 5000 }).toBe(true);
  expect((await store.readEvents(record.id)).filter(event => event.type === type)).toHaveLength(1);
  expect(f.starts()).toBe(1); expect(f.stopped()).toBe(1);
});

it("detaches terminal persistence retries on coordinator shutdown", async () => {
  const { SessionManager } = await import("./manager.js");
  const { SessionStore } = await import("./store.js");
  const { AuditReporter } = await import("../audit.js");
  const f = await fixture();
  const store = new SessionStore(path.join(f.root, "coordinator"), path.join(f.root, "cache"));
  const manager = new SessionManager(store, f.adapter, new AuditReporter(null, null, "hosty.harness"), f.root,
    null, null, null, null, null, null, null, null, f.client, "docker");
  cleanups.push(() => manager.shutdown());
  const record = await manager.createSession({ createdBy: "owner" });
  await manager.postMessage(record.id, "work"); await expect.poll(f.starts).toBe(1);
  const save = store.saveRecord.bind(store); let failures = 0;
  vi.spyOn(store, "saveRecord").mockImplementation(async value => {
    if (value.id === record.id && !value.workerRun) { failures++; throw new Error("receipt storage unavailable"); }
    return save(value);
  });
  f.options()!.onEvent({ type: "result", status: "success" });
  await expect.poll(() => failures, { timeout: 3000 }).toBeGreaterThanOrEqual(2);
  await expect(manager.postMessage(record.id, "must wait for persistence")).rejects.toThrow();
  await expect(manager.setModel(record.id, { expectedRevision: 0, selection: { model: null } })).rejects.toThrow();
  expect(f.starts()).toBe(1);
  await manager.shutdown();
  const afterShutdown = failures;
  await new Promise(resolve => setTimeout(resolve, 700));
  expect(failures).toBe(afterShutdown);
  expect((await store.readRecord(record.id))!.workerRun).toBeDefined();
});


it.each([
  { type: "result", text: true }, { type: "result", text: false },
  { type: "error", text: true }, { type: "error", text: false },
] as const)("recovers expired $type replay with snapshot text=$text without consuming its terminal revision", async ({ type, text }) => {
  const { SessionManager } = await import("./manager.js");
  const { SessionStore } = await import("./store.js");
  const { AuditReporter } = await import("../audit.js");
  const f = await fixture();
  const store = new SessionStore(path.join(f.root, "coordinator"), path.join(f.root, "cache"));
  const make = () => new SessionManager(store, f.adapter, new AuditReporter(null, null, "hosty.harness"), f.root,
    null, null, null, null, null, null, null, null, f.client, "docker");
  const first = make(); cleanups.push(() => first.shutdown());
  const record = await first.createSession({ createdBy: "owner" });
  await first.postMessage(record.id, "work"); await expect.poll(f.starts).toBe(1);
  const runId = (await store.readRecord(record.id))!.workerRun!.id;
  await first.shutdown();
  const usage = { usedTokens: 4200, maxTokens: 10000, estimated: true, observedAt: new Date().toISOString() };
  f.options()!.onEvent({ type: "context_usage", usage });
  if (text) f.options()!.onEvent({ type: "assistant_text", text: "Retained final answer" });
  f.options()!.onEvent(type === "result" ? { type, status: "success" } : { type, message: "Retained provider error" });
  await expect.poll(async () => (await f.journal.load(runId)).receipt.state).toBe(type === "result" ? "completed" : "failed");
  const expired = new WorkerJournal(path.join(f.root, "independent-provider-storage"), -1);
  await expired.prune();
  const receipt = (await f.journal.load(runId)).receipt;
  expect((await f.journal.load(runId)).replayExpired).toBe(true);
  const next = make(); cleanups.push(() => next.shutdown()); await next.recoverWorkerRuns();
  await expect.poll(async () => {
    const saved = (await store.readRecord(record.id))!;
    return saved.status === (type === "result" ? "idle" : "failed") && !saved.workerRun;
  }).toBe(true);
  const events = await store.readEvents(record.id);
  expect(events.filter(event => event.type === type)).toHaveLength(1);
  expect(events.find(event => event.type === type)).toMatchObject({ workerRunId: runId, workerSequence: receipt.revision });
  expect(events.find(event => event.type === "notice" && String(event.message).includes("replay expired"))).toMatchObject({ type: "notice" });
  expect(events.filter(event => event.workerSequence === receipt.revision)).toHaveLength(1);
  expect(events.filter(event => event.type === "assistant_text")).toHaveLength(text ? 1 : 0);
  expect(events.filter(event => event.type === "context_usage")).toEqual([
    expect.objectContaining({ usage, workerSequence: receipt.snapshot!.contextUsage!.sequence }),
  ]);
  expect(events.findIndex(event => event.type === "context_usage")).toBeLessThan(events.findIndex(event => event.type === type));
  expect(f.starts()).toBe(1); expect(f.stopped()).toBe(1);
});
