import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionManager } from "./manager.js";
import { SessionStore } from "./store.js";
import { SettingsStore } from "../settings/store.js";
import { AgentConnections } from "../connections/registry.js";
import { DevelopmentClient, DEVELOPMENT_IDENTITY, DEVELOPMENT_PROVIDER, developmentTools } from "./development.js";
import { ruleKey } from "../mcp/policy.js";
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

it.each(["pause", "close"])("%s stops only its own workspace, recovers failures and preserves completed replay", async action => {
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
  const input = { requestId: "818b936d-cdcc-42f4-a449-9feb559cfc40", expectedRevision: 0 }, route = `/${workspaceId}/workflow/${action}`;
  const inspection = vi.spyOn(client, "inspection").mockImplementation(async (_token, path, body) => {
    if (!path) return { workspaces: [{ id: workspaceId, owner: { kind: ownerKind, appId: "hosty.harness", reference: session.id } }] };
    expect(body).toEqual(input);
    if (path.endsWith(`${action}-confirm`)) {
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


it("recovers a persisted worker close after the second repository lease release fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-close-cold-manager-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root, path.join(root, "cache"));
  const adapter: HarnessAdapter = { name: "test", capabilities: { questions: false, appMcp: true, liveReconfigure: false, autoAllow: false, denyReason: false },
    probe: async () => ({ available: true }), start: vi.fn() as never };
  const client = new DevelopmentClient("http://core.test", "hosty.harness", "service");
  let present = true, running = true;
  const instanceId = "c".repeat(64), installationId = "d".repeat(64), leaseId = "0d97e8d0-1841-416e-9c4a-b303d6a06fe8";
  const commands = vi.fn(async (args: string[]) => {
    if (args[0] === "ps") return present ? "e".repeat(12) : "";
    if (args[0] === "inspect") return JSON.stringify([{ State: { Running: running }, Config: { Labels: {
      "hosty.agent-worker": "1", "hosty.agent-worker.instance": instanceId,
      "hosty.agent-worker.installation": installationId, "hosty.agent-worker.generation": leaseId } } }]);
    if (args[0] === "stop") { running = false; return ""; }
    if (args[0] === "rm") { present = false; return ""; }
    throw new Error("Unexpected Docker command");
  });
  const worker = new SharedDockerWorker(root, path.join(root, "cache"), { run: commands, spawn: vi.fn() as never });
  const health = vi.spyOn(worker, "health");
  vi.spyOn(worker, "sample").mockResolvedValue({ memoryBytes: 1, peakMemoryBytes: 1, pids: 1 });
  const manager = new SessionManager(store, adapter, new AuditReporter(null, null, "hosty.harness"), root, null, null, null, null, "http://127.0.0.1:1", null, null, client, worker);
  cleanups.push(() => manager.shutdown());
  const session = await manager.createSession({ createdBy: "admin" });
  session.executionMode = "docker"; session.developmentLease = leaseId; await store.saveRecord(session);
  const persisted: WorkerState = { version: 1, phase: "running", sessionId: session.id, leaseId, generation: leaseId,
    name: `hosty-agent-${instanceId.slice(0, 12)}-${installationId.slice(0, 12)}-${leaseId}`, instanceId, installationId, imageId: "sha256:" + "f".repeat(64) };
  await mkdir(path.join(root, "worker"), { recursive: true });
  await writeFile(path.join(root, "worker", "state.json"), JSON.stringify(persisted));
  const workspaceId = "b".repeat(64), tree = { id: "a".repeat(64), workspaceId, state: "active" };
  const release = vi.spyOn(client, "workerBindings").mockImplementation(async () => { expect(present).toBe(false); return null; });
  const second = { ...tree, id: "f".repeat(64) };
  let refuseSecondRelease = true;
  const released = new Set<string>();
  const calls = vi.spyOn(client, "call").mockImplementation(async (_id, _credential, action, input) => {
    if (action === "list") return { workspaces: [tree, second] };
    if (action === "release-lease") {
      expect(present).toBe(false);
      if (input.workspaceId === second.id && refuseSecondRelease) throw new Error("second repository unavailable");
      released.add(String(input.workspaceId));
    }
    return {};
  });
  const input = { requestId: "03b309cb-b6f1-4db2-a0c2-80bb53847e55", expectedRevision: 0 };
  vi.spyOn(client, "inspection").mockImplementation(async (_credential, route) => {
    if (!route) return { workspaces: [{ id: workspaceId, owner: { kind: "assistant", appId: "hosty.harness", reference: session.id } }] };
    if (route.endsWith("close-confirm")) {
      expect(present).toBe(false); expect(released).toEqual(new Set([tree.id, second.id]));
      return { closure: "closed" };
    }
    return { closure: "closing", operations: [{ id: input.requestId, state: "pending" }] };
  });
  expect(worker.activeSession).toBeNull();
  await expect(manager.inspectWorkspaces("fresh", `/${workspaceId}/workflow/close`, input, "admin"))
    .rejects.toMatchObject({ code: "workspace_stop_unconfirmed" });
  expect(worker.current?.phase).toBe("stopped");
  expect(released).toEqual(new Set([tree.id]));
  refuseSecondRelease = false;
  expect(await manager.inspectWorkspaces("fresh", `/${workspaceId}/workflow/close`, input, "admin")).toMatchObject({ closure: "closed" });
  expect(health).not.toHaveBeenCalled();
  expect(commands).toHaveBeenCalledWith(["stop", "--time", "10", persisted.name]);
  expect(commands).toHaveBeenCalledWith(["rm", persisted.name]);
  expect(release).toHaveBeenCalledWith(session.id, "fresh", { leaseId, acquire: false });
  expect(calls.mock.calls.some(call => call[2] === "release-lease")).toBe(true);
  expect(worker.current).toBeNull();
});


async function deferredDockerActivation(beforeStop: () => Promise<void> = async () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-docker-activation-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const settings = new SettingsStore(root); await settings.update({ executionMode: "docker" });
  const secrets = new Map<string, string>();
  const connections = new AgentConnections(root, path.join(root, "cache"), { get: async key => secrets.get(key) ?? null,
    set: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); } });
  cleanups.push(() => connections.shutdown());
  await connections.update({ name: "Test", kind: "claude", auth: "api-key", secret: "synthetic" });
  const starts: HarnessStartOptions[] = [], order: string[] = [];
  const adapter: HarnessAdapter = { name: "test", capabilities: { questions: true, appMcp: true, liveReconfigure: true, autoAllow: true, denyReason: true },
    probe: async () => ({ available: true }), start: options => { starts.push(options); return { send() {}, stop: async () => { order.push("run-stopped"); }, interrupt: async () => {},
      setMcpServers: async () => true, resolveApproval: () => true, resolveQuestion: () => true }; } };
  vi.spyOn(connections, "adapter").mockResolvedValue(adapter); vi.spyOn(connections, "workerMounts").mockResolvedValue([]);
  const client = new DevelopmentClient("http://core.test", "hosty.harness", "service");
  const bindings = { instanceId: "a".repeat(64), installationId: "b".repeat(64), treesRoot: "/trees", repositoriesRoot: "/repos", worktreePaths: [] };
  vi.spyOn(client, "workerBindings").mockImplementation(async (_id, _credential, input) => {
    if (input?.acquire === false) order.push("worker-lease-released");
    return bindings;
  });
  const calls = vi.spyOn(client, "call").mockImplementation(async (_id, _credential, action) => {
    order.push(action);
    return { workspaces: [{ id: "existing-workspace", state: "active" }] };
  });
  const worker = new SharedDockerWorker(root, path.join(root, "cache"));
  let state: WorkerState | null = null;
  vi.spyOn(worker, "current", "get").mockImplementation(() => state);
  vi.spyOn(worker, "prepare").mockImplementation(async (sessionId, leaseId, _bindings, _cwd, _mounts, acquire) => {
    await acquire(); state = { version: 1, phase: "running", sessionId, leaseId, generation: leaseId, name: "test", instanceId: bindings.instanceId, installationId: bindings.installationId, imageId: "test" };
    return { spawn: vi.fn() };
  });
  const stop = vi.spyOn(worker, "stop").mockImplementation(async () => {
    order.push("worker-stopping"); await beforeStop();
    if (state) { state.phase = "stopped"; order.push("worker-stopped"); }
  });
  vi.spyOn(worker, "sample").mockResolvedValue({ memoryBytes: 1, peakMemoryBytes: 1, pids: 1 });
  vi.spyOn(worker, "finish").mockImplementation(async () => { expect(state?.phase).toBe("stopped"); state = null; order.push("worker-finished"); });
  const store = new SessionStore(root, path.join(root, "cache"));
  const manager = new SessionManager(store, adapter, new AuditReporter(null, null, "hosty.harness"), root, settings, null, null, null, "http://127.0.0.1:1", null, connections, client, worker);
  cleanups.push(() => manager.shutdown());
  const record = await manager.createSession({ createdBy: "admin" });
  record.developmentLease = "11111111-1111-4111-8111-111111111111"; await store.saveRecord(record);
  await manager.postMessage(record.id, "work", undefined, [], { workspaceCredential: "hostyg_test" });
  const server = createServer((request, response) => { void manager.developmentMcp.handle(request, response, new URL(request.url!, "http://localhost").pathname); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const config = manager.developmentMcp.config(record.id, `http://127.0.0.1:${(server.address() as { port: number }).port}`)["hosty-workspaces"] as { url: string; headers: Record<string, string> };
  const rpc = (body: unknown) => fetch(config.url, { method: "POST", headers: config.headers, body: JSON.stringify(body) });
  const queue = async (action: "activation-apply" | "activation-return" | "activation-resume", mode: "run" | "ask" = "run") => {
    const tool = action.replaceAll("-", "_");
    await manager.mcpPolicy.catalog(DEVELOPMENT_PROVIDER, DEVELOPMENT_IDENTITY, developmentTools());
    await manager.mcpPolicy.update({ [ruleKey(DEVELOPMENT_PROVIDER, tool)]: { identity: DEVELOPMENT_IDENTITY, mode } });
    const input = { requestId: "c0da75ef-bd6c-4b61-99ad-241a613aa2d7", activationId: "retained-activation" };
    const pending = rpc({ id: 1, method: "tools/call", params: { name: tool, arguments: input } });
    if (mode === "ask") {
      await vi.waitFor(async () => expect((await store.readRecord(record.id))?.mcpPendingApprovals).toHaveLength(1));
      const approval = (await store.readRecord(record.id))!.mcpPendingApprovals![0]!;
      expect(await manager.resolveApproval(record.id, approval.id, "allow", undefined, "admin")).toBe(true);
    }
    const response = await pending;
    const result = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(result.result.isError).toBeUndefined();
    expect(JSON.parse(result.result.content[0]!.text)).toMatchObject({ state: "queued" });
    expect(calls.mock.calls.some(call => call[2] === action)).toBe(false);
    return { input, tool };
  };
  return { manager, store, record, starts, order, stop, calls, queue, rpc };
}

it.each([["activation-apply", "run"], ["activation-return", "run"], ["activation-resume", "run"], ["activation-apply", "ask"]] as const)("dispatches reviewed Docker %s (%s) after worker exit and all lease acknowledgements", async (action, mode) => {
  const fixture = await deferredDockerActivation();
  const { input } = await fixture.queue(action, mode);
  fixture.starts[0]!.onEvent({ type: "result", status: "success" });
  await vi.waitFor(async () => expect((await fixture.store.readRecord(fixture.record.id))?.workspaceActivation?.state).toBe("dispatched"));
  expect(fixture.calls).toHaveBeenCalledWith(fixture.record.id, "hostyg_test", action, input);
  expect(fixture.order.filter(item => item === action)).toHaveLength(1);
  for (const prerequisite of ["worker-stopped", "run-stopped", "worker-lease-released", "release-lease", "worker-finished"]) {
    expect(fixture.order).toContain(prerequisite);
    expect(fixture.order.indexOf(prerequisite)).toBeLessThan(fixture.order.indexOf(action));
  }
  expect((await fixture.rpc({ id: 2, method: "ping" })).status).toBe(403);
});

it.each(["disabled", "revoked"] as const)("blocks reviewed Docker dispatch when policy is %s during worker shutdown", async change => {
  let stopped!: () => void;
  const pendingStop = new Promise<void>(resolve => { stopped = resolve; });
  const fixture = await deferredDockerActivation(() => pendingStop);
  try {
    const { tool } = await fixture.queue("activation-apply");
    fixture.starts[0]!.onEvent({ type: "result", status: "success" });
    await vi.waitFor(() => expect(fixture.stop).toHaveBeenCalled());
    // Transport access is gone before waiting for the worker; its retained review is separate.
    expect((await fixture.rpc({ id: 2, method: "ping" })).status).toBe(403);
    if (change === "disabled") await fixture.manager.mcpPolicy.update({ [ruleKey(DEVELOPMENT_PROVIDER, tool)]: { identity: DEVELOPMENT_IDENTITY, mode: "disabled" } });
    else fixture.manager.developmentMcp.unregister(fixture.record.id);
  } finally { stopped(); }
  await vi.waitFor(async () => expect((await fixture.store.readRecord(fixture.record.id))?.workspaceActivation).toMatchObject({ state: "blocked", error: expect.stringContaining("canceled") }));
  expect(fixture.calls.mock.calls.some(call => call[2] === "activation-apply")).toBe(false);
  expect(fixture.order).toContain("release-lease");
});

it("cancels a reviewed Docker activation on explicit session teardown", async () => {
  const fixture = await deferredDockerActivation();
  await fixture.queue("activation-apply");
  await fixture.manager.cancelSession(fixture.record.id);
  expect((await fixture.store.readRecord(fixture.record.id))?.workspaceActivation?.state).toBe("blocked");
  expect(fixture.calls.mock.calls.some(call => call[2] === "activation-apply")).toBe(false);
  expect((await fixture.rpc({ id: 2, method: "ping" })).status).toBe(403);
});
