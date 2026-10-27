import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { HarnessTaskExecutor, type ExecutionAuthority } from "./executor.js";
import { SessionManager } from "../sessions/manager.js";
import { SessionStore } from "../sessions/store.js";
import { ProfileStore } from "../profiles/store.js";
import { SettingsStore } from "../settings/store.js";
import { AuditReporter } from "../audit.js";
import type { HarnessAdapter, HarnessStartOptions, HarnessRun } from "../harness/adapter.js";
import type { TaskExecutionInput } from "@hosty-sdk/app/tasks";
let dir: string, manager: SessionManager, profiles: ProfileStore, executor: HarnessTaskExecutor;
let runOptions: HarnessStartOptions | undefined;
const sent = vi.fn(), stopped = vi.fn(async () => {}), valid = vi.fn(async () => {});
const actor: ExecutionAuthority = { actor: { userId: "owner", appId: "example.producer", installationId: "one" }, scope: "example.producer:one", validate: valid };
const input: TaskExecutionInput = { taskRef: { appId: "example.producer", installationId: "one", key: "default", id: randomUUID() }, taskRevision: 1,
  input: { title: "Write summary", markdown: "A plain task without a workspace.", requiresReview: false, resources: [] } };
const adapter: HarnessAdapter = { name: "controlled", capabilities: { questions: true, appMcp: true, liveReconfigure: false, autoAllow: false, denyReason: false }, probe: async () => ({ available: true }),
  start: options => { runOptions = options; return { send: sent, resolveApproval: () => true, resolveQuestion: () => true, setMcpServers: async () => false, interrupt: async () => {}, stop: stopped, stopAndWait: stopped } satisfies HarnessRun; } };
function openManager() { return new SessionManager(new SessionStore(dir), adapter, new AuditReporter(null, null, "example.harness"), dir, new SettingsStore(dir), null, null, null, "http://localhost:1234", null, null, null, null, undefined, profiles); }
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hosty-executor-")); runOptions = undefined; vi.clearAllMocks();
  profiles = new ProfileStore(dir, async () => ({ name: "Writer", description: "", instructions: "Write carefully", connectionId: null, model: null, reasoningEffort: null, skillIds: [] }), async () => []);
  manager = openManager(); executor = new HarnessTaskExecutor(manager);
});
afterEach(async () => { await manager.shutdown(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
it("accepts durably without running inline, then replays after profile deletion and restart", async () => {
  const id = randomUUID(), a = await executor.accept(id, input, actor); expect(a.state).toBe("accepted"); expect(sent).not.toHaveBeenCalled();
  const directory = await profiles.read(); await profiles.remove(directory.defaultId!, directory.revision);
  executor = new HarnessTaskExecutor(manager);
  await executor.tick(); expect(sent).not.toHaveBeenCalled();
  expect(await executor.accept(id, input, actor)).toEqual(a);
  await executor.tick(); expect(sent).toHaveBeenCalledTimes(1);
  expect(runOptions?.systemPrompt).toContain("Write carefully");
  expect(runOptions?.mcpServers).toHaveProperty("hosty-workspaces");
  await executor.accept(id, input, actor); await executor.tick(); expect(sent).toHaveBeenCalledTimes(1);
  await expect(executor.accept(id, { ...input, input: { ...input.input, markdown: "different" } }, actor)).rejects.toMatchObject({ code: "execution_conflict" });
});
it("requires explicit outcome and confirmed native exit before success", async () => {
  const id = randomUUID(), a = await executor.accept(id, input, actor); await executor.tick();
  await executor.report(a.sessionRef!.id, randomUUID(), { markdown: "Task outcome", resources: [] });
  expect((await executor.get(id, actor)).state).toBe("running");
  runOptions!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(a.sessionRef!.id))?.status).toBe("idle"));
  await executor.tick(); expect(await executor.get(id, actor)).toMatchObject({ state: "completed", stopConfirmed: true, result: { markdown: "Task outcome" } });
  expect(stopped).toHaveBeenCalled();
});
it("does not treat an ordinary successful turn as task completion", async () => {
  const id = randomUUID(), a = await executor.accept(id, input, actor); await executor.tick();
  runOptions!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(a.sessionRef!.id))?.status).toBe("idle"));
  await executor.tick(); expect(await executor.get(id, actor)).toMatchObject({ state: "failed", stopConfirmed: true, error: { code: "task_result_missing" } });
});
it("fences a late acceptance after cancel-before-PUT and scopes IDs to provider installations", async () => {
  const id = randomUUID(); await executor.cancel(id, randomUUID(), actor);
  expect(await executor.accept(id, input, actor)).toMatchObject({ state: "cancelled", stopConfirmed: true });
  await executor.tick(); expect(sent).not.toHaveBeenCalled();
  const other = { ...actor, scope: "example.producer:two", actor: { ...actor.actor, installationId: "two" } };
  expect((await executor.accept(id, input, other)).state).toBe("accepted");
});
it("retains uncertain native termination and rejects late outcome after cancellation", async () => {
  const id = randomUUID(), a = await executor.accept(id, input, actor); await executor.tick();
  stopped.mockRejectedValueOnce(new Error("Native child still exists"));
  await executor.cancel(id, randomUUID(), actor); await executor.tick();
  expect(await executor.get(id, actor)).toMatchObject({ state: "cancelling", stopConfirmed: false });
  await expect(executor.report(a.sessionRef!.id, randomUUID(), { markdown: "late", resources: [] })).rejects.toMatchObject({ code: "execution_closed" });
  await executor.tick(); expect(await executor.get(id, actor)).toMatchObject({ state: "cancelled", stopConfirmed: true });
});
it("checks current authority before replay and keeps missing profiles explicit", async () => {
  const id = randomUUID(); await executor.accept(id, input, actor);
  const denied = { ...actor, validate: async () => { throw new Error("revoked"); } };
  await expect(executor.accept(id, input, denied)).rejects.toThrow("revoked");
  const bad = await executor.accept(randomUUID(), { ...input, executorOptionId: randomUUID() }, actor);
  expect(bad).toMatchObject({ state: "failed", stopConfirmed: true, error: { code: "profile_not_found" } });
});
it("recovers authorized local cancellation without saved credentials and fences extra chat turns", async () => {
  const id = randomUUID(), accepted = await executor.accept(id, input, actor); await executor.tick();
  await expect(manager.postMessage(accepted.sessionRef!.id, "another turn", undefined, [], { actorUserId: "owner", clientRequestId: randomUUID() }))
    .rejects.toMatchObject({ code: "task_managed_session" });
  executor = new HarnessTaskExecutor(manager);
  await executor.recoverCancellation(id, actor.scope, actor.actor.userId);
  await executor.tick();
  expect(await executor.peek(id, actor.scope, actor.actor.userId)).toMatchObject({ state: "cancelled", stopConfirmed: true });
  expect(sent).toHaveBeenCalledTimes(1);
});
it("attaches an existing workspace with its participation revision and reuses original recovery arguments", async () => {
  const id = randomUUID(), workspaceId = "existing-workspace";
  vi.spyOn(manager, "workspaceInventory").mockResolvedValue({ workspaces: [{ id: workspaceId, participation: { revision: 7 } }] });
  const attach = vi.spyOn(manager, "workspaceAction").mockResolvedValue({});
  const a = await executor.accept(id, { ...input, input: { ...input.input, workspaceId } }, { ...actor, credential: "volatile-user" });
  const session = await manager.getSession(a.sessionRef!.id);
  session!.associationRequests = [{ id, action: "attach", input: { workspaceId, expectedRevision: 3, requestId: id }, state: "succeeded" }];
  await manager.store.saveRecord(session!);
  await executor.tick();
  expect(attach).toHaveBeenCalledWith(a.sessionRef!.id, "attach", { workspaceId, expectedRevision: 3, requestId: id }, "volatile-user", "owner");
  expect(sent).toHaveBeenCalledTimes(1);
});
it("allows an explicit retry after a known rejection before native admission", async () => {
  vi.spyOn(manager, "postMessage").mockRejectedValue(new Error("Selected connection unavailable"));
  const id = randomUUID(); await executor.accept(id, input, actor); await executor.tick();
  expect(await executor.get(id, actor)).toMatchObject({ state: "failed", stopConfirmed: true, error: { message: "Selected connection unavailable" } });
  expect(sent).not.toHaveBeenCalled();
});

it("keeps an accepted task's profile and model immutable before dispatch", async () => {
  const id = randomUUID(), accepted = await executor.accept(id, input, actor);
  const sid = accepted.sessionRef!.id;
  await expect(manager.setProfile(sid, { profileId: null, expectedRevision: 0 }))
    .rejects.toMatchObject({ code: "profile_locked" });
  await expect(manager.setModel(sid, { selection: { model: null }, expectedRevision: 0 }))
    .rejects.toMatchObject({ code: "task_managed_session" });
  await executor.tick();
  expect(runOptions?.systemPrompt).toContain("Write carefully");
});
it("reserves the task's first message for its executor even when a caller knows the execution ID", async () => {
  const id = randomUUID(), accepted = await executor.accept(id, input, actor);
  await expect(manager.postMessage(accepted.sessionRef!.id, "Replace the task instructions", undefined, [], { actorUserId: "owner", clientRequestId: id }))
    .rejects.toMatchObject({ code: "task_managed_session" });
  expect(sent).not.toHaveBeenCalled();
  await executor.tick();
  expect(sent).toHaveBeenCalledTimes(1);
  expect(sent.mock.calls[0]?.[0]).toContain(input.input.markdown);
});

it.each(["workspace", "adapter"] as const)("recovers a definite local %s startup rejection without replacing its attempt", async failure => {
  if (failure === "workspace") vi.spyOn(manager.store, "ensureWorkspace").mockRejectedValueOnce(new Error("Workspace preparation failed"));
  else vi.spyOn(adapter, "start").mockImplementationOnce(() => { throw new Error("Native startup failed"); });
  const id = randomUUID(), accepted = await executor.accept(id, input, actor);
  await executor.tick();
  expect(await manager.messageReceipt(accepted.sessionRef!.id, id, "owner")).toMatchObject({ state: "rejected" });
  expect(await executor.get(id, actor)).toMatchObject({ state: "failed", stopConfirmed: true });
  expect(sent).not.toHaveBeenCalled();
  executor = new HarnessTaskExecutor(manager);
  await executor.tick();
  expect(await executor.accept(id, input, actor)).toMatchObject({ state: "failed", stopConfirmed: true });
  await manager.cancelSession(accepted.sessionRef!.id);
  await executor.accept(randomUUID(), input, actor);
  await executor.tick();
  expect(sent).toHaveBeenCalledTimes(1);
});
it("keeps failed local send admission uncertain until native exit is confirmed", async () => {
  sent.mockImplementationOnce(() => { throw new Error("Lost send acknowledgement"); });
  const id = randomUUID(), accepted = await executor.accept(id, input, actor);
  await executor.tick();
  expect(await manager.messageReceipt(accepted.sessionRef!.id, id, "owner")).toMatchObject({ state: "unknown" });
  expect(await executor.get(id, actor)).toMatchObject({ state: "interrupted", stopConfirmed: false });
  expect(manager.hasLiveTaskRun(accepted.sessionRef!.id)).toBe(true);
  await executor.cancel(id, randomUUID(), actor); await executor.tick();
  expect(await executor.get(id, actor)).toMatchObject({ state: "cancelled", stopConfirmed: true });
});
it.each([false, true])("confirms local abandoned-task exit and continues past a failed stop (%s)", async failFirstStop => {
  const executions: { id: string; sessionId: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const id = randomUUID(), accepted = await executor.accept(id, input, actor); await executor.tick();
    const sessionId = accepted.sessionRef!.id;
    runOptions!.onEvent({ type: "question_request", questionId: randomUUID(), questions: [{ question: "Continue?", header: "Confirm", options: [{ label: "Yes", description: "Continue the task" }], multiSelect: false }] });
    await vi.waitFor(async () => expect((await manager.getSession(sessionId))?.status).toBe("awaiting_question"));
    executions.push({ id, sessionId });
  }
  if (failFirstStop) stopped.mockRejectedValueOnce(new Error("Native exit is not confirmed"));
  const day = 24 * 60 * 60 * 1000;
  expect(await manager.sweepAbandoned(day, Date.now() + 2 * day)).toEqual(executions.slice(failFirstStop ? 1 : 0).map(e => e.sessionId));
  if (failFirstStop) {
    expect(manager.hasLiveTaskRun(executions[0]!.sessionId)).toBe(true);
    expect((await manager.getSession(executions[0]!.sessionId))?.status).toBe("awaiting_question");
    expect(await manager.sweepAbandoned(day, Date.now() + 2 * day)).toEqual([executions[0]!.sessionId]);
  }
  await executor.tick();
  for (const execution of executions) {
    expect((await manager.getSession(execution.sessionId))?.status).toBe("abandoned");
    expect(await executor.get(execution.id, actor)).toMatchObject({ state: "failed", stopConfirmed: true });
    expect(manager.hasLiveTaskRun(execution.sessionId)).toBe(false);
  }
});

it("recovers persisted no-run proof even when the failed-status update did not complete", async () => {
  const saveReceipt = manager.store.saveMessageReceipt.bind(manager.store);
  vi.spyOn(manager.store, "saveMessageReceipt").mockImplementation(async (sessionId, receipt) => {
    await saveReceipt(sessionId, receipt);
    if (receipt.state === "rejected") throw new Error("Stopped before updating the session status");
  });
  vi.spyOn(adapter, "start").mockImplementationOnce(() => { throw new Error("Native startup failed"); });
  vi.spyOn(manager, "messageReceipt").mockRejectedValueOnce(new Error("Receipt temporarily unavailable"));
  const id = randomUUID(), accepted = await executor.accept(id, input, actor); await executor.tick();
  expect((await manager.getSession(accepted.sessionRef!.id))?.status).toBe("running");
  executor = new HarnessTaskExecutor(manager);
  await executor.tick();
  expect(await executor.get(id, actor)).toMatchObject({ state: "failed", stopConfirmed: true });
  expect(sent).not.toHaveBeenCalled();
});

it("waits for the final session status when a started run has confirmed exit", async () => {
  const id = randomUUID(), accepted = await executor.accept(id, input, actor); await executor.tick();
  await executor.report(accepted.sessionRef!.id, randomUUID(), { markdown: "Explicit outcome", resources: [] });
  const session = (await manager.getSession(accepted.sessionRef!.id))!;
  vi.spyOn(manager, "getSession").mockResolvedValueOnce({ ...session, status: "running", taskRun: { started: true, exitConfirmed: true } });
  await executor.tick();
  expect(await executor.get(id, actor)).toMatchObject({ state: "running", stopConfirmed: false });
  runOptions!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(accepted.sessionRef!.id))?.status).toBe("idle"));
  await executor.tick();
  expect(await executor.get(id, actor)).toMatchObject({ state: "completed", stopConfirmed: true });
});
