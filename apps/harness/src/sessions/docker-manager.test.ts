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
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-remote-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const identity = await ensureServiceIdentity(path.join(root, "auth"));
  const journal = new WorkerJournal(path.join(root, "independent-provider-storage")); await journal.initialize();
  let options: HarnessStartOptions | undefined, stopped = 0, starts = 0;
  const capabilities = { questions: true, appMcp: true, autoAllow: true, denyReason: true, liveReconfigure: true };
  const engine = new WorkerEngine(journal, { validateSelection: async () => {}, cwd: async () => root, reserve: async () => () => {},
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
