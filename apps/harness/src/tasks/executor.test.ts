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
afterEach(async () => { await manager.shutdown(); await rm(dir, { recursive: true, force: true }); });
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
