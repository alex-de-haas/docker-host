import { TaskService } from "./service.js";
import { TaskStore } from "./store.js";
import { DevelopmentClient } from "../sessions/development.js";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
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
const ref = { appId: "example.producer", installationId: "one", key: "default", id: randomUUID() };
const input: TaskExecutionInput = { version: 1, taskRef: ref, inputRevision: 1,
  content: { title: "Write summary", markdown: "A plain task without a workspace.", review: { mode: "none" }, resources: [] },
  relations: { rootTaskRef: ref, parentTaskRef: null, relationRevision: 1 }, prerequisiteOutcomes: [] };
const adapter: HarnessAdapter = { name: "controlled", capabilities: { questions: true, appMcp: true, liveReconfigure: false, autoAllow: false, denyReason: false }, probe: async () => ({ available: true }),
  start: options => { runOptions = options; return { send: sent, resolveApproval: () => true, resolveQuestion: () => true, setMcpServers: async () => false, interrupt: async () => {}, stop: stopped, stopAndWait: stopped } satisfies HarnessRun; } };
function openManager(development: DevelopmentClient | null = null) { return new SessionManager(new SessionStore(dir), adapter, new AuditReporter(null, null, "example.harness"), dir, new SettingsStore(dir), null, null, null, "http://localhost:1234", null, null, development, null, undefined, profiles); }
beforeEach(async () => {
  vi.stubEnv("HOSTY_PUBLIC_ORIGIN_HTTP", "https://harness.example.test");
  dir = await mkdtemp(path.join(os.tmpdir(), "hosty-executor-")); runOptions = undefined; vi.clearAllMocks();
  profiles = new ProfileStore(dir, async () => ({ name: "Writer", description: "", instructions: "Write carefully", connectionId: null, model: null, reasoningEffort: null, skillIds: [] }), async () => []);
  const defaults = await profiles.read(); await profiles.setDefault(defaults.profiles[0]!.id, defaults.revision);
  manager = openManager(); executor = new HarnessTaskExecutor(manager);
});
afterEach(async () => { await manager.shutdown(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
it("discovers saved descriptions and revisions without exposing private configuration", async () => {
  const before = await profiles.read();
  const profile = before.profiles[0]!;
  const { id, revision, ...config } = profile;
  await profiles.save({ ...config, description: "Writes technical documentation", instructions: "Private role instructions" }, before.revision, id);
  expect(await executor.options()).toEqual({ version: 1, revision: before.revision + 1,
    options: [{ id, revision: revision + 1, name: "Writer", description: "Writes technical documentation",
      capabilities: ["markdown", "resources", "options", "cancellation"], availability: { state: "unknown" } }], defaultId: id });
});
it("persists autonomous task admission while retaining ordinary chat defaults and replayed mode choices", async () => {
  const chat = await manager.createSession({ createdBy: "owner" });
  expect(chat.autonomy ?? "normal").toBe("normal");
  const id = randomUUID(), receipt = await executor.accept(id, input, actor);
  const task = (await manager.getSession(receipt.sessionRef!.id))!;
  expect(task.autonomy).toBe("autonomous");
  await manager.setAutonomy(task.id, "normal", "owner");
  await executor.accept(id, input, actor);
  expect((await manager.getSession(task.id))?.autonomy).toBe("normal");
});
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
  await expect(executor.accept(id, { ...input, content: { ...input.content, markdown: "different" } }, actor)).rejects.toMatchObject({ code: "execution_conflict" });
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
  const bad = await executor.accept(randomUUID(), { ...input, selection: { kind: "option", id: randomUUID(), revision: 1 } }, actor);
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
  const authority = { ...actor, credential: "volatile-user" };
  const a = await executor.accept(id, input, authority);
  await executor.bindSource(id, workspaceId, authority);
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
  expect(sent.mock.calls[0]?.[0]).toContain(input.content.markdown);
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

it("recovers cancellation after graceful Local shutdown without a workspace", async () => {
  const id = randomUUID(), accepted = await executor.accept(id, input, actor); await executor.tick();
  await manager.shutdown();
  expect((await manager.store.readRecord(accepted.sessionRef!.id))?.taskRun).toEqual({ started: true, exitConfirmed: true });
  manager = openManager(); executor = new HarnessTaskExecutor(manager);
  await executor.cancel(id, randomUUID(), actor); await executor.tick();
  expect(await executor.get(id, actor)).toMatchObject({ state: "cancelled", stopConfirmed: true });
  expect(sent).toHaveBeenCalledTimes(1);
  expect(stopped).toHaveBeenCalledTimes(1);
});
it("records a live outcome while reconciliation is temporarily interrupted", async () => {
  const id = randomUUID(), accepted = await executor.accept(id, input, actor); await executor.tick();
  valid.mockRejectedValueOnce(new Error("Core temporarily unavailable"));
  await executor.tick();
  expect(await executor.get(id, actor)).toMatchObject({ state: "interrupted", stopConfirmed: false });
  expect(manager.hasLiveTaskRun(accepted.sessionRef!.id)).toBe(true);
  await expect(executor.report(accepted.sessionRef!.id, randomUUID(), { markdown: "Outcome during outage", resources: [] })).resolves.toMatchObject({ recorded: true });
  runOptions!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(accepted.sessionRef!.id))?.status).toBe("idle"));
  await executor.tick();
  expect(await executor.get(id, actor)).toMatchObject({ state: "completed", stopConfirmed: true, result: { markdown: "Outcome during outage" } });
});
it("rejects a new result when an interrupted execution no longer has a live run", async () => {
  const id = randomUUID(), accepted = await executor.accept(id, input, actor); await executor.tick();
  valid.mockRejectedValueOnce(new Error("Core temporarily unavailable"));
  await executor.tick();
  await manager.shutdown();
  await expect(executor.report(accepted.sessionRef!.id, randomUUID(), { markdown: "Late outcome", resources: [] })).rejects.toMatchObject({ code: "execution_closed" });
});

it("returns an absolute conversation URL to another application and a relative link to Harness", async () => {
  const external = await executor.accept(randomUUID(), input, actor);
  expect(external.sessionRef?.path).toBe(`https://harness.example.test/assistant?session=${external.sessionRef!.id}`);
  const local = await executor.accept(randomUUID(), input, { ...actor, scope: "hosty.harness:standalone", actor: { ...actor.actor, appId: "hosty.harness", installationId: "standalone" } });
  expect(local.sessionRef?.path).toBe(`/assistant?session=${local.sessionRef!.id}`);
});
it.each(["", "file:///tmp/harness", "https://user:password@harness.test"])("omits an unusable cross-app conversation origin: %s", async origin => {
  vi.stubEnv("HOSTY_PUBLIC_ORIGIN_HTTP", origin);
  const receipt = await executor.accept(randomUUID(), input, actor);
  expect(receipt.state).toBe("accepted");
  expect(receipt.sessionRef).toBeUndefined();
});

it("admits a mediated task workspace without user credentials and releases only after native exit", async () => {
  await manager.shutdown();
  vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.test"); vi.stubEnv("HOSTY_APP_ID", "independent.runner"); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "runner-service");
  const workspaceId = "f".repeat(64), treeId = "e".repeat(64), sourcePath = path.join(dir, "registered-source");
  await mkdir(sourcePath);
  const calls: import("@hosty-sdk/app/providers").TaskWorkspaceRequest[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe("http://core.test/api/internal/apps/independent.runner/task-workspace");
    expect(new Headers(init!.headers).get("X-Hosty-User-Token")).toBeNull();
    const body = JSON.parse(String(init!.body)) as typeof calls[number]; calls.push(body);
    if (body.kind === "activity") return Response.json({ workspaceId, revision: 2, stopRequested: false, state: body.activity!.status });
    return Response.json({ association: { workspace: { id: workspaceId, revision: 2 } }, sources: { workspaces: [{ id: treeId, workspaceId,
      path: sourcePath, branch: "task", targetBranch: "main", originalBase: "base", state: "active", repository: "repo", sessionPath: "/run",
      leases: body.kind === "lease" ? [body.leaseId] : [], pullRequests: [], apps: [], operations: [] }] } });
  });
  manager = openManager(new DevelopmentClient("http://core.test", "independent.runner", "runner-service")); executor = new HarnessTaskExecutor(manager);
  const id = randomUUID(), dispatch = { userId: "owner", principalId: "manual:original", requestId: randomUUID() };
  const authority = { ...actor, taskDispatch: dispatch, principalId: dispatch.principalId };
  const accepted = await executor.accept(id, input, authority);
  await executor.bindSource(id, workspaceId, authority);
  await executor.tick();
  const running = await executor.get(id, authority);
  expect(running.error).toBeUndefined();
  expect(running.state).toBe("running");
  expect(sent).toHaveBeenCalledOnce();
  expect(calls.map(c => c.kind)).toEqual(expect.arrayContaining(["observe", "attach", "lease", "activity"]));
  expect(calls.every(c => c.dispatch.requestId === dispatch.requestId && c.executionId === id && c.sessionId === accepted.sessionRef!.id)).toBe(true);
  const record = (await manager.getSession(accepted.sessionRef!.id))!;
  expect(record.developmentWorkspaces?.[0]?.path).toBe(sourcePath);
  let confirm!: () => void;
  stopped.mockImplementationOnce(() => new Promise<void>(resolve => { confirm = resolve; }));
  await executor.cancel(id, randomUUID(), authority);
  const stopping = executor.tick();
  await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce());
  expect(calls.some(c => c.activity?.stopped)).toBe(false);
  confirm(); await stopping;
  expect(calls.filter(c => c.activity?.stopped)).toHaveLength(1);
  expect(calls.find(c => c.activity?.stopped)?.leaseId).toBe(record.taskWorkspace?.leaseId);
  expect(await executor.get(id, authority)).toMatchObject({ state: "cancelled", stopConfirmed: true });
});

it("uses task-scoped fallback instructions without creating saved profiles or sharing sessions", async () => {
  const parentId = randomUUID(), aggregate = new TaskStore(dir, { appId: ref.appId, installationId: ref.installationId, key: ref.key });
  await aggregate.create(actor.actor, { requestId: randomUUID(), input: { ...input.content, assignee: null } });
  await aggregate.transaction(state => { const task = state.tasks[0]!; task.ref = input.taskRef; task.rootTaskRef = input.taskRef;
    task.coordination = { executionId: parentId, rootGeneration: 1, coordinatorEpoch: 1 }; });
  executor = new HarnessTaskExecutor(manager, aggregate);
  const parentReceipt = await executor.accept(parentId, input, actor);
  const parent = (await manager.getSession(parentReceipt.sessionRef!.id))!;
  const previous = await profiles.read(); await profiles.remove(previous.defaultId!, previous.revision);
  const directory = await profiles.read();
  const scope = { owner: "owner", rootTaskRef: input.taskRef, parentTaskRef: input.taskRef,
    parentExecutionId: parentId, parentSessionId: parent.id, generation: 1, coordinatorEpoch: 1 };
  const request = { requestId: randomUUID(), directoryRevision: directory.revision, name: "Requirements analyst",
    rationale: "No saved profiles are configured.", instructions: "Extract testable acceptance criteria.", skillIds: [] };
  const config = await executor.configurations.prepare(scope, parent, request);
  expect(await executor.configurations.prepare(scope, parent, request)).toEqual(config);
  expect((await profiles.read()).profiles).toHaveLength(0);
  const childInput = { ...input, taskRef: { ...input.taskRef, id: randomUUID() }, selection: config.selection,
    relations: { ...input.relations, parentTaskRef: input.taskRef } };
  const a = await executor.accept(randomUUID(), childInput, actor), b = await executor.accept(randomUUID(), { ...childInput, taskRef: { ...childInput.taskRef, id: randomUUID() } }, actor);
  expect(a.state).toBe("accepted"); expect(b.state).toBe("accepted");
  expect(a.sessionRef!.id).not.toBe(b.sessionRef!.id);
  const session = (await manager.getSession(a.sessionRef!.id))!;
  expect(session).toMatchObject({ autonomy: "autonomous", taskConfiguration: { id: config.selection.id, rationale: request.rationale },
    taskContext: { rootTaskRef: input.taskRef, executor: { kind: "configuration", name: "Requirements analyst" } } });
  expect(session.agentProfile?.instructions).toBe(request.instructions);
  const wrongRoot = await executor.accept(randomUUID(), { ...childInput, relations: { ...childInput.relations, rootTaskRef: { ...input.taskRef, id: randomUUID() } } }, actor);
  expect(wrongRoot).toMatchObject({ state: "failed", stopConfirmed: true, error: { code: "configuration_unavailable" } });
});
it("requires current profile discovery before preparing a fallback and rejects connection overrides", async () => {
  const id = randomUUID(), admitted = await executor.accept(id, input, actor), parent = (await manager.getSession(admitted.sessionRef!.id))!;
  const scope = { owner: "owner", rootTaskRef: input.taskRef, parentTaskRef: input.taskRef,
    parentExecutionId: id, parentSessionId: parent.id, generation: 1, coordinatorEpoch: 1 };
  const request = { requestId: randomUUID(), directoryRevision: 0, name: "Analyst", rationale: "The available writer profile does not analyze requirements.", instructions: "Analyze requirements.", skillIds: [] };
  await expect(executor.configurations.prepare(scope, parent, request)).rejects.toMatchObject({ code: "selection_changed" });
  await expect(executor.configurations.prepare(scope, parent, { ...request, directoryRevision: (await profiles.read()).revision, connectionId: "another-account" }))
    .rejects.toMatchObject({ code: "configuration_invalid" });
  await expect(executor.configurations.prepare({ ...scope, owner: "other" }, parent, request)).rejects.toMatchObject({ code: "configuration_forbidden" });
});

it("recovers a persisted launch intent with the original command and never repeats an uncertain dispatch", async () => {
  const aggregate = new TaskStore(dir, { appId: "example.producer", installationId: "one", key: "default" });
  executor = new HarnessTaskExecutor(manager, aggregate);
  const id = randomUUID(), accepted = await executor.accept(id, input, actor);
  const [key, stored] = (await aggregate.journalEntries<any>("execution:"))[0]!;
  stored.launchRequested = true;
  stored.launch = { commandId: id, prompt: "Retained first dispatch", contextRevision: 0, selectionRevision: 0 };
  await aggregate.writeJournal(key, stored);
  executor = new HarnessTaskExecutor(manager, aggregate);
  await executor.accept(id, input, actor); await executor.tick();
  expect(sent).toHaveBeenCalledExactlyOnceWith("Retained first dispatch");
  const receipt = (await manager.store.readMessageReceipt(accepted.sessionRef!.id, id))!;
  await manager.store.saveMessageReceipt(accepted.sessionRef!.id, { ...receipt, state: "unknown" });
  const uncertain = await aggregate.readJournal<any>(key);
  uncertain.launch.delivered = false; await aggregate.writeJournal(key, uncertain);
  executor = new HarnessTaskExecutor(manager, aggregate);
  await executor.accept(id, input, actor); await executor.tick(); await executor.tick();
  expect(sent).toHaveBeenCalledTimes(1);
  expect(await executor.get(id, actor)).toMatchObject({ state: "interrupted", stopConfirmed: false, error: { code: "message_outcome_unknown" } });
});

it("rechecks policy before recovering an intent that never reached native admission", async () => {
  const aggregate = new TaskStore(dir, { appId: ref.appId, installationId: ref.installationId, key: ref.key });
  executor = new HarnessTaskExecutor(manager, aggregate);
  const id = randomUUID(); await executor.accept(id, input, actor);
  const [key, stored] = (await aggregate.journalEntries<any>("execution:"))[0]!;
  stored.launchRequested = true;
  stored.launch = { commandId: id, prompt: "Unstarted retained intent", contextRevision: 0, selectionRevision: 0 };
  await aggregate.writeJournal(key, stored);
  const admit = vi.fn(async () => false);
  executor = new HarnessTaskExecutor(manager, aggregate); executor.beforeLaunch = admit;
  await executor.accept(id, input, actor); await executor.tick();
  expect(sent).not.toHaveBeenCalled();
  expect(await executor.get(id, actor)).toMatchObject({ state: "accepted", nativeStopConfirmed: true, wait: { kind: "limits" } });
  admit.mockResolvedValue(true); await executor.tick();
  expect(sent).toHaveBeenCalledExactlyOnceWith("Unstarted retained intent");
});

it("retries an adopted root in a fresh session and never adopts its chat as a child", async () => {
  const aggregate = new TaskStore(dir, { appId: ref.appId, installationId: ref.installationId, key: ref.key });
  const configurationId = randomUUID(), choice = { kind: "configuration" as const, id: configurationId, revision: 1 };
  let root = await aggregate.create(actor.actor, { requestId: randomUUID(), input: { ...input.content,
    assignee: { kind: "app", executor: aggregate.provider, selection: choice } } });
  root = await aggregate.action(root.ref.id, actor.actor, { requestId: randomUUID(), expectedRevision: root.revision, action: "ready" });
  const oldId = root.attempts[0]!.executionId;
  const original = await manager.createSession({ createdBy: "owner", profileId: null, taskExecutionId: oldId });
  const profile = (await profiles.read()).profiles[0]!;
  const configuration = { version: 1, selection: choice, name: "Chat configuration", rationale: "Retained chat instructions", directoryRevision: 1,
    requestHash: "original", createdAt: "now", launchMode: "adopt", sessionId: original.id,
    scope: { owner: "owner", rootTaskRef: root.ref, parentTaskRef: root.ref, parentExecutionId: configurationId, parentSessionId: original.id, generation: 1, coordinatorEpoch: 1 },
    profile, binding: {}, adoption: { approved: true, id: configurationId } };
  await aggregate.writeJournal("configuration:" + configurationId, configuration);
  root = await aggregate.observe(root.ref.id, oldId, { executionId: oldId, revision: 1, state: "failed", stopConfirmed: true, createdAt: "now", updatedAt: "now" });
  root = await aggregate.action(root.ref.id, actor.actor, { requestId: randomUUID(), expectedRevision: root.revision, action: "retry" });
  executor = new HarnessTaskExecutor(manager, aggregate);
  const next = root.attempts.at(-1)!;
  const receipt = await executor.accept(next.executionId, next.request, actor);
  expect(receipt.state).toBe("accepted"); expect(receipt.sessionRef!.id).not.toBe(original.id);
  expect((await manager.getSession(original.id))!.taskExecutionId).toBe(oldId);
  expect((await manager.getSession(receipt.sessionRef!.id))!.taskExecutionId).toBe(next.executionId);
  const child = { ...next.request, taskRef: { ...root.ref, id: randomUUID() }, relations: { ...next.request.relations, parentTaskRef: root.ref } };
  expect(await executor.accept(randomUUID(), child, actor)).toMatchObject({ state: "failed", error: { code: "configuration_unavailable" } });
});

it("starts distinct tasks concurrently from one saved profile without reusing their conversation", async () => {
  const profile = (await profiles.read()).profiles[0]!;
  const make = () => { const taskRef = { ...ref, id: randomUUID() }; return { ...input, taskRef, relations: { ...input.relations, rootTaskRef: taskRef }, selection: { kind: "option" as const, id: profile.id, revision: profile.revision } }; };
  const starts = vi.spyOn(adapter, "start");
  const receipts = await Promise.all([executor.accept(randomUUID(), make(), actor), executor.accept(randomUUID(), make(), actor)]);
  expect(receipts[0]!.sessionRef!.id).not.toBe(receipts[1]!.sessionRef!.id);
  await executor.tick();
  expect(starts).toHaveBeenCalledTimes(2); expect(sent).toHaveBeenCalledTimes(2);
  const sessions = await Promise.all(receipts.map(r => manager.getSession(r.sessionRef!.id)));
  expect(sessions.map(s => s!.taskContext!.executor)).toEqual([expect.objectContaining({ id: profile.id, name: profile.name }), expect.objectContaining({ id: profile.id, name: profile.name })]);
  expect(sessions[0]!.taskContext!.taskRef.id).not.toBe(sessions[1]!.taskContext!.taskRef.id);
  expect((await profiles.read()).profiles).toHaveLength(1);
});

it.each([false, true])("executes an externally owned task through the full service (mediated=%s)", async mediated => {
  const service = new TaskService(manager);
  const bind = vi.spyOn(service.orchestration, "bindNative");
  const source = vi.spyOn(service.sources, "beforeLaunch");
  try {
    const id = randomUUID();
    const authority = mediated ? { ...actor, taskDispatch: { userId: "owner", principalId: "external-client", requestId: randomUUID() } } : actor;
    const accepted = await service.executor.accept(id, input, authority);
    await service.executor.tick();
    expect(await service.executor.get(id, authority)).toMatchObject({ state: "running" });
    expect(sent).toHaveBeenCalledOnce();
    expect(bind).not.toHaveBeenCalled(); expect(source).not.toHaveBeenCalled();
    await service.executor.report(accepted.sessionRef!.id, randomUUID(), { markdown: "External provider result", resources: [] });
    runOptions!.onEvent({ type: "result", status: "success" });
    await vi.waitFor(async () => expect((await manager.getSession(accepted.sessionRef!.id))?.status).toBe("idle"));
    await service.executor.tick();
    expect(await service.executor.get(id, authority)).toMatchObject({ state: "completed", stopConfirmed: true });
    expect(await service.store.all()).toEqual([]);
  } finally { await service.close(); }
});


it("retains an unsuccessful report as failed attempt evidence rather than completed work", async () => {
  const id = randomUUID(), accepted = await executor.accept(id, input, actor); await executor.tick();
  const requestId = randomUUID(), result = { markdown: "The application is not implemented: build failed.", resources: [] };
  await executor.fail(accepted.sessionRef!.id, requestId, result);
  await executor.fail(accepted.sessionRef!.id, requestId, result);
  await expect(executor.report(accepted.sessionRef!.id, randomUUID(), result)).rejects.toMatchObject({ code: "result_conflict" });
  runOptions!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(accepted.sessionRef!.id))?.status).toBe("idle"));
  await executor.tick(); expect(await executor.get(id, actor)).toMatchObject({ state: "failed", stopConfirmed: true, result, error: { code: "task_failed" } });
});

it("keeps optional nonblocking clarification independent of successful task completion", async () => {
  const id = randomUUID(), receipt = await executor.accept(id, input, actor); await executor.tick();
  runOptions!.onEvent({ type: "question_request", questionId: "optional", blocking: false,
    questions: [{ id: "extra", header: "Optional", question: "Any optional additions?", options: [], multiSelect: false }] });
  await vi.waitFor(async () => expect((await manager.store.readEvents(receipt.sessionRef!.id)).some(e => e.type === "question_request")).toBe(true));
  await executor.report(receipt.sessionRef!.id, randomUUID(), { markdown: "Required work verified", resources: [] });
  runOptions!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await manager.getSession(receipt.sessionRef!.id))?.status).toBe("idle"));
  await executor.tick(); expect((await executor.get(id, actor)).state).toBe("completed");
});

it("invalidates a report when required input arrives during its barrier check", async () => {
  const id = randomUUID(), accepted = await executor.accept(id, input, actor); await executor.tick();
  const sessionId = accepted.sessionRef!.id, requestId = randomUUID(), result = { markdown: "Checked before the new question", resources: [] };
  const getSession = manager.getSession.bind(manager); let generation = 0;
  vi.spyOn(manager, "getSession").mockImplementation(async session => {
    const record = await getSession(session); return record && { ...record, taskInputGeneration: generation };
  });
  // The wait can be persisted immediately after the barrier's final read. Its answer must not
  // make a report already in flight count as fresh post-answer evidence.
  vi.spyOn(manager, "taskCompletionBarrier").mockImplementationOnce(async () => { generation++; return undefined; });
  await executor.report(sessionId, requestId, result);
  await expect(executor.report(sessionId, requestId, result)).rejects.toMatchObject({ code: "result_superseded" });
  await executor.report(sessionId, randomUUID(), { markdown: "Rechecked after the answer", resources: [] });
});
