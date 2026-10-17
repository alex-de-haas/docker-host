import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionManager } from "./manager.js";
import { SessionStore } from "./store.js";
import { SettingsStore } from "../settings/store.js";
import { AgentConnections } from "../connections/registry.js";
import { DevelopmentClient } from "./development.js";
import { AuditReporter } from "../audit.js";
import { SharedDockerWorker, type WorkerState } from "../runtime/worker.js";
import type { HarnessAdapter, HarnessStartOptions } from "../harness/adapter.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

it("rejects a second Docker turn before recording it, holds admission during approval and releases only after verified stop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-docker-manager-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const settings = new SettingsStore(root); await settings.update({ executionMode: "docker" });
  const secrets = new Map<string, string>();
  const connections = new AgentConnections(root, path.join(root, "cache"), { get: async key => secrets.get(key) ?? null,
    set: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); } });
  cleanups.push(() => connections.shutdown());
  await connections.update({ name: "Test", kind: "claude", auth: "api-key", secret: "synthetic" });
  const starts: HarnessStartOptions[] = [];
  const runStop = vi.fn(async () => {});
  const adapter: HarnessAdapter = { name: "test", capabilities: { questions: true, appMcp: true, liveReconfigure: true, autoAllow: true, denyReason: true },
    probe: async () => ({ available: true }), start: options => { starts.push(options); return { send() {}, stop: runStop, interrupt: async () => {},
      setMcpServers: async () => true, resolveApproval: () => true, resolveQuestion: () => true }; } };
  vi.spyOn(connections, "adapter").mockResolvedValue(adapter); vi.spyOn(connections, "workerMounts").mockResolvedValue([]);
  const client = new DevelopmentClient("http://core.test", "hosty.harness", "service");
  const bindings = { instanceId: "a".repeat(64), installationId: "b".repeat(64), treesRoot: "/trees", repositoriesRoot: "/repos", worktreePaths: [] };
  const lease = vi.spyOn(client, "workerBindings").mockResolvedValue(bindings);
  let releaseFails = false;
  const workspaceCalls = vi.spyOn(client, "call").mockImplementation(async (_id, _token, action) => {
    if (action === "release-lease" && releaseFails) throw new Error("workspace release unavailable");
    return { workspaces: [{ id: "existing-workspace", state: "active" }] };
  });
  const worker = new SharedDockerWorker(root, path.join(root, "cache"));
  let state: WorkerState | null = null, stopFails = false;
  vi.spyOn(worker, "current", "get").mockImplementation(() => state);
  vi.spyOn(worker, "prepare").mockImplementation(async (sessionId, leaseId, _bindings, _cwd, _mounts, acquire) => {
    await acquire(); state = { version: 1, phase: "running", sessionId, leaseId, generation: leaseId, name: "test", instanceId: bindings.instanceId, installationId: bindings.installationId, imageId: "test" };
    return { spawn: vi.fn() };
  });
  const stop = vi.spyOn(worker, "stop").mockImplementation(async () => { if (stopFails) throw new Error("daemon lost"); if (state) state.phase = "stopped"; });
  vi.spyOn(worker, "sample").mockResolvedValue({ memoryBytes: 10, peakMemoryBytes: 15, pids: 3 });
  vi.spyOn(worker, "finish").mockImplementation(async () => { expect(state?.phase).toBe("stopped"); state = null; });
  const store = new SessionStore(root, path.join(root, "cache"));
  const manager = new SessionManager(store, adapter, new AuditReporter(null, null, "hosty.harness"), root, settings, null, null, null, "http://127.0.0.1:1", null, connections, client, worker);
  cleanups.push(async () => { stopFails = false; releaseFails = false; await manager.shutdown(); });
  const first = await manager.createSession({ createdBy: "admin" }), second = await manager.createSession({ createdBy: "admin" });
  first.developmentLease = "11111111-1111-4111-8111-111111111111";
  await store.saveRecord(first);
  await manager.postMessage(first.id, "start", undefined, [], { workspaceCredential: "hostyg_test" });
  expect(starts[0]?.processTransport).toBeDefined();
  starts[0]!.onEvent({ type: "approval_request", approvalId: "approval", toolName: "Bash", input: {} });
  await vi.waitFor(async () => expect((await manager.getSession(first.id))?.status).toBe("awaiting_approval"));
  await expect(manager.postMessage(second.id, "must not persist")).rejects.toMatchObject({ code: "worker_busy" });
  expect((await store.readEvents(second.id)).some(event => event.type === "user_message")).toBe(false);
  stopFails = true;
  starts[0]!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(() => expect(stop).toHaveBeenCalled());
  expect(worker.busy).toBe(true);
  expect(lease.mock.calls.some(call => call[2]?.acquire === false)).toBe(false);
  stopFails = false; releaseFails = true;
  await expect(manager.recoverDocker("admin", "hostyg_fresh")).rejects.toThrow("workspace release unavailable");
  expect(worker.current?.phase).toBe("stopped");
  expect(worker.finish).not.toHaveBeenCalled();
  expect(worker.busy).toBe(true);
  releaseFails = false;
  await manager.recoverDocker("admin", "hostyg_fresh");
  expect(worker.busy).toBe(false);
  expect(lease.mock.calls.some(call => call[1] === "hostyg_fresh" && call[2]?.acquire === false)).toBe(true);
  await manager.postMessage(second.id, "next", undefined, [], { workspaceCredential: "hostyg_fresh" });
  expect(starts).toHaveLength(2);
  starts[1]!.onEvent({ type: "approval_request", approvalId: "second-approval", toolName: "Bash", input: {} });
  await vi.waitFor(async () => expect((await manager.getSession(second.id))?.status).toBe("awaiting_approval"));
  const stopsBeforeSweep = runStop.mock.calls.length;
  stopFails = true;
  expect(await manager.sweepAbandoned(1, Date.now() + 100)).toEqual([]);
  expect(runStop).toHaveBeenCalledTimes(stopsBeforeSweep);
  expect(worker.busy).toBe(true);
  expect((await manager.getSession(second.id))?.status).toBe("awaiting_approval");
  stopFails = false;
  expect(await manager.sweepAbandoned(1, Date.now() + 100)).toEqual([second.id]);
  expect(runStop).toHaveBeenCalledTimes(stopsBeforeSweep + 1);
  expect(worker.busy).toBe(false);
  const releasesBeforePreparation = workspaceCalls.mock.calls.filter(call => call[2] === "release-lease").length;
  releaseFails = true;
  vi.mocked(connections.adapter).mockRejectedValueOnce(new Error("provider unavailable before launch"));
  await expect(manager.postMessage(first.id, "retry")).rejects.toThrow("provider unavailable before launch");
  expect(worker.busy).toBe(false);
  expect(workspaceCalls.mock.calls.filter(call => call[2] === "release-lease")).toHaveLength(releasesBeforePreparation);
  releaseFails = false;
  vi.spyOn(worker, "health").mockResolvedValue({ available: false, reason: "Docker daemon unavailable", image: "test", state: null });
  const providerHealth = vi.spyOn(connections, "health").mockResolvedValue({ name: "test", available: true, capabilities: { ...adapter.capabilities, appContext: true } });
  expect(await manager.sessionHealth(second.id)).toMatchObject({ executionMode: "docker", available: false, reason: "Docker daemon unavailable" });
  expect(providerHealth).toHaveBeenLastCalledWith(expect.any(Object), true);
});

it("closes only its own workspace, recovers stop failures and never cancels again on a completed replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-close-manager-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root, path.join(root, "cache"));
  const adapter: HarnessAdapter = { name: "test", capabilities: { questions: false, appMcp: true, liveReconfigure: true, autoAllow: false, denyReason: false },
    probe: async () => ({ available: true }), start: vi.fn() as never };
  const client = new DevelopmentClient("http://core.test", "hosty.harness", "service");
  const worker = new SharedDockerWorker(root, path.join(root, "cache"));
  const manager = new SessionManager(store, adapter, new AuditReporter(null, null, "hosty.harness"), root, null, null, null, null, "http://127.0.0.1:1", null, null, client, worker);
  const session = await manager.createSession({ createdBy: "admin" });
  session.executionMode = "docker"; session.developmentLease = "d2200000-0000-4000-8000-000000000000";
  await store.saveRecord(session);
  const workspaceId = "b".repeat(64), tree = { id: "a".repeat(64), workspaceId, state: "active" };
  let ownerKind = "assistant", admitted = false, succeeded = false, stopFails = true;
  let state: WorkerState | null = { version: 1, phase: "running", sessionId: session.id, leaseId: session.developmentLease,
    generation: session.developmentLease, name: "owned", instanceId: "c".repeat(64), installationId: "d".repeat(64), imageId: "test" };
  vi.spyOn(worker, "load").mockResolvedValue();
  vi.spyOn(worker, "activeSession", "get").mockImplementation(() => state?.sessionId ?? null);
  vi.spyOn(worker, "current", "get").mockImplementation(() => state);
  const stop = vi.spyOn(worker, "stop").mockImplementation(async () => { expect(admitted).toBe(true); if (stopFails) throw new Error("Docker unavailable"); if (state) state.phase = "stopped"; });
  vi.spyOn(worker, "sample").mockResolvedValue({ memoryBytes: 1, peakMemoryBytes: 1, pids: 1 });
  vi.spyOn(worker, "finish").mockImplementation(async () => { expect(state?.phase).toBe("stopped"); state = null; });
  const release = vi.spyOn(client, "workerBindings").mockResolvedValue(null);
  vi.spyOn(client, "call").mockImplementation(async (_id, _token, action) => action === "list" ? { workspaces: [tree] } : { closure: admitted ? "closing" : null });
  const input = { requestId: "818b936d-cdcc-42f4-a449-9feb559cfc40", expectedRevision: 0 }, route = `/${workspaceId}/workflow/close`;
  const inspection = vi.spyOn(client, "inspection").mockImplementation(async (_token, path, body) => {
    if (!path) return { workspaces: [{ id: workspaceId, owner: { kind: ownerKind, appId: "hosty.harness", reference: session.id } }] };
    expect(body).toEqual(input);
    if (path.endsWith("close-confirm")) {
      expect(state).toBeNull(); succeeded = true;
      return { state: "in-progress", closure: "closed", revision: 1 };
    }
    admitted = true;
    return { state: "in-progress", closure: "closing", operations: [{ id: input.requestId, state: succeeded ? "succeeded" : "pending" }] };
  });
  await expect(manager.inspectWorkspaces("fresh", route, input, "admin")).rejects.toMatchObject({ code: "workspace_stop_unconfirmed" });
  expect(release).not.toHaveBeenCalled();
  await expect(manager.postMessage(session.id, "new work", "fresh")).rejects.toMatchObject({ code: "workspace_closed" });
  expect(adapter.start).not.toHaveBeenCalled();
  stopFails = false;
  expect(await manager.inspectWorkspaces("fresh", route, input, "admin")).toMatchObject({ closure: "closed", state: "in-progress" });
  expect(release).toHaveBeenCalledWith(session.id, "fresh", { leaseId: session.developmentLease, acquire: false });
  expect(await store.readRecord(session.id)).not.toBeNull();
  const stopped = stop.mock.calls.length;
  await manager.inspectWorkspaces("fresh", route, input, "admin");
  expect(stop).toHaveBeenCalledTimes(stopped);
  // An external owner's reference may collide with a local chat ID; it never grants stop authority.
  succeeded = false; ownerKind = "external";
  await manager.inspectWorkspaces("fresh", route, input, "admin");
  expect(stop).toHaveBeenCalledTimes(stopped);
  expect(inspection).toHaveBeenCalledWith("fresh", route + "-confirm", input);
  await manager.shutdown();
});
