import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DecisionClient, type DecisionRecord } from "@hosty-sdk/app/decisions";
import { DecisionsService } from "./service.js";
import { SessionManager } from "../sessions/manager.js";
import { SessionStore } from "../sessions/store.js";
import { SettingsStore } from "../settings/store.js";
import { AuditReporter } from "../audit.js";
import { WorkerJournal } from "../worker/journal.js";
import { WorkerEngine } from "../worker/engine.js";
import { WorkerClient } from "../worker/client.js";
import { createWorkerServer } from "../worker/http.js";
import { ensureServiceIdentity } from "../worker/auth.js";
import { ProfileStore } from "../profiles/store.js";
import { HarnessTaskExecutor } from "../tasks/executor.js";
import { TaskService } from "../tasks/service.js";
import type { HarnessStartOptions } from "../harness/adapter.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function setup(nativeQuestion = true, kind: "codex" | "claude" = "codex") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "decision-native-boundary-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  vi.stubEnv("HOSTY_PUBLIC_ORIGIN_HTTP", "https://harness.example.test");
  const journal = new WorkerJournal(path.join(dir, "worker")); await journal.initialize();
  const identity = await ensureServiceIdentity(path.join(dir, "identity"));
  const starts: HarnessStartOptions[] = [], inputs: string[] = [], stop = vi.fn(async () => {}); let releases = 0;
  const capabilities = { questions: true, appMcp: true, liveReconfigure: false, autoAllow: true, denyReason: true };
  const engine = new WorkerEngine(journal, { reserve: async () => () => { releases++; }, validateSelection: async () => {}, cwd: async () => dir,
    adapter: async () => ({ name: kind, capabilities, probe: async () => ({ available: true }), start: options => {
      starts.push(options);
      return { send: input => {
        inputs.push(input); options.onEvent({ type: "harness_session", harnessSessionId: "native-thread" });
        if (nativeQuestion && !options.resumeHarnessSessionId) options.onEvent({ type: "question_request", questionId: "native-question", blocking: true,
          questions: [{ id: "choice", header: "Choose", question: "Which summary?", options: [{ id: "brief", label: "Brief", description: "One paragraph" }], multiSelect: false }] });
      }, resolveApproval: () => true, resolveQuestion: () => true, setMcpServers: async () => false, interrupt: async () => {}, stop: async () => {}, stopAndWait: stop };
    } }),
  }, 1);
  const server = createWorkerServer(engine, async () => identity, { capabilities: async () => ({ capacity: 1 }), configure: async () => ({}), connection: async () => ({}), models: async () => ({}) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await engine.close(); });
  const worker = new WorkerClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`, identity);
  const remote = worker.adapter({ connectionId: "account", connectionRevision: 1, harnessKind: kind }, capabilities, kind);
  const profiles = new ProfileStore(dir, async () => ({ name: "Writer", description: "", instructions: "Write carefully", connectionId: null, model: null, reasoningEffort: null, skillIds: [] }), async () => []);
  const directory = await profiles.read(); await profiles.setDefault(directory.profiles[0]!.id, directory.revision);
  const rows = new Map<string, DecisionRecord>(), client = new DecisionClient(async () => { throw new Error("No transport"); });
  client.create = async input => {
    const existing = [...rows.values()].find(r => r.input?.correlationKey === input.input.correlationKey); if (existing) return structuredClone(existing);
    const row: DecisionRecord = { id: randomUUID(), userId: "owner", sequence: 1, revision: 1, sourceAppId: "harness", sourceInstallation: "one", sourcePrincipal: "app", correlationHash: "hash", input: input.input,
      state: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resolution: null, delivery: null, continuation: null };
    rows.set(row.id, row); return structuredClone(row);
  };
  client.get = async id => structuredClone(rows.get(id)!);
  client.responses = async () => ({ items: [...rows.values()].filter(r => r.resolution && !r.delivery?.receivedAt).map(r => structuredClone(r)), pendingCount: 0, cursor: null });
  client.resolve = async (id, input) => {
    const row = rows.get(id)!; row.state = "answered"; row.revision++;
    row.resolution = { revision: row.revision, userId: "owner", principalId: "owner", answers: input.answers, answeredAt: new Date().toISOString() };
    row.delivery = { resolutionRevision: row.revision, receivedAt: null }; row.continuation = { revision: 1, commandId: null, state: "pending", updatedAt: row.createdAt };
    return structuredClone(row);
  };
  client.withdraw = async id => { const row = rows.get(id)!; row.state = "withdrawn"; return structuredClone(row); };
  client.acknowledge = async id => { const row = rows.get(id)!; row.delivery!.receivedAt = new Date().toISOString(); row.continuation!.state = "received"; return structuredClone(row); };
  client.continuation = async (id, input) => { const row = rows.get(id)!; expect(input.expectedRevision).toBe(row.continuation!.revision); row.continuation = { ...row.continuation!, commandId: input.commandId, state: input.state, reason: input.reason, revision: input.expectedRevision + 1 }; return structuredClone(row); };
  const open = () => {
    const manager = new SessionManager(new SessionStore(dir), remote, new AuditReporter(null, null, "harness"), dir, new SettingsStore(dir), null, null, null, "http://localhost:1234", null, null, null, worker, undefined, profiles);
    const decisions = manager.decisions = new DecisionsService(manager, () => client, () => Date.now() + 8 * 3600_000);
    vi.spyOn(decisions, "kick").mockImplementation(() => {}); decisions.authorize("owner", "volatile-current-authority");
    cleanup.push(async () => { await decisions.close(); await manager.shutdown(); });
    return { manager, decisions };
  };
  const initial = open();
  return { ...initial, open, starts, inputs, releases: () => releases, journal, dir, client, stop };
}
async function waiting(f: Awaited<ReturnType<typeof setup>>, id: string) {
  await vi.waitFor(async () => expect((await f.manager.getSession(id))?.status).toBe("awaiting_question"));
  const waits = await f.decisions.waits.list("owner"); expect(waits).toHaveLength(1);
  // The exact provider binding is part of the production session snapshot; this fixture uses a
  // static Worker adapter rather than the ConnectionService account registry.
  expect(waits[0]?.native.sessionId).toBe("native-thread");
  return waits[0]!;
}
it("parks, restarts the coordinator, and continues the same native thread once with its saved answer", async () => {
  const f = await setup();
  const chat = await f.manager.createSession({ createdBy: "owner", title: "Question" });
  await f.manager.postMessage(chat.id, "Ask first", "volatile-current-authority");
  const wait = await waiting(f, chat.id);
  // Set only the adapter kind absent from this static registry fixture before registration.
  await f.decisions.waits.update(wait.id, w => ({ ...w!, native: { ...w!.native, kind: "codex" } }));
  await f.decisions.tick();
  await vi.waitFor(async () => expect((await f.manager.getSession(chat.id))?.workerRun).toBeUndefined());
  expect((await f.manager.getSession(chat.id))?.status).toBe("awaiting_question"); expect(f.releases()).toBe(1);
  await f.decisions.close(); await f.manager.shutdown();
  const reopened = f.open(), saved = await reopened.decisions.local("owner", wait.id);
  await reopened.decisions.resolve("owner", saved.core!.id, { requestId: randomUUID(), expectedRevision: saved.core!.revision, answers: { choice: { optionIds: ["brief"] } } });
  await reopened.decisions.tick();
  await vi.waitFor(() => expect(f.starts).toHaveLength(2));
  expect(f.starts[1]).toMatchObject({ resumeHarnessSessionId: "native-thread", requireNativeResume: true });
  expect(f.inputs[1]).toContain(saved.core!.id);
  const messages = (await reopened.manager.store.readEvents(chat.id)).filter(e => e.type === "user_message");
  expect(messages.at(-1)?.text).toBe("Continue with the saved answer.");
  expect(JSON.stringify(messages)).not.toContain('"resolutionRevision"');
  await reopened.decisions.tick(); expect(f.starts).toHaveLength(2);
  f.starts[1]!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await reopened.manager.getSession(chat.id))?.status).toBe("idle"));
  await reopened.decisions.tick(); expect((await reopened.decisions.local("owner", wait.id)).state).toBe("completed");
  expect((await reopened.manager.store.readEvents(chat.id)).filter(e => e.type === "question_answered")).toHaveLength(1);
});
it.each([["codex", false], ["claude", true]] as const)("%s continues its parked question ahead of follow-ups without consuming the queue (paused: %s)", async (kind, paused) => {
  const f = await setup(true, kind);
  const chat = await f.manager.createSession({ createdBy: "owner", title: "Question with follow-ups" });
  await f.manager.postMessage(chat.id, "Ask first", "volatile-current-authority");
  const wait = await waiting(f, chat.id), entryIds = [randomUUID(), randomUUID()];
  const queueCommand = async (command: Record<string, unknown>) => f.manager.messageQueueCommand(chat.id, "owner", {
    requestId: randomUUID(), expectedRevision: (await f.manager.messageQueue(chat.id, "owner")).revision, command,
  });
  for (const [index, entryId] of entryIds.entries()) await queueCommand({ type: "enqueue", entryId, text: `Follow-up ${index + 1}`, attachments: [] });
  if (paused) await queueCommand({ type: "pause" });
  await expect(f.manager.postMessage(chat.id, "Unrelated new turn", "volatile-current-authority")).rejects.toMatchObject({ code: "queue_pending" });
  await f.decisions.waits.update(wait.id, w => ({ ...w!, native: { ...w!.native, kind } }));
  await f.decisions.tick();
  await vi.waitFor(async () => expect((await f.manager.getSession(chat.id))?.workerRun).toBeUndefined());
  const saved = await f.decisions.local("owner", wait.id);
  await f.decisions.resolve("owner", saved.core!.id, { requestId: randomUUID(), expectedRevision: saved.core!.revision, answers: { choice: { optionIds: ["brief"] } } });
  await f.decisions.tick();
  await vi.waitFor(() => expect(f.starts).toHaveLength(2));
  expect(f.starts[1]).toMatchObject({ resumeHarnessSessionId: "native-thread", requireNativeResume: true });
  expect(f.inputs[1]).toContain(saved.core!.id);
  await expect(f.manager.postMessage(chat.id, "Forged continuation", "volatile-current-authority", [], {
    clientRequestId: randomUUID(), actorUserId: "owner", decisionContinuation: {
      id: wait.id, owner: "someone-else", snapshot: wait.snapshot, cancellationGeneration: wait.cancellationGeneration,
    },
  })).rejects.toMatchObject({ code: "stale_input" });
  const queue = await f.manager.messageQueue(chat.id, "owner");
  expect(queue.entries.map(entry => [entry.id, entry.state, entry.text])).toEqual(entryIds.map((id, index) => [id, "queued", `Follow-up ${index + 1}`]));
  expect(queue.paused).toBe(paused);
  await expect(f.manager.postMessage(chat.id, "Still cannot overtake", "volatile-current-authority")).rejects.toMatchObject({ code: "queue_pending" });
  await f.decisions.tick(); expect(f.starts).toHaveLength(2);
  // Pausing future messages must not cancel the continued turn or retire either follow-up.
  if (!paused) await queueCommand({ type: "pause" });
  f.starts[1]!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await f.manager.getSession(chat.id))?.status).toBe("idle"));
  expect((await f.manager.messageQueue(chat.id, "owner")).entries.map(entry => entry.id)).toEqual(entryIds);
  expect((await f.manager.store.readEvents(chat.id)).filter(event => event.type === "user_message").map(event => event.text)).toEqual(["Ask first", "Continue with the saved answer."]);
});
it("keeps the original task attempt awaiting input through parking and reports its explicit result after continuation", async () => {
  const f = await setup(), executor = new HarnessTaskExecutor(f.manager), executionId = randomUUID();
  const authority = { actor: { userId: "owner", appId: "source", installationId: "one" }, scope: "source:one", credential: "volatile-current-authority", validate: async () => {} };
  const ref = { appId: "source", installationId: "one", key: "default", id: randomUUID() };
  const input: import("@hosty-sdk/app/tasks").TaskExecutionInput = { version: 1, taskRef: ref, inputRevision: 1,
    content: { title: "Summary", markdown: "Ask before writing", review: { mode: "none" }, resources: [] },
    relations: { rootTaskRef: ref, parentTaskRef: null, relationRevision: 1 }, prerequisiteOutcomes: [] };
  const accepted = await executor.accept(executionId, input, authority); await executor.tick();
  const wait = await waiting(f, accepted.sessionRef!.id);
  await f.decisions.waits.update(wait.id, w => ({ ...w!, native: { ...w!.native, kind: "codex" } }));
  await f.decisions.tick(); await vi.waitFor(async () => expect((await f.manager.getSession(wait.sessionId))?.workerRun).toBeUndefined());
  await executor.tick(); expect(await executor.get(executionId, authority)).toMatchObject({ state: "awaiting_input", stopConfirmed: false, nativeStopConfirmed: true });
  const saved = await f.decisions.local("owner", wait.id);
  await f.decisions.resolve("owner", saved.core!.id, { requestId: randomUUID(), expectedRevision: saved.core!.revision, answers: { choice: { text: "Keep it brief" } } });
  await f.decisions.tick(); await vi.waitFor(() => expect(f.starts).toHaveLength(2));
  expect((await f.manager.getSession(wait.sessionId))?.taskExecutionId).toBe(executionId);
  await executor.report(wait.sessionId, randomUUID(), { markdown: "The requested summary", resources: [] });
  f.starts[1]!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await f.manager.getSession(wait.sessionId))?.status).toBe("idle"));
  await executor.tick(); expect(await executor.get(executionId, authority)).toMatchObject({ state: "completed", stopConfirmed: true, result: { markdown: "The requested summary" } });
  expect(f.starts).toHaveLength(2);
});


it.each([["codex", "completed"], ["claude", "completed"], ["codex", "failed"], ["claude", "failed"]] as const)("%s resumes an external required-input task through TaskService after restart (%s)", async (kind, outcome) => {
  const f = await setup(false, kind), service = new TaskService(f.manager), executor = service.executor, executionId = randomUUID();
  cleanup.push(() => service.close());
  const authority = { actor: { userId: "owner", appId: "source", installationId: "one" }, scope: "source:one", credential: "volatile-current-authority", validate: async () => {} };
  const ref = { appId: "source", installationId: "one", key: "default", id: randomUUID() };
  const accepted = await executor.accept(executionId, { version: 1, taskRef: ref, inputRevision: 1,
    content: { title: "Missing setup", markdown: "Require configured setup before completing", review: { mode: "none" }, resources: [] },
    relations: { rootTaskRef: ref, parentTaskRef: null, relationRevision: 1 }, prerequisiteOutcomes: [] }, authority);
  await executor.tick(); const sessionId = accepted.sessionRef!.id;
  await vi.waitFor(async () => expect((await f.manager.getSession(sessionId))?.harnessSessionId).toBe("native-thread"));
  const previousResult = randomUUID();
  await executor.report(sessionId, previousResult, { markdown: "Premature success", resources: [] });
  const request = { requestId: randomUUID(), reason: "Configure the missing Git author",
    questions: [{ id: "setup", header: "Setup", question: "Have you configured the Git author?", isOther: true,
      options: [{ label: "Configured", description: "Recheck the saved configuration" }] }] };
  f.starts[0]!.onEvent({ type: "tool_use", toolUseId: "input-call", toolName: "mcp__tasks__task_request_input", input: request });
  const registered = await f.manager.requestTaskInput(sessionId, request);
  await f.decisions.tick();
  expect((await f.decisions.local("owner", registered.waitId)).core?.state).toBe("pending");
  expect(f.releases()).toBe(0);
  await expect(executor.report(sessionId, randomUUID(), { markdown: "Not done, waiting", resources: [] })).rejects.toMatchObject({ code: "required_input_pending" });
  await expect(f.manager.requestTaskInput(sessionId, { ...request, reason: "Changed request" })).rejects.toMatchObject({ code: "request_conflict" });
  f.starts[0]!.onEvent({ type: "tool_result", toolUseId: "input-call", status: "completed", output: JSON.stringify(registered) });
  await vi.waitFor(async () => expect((await f.manager.getSession(sessionId))?.taskBarrier?.acknowledgedSequence).toBeTruthy());
  await f.decisions.tick();
  await vi.waitFor(async () => expect((await f.manager.getSession(sessionId))?.taskBarrier?.state).toBe("parked"));
  await executor.tick(); expect(await executor.get(executionId, authority)).toMatchObject({ state: "awaiting_input", stopConfirmed: false, nativeStopConfirmed: true, wait: { kind: "human" } });
  expect(await f.manager.sweepAbandoned(1, Date.now() + 86400000)).toEqual([]);
  await service.close(); await f.decisions.close(); await f.manager.shutdown();
  const reopened = f.open(), resumedService = new TaskService(reopened.manager), wait = await reopened.decisions.local("owner", registered.waitId);
  cleanup.push(() => resumedService.close());
  await reopened.decisions.resolve("owner", wait.core!.id, { requestId: randomUUID(), expectedRevision: wait.core!.revision, answers: { setup: { text: "Configured" } } });
  await reopened.decisions.tick();
  await vi.waitFor(() => expect(f.starts).toHaveLength(2));
  expect(f.starts[1]).toMatchObject({ requireNativeResume: true, resumeHarnessSessionId: "native-thread" });
  expect(f.inputs[1]).toContain("Recheck any setup prerequisite");
  expect((await reopened.manager.getSession(sessionId))?.taskExecutionId).toBe(executionId);
  await reopened.decisions.tick(); expect(f.starts).toHaveLength(2);
  const resumed = resumedService.executor;
  await expect(resumed.report(sessionId, previousResult, { markdown: "Premature success", resources: [] })).rejects.toMatchObject({ code: "result_superseded" });
  const replayed = await reopened.manager.requestTaskInput(sessionId, request);
  expect(replayed.state).toBe("running");
  expect((await reopened.manager.getSession(sessionId))?.status).toBe("running");
  const evidence = { markdown: outcome === "completed" ? "Verified setup and completed work" : "Setup was supplied but the build still failed", resources: [] };
  if (outcome === "completed") await resumed.report(sessionId, randomUUID(), evidence);
  else await resumed.fail(sessionId, randomUUID(), evidence);
  f.starts[1]!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await reopened.manager.getSession(sessionId))?.status).toBe("idle"));
  await resumed.tick(); expect(await resumed.get(executionId, authority)).toMatchObject({ state: outcome, stopConfirmed: true, result: evidence });
  expect(await resumedService.store.all()).toEqual([]);
});

async function requiredFixture() {
  const f = await setup(false), executor = new HarnessTaskExecutor(f.manager), executionId = randomUUID();
  const authority = { actor: { userId: "owner", appId: "source", installationId: "one" }, scope: "source:one", credential: "volatile-current-authority", validate: async () => {} };
  const ref = { appId: "source", installationId: "one", key: "default", id: randomUUID() };
  const receipt = await executor.accept(executionId, { version: 1, taskRef: ref, inputRevision: 1,
    content: { title: "Required input", markdown: "Wait for setup", review: { mode: "none" }, resources: [] },
    relations: { rootTaskRef: ref, parentTaskRef: null, relationRevision: 1 }, prerequisiteOutcomes: [] }, authority);
  await executor.tick(); const id = receipt.sessionRef!.id;
  await vi.waitFor(async () => expect((await f.manager.getSession(id))?.harnessSessionId).toBe("native-thread"));
  const request = { requestId: randomUUID(), reason: "Missing setup", questions: [{ id: "setup", header: "Setup", question: "Is setup configured?", isOther: true }] };
  f.starts[0]!.onEvent({ type: "tool_use", toolUseId: "required", toolName: "mcp__tasks__task_request_input", input: request });
  const registered = await f.manager.requestTaskInput(id, request);
  const acknowledge = async () => {
    f.starts[0]!.onEvent({ type: "tool_result", toolUseId: "required", status: "completed", output: JSON.stringify(registered) });
    await vi.waitFor(async () => expect((await f.manager.getSession(id))?.taskBarrier?.acknowledgedSequence).toBeTruthy());
  };
  const answer = async () => {
    const wait = await f.decisions.local("owner", registered.waitId);
    await f.decisions.resolve("owner", wait.core!.id, { requestId: randomUUID(), expectedRevision: wait.core!.revision, answers: { setup: { text: "Configured" } } });
  };
  return { ...f, executor, executionId, authority, id, registered, acknowledge, answer };
}
it("retains failed Decision registration visibly and retries the same request after recovery", async () => {
  const f = await requiredFixture();
  const create = vi.spyOn(f.client, "create").mockRejectedValue(new Error("Core unavailable"));
  await f.decisions.tick();
  const wait = await f.decisions.local("owner", f.registered.waitId);
  expect(wait.core).toBeUndefined(); expect(wait.error).toContain("Core unavailable");
  expect((await f.decisions.projections("owner")).items).toContainEqual(expect.objectContaining({ id: `decision-wait:${wait.id}`, kind: "recovery" }));
  await expect(f.executor.report(f.id, randomUUID(), { markdown: "Unfinished", resources: [] })).rejects.toMatchObject({ code: "required_input_pending" });
  create.mockRestore(); await f.decisions.tick();
  expect((await f.decisions.local("owner", wait.id)).create.requestId).toBe(wait.create.requestId);
  expect((await f.decisions.local("owner", wait.id)).core?.state).toBe("pending");
});
it("saves an early answer but cannot resume before acknowledgement and confirmed parking", async () => {
  const f = await requiredFixture(); await f.decisions.tick(); await f.answer(); await f.decisions.tick();
  expect(f.starts).toHaveLength(1); expect(f.releases()).toBe(0);
  await f.acknowledge(); await f.decisions.tick(); await f.decisions.tick();
  await vi.waitFor(() => expect(f.starts).toHaveLength(2));
  await f.decisions.tick(); expect(f.starts).toHaveLength(2);
});
it("fences an answered required-input wait after cancellation", async () => {
  const f = await requiredFixture(); await f.decisions.tick(); await f.acknowledge(); await f.decisions.tick();
  await vi.waitFor(async () => expect((await f.manager.getSession(f.id))?.taskBarrier?.state).toBe("parked"));
  await f.answer(); await f.executor.cancel(f.executionId, randomUUID(), f.authority); await f.decisions.tick();
  expect(f.starts).toHaveLength(1);
  expect((await f.manager.getSession(f.id))?.status).toBe("cancelled");
  await expect(f.executor.report(f.id, randomUUID(), { markdown: "Late", resources: [] })).rejects.toBeTruthy();
});
it("retains unknown task-input stop without starting a replacement", async () => {
  const f = await requiredFixture(); await f.decisions.tick(); f.stop.mockRejectedValue(new Error("Native process still exists"));
  await f.acknowledge(); await f.answer(); await f.decisions.tick();
  expect(f.starts).toHaveLength(1); expect(f.releases()).toBe(0);
  await f.executor.tick();
  expect(await f.executor.get(f.executionId, f.authority)).toMatchObject({ state: "awaiting_input", stopConfirmed: false, nativeStopConfirmed: false });
  f.stop.mockResolvedValue();
});
