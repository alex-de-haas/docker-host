import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ProfileStore } from "../profiles/store.js";
import { SettingsStore } from "../settings/store.js";
import { DevelopmentClient } from "../sessions/development.js";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { publicProviderFixture, type PublicProviderFixture } from "./test-fixture.js";

const fixtures: PublicProviderFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function fixture() {
  vi.stubEnv("HOSTY_CORE_ORIGIN", "");
  const f = await publicProviderFixture(); fixtures.push(f); return f;
}
async function idle(f: PublicProviderFixture, id: string) {
  await vi.waitFor(async () => expect((await f.store.readRecord(id))!.status).toBe("idle"));
}

it("admits the selected profile through the public configuration and pins it across edits and consumer restart", async () => {
  const f = await fixture(), skillId = "c".repeat(64);
  const settings = new SettingsStore(path.join(f.root, "settings"));
  await settings.update({ systemPrompt: "Original common instructions", workflowPrompt: "Original workflow", skillIds: ["b".repeat(64)] });
  const profiles = new ProfileStore(path.join(f.root, "profiles"), async () => ({ name: "Reviewer", description: "Review changes",
    instructions: "Keep the selected role instructions", connectionId: f.connectionId, model: "model", reasoningEffort: null, skillIds: [skillId] }), async () => [skillId]);
  const directory = await profiles.read(), profile = directory.profiles[0]!;
  const { manager } = f.makeManager({ settings, profiles });
  const record = await manager.createSession({ createdBy: f.owner, profileId: profile.id, profileRevision: profile.revision, autonomy: "autonomous" });
  expect(record).toMatchObject({ agentProfile: profile, selection: f.selection, connectionRevision: "1", skillIds: [skillId],
    executionSelection: { model: "model", reasoningEffort: null } });
  await manager.postMessage(record.id, "Review the change", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  const first = f.starts[0]!, admitted = structuredClone(f.sessions.get(first.sessionId)!.configuration!);
  expect(admitted).toMatchObject({ connection: f.selection.connection, approvalMode: "autonomous", skills: [{ skillId }] });
  expect(admitted.instructions?.map(block => block.text).join("\n")).toContain("Original common instructions");
  expect(admitted.instructions?.map(block => block.text).join("\n")).toContain("Original workflow");
  expect(admitted.instructions?.map(block => block.text).join("\n")).toContain("Keep the selected role instructions");
  expect(first.input.selection).toEqual({ model: "model", reasoningEffort: null });
  await expect(manager.setProfile(record.id, { profileId: null, expectedRevision: 0 })).rejects.toMatchObject({ code: "profile_locked" });
  f.complete(first.runId); await idle(f, record.id);
  await profiles.remove(profile.id, directory.revision);
  await settings.update({ systemPrompt: "Replacement common instructions", workflowPrompt: "Replacement workflow", skillIds: [] });
  await manager.shutdown();

  const reopenedProfiles = new ProfileStore(path.join(f.root, "profiles"), async () => { throw new Error("Do not recreate a deleted profile"); }, async () => []);
  const restored = f.makeManager({ settings, profiles: reopenedProfiles });
  await restored.manager.refreshSessionCredentials(record.id, f.owner, f.credential);
  await restored.manager.postMessage(record.id, "Continue the same review", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  expect(f.starts).toHaveLength(2);
  expect(f.starts[1]!.sessionId).toBe(first.sessionId);
  expect(f.sessions.get(first.sessionId)!.configuration).toEqual(admitted);
  expect(f.starts[1]!.input).toMatchObject({ continuation: "resume", selection: first.input.selection, configurationRevision: first.input.configurationRevision });
  expect(f.requests.filter(request => request.path.includes("/configurations/"))).toEqual([]);
  expect((await restored.store.readRecord(record.id))!).toMatchObject({ agentProfile: profile, skillIds: [skillId], profileLocked: true, selection: f.selection });
  f.complete(f.starts[1]!.runId); await idle(f, record.id);
});

it("rejects a changed public account revision after restart without replacing the pinned profile or starting another run", async () => {
  const f = await fixture();
  const profiles = new ProfileStore(path.join(f.root, "profiles"), async () => ({ name: "Writer", description: "Write text",
    instructions: "Pinned role", connectionId: f.connectionId, model: "model", reasoningEffort: null, skillIds: [] }), async () => []);
  const directory = await profiles.read(), profile = directory.profiles[0]!;
  const { manager } = f.makeManager({ profiles });
  const record = await manager.createSession({ createdBy: f.owner, profileId: profile.id, profileRevision: profile.revision });
  await manager.postMessage(record.id, "First turn", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  f.complete(f.starts[0]!.runId); await idle(f, record.id); await manager.shutdown();
  f.behavior.connectionRevision = "9007199254740993";
  const restored = f.makeManager({ profiles });
  await restored.manager.refreshSessionCredentials(record.id, f.owner, f.credential);
  await expect(restored.manager.postMessage(record.id, "Do not silently switch accounts", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() }))
    .rejects.toMatchObject({ code: "provider_connection_changed" });
  expect(f.starts).toHaveLength(1); expect(f.sessions.size).toBe(1);
  expect((await restored.store.readRecord(record.id))!).toMatchObject({ agentProfile: profile, selection: f.selection, connectionRevision: "1" });
  expect((await restored.store.readEvents(record.id)).filter(event => event.type === "user_message")).toHaveLength(1);
});

it("submits attached worktree identities and participation revisions while unknown stop protects their retained association", async () => {
  const f = await fixture(), workspaceId = "d".repeat(64), treeId = "e".repeat(64);
  const tree = { id: treeId, workspaceId, path: "/owned/native/private-worktree", state: "active", repository: "https://example.test/source",
    sessionPath: "/owned/native/session", apps: [], operations: [], leases: [] };
  const development = new DevelopmentClient("http://core.test", "unrelated.consumer", "fixture-service");
  const call = vi.spyOn(development, "call").mockImplementation(async (_id, _token, action) => {
    if (action === "attach") return { workspace: { id: workspaceId, revision: 37 } };
    if (action === "list") return { workspaces: [tree] };
    if (action === "workflow-status") return { state: "in-progress", revision: 37 };
    throw new Error(`Unexpected Core workspace operation: ${action}`);
  });
  const activity = vi.spyOn(development, "activity").mockResolvedValue({ workspaceId, revision: 37, stopRequested: false, state: "active" });
  vi.spyOn(development, "inspection").mockResolvedValue({ id: workspaceId, revision: 37 });
  const retention = vi.spyOn(development, "retention").mockResolvedValue({ kind: "workspace", workflow: { state: "in-progress", revision: 37 }, resourcesFinished: false });
  const { manager } = f.makeManager({ development });
  const record = await manager.createSession({ createdBy: f.owner });
  const attachId = randomUUID();
  await manager.workspaceAction(record.id, "attach", { requestId: attachId, workspaceId, expectedRevision: 36 }, f.credential, f.owner);
  expect(call).toHaveBeenCalledWith(record.id, f.credential, "attach", expect.objectContaining({ requestId: attachId, workspaceId, expectedRevision: 36 }));
  await manager.postMessage(record.id, "Edit the registered worktree", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  const started = f.starts[0]!;
  expect(started.input.resources).toEqual([{ kind: "worktree", id: treeId, revision: "37" }]);
  expect(started.body).not.toContain(tree.path); expect(started.body).not.toContain(tree.sessionPath); expect(started.body).not.toContain(f.root);
  expect(call.mock.calls.some(([, , action]) => action === "lease" || action === "release-lease")).toBe(false);
  f.update(started.runId, { state: "unknown", phase: "interrupted", stopConfirmed: false, freshness: "last_known", effects: { certainty: "unknown", unresolvedCallIds: ["command"] } });
  f.behavior.cancel = "unavailable";
  await expect(manager.deleteSession(record.id, f.owner, f.credential)).rejects.toMatchObject({ code: "exit_unconfirmed" });
  expect(await manager.sessionRetention(record.id, new Date("2100-01-01T00:00:00Z"))).toMatchObject({ state: "protected" });
  expect(await manager.sweepRetention(new Date("2100-01-01T00:00:00Z"))).toEqual([]);
  expect((await f.store.readRecord(record.id))!).toMatchObject({ workspaceAssociation: { id: workspaceId, revision: 37 }, developmentWorkspaces: [tree],
    providerExecution: { runId: started.runId, run: { stopConfirmed: false } } });
  expect(call.mock.calls.some(([, , action]) => ["detach", "cleanup", "release-lease"].includes(action))).toBe(false);
  expect(activity.mock.calls.some(([, , input]) => input.stopped)).toBe(false);
  expect(retention).not.toHaveBeenCalled();
});

it("captures each prepared workspace's current participation before new turns, including after provider-owned lease changes", async () => {
  const f = await fixture(), workspaceIds = ["a".repeat(64), "b".repeat(64)];
  const trees = workspaceIds.map((workspaceId, index) => ({ id: String(index + 1).repeat(64), workspaceId,
    path: `/owned/private/tree-${index}`, state: "active", repository: "https://example.test/source",
    sessionPath: "/owned/private/session", apps: [], operations: [], leases: [] }));
  let revisions = [12, 29];
  const development = new DevelopmentClient("http://core.test", "unrelated.consumer", "fixture-service");
  vi.spyOn(development, "activity").mockResolvedValue({ workspaceId: workspaceIds[0]!, revision: 12, stopRequested: false, state: "active" });
  const call = vi.spyOn(development, "call").mockImplementation(async (_id, token, action, input) => {
    expect(token).toBe(f.credential);
    if (action === "prepare") return trees[input.appId === "second.component" ? 1 : 0];
    if (action === "list") return { workspaces: trees };
    if (action === "workflow-status") return { state: "in-progress" };
    throw new Error(`Unexpected Core workspace operation: ${action}`);
  });
  const inspection = vi.spyOn(development, "inspection").mockImplementation(async (token, route) => {
    expect(token).toBe(f.credential);
    const index = workspaceIds.findIndex(id => route === `/${id}/participants`);
    expect(index).toBeGreaterThanOrEqual(0);
    return { id: workspaceIds[index], revision: revisions[index] };
  });
  const { manager } = f.makeManager({ development }), record = await manager.createSession({ createdBy: f.owner });
  for (const appId of ["first.component", "second.component"])
    await manager.workspaceAction(record.id, "prepare", { appId, requestId: randomUUID() }, f.credential, f.owner);
  expect((await manager.getSession(record.id))!.workspaceAssociation).toBeUndefined();
  await manager.postMessage(record.id, "Edit both selected worktrees", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  const original = structuredClone(f.starts[0]!);
  expect(original.input.resources).toEqual(trees.map((tree, index) => ({ kind: "worktree", id: tree.id, revision: String(revisions[index]) })));
  expect(original.body).not.toContain("/owned/private");
  f.complete(original.runId); await idle(f, record.id);
  revisions = [14, 32]; // Provider-owned association/lease changes advance Core participation.
  await manager.postMessage(record.id, "Continue the same source", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() });
  expect(f.starts[1]!.sessionId).toBe(original.sessionId);
  expect(f.starts[1]!.input.resources).toEqual(trees.map((tree, index) => ({ kind: "worktree", id: tree.id, revision: String(revisions[index]) })));
  expect(f.starts[0]).toEqual(original);
  for (const workspaceId of workspaceIds)
    expect(inspection.mock.calls.filter(([, route]) => route === `/${workspaceId}/participants`).length).toBeGreaterThanOrEqual(2);
  expect(call.mock.calls.some(([, , action]) => action === "lease" || action === "release-lease")).toBe(false);
  f.complete(f.starts[1]!.runId); await idle(f, record.id);
});

it.each(["foreign-participation", "invalid-revision", "changed-source", "malformed-source", "revoked"] as const)("denies new source admission for %s instead of substituting cached authority", async mode => {
  const f = await fixture(), workspaceId = "d".repeat(64), tree = { id: "e".repeat(64), workspaceId,
    path: "/owned/private/source", state: "active", repository: "repo", apps: [], operations: [], leases: [] };
  const development = new DevelopmentClient("http://core.test", "unrelated.consumer", "fixture-service");
  vi.spyOn(development, "call").mockImplementation(async (_id, _token, action) => {
    if (action === "prepare") return tree;
    if (action === "list") return { workspaces: mode === "changed-source" || mode === "malformed-source"
      ? [{ ...tree, workspaceId: mode === "malformed-source" ? "../participants" : "f".repeat(64) }] : [tree] };
    if (action === "workflow-status") return { state: "in-progress" };
    throw new Error(`Unexpected Core workspace operation: ${action}`);
  });
  const inspection = vi.spyOn(development, "inspection").mockImplementation(async () => {
    if (mode === "revoked") throw Object.assign(new Error("Current actor source access revoked"), { code: "workspace_forbidden" });
    return { id: mode === "foreign-participation" ? "f".repeat(64) : workspaceId,
      revision: mode === "invalid-revision" ? Number.MAX_SAFE_INTEGER + 1 : 37 };
  });
  const { manager } = f.makeManager({ development }), record = await manager.createSession({ createdBy: f.owner });
  await manager.workspaceAction(record.id, "prepare", { appId: "source.component", requestId: randomUUID() }, f.credential, f.owner);
  await expect(manager.postMessage(record.id, "Use selected source", f.credential, [], { actorUserId: f.owner, clientRequestId: randomUUID() })).rejects.toBeInstanceOf(Error);
  expect(f.starts).toEqual([]);
  if (mode === "malformed-source") expect(inspection.mock.calls.filter(([, route]) => route?.includes("participants"))).toEqual([]);
  await vi.waitFor(async () => expect((await f.store.readEvents(record.id)).some(event => event.type === "notice")).toBe(true));
  const subscription = await manager.subscribe(record.id, 0, () => {}); subscription.unsubscribe();
});

it("refreshes task-owned source revisions through the retained attempt without browser authority or consumer leases", async () => {
  const f = await fixture(), workspaceId = "d".repeat(64), treeId = "e".repeat(64), executionId = randomUUID();
  vi.stubEnv("HOSTY_APP_ID", "unrelated.consumer"); vi.stubEnv("HOSTY_APP_INSTALLATION_ID", "consumer-installation");
  vi.stubEnv("HOSTY_CORE_ORIGIN", undefined); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "fixture-service");
  vi.spyOn(ProviderClient.prototype, "permissions").mockResolvedValue({ required: [], optional: [], granted: ["providers.task-executor"] });
  let revision = 4;
  const tree = { id: treeId, workspaceId, path: "/task/private/source", state: "active", repository: "repo", apps: [], operations: [], leases: [] };
  const taskWorkspace = vi.spyOn(ProviderClient.prototype, "taskWorkspace").mockImplementation(async () => ({
    association: { workspace: { id: workspaceId, revision } }, sources: { workspaces: [tree] },
  }) as never);
  const development = new DevelopmentClient("http://core.test", "unrelated.consumer", "fixture-service");
  const generic = vi.spyOn(development, "call");
  const inspection = vi.spyOn(development, "inspection");
  const { manager } = f.makeManager({ development }), record = await manager.createSession({ createdBy: f.owner, taskExecutionId: executionId });
  manager.taskAction = vi.fn(async () => ({}));
  const dispatch = { userId: f.owner, principalId: "original-task-actor", requestId: randomUUID() };
  await manager.bindTaskDispatch(record.id, executionId, dispatch);
  await manager.prepareTaskWorkspace(record.id, dispatch, executionId, workspaceId);
  revision = 7;
  await manager.postMessage(record.id, "Use the task's exact source", undefined, [], { actorUserId: f.owner, clientRequestId: executionId, taskDispatch: true });
  expect(f.starts[0]!.input.resources).toEqual([{ kind: "worktree", id: treeId, revision: "7" }]);
  expect(taskWorkspace.mock.calls.every(([input]) => input.dispatch === dispatch && input.executionId === executionId && input.sessionId === record.id)).toBe(true);
  expect(generic).not.toHaveBeenCalled(); expect(inspection).not.toHaveBeenCalled();
  f.complete(f.starts[0]!.runId); await idle(f, record.id);
});

it("does not replace missing task workspace authority with the signed-in browser's source access", async () => {
  const f = await fixture(), executionId = randomUUID(), workspaceId = "d".repeat(64);
  vi.stubEnv("HOSTY_APP_ID", "unrelated.consumer"); vi.stubEnv("HOSTY_APP_INSTALLATION_ID", "consumer-installation");
  vi.stubEnv("HOSTY_CORE_ORIGIN", undefined); vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "fixture-service");
  vi.spyOn(ProviderClient.prototype, "permissions").mockResolvedValue({ required: [], optional: [], granted: ["providers.task-executor"] });
  const tree = { id: "e".repeat(64), workspaceId, path: "/browser/private/source", state: "active", repository: "repo", apps: [], operations: [], leases: [] };
  const development = new DevelopmentClient("http://core.test", "unrelated.consumer", "fixture-service");
  vi.spyOn(development, "activity").mockResolvedValue({ workspaceId, revision: 3, stopRequested: false, state: "active" });
  vi.spyOn(development, "call").mockImplementation(async (_id, _token, action) => {
    if (action === "prepare") return tree;
    if (action === "workflow-status") return { state: "in-progress" };
    throw new Error(`Unexpected Core workspace operation: ${action}`);
  });
  const inspection = vi.spyOn(development, "inspection");
  const { manager } = f.makeManager({ development }), record = await manager.createSession({ createdBy: f.owner, taskExecutionId: executionId });
  manager.taskAction = vi.fn(async () => ({}));
  await manager.workspaceAction(record.id, "prepare", { appId: "source.component", requestId: randomUUID() }, f.credential, f.owner);
  await manager.bindTaskDispatch(record.id, executionId, { userId: f.owner, principalId: "original-task-actor", requestId: randomUUID() });
  await expect(manager.postMessage(record.id, "No browser authority substitution", f.credential, [], { actorUserId: f.owner, clientRequestId: executionId, taskDispatch: true }))
    .rejects.toMatchObject({ code: "task_workspace_missing" });
  expect(f.starts).toEqual([]); expect(inspection).not.toHaveBeenCalled();
  await vi.waitFor(async () => expect((await f.store.readEvents(record.id)).some(event => event.type === "notice")).toBe(true));
  const subscription = await manager.subscribe(record.id, 0, () => {}); subscription.unsubscribe();
});
