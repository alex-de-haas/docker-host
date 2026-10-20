import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "./store.js";
import { SessionManager } from "./manager.js";
import { DevelopmentClient } from "./development.js";
import { ProviderDirectory } from "../settings/providers.js";
import { AuditReporter } from "../audit.js";
import { AppContextError } from "./app-context.js";
import type { HarnessAdapter, HarnessStartOptions } from "../harness/adapter.js";
let dir: string, manager: SessionManager, store: SessionStore, client: DevelopmentClient;
let starts: HarnessStartOptions[], sent: string[];
const tree = { id: "a".repeat(64), path: "/owned/worktree", state: "active", apps: [{ appId: "notes" }], operations: [], leases: [] };
const adapter: HarnessAdapter = { name: "recording", capabilities: { questions: false, appMcp: true, liveReconfigure: true, autoAllow: false, denyReason: false },
  probe: async () => ({ available: true }), start: options => { starts.push(options); return { send: text => sent.push(text), stop: async () => {}, stopAndWait: async () => {}, interrupt: async () => {}, setMcpServers: async () => true, resolveApproval: () => false, resolveQuestion: () => false }; } };
let directory: ProviderDirectory;
const build = () => new SessionManager(store, adapter, new AuditReporter(null, null, "hosty.harness"), dir, null, directory, null, null, "http://127.0.0.1:3400", null, null, client);
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hosty-development-test-")); store = new SessionStore(dir, path.join(dir, "cache"));
  directory = new ProviderDirectory(null, null, "hosty.harness"); vi.spyOn(directory, "readApps").mockResolvedValue([{ id: "notes", displayName: "Notes", runtimeState: "stopped" }]);
  client = new DevelopmentClient("http://core.test", "hosty.harness", "service");
  vi.spyOn(client, "retention").mockResolvedValue({ kind: "workspace", workflow: { state: "in-progress", revision: 0 }, resourcesFinished: true });
  vi.spyOn(client, "call").mockImplementation(async (_id, _token, action) => action === "list" ? { workspaces: [tree] } : tree);
  starts = []; sent = []; manager = build();
});
afterEach(async () => { await manager.shutdown(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
const finish = async (id: string) => { starts.at(-1)!.onEvent({ type: "result", status: "success" }); await vi.waitFor(async () => expect((await manager.getSession(id))?.status).toBe("idle")); };
describe("development session coordination", () => {
  it("persists app-creation activity and emits the same timestamp with observed state", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-18T10:00:00Z"));
      const record = await manager.createSession({ createdBy: "admin" });
      const input = { requestId: "12345678-1234-4234-8234-123456789abd", appId: "notes", name: "Notes", bootstrapCommit: true };
      vi.mocked(client.call).mockResolvedValue({ operation: { stage: "installed" }, workspace: tree });
      vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
      await manager.workspaceAction(record.id, "app-create", input, "token", "admin");
      const saved = (await store.readRecord(record.id))!;
      const event = (await store.readEvents(record.id)).find(item => item.type === "app_context_changed")!;
      expect(saved.updatedAt).toBe("2026-10-18T12:00:00.000Z");
      expect(event.ts).toBe(saved.updatedAt);
      expect(saved.appCreations![0]!.state).toBe("observed");
      expect(saved.title).toBe("Notes");
      expect(saved.lastEventSeq).toBe(event.seq);
    } finally { vi.useRealTimers(); }
  });
  it("keeps a refused unallocated building session deletable after Core confirms no worktree exists", async () => {
    vi.mocked(client.call).mockImplementation(async (_id, _token, action) => {
      if (action === "prepare") throw new AppContextError(409, "workspace_local_head_changed", "Refresh main");
      return { workspaces: [] };
    });
    vi.mocked(client.retention).mockResolvedValue({ kind: "chat", workflow: null, resourcesFinished: true });
    await expect(manager.newBuildingSession("admin", "token", {
      appId: "notes", requestId: "12345678-1234-4234-8234-123456789abc", expectedLocalHead: "b".repeat(40),
    })).rejects.toThrow("Refresh main");
    const record = (await store.listRecords())[0]!;
    expect(record.developmentLease).toBeUndefined();
    expect(await manager.deleteSession(record.id, "admin", "token")).toBe(true);
  });
  it("recovers new building preparation across restart without duplicating the session or starting an agent", async () => {
    const input = { appId: "notes", requestId: "12345678-1234-4234-8234-123456789abc", expectedLocalHead: "b".repeat(40) };
    vi.mocked(client.call).mockRejectedValueOnce(new Error("response lost"));
    await expect(manager.newBuildingSession("admin", "token", input)).rejects.toThrow("response lost");
    const original = (await store.listRecords())[0]!;
    await expect(manager.deleteSession(original.id, "admin", "token")).rejects.toThrow("Complete and delete");
    await manager.shutdown(); manager = build();
    const resumed = await manager.newBuildingSession("admin", "token", input);
    expect(resumed.id).toBe(original.id);
    expect(resumed.developmentWorkspaces).toEqual([tree]);
    expect(await store.listRecords()).toHaveLength(1);
    const calls = vi.mocked(client.call).mock.calls.length;
    expect((await manager.newBuildingSession("admin", "token", input)).id).toBe(original.id);
    expect(client.call).toHaveBeenCalledTimes(calls);
    expect(starts).toHaveLength(0);
    await expect(manager.newBuildingSession("admin", "token", { ...input, expectedLocalHead: "c".repeat(40) })).rejects.toThrow("different session details");
  });
  it("does not store app handoff responses as worktrees", async () => {
    const session = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
    await manager.workspaceAction(session.id, "prepare", { appId: "notes" }, "token", "admin");
    vi.mocked(client.call).mockResolvedValue({ appId: "notes", accepted: true });
    for (const action of ["app-local-status", "app-local-accept", "app-local-use"] as const)
      await manager.workspaceAction(session.id, action, { appId: "notes", workspaceId: tree.id }, "token", "admin");
    expect((await manager.getSession(session.id))?.developmentWorkspaces).toEqual([tree]);
  });
  it("recovers local creation without allocating again and dispatches the generation request once", async () => {
    const record = await manager.createSession({ createdBy: "admin" });
    const input = { requestId: "12345678-1234-4234-8234-123456789abc", appId: "notes", name: "Notes", bootstrapCommit: true, iconPng: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGPQmXgBiBggFAAo6gY1Dm5YbwAAAABJRU5ErkJggg==" };
    vi.mocked(client.call).mockRejectedValueOnce(new Error("response lost"));
    await expect(manager.workspaceAction(record.id, "app-create", input, "token", "admin")).rejects.toThrow("response lost");
    expect((await store.readRecord(record.id))!.appCreations?.[0]?.state).toBe("pending");
    expect((await store.readRecord(record.id))!.appCreations?.[0]?.input.iconPng).toBe(input.iconPng);
    await manager.shutdown(); manager = build();
    vi.mocked(client.call).mockImplementation(async (_id, _token, action) => action === "app-create"
      ? { operation: { stage: "installed" }, workspace: tree } : action === "list" ? { workspaces: [tree] } : tree);
    await manager.workspaceAction(record.id, "app-create", input, "token", "admin");
    await manager.workspaceAction(record.id, "app-create", input, "token", "admin");
    expect((await manager.getSession(record.id))?.appContextRevision).toBe(1);
    await manager.dispatchAppCreation(record.id, input.requestId, "Build a notes app", "admin", "token", "token");
    await manager.dispatchAppCreation(record.id, input.requestId, "Build a notes app", "admin", "token", "token");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("parent installation must remain stopped");
    expect(sent[0]).toContain("Build a notes app");
    await expect(manager.dispatchAppCreation(record.id, input.requestId, "Different request", "admin", "token", "token")).rejects.toThrow("already has a generation prompt");
    await finish(record.id);
    await manager.shutdown(); manager = build();
    await manager.dispatchAppCreation(record.id, input.requestId, "Build a notes app", "admin", "token", "token");
    expect(sent).toHaveLength(1);
  });
  it("retains uncertain creation after permission loss and protects a retried refused request", async () => {
    const record = await manager.createSession({ createdBy: "admin" });
    const input = { requestId: "12345678-1234-4234-8234-123456789abe", appId: "notes", name: "Notes", bootstrapCommit: true };
    vi.mocked(client.retention).mockResolvedValue({ kind: "chat", workflow: null, resourcesFinished: true });
    vi.mocked(client.call).mockRejectedValueOnce(new Error("response lost"));
    await expect(manager.workspaceAction(record.id, "app-create", input, "token", "admin")).rejects.toThrow("response lost");
    await manager.shutdown(); manager = build();
    vi.mocked(client.call).mockRejectedValueOnce(new AppContextError(403, "app_permission_required", "Permission revoked"));
    await expect(manager.workspaceAction(record.id, "app-create", input, "token", "admin")).rejects.toThrow("Permission revoked");
    expect((await store.readRecord(record.id))!.appCreations![0]!.state).toBe("pending");
    await expect(manager.deleteSession(record.id, "admin", "token")).rejects.toThrow();

    const refused = await manager.createSession({ createdBy: "admin" });
    vi.mocked(client.call).mockRejectedValueOnce(new AppContextError(403, "app_permission_required", "Permission missing"));
    await expect(manager.workspaceAction(refused.id, "app-create", input, "token", "admin")).rejects.toThrow("Permission missing");
    expect((await store.readRecord(refused.id))!.appCreations![0]!.state).toBe("rejected");
    vi.mocked(client.call).mockRejectedValueOnce(new Error("response lost"));
    await expect(manager.workspaceAction(refused.id, "app-create", input, "token", "admin")).rejects.toThrow("response lost");
    expect((await store.readRecord(refused.id))!.appCreations![0]!.state).toBe("pending");
    await expect(manager.deleteSession(refused.id, "admin", "token")).rejects.toThrow();
  });

  it("does not replay a creation prompt after an interrupted dispatch", async () => {
    const record = await manager.createSession({ createdBy: "admin" });
    const input = { requestId: "12345678-1234-4234-8234-123456789abd", appId: "notes", name: "Notes", bootstrapCommit: true };
    vi.mocked(client.call).mockImplementation(async (_id, _token, action) => action === "app-create"
      ? { operation: { stage: "installed" }, workspace: tree } : action === "list" ? { workspaces: [tree] } : tree);
    await manager.workspaceAction(record.id, "app-create", input, "token", "admin");
    await manager.dispatchAppCreation(record.id, input.requestId, "Build", "admin", "token", "token");
    await manager.shutdown();
    const saved = (await store.readRecord(record.id))!;
    saved.handoffDispatch!.state = "unknown"; await store.saveRecord(saved);
    manager = build();
    await manager.dispatchAppCreation(record.id, input.requestId, "Build", "admin", "token", "token");
    expect(sent).toHaveLength(1);
    expect((await manager.getSession(record.id))?.handoffDispatch?.state).toBe("unknown");
  });

  it("redacts child setup passwords in persisted tool history", async () => {
    const record = await manager.createSession({ createdBy: "admin" });
    await manager.postMessage(record.id, "Start QA", "credential");
    starts.at(-1)!.onEvent({ type: "tool_use", toolName: "mcp__hosty-workspaces__environment_setup",
      input: { environmentId: "child", email: "qa@example.test", password: "private-child-password" } });
    await vi.waitFor(async () => {
      const log = await readFile(path.join(dir, "sessions", record.id, "events.ndjson"), "utf8");
      expect(log).toContain("[redacted]");
      expect(log).not.toContain("private-child-password");
    });
    await finish(record.id);
  });

  it("keeps consent review separate from the creation journal with the same request ID", async () => {
    const record = await manager.createSession({ createdBy: "admin" });
    const input = { requestId: "a".repeat(32), label: "QA" };
    const call = vi.spyOn(client, "environment").mockResolvedValue({ approvalUrl: "http://core.test/install/confirm/review" });
    await manager.workspaceAction(record.id, "environment-consent", input, "token", "admin");
    expect((await store.readRecord(record.id))!.coreEnvironmentOperations ?? []).toEqual([]);
    expect((await store.readRecord(record.id))!.coreEnvironments ?? []).toEqual([]);
    expect(call).toHaveBeenCalledWith("token", "environment-consent", { ...input, context: { sessionId: record.id } });
    call.mockResolvedValue({ id: "b".repeat(32), state: "stopped", context: { sessionId: record.id } });
    await manager.workspaceAction(record.id, "environment-create", input, "token", "admin");
    expect((await store.readRecord(record.id))!.coreEnvironmentOperations?.[0]?.state).toBe("observed");
  });
  it("recovers child Core creation without a workspace and keeps setup secrets out of session records", async () => {
    const record = await manager.createSession({ createdBy: "admin" });
    const input = { requestId: "a".repeat(32), label: "Independent QA" };
    const environment = { id: "b".repeat(32), label: "Independent QA", state: "stopped", context: { sessionId: record.id } };
    const call = vi.spyOn(client, "environment").mockRejectedValueOnce(new Error("response lost"));
    await expect(manager.workspaceAction(record.id, "environment-create", input, "token", "admin")).rejects.toThrow("response lost");
    expect((await store.readRecord(record.id))!.coreEnvironmentOperations?.[0]?.state).toBe("pending");
    await manager.shutdown(); manager = build();
    call.mockResolvedValue({ environments: [environment] });
    await manager.workspaceAction(record.id, "environment-list", {}, "fresh-token", "admin");
    call.mockResolvedValue(environment);
    await manager.workspaceAction(record.id, "environment-create", input, "fresh-token", "admin");
    expect((await store.readRecord(record.id))!.coreEnvironmentOperations?.[0]?.state).toBe("observed");
    call.mockResolvedValue({ status: 200 });
    await manager.workspaceAction(record.id, "environment-setup", { environmentId: environment.id, email: "test@example.test", password: "private-test-password" }, "fresh-token", "admin");
    expect(JSON.stringify(await store.readRecord(record.id))).not.toContain("private-test-password");
    expect(vi.mocked(client.call).mock.calls.every(call => call[2] === "workflow-status")).toBe(true);
    const other = await manager.createSession({ createdBy: "admin" });
    await expect(manager.workspaceAction(other.id, "environment-status", { environmentId: environment.id }, "token", "admin")).rejects.toThrow("not associated");
    await expect(manager.workspaceAction(record.id, "environment-status", { environmentId: environment.id }, "token", "other")).rejects.toThrow("another user");
  });

  it("keeps Finish available when child Core outcomes exhaust the pending journal", async () => {
    const record = await manager.createSession({ createdBy: "admin" });
    const environment = { id: "b".repeat(32), state: "running", context: { sessionId: record.id } };
    const call = vi.spyOn(client, "environment").mockResolvedValue({ environments: [environment] });
    await manager.workspaceAction(record.id, "environment-list", {}, "token", "admin");
    call.mockRejectedValue(new Error("response lost"));
    for (let i = 0; i < 32; i++) await expect(manager.workspaceAction(record.id, "environment-stop",
      { environmentId: environment.id, requestId: `request-${i}`, expectedRevision: 1 }, "token", "admin")).rejects.toThrow("response lost");
    await expect(manager.workspaceAction(record.id, "environment-stop", { environmentId: environment.id, requestId: "overflow" }, "token", "admin")).rejects.toThrow("Observe pending");
    call.mockResolvedValue({ ...environment, state: "finished" });
    await expect(manager.workspaceAction(record.id, "environment-finish", { environmentId: environment.id,
      requestId: "finish", expectedRevision: 1 }, "token", "admin")).resolves.toMatchObject({ state: "finished" });
  });

  it("plans artifact QA without a worktree and recovers the same preparation after reconnect", async () => {
    const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
    const plan = { id: "b".repeat(32), digest: "c".repeat(64), inputDigest: "d".repeat(64), request: { appId: "notes" },
      blockers: [], expiresAt: new Date(Date.now() + 600000).toISOString() };
    const sandbox = vi.spyOn(client, "sandbox").mockResolvedValueOnce(plan).mockRejectedValueOnce(new Error("response lost"));
    await manager.workspaceAction(record.id, "sandbox-plan", { appId: "notes", profile: "sandbox", source: { kind: "appArtifact" } }, "token", "admin");
    expect(sandbox).toHaveBeenCalledWith("token", "sandbox-plan", expect.objectContaining({ context: { sessionId: record.id } }));
    expect(vi.mocked(client.call).mock.calls.every(call => call[2] === "workflow-status")).toBe(true);
    const input = { requestId: "a".repeat(32), planId: plan.id, digest: plan.digest };
    await expect(manager.workspaceAction(record.id, "sandbox-prepare", input, "token", "admin")).rejects.toThrow("response lost");
    expect((await store.readRecord(record.id))!.sandboxOperations?.[0]?.state).toBe("pending");
    expect(JSON.stringify(await store.readRecord(record.id))).not.toContain('"token"');
    await manager.shutdown(); manager = build();
    sandbox.mockResolvedValue({ id: "e".repeat(32), appId: "notes", state: "prepared" });
    await manager.workspaceAction(record.id, "sandbox-prepare", input, "fresh-token", "admin");
    expect(sandbox).toHaveBeenLastCalledWith("fresh-token", "sandbox-prepare", input);
    expect((await store.readRecord(record.id))!.sandboxOperations?.[0]?.state).toBe("observed");
    const other = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
    await expect(manager.workspaceAction(other.id, "sandbox-status", { runtimeInstanceId: "e".repeat(32) }, "token", "admin")).rejects.toThrow("not associated");
  });
  it("can cancel and inspect a private browser job while its response remains pending", async () => {
    const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
    const instance = { id: "e".repeat(32), appId: "notes", state: "ready", context: { sessionId: record.id } };
    let complete!: (value: unknown) => void;
    const pending = new Promise(resolve => { complete = resolve; });
    const sandbox = vi.spyOn(client, "sandbox").mockImplementation(async (_credential, action) => {
      if (action === "sandbox-list") return { instances: [instance] };
      if (action === "sandbox-browser") return pending;
      return instance;
    });
    await manager.workspaceAction(record.id, "sandbox-list", {}, "token", "admin");
    const browser = manager.workspaceAction(record.id, "sandbox-browser", { runtimeInstanceId: instance.id, requestId: "browser-job" }, "token", "admin");
    try {
      await vi.waitFor(() => expect(sandbox).toHaveBeenCalledWith("token", "sandbox-browser", expect.anything()));
      await expect(manager.workspaceAction(record.id, "sandbox-status", { runtimeInstanceId: instance.id }, "token", "other")).rejects.toThrow("another user");
      const cancel = manager.workspaceAction(record.id, "sandbox-browser-cancel", {
        runtimeInstanceId: instance.id, requestId: "cancel-job", jobId: "browser-job", expectedRevision: 1,
      }, "token", "admin");
      await vi.waitFor(() => expect(sandbox).toHaveBeenCalledWith("token", "sandbox-browser-cancel", expect.anything()));
      await cancel;
      expect((await store.readRecord(record.id))!.sandboxOperations?.find(o => o.input.requestId === "browser-job")?.state).toBe("pending");
    } finally { complete({ state: "failed", errorCode: "sandbox_browser_cancelled" }); await browser; }
    expect((await store.readRecord(record.id))!.sandboxOperations?.every(o => o.state === "observed")).toBe(true);
  });
  it("accepts only this session's attached worktree for source sandbox plans", async () => {
    const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
    const input = { appId: "notes", profile: "sandbox-dev", source: { kind: "worktree", worktreeId: tree.id } };
    await expect(manager.workspaceAction(record.id, "sandbox-plan", input, "token", "admin")).rejects.toThrow("registered app worktree");
    await manager.workspaceAction(record.id, "prepare", { appId: "notes" }, "token", "admin");
    const sandbox = vi.spyOn(client, "sandbox").mockResolvedValue({ id: "plan", expiresAt: new Date(Date.now() + 60000).toISOString() });
    await manager.workspaceAction(record.id, "sandbox-plan", input, "token", "admin");
    expect(sandbox).toHaveBeenCalledWith("token", "sandbox-plan", expect.objectContaining({ source: input.source, context: { sessionId: record.id, workspaceId: undefined } }));
  });
  it("does not allocate for conversation and includes the instructions on subsequent turns", async () => {
    const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
    await manager.postMessage(record.id, "hello", "credential"); await finish(record.id);
    await manager.postMessage(record.id, "continue", "credential"); await finish(record.id);
    expect(vi.mocked(client.call).mock.calls.every(call => call[2] === "workflow-status")).toBe(true);
    expect(sent).toHaveLength(2);
    for (const prompt of sent) expect(prompt).toContain("Do not access or modify original source checkouts");
    expect(starts[0]!.mcpServers).toHaveProperty("hosty-workspaces");
  });
  it("prepares only attached apps, persists associations and holds a lease for active source work", async () => {
    const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
    await expect(manager.workspaceAction(record.id, "prepare", { appId: "other" }, "token", "admin")).rejects.toThrow("Attach");
    await expect(manager.workspaceAction(record.id, "prepare", { appId: "notes" }, "token", "other")).rejects.toThrow("another user");
    await manager.workspaceAction(record.id, "prepare", { appId: "notes", requestId: "prepare-id" }, "token", "admin");
    expect((await store.readRecord(record.id))!.developmentWorkspaces?.[0]?.id).toBe(tree.id);
    await manager.postMessage(record.id, "edit", "token");
    expect(client.call).toHaveBeenCalledWith(record.id, "token", "lease", expect.objectContaining({ workspaceId: tree.id }));
    expect(sent[0]).toContain(tree.path);
    await expect(manager.workspaceAction(record.id, "cleanup", { workspaceId: tree.id }, "token", "admin")).rejects.toThrow();
    await finish(record.id);
    expect(client.call).toHaveBeenCalledWith(record.id, "token", "release-lease", expect.objectContaining({ workspaceId: tree.id }));
    await manager.shutdown(); manager = build();
    await manager.postMessage(record.id, "resume", "fresh-token");
    expect(client.call).toHaveBeenCalledWith(record.id, "fresh-token", "list", {});
    expect(sent.at(-1)).toContain(tree.path);
  });
  it("recovers a lost prepare response before running and refuses execution when lease coordination fails", async () => {
    const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
    vi.mocked(client.call).mockRejectedValueOnce(new Error("response lost"));
    await expect(manager.workspaceAction(record.id, "prepare", { appId: "notes" }, "token", "admin")).rejects.toThrow("response lost");
    vi.mocked(client.call).mockImplementation(async (_id, _token, action) => { if (action === "lease") throw new Error("Core unavailable"); return { workspaces: [tree] }; });
    await expect(manager.postMessage(record.id, "resume", "token")).rejects.toThrow("Core unavailable");
    expect(starts).toHaveLength(0);
  });
});

it("binds shared MCP approvals to the session owner and persists denial after restart", async () => {
  const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
  await manager.postMessage(record.id, "edit", "credential");
  await manager.mcpPolicy.catalog("hosty:development", "v1", [{ name: "pr_merge" }]);
  const pending = manager.mcpPolicy.authorize(record.id, "hosty:development", "v1", "request", "pr_merge", { expectedHead: "abc" }, new AbortController().signal).catch(error => error);
  const event = await vi.waitFor(async () => {
    const approval = (await store.readEvents(record.id)).find(e => e.type === "approval_request");
    expect(approval).toBeDefined(); return approval!;
  });
  await expect(manager.resolveApproval(record.id, event.approvalId as string, "allow", undefined, "another-user")).rejects.toThrow("another user");
  await manager.shutdown(); await pending;
  manager = build(); await manager.recoverMcpApprovals();
  expect((await store.readRecord(record.id))!.mcpPendingApprovals).toEqual([]);
  expect((await store.readEvents(record.id)).some(e => e.type === "approval_decision" && e.decision === "deny")).toBe(true);
  expect(await manager.resolveApproval(record.id, event.approvalId as string, "allow")).toBe(false);
  expect(vi.mocked(client.call).mock.calls.every(call => call[2] === "workflow-status")).toBe(true);
});

it("retains corrective PR history before completion and allows an explicit unpublished abandonment", async () => {
  const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
  vi.mocked(client.call).mockImplementation(async (_id, _token, action) => {
    if (action === "pr-status") return { workspaceId: "workspace", repository: "owner/repo", url: "https://github.com/owner/repo/pull/2", publishedHead: "new", history: [{ url: "https://github.com/owner/repo/pull/1", head: "old" }] };
    expect((await store.readRecord(record.id))!.publicationReferences).toHaveLength(2);
    return {};
  });
  await manager.workspaceAction(record.id, "pr-complete", { workspaceId: "workspace", outcome: "merged" }, "token", "admin");
  vi.mocked(client.call).mockResolvedValue({ workspaceId: "workspace", repository: "owner/repo" });
  await manager.workspaceAction(record.id, "pr-complete", { workspaceId: "workspace", outcome: "abandoned" }, "token", "admin");
  expect((await store.readRecord(record.id))!.publicationReferences).toHaveLength(2);
});

it("uses app identity for source operations without creating a cross-app credential", async () => {
  const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
  await manager.workspaceAction(record.id, "prepare", { appId: "notes", requestId: "prepare-own" }, "hostyg_own", "admin");
  await manager.postMessage(record.id, "work on the attached source", undefined, [], { workspaceCredential: "hostyg_own" });
  expect(starts[0]!.mcpServers).toHaveProperty("hosty-workspaces");
  expect(await manager.mintAppToken(record.id, "another.app")).toBeNull();
  await manager.workspaceAction(record.id, "status", { workspaceId: tree.id });
  expect(client.call).toHaveBeenCalledWith(record.id, "hostyg_own", "status", expect.objectContaining({ workspaceId: tree.id }));
  await finish(record.id);
  expect(client.call).toHaveBeenCalledWith(record.id, "hostyg_own", "release-lease", expect.anything());
  expect(JSON.stringify(await store.readRecord(record.id))).not.toContain("hostyg_own");
  await manager.postMessage(record.id, "continue from a legacy client", "fresh-delegation");
  expect(client.call).toHaveBeenCalledWith(record.id, "fresh-delegation", "list", {});
});

it("queues explicit agent completion until turn exit; Core rejection remains visible", async () => {
  const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
  await manager.postMessage(record.id, "work", "token");
  const request = { requestId: "decfc6bd-033b-46f2-8138-7d0e54ff7923", expectedRevision: 0 };
  vi.mocked(client.call).mockClear();
  expect(await manager.workspaceAction(record.id, "workflow-complete", request)).toMatchObject({ state: "queued" });
  expect(client.call).not.toHaveBeenCalledWith(record.id, expect.anything(), "workflow-complete", expect.anything());
  vi.mocked(client.call).mockImplementation(async (_id, _token, action) => {
    if (action === "workflow-complete") throw new Error("Current commits are not merged");
    return action === "list" ? { workspaces: [tree] } : tree;
  });
  await finish(record.id);
  await vi.waitFor(async () => expect((await store.readRecord(record.id))!.workflowCompletion?.state).toBe("blocked"));
  expect(client.call).toHaveBeenCalledWith(record.id, "token", "workflow-complete", request);
});
it("retains a development conversation until Core confirms deletion", async () => {
  const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
  await manager.workspaceAction(record.id, "prepare", { appId: "notes" }, "token", "admin");
  vi.mocked(client.call).mockResolvedValue({ state: "completed" });
  await expect(manager.deleteSession(record.id, "admin", "token")).rejects.toThrow("Complete and delete");
  expect(await store.readRecord(record.id)).not.toBeNull();
  vi.mocked(client.call).mockResolvedValue({ state: "deleted" });
  vi.mocked(client.retention).mockResolvedValue({ kind: "workspace", workflow: { state: "deleted", revision: 2 }, resourcesFinished: true });
  expect(await manager.deleteSession(record.id, "admin", "token")).toBe(true);
});
it("retention preserves unfinished development and waiting questions", async () => {
  const record = await manager.createSession({ createdBy: "admin" });
  record.updatedAt = "2000-01-01T00:00:00Z";
  const check = vi.spyOn(client, "retention").mockResolvedValue({ kind: "workspace", workflow: { state: "in-progress", revision: 0 }, resourcesFinished: true });
  expect(await manager.sweepRetention()).toEqual([]);
  record.status = "awaiting_question";
  check.mockResolvedValue({ kind: "chat", workflow: null, resourcesFinished: true });
  expect(await manager.sweepRetention()).toEqual([]);
  record.status = "idle";
  expect(await manager.sweepRetention()).toEqual([record.id]);
});


it.each([false, true])("retains native source leases on close without descendant stop proof (stop fails: %s)", async stopFails => {
  const stop = vi.fn(async () => { if (stopFails) throw new Error("native stop unconfirmed"); });
  vi.spyOn(adapter, "start").mockImplementation(options => {
    starts.push(options);
    return { send() {}, stop, interrupt: async () => {}, setMcpServers: async () => true,
      resolveApproval: () => false, resolveQuestion: () => false };
  });
  const record = await manager.createSession({ createdBy: "admin" });
  record.developmentLease = "0e5c0fab-95e6-4b9e-bebc-b9b233939dfb";
  await store.saveRecord(record);
  const workspaceId = "b".repeat(64);
  vi.mocked(client.call).mockImplementation(async (_id, _credential, action) =>
    action === "list" ? { workspaces: [{ ...tree, workspaceId }] } : { state: "in-progress" });
  await manager.postMessage(record.id, "start native work", "credential");
  expect(vi.mocked(client.call).mock.calls.some(call => call[2] === "lease")).toBe(true);
  const input = { requestId: "568b93d2-cfe6-4d50-a39a-409a1e8a16b5", expectedRevision: 0 };
  const route = `/${workspaceId}/workflow/close`;
  const inspection = vi.spyOn(client, "inspection").mockImplementation(async (_credential, path, body) => {
    if (!path) return { workspaces: [{ id: workspaceId, owner: { kind: "assistant", appId: "hosty.harness", reference: record.id } }] };
    expect(body).toEqual(input);
    if (path.endsWith("close-confirm")) throw new Error("Execution stop is unconfirmed: activity lease retained");
    return { closure: "closing", operations: [{ id: input.requestId, state: "pending" }] };
  });
  await expect(manager.inspectWorkspaces("fresh", route, input, "admin")).rejects.toThrow("activity lease retained");
  await expect(manager.inspectWorkspaces("fresh", route, input, "admin")).rejects.toThrow("activity lease retained");
  expect(stop).toHaveBeenCalledTimes(1);
  expect(vi.mocked(client.call).mock.calls.some(call => call[2] === "release-lease")).toBe(false);
  expect(inspection).toHaveBeenCalledWith("fresh", route + "-confirm", input);
  expect((await store.readRecord(record.id))?.developmentLease).toBe(record.developmentLease);
});


it("accepts a legacy delegated-token chat without sending its token to workspace authorization", async () => {
  const record = await manager.createSession({ createdBy: "admin" });
  vi.mocked(client.retention).mockResolvedValue({ kind: "chat", workflow: null, resourcesFinished: true });
  vi.mocked(client.call).mockRejectedValue(new Error("reauth_required"));
  await manager.postMessage(record.id, "hello", "hosty_delegated.1.legacy");
  expect(starts).toHaveLength(1);
  expect(client.retention).toHaveBeenCalledWith(record.id, "admin");
  expect(client.call).not.toHaveBeenCalled();
});

it("still checks Core closure for a legacy client after local workspace associations are lost", async () => {
  const record = await manager.createSession({ createdBy: "admin" });
  vi.mocked(client.retention).mockResolvedValue({ kind: "workspace", workflow: { state: "in-progress", closure: "closed", revision: 2 }, resourcesFinished: true });
  vi.mocked(client.call).mockRejectedValue(new Error("reauth_required"));
  await expect(manager.postMessage(record.id, "continue", "hosty_delegated.1.legacy")).rejects.toMatchObject({ code: "workspace_closed" });
  expect(starts).toHaveLength(0);
  expect(client.call).not.toHaveBeenCalled();
});

it("keeps acceptance and ordinary start operator-only and blocks active source work", async () => {
  const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
  for (const action of ["app-local-accept", "app-local-use"] as const) {
    await expect(manager.workspaceAction(record.id, action, {}, "token")).rejects.toThrow("explicit operator");
    await expect(manager.workspaceAction(record.id, action, {}, "token", "other")).rejects.toThrow("another user");
  }
  await manager.workspaceAction(record.id, "app-local-accept", { workspaceId: tree.id }, "token", "admin");
  await manager.postMessage(record.id, "keep working", "token");
  await expect(manager.workspaceAction(record.id, "app-local-use", {}, "token", "admin")).rejects.toThrow();
  await finish(record.id);
});


it("retains both repositories across context removal, cancellation and restart without moving attachments", async () => {
  const second = { ...tree, id: "b".repeat(64), path: "/owned/second", apps: [{ appId: "media" }] };
  vi.mocked(directory.readApps).mockResolvedValue([
    { id: "notes", displayName: "Notes", runtimeState: "stopped" },
    { id: "media", displayName: "Media", runtimeState: "stopped" },
  ]);
  vi.mocked(client.call).mockImplementation(async (_id, _token, action, input) =>
    action === "list" ? { workspaces: [tree, second] } : input.appId === "media" ? second : tree);
  const record = await manager.createSession({ createdBy: "admin", appIds: ["notes", "media"] });
  await manager.workspaceAction(record.id, "prepare", { appId: "notes" }, "token", "admin");
  await manager.workspaceAction(record.id, "prepare", { appId: "media" }, "token", "admin");
  const attachment = store.attachmentPath(record.id, "context.txt")!;
  await mkdir(path.dirname(attachment), { recursive: true });
  await writeFile(attachment, "Reference material, not source");
  await manager.addAttachment(record.id, { name: "context.txt", size: 30, path: attachment });
  await manager.postMessage(record.id, "edit both", "token", ["context.txt"]);
  for (const w of [tree, second]) {
    expect(client.call).toHaveBeenCalledWith(record.id, "token", "lease", expect.objectContaining({ workspaceId: w.id }));
    expect(sent.at(-1)).toContain(w.path);
  }
  expect(starts.at(-1)!.cwd).not.toBe(tree.path);
  expect(starts.at(-1)!.cwd).not.toBe(second.path);
  expect(sent.at(-1)).toContain(attachment);
  await manager.setAppContext(record.id, ["notes"], 0, "admin");
  await manager.cancelSession(record.id);
  expect(vi.mocked(client.call).mock.calls.some(call => call[2] === "release-lease")).toBe(false);
  await manager.shutdown(); manager = build();
  await manager.postMessage(record.id, "resume both", "fresh-token", [], { expectedRevision: 1 });
  expect((await manager.getSession(record.id))!.developmentWorkspaces?.map(w => w.id)).toEqual([tree.id, second.id]);
  expect(sent.at(-1)).toContain(second.path);
  await finish(record.id);
  for (const w of [tree, second])
    expect(client.call).toHaveBeenCalledWith(record.id, "fresh-token", "release-lease", expect.objectContaining({ workspaceId: w.id }));
  await expect(manager.deleteSession(record.id, "admin", "fresh-token")).rejects.toMatchObject({ code: "workspace_retained" });
  expect(await readFile(attachment, "utf8")).toBe("Reference material, not source");
});

it("does not start a multi-repository turn when the second source lease cannot be acquired", async () => {
  const second = { ...tree, id: "b".repeat(64), path: "/owned/second" };
  vi.mocked(client.call).mockImplementation(async (_id, _token, action, input) => {
    if (action === "lease" && input.workspaceId === second.id) throw new Error("second source authority unavailable");
    return action === "list" ? { workspaces: [tree, second] } : tree;
  });
  const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
  await manager.workspaceAction(record.id, "prepare", { appId: "notes" }, "token", "admin");
  await expect(manager.postMessage(record.id, "edit both", "token")).rejects.toThrow("second source authority unavailable");
  expect(starts).toHaveLength(0);
  expect((await store.readRecord(record.id))!.developmentWorkspaces).toHaveLength(2);
});


it.each(["completed", "deferred"])("requires explicit Resume before a new turn in a %s workspace", async state => {
  const record = await manager.createSession({ createdBy: "admin" });
  vi.mocked(client.call).mockResolvedValue({ state, revision: 2 });
  await expect(manager.postMessage(record.id, "continue", "fresh")).rejects.toMatchObject({ code: "workspace_closed" });
  expect(starts).toHaveLength(0);
});

it("coordinates a session Pause through admission, stopping and confirmation", async () => {
  const record = await manager.createSession({ createdBy: "admin" });
  const input = { requestId: "25d52b79-385d-41a0-b7df-388f84aed559", expectedRevision: 0 };
  vi.mocked(client.call).mockImplementation(async (_id, _token, action) => action === "workflow-pause"
    ? { state: "in-progress", closure: "closing", operations: [{ id: input.requestId, state: "pending" }] }
    : action === "workflow-pause-confirm" ? { state: "in-progress", closure: "closed", revision: 1 } : { workspaces: [] });
  expect(await manager.workspaceAction(record.id, "workflow-pause", input, "fresh", "admin")).toMatchObject({ closure: "closed" });
  expect(client.call).toHaveBeenCalledWith(record.id, "fresh", "workflow-pause", input);
  expect(client.call).toHaveBeenCalledWith(record.id, "fresh", "workflow-pause-confirm", input);
});


it.each(["activation-apply", "execution-select"] as const)("queues reviewed %s until agent exit and rechecks its dispatch guard", async action => {
  const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
  await manager.postMessage(record.id, "work", "token");
  const input = { workspaceId: "a".repeat(64), requestId: "c0da75ef-bd6c-4b61-99ad-241a613aa2d7", selection: { coreSelected: false }, planDigest: "review" };
  const guard = vi.fn().mockResolvedValue(undefined);
  vi.mocked(client.call).mockClear();
  await expect(manager.workspaceAction(record.id, action, input, undefined, undefined, guard)).resolves.toMatchObject({ state: "queued" });
  expect(client.call).not.toHaveBeenCalledWith(record.id, expect.anything(), action, expect.anything());
  await finish(record.id);
  await vi.waitFor(() => expect(client.call).toHaveBeenCalledWith(record.id, "token", action, input));
  expect(guard).toHaveBeenCalledOnce();
  const calls = vi.mocked(client.call).mock.calls.map(c => c[2]);
  expect(calls.indexOf("release-lease")).toBeLessThan(calls.indexOf(action));
});
it("does not dispatch queued activation after policy revocation", async () => {
  const record = await manager.createSession({ createdBy: "admin", appIds: ["notes"] });
  await manager.postMessage(record.id, "work", "token");
  const guard = vi.fn().mockRejectedValue(new Error("Tool disabled"));
  await manager.workspaceAction(record.id, "activation-apply", { requestId: "original" }, undefined, undefined, guard);
  await finish(record.id);
  await vi.waitFor(async () => expect((await store.readRecord(record.id))!.workspaceActivation?.state).toBe("blocked"));
  expect(client.call).not.toHaveBeenCalledWith(record.id, expect.anything(), "activation-apply", expect.anything());
});
