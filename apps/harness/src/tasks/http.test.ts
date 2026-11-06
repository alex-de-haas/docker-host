import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { SessionManager } from "../sessions/manager.js";
import { TaskService } from "./service.js";
import type { TaskRecord } from "@hosty-sdk/app/tasks";
import { TaskStore } from "./store.js";
import { TaskExecutorClient } from "@hosty-sdk/app/tasks/server";
const auth = vi.hoisted(() => ({ revoked: false, checks: 0, revokeOnCheck: null as number | null }));
vi.mock("../auth.js", () => ({
  resolveAdminActor: async (request: { headers: { authorization?: string } }) => {
    auth.checks++;
    return auth.revoked || auth.revokeOnCheck === auth.checks ? null : { userId: request.headers.authorization?.slice(7) ?? "owner", via: "delegated-token" };
  },
  isSameOriginRequest: () => true,
}));
vi.mock("../session-delegation.js", () => ({ delegationCredential: async () => undefined }));
let directory: string, server: Server, service: TaskService, origin: string;
const provider = { appId: "example.harness", installationId: "one", key: "default" };
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "hosty-task-http-")); auth.revoked = false; auth.checks = 0; auth.revokeOnCheck = null;
  vi.stubEnv("HOSTY_APP_ID", provider.appId); vi.stubEnv("HOSTY_APP_INSTALLATION_ID", provider.installationId);
});
afterEach(async () => { await service?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
async function start() {
  service = new TaskService({ store: { dataDir: directory } } as SessionManager);
  server = createServer((req, res) => {
    void service.route(req, res, new URL(req.url!, origin), async () => {
      let data = ""; for await (const chunk of req) data += chunk; return JSON.parse(data);
    }).catch(e => { res.writeHead(e.status ?? 500, { "content-type": "application/json" }); res.end(JSON.stringify({ code: e.code })); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const call = (route: string, actor = "owner", body?: unknown) => fetch(origin + "/api/tasks/v1" + route, {
  method: body ? "POST" : "GET", headers: { authorization: `Bearer ${actor}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
});
it("revalidates before creation replay and denies another actor's task", async () => {
  await start();
  const input = { requestId: randomUUID(), input: { title: "Task", markdown: "Work", assignee: null, resources: [] } };
  const created = await (await call("/tasks", "owner", input)).json() as TaskRecord;
  expect(created.review.mode).toBe("none");
  expect(await (await call("/tasks", "owner", input)).json()).toEqual(created);
  expect((await call(`/tasks/${created.ref.id}`, "other")).status).toBe(404);
  auth.revoked = true;
  expect((await call("/tasks", "owner", input)).status).toBe(401);
});
it("projects historical results for a human assignee without the owner's private conversation", async () => {
  const store = new TaskStore(directory, provider), owner = { userId: "owner", appId: null };
  const input = { title: "Private execution", markdown: "Work", review: { mode: "none" as const }, resources: [], assignee: { kind: "app" as const, executor: provider, selection: { kind: "option" as const, id: "writer", revision: 1 } } };
  let task = await store.create(owner, { requestId: randomUUID(), input });
  task = await store.action(task.ref.id, owner, { requestId: randomUUID(), expectedRevision: task.revision, action: "ready" });
  const executionId = task.attempts[0]!.executionId;
  task = await store.observe(task.ref.id, executionId, { executionId, revision: 1, state: "completed", stopConfirmed: true, createdAt: "now", updatedAt: "now", result: { markdown: "Public result", resources: [] }, sessionRef: { id: "private", path: "/assistant?session=private" } });
  task = await store.action(task.ref.id, owner, { requestId: randomUUID(), expectedRevision: task.revision, action: "draft" });
  await store.edit(task.ref.id, owner, { requestId: randomUUID(), expectedRevision: task.revision, expectedGraphRevision: task.graphRevision, input: { ...input, assignee: { kind: "human", userId: "reviewer" } } });
  await start();
  const reader = await (await call(`/tasks/${task.ref.id}`, "reviewer")).json() as TaskRecord;
  expect(reader.attempts[0]!.receipt!.result!.markdown).toBe("Public result");
  expect(reader.attempts[0]!.receipt!.sessionRef).toBeUndefined();
  const own = await (await call(`/tasks/${task.ref.id}`)).json() as TaskRecord;
  expect(own.attempts[0]!.receipt!.sessionRef!.id).toBe("private");
});

it("closes task streams and drains dispatch before shutting down native runs", async () => {
  await start();
  const response = await call("/events"), reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  let finish!: () => void;
  const dispatch = vi.spyOn(service.executor, "tick").mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const tick = service.tick();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  expect((await reader.read()).done).toBe(true);
  expect(closed).toBe(false);
  finish(); await closing; await tick; await service.tick();
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect((await call("/tasks")).status).toBe(503);
});

it("preserves an authorization error if access ends during task stream admission", async () => {
  await start(); auth.revokeOnCheck = 2;
  const response = await call("/events");
  expect(response.status).toBe(401);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(await response.json()).toEqual({ code: "task_unauthorized" });
});

it("announces task readiness and closes the observer before a revoked actor receives another hint", async () => {
  await start();
  const response = await call("/events"), reader = response.body!.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  expect(initial).toContain("event: stream.ready");
  expect(initial).toContain("event: changed");
  auth.revoked = true;
  await service.store.create({ userId: "owner", appId: null }, { requestId: randomUUID(),
    input: { title: "After revocation", markdown: "Private", assignee: null, resources: [] } });
  expect((await reader.read()).done).toBe(true);
});

it("restores an awaiting-input task after the remote executor returns the unchanged receipt", async () => {
  vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "synthetic-service-token");
  await start();
  vi.spyOn(TaskExecutorClient.prototype, "options").mockResolvedValue({ version: 1, revision: 1, options: [{ id: "plain", revision: 1, name: "Plain", description: "", capabilities: [], availability: { state: "unknown" } }], defaultId: "plain" });
  const get = vi.spyOn(TaskExecutorClient.prototype, "get").mockImplementation(async executionId => ({ executionId, revision: 2,
    state: "awaiting_input", stopConfirmed: false, createdAt: "now", updatedAt: "now" }));
  let task = await (await call("/tasks", "owner", { requestId: randomUUID(), input: { title: "Remote work", markdown: "Ask for input", resources: [],
    assignee: { kind: "app", executor: { appId: "independent.executor", installationId: "two", key: "default" } } } })).json() as TaskRecord;
  const ready = await call(`/tasks/${task.ref.id}/actions`, "owner", { requestId: randomUUID(), expectedRevision: task.revision, action: "ready" });
  expect(ready.status).toBe(200);
  task = await ready.json() as TaskRecord;
  await service.tick();
  expect((await service.store.get(task.ref.id, { userId: "owner", appId: null })).blocked?.reason).toBe("needs_input");
  get.mockRejectedValueOnce(new Error("Temporary executor outage"));
  await service.tick();
  expect((await service.store.get(task.ref.id, { userId: "owner", appId: null })).blocked?.reason).toBe("executor_unavailable");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31000);
  await service.tick();
  const recovered = await (await call(`/tasks/${task.ref.id}`)).json() as TaskRecord;
  expect(recovered.blocked?.reason).toBe("needs_input");
  expect(recovered.attempts).toHaveLength(1);
  expect(recovered.attempts[0]!.receipt!.revision).toBe(2);
});

it("binds v2 writes to exact bytes and isolates request UUIDs by original principal", async () => {
  vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "test-service"); await start();
  const { ProviderClient } = await import("@hosty-sdk/app/providers/server");
  const invocation = { version: 2 as const, userId: "owner", hostRole: "host.admin", principalId: "direct-one", callerAppId: null, callerInstallation: null, kind: "tasks" as const, key: "default", operation: "create", resourceIds: [] };
  const validate = vi.spyOn(ProviderClient.prototype, "validateMediated").mockResolvedValue(invocation);
  const payload = JSON.stringify({ requestId: randomUUID(), input: { title: "Private task", markdown: "Private instructions", assignee: null, resources: [] } }, null, 2);
  const request = () => fetch(origin + "/api/tasks/v1/tasks", { method: "POST", headers: { authorization: "Bearer hosty_provider.2.test.signature", "content-type": "application/json" }, body: payload });
  const created = await request(); expect(created.status).toBe(201); const first = await created.json() as TaskRecord;
  expect((await (await request()).json() as TaskRecord).ref.id).toBe(first.ref.id);
  validate.mockResolvedValue({ ...invocation, principalId: "direct-two" });
  expect((await (await request()).json() as TaskRecord).ref.id).not.toBe(first.ref.id);
  for (const [, kind, actual] of validate.mock.calls) { expect(kind).toBe("tasks"); expect(actual).toMatchObject({ method: "POST", operation: "create", path: "/tasks" }); expect(Buffer.from(actual.body).toString()).toBe(payload); }
});

it("recovers v2 executor dispatch after source restart without saving a bearer token", async () => {
  vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "test-service"); await start();
  const { ProviderClient } = await import("@hosty-sdk/app/providers/server");
  const { ProviderError } = await import("@hosty-sdk/app/providers");
  vi.spyOn(service.executor, "tick").mockResolvedValue();
  const actor = { userId: "owner", appId: null }, executor = { appId: "unrelated.runner", installationId: "two", key: "default" };
  let task = await service.store.create(actor, { requestId: randomUUID(), input: { title: "Delegated work", markdown: "Work", resources: [], assignee: { kind: "app", executor } } });
  const requestId = randomUUID(), dispatch = { userId: "owner", principalId: "original-client", requestId };
  const invocation = { version: 2 as const, ...dispatch, hostRole: "host.admin", callerAppId: null, callerInstallation: null, kind: "tasks" as const, key: "default", operation: "execute", resourceIds: [task.ref.id], taskDispatch: dispatch };
  vi.spyOn(ProviderClient.prototype, "validateMediated").mockImplementation(async (_token, _kind, request) => {
    if (request.operation === "action") throw new ProviderError("token_invalid", "Execution operation required", 401);
    return invocation;
  });
  vi.spyOn(ProviderClient.prototype, "taskDispatchAuthority").mockResolvedValue({ dispatch, scope: { taskRef: task.ref, executor, inputRevision: 1, inputHash: "digest", selection: { kind: "option", id: "writer", revision: 1 }, executionId: null } });
  const delegated = vi.spyOn(ProviderClient.prototype, "taskDispatch").mockImplementation(async input => (input.operation === "options"
    ? { version: 1, revision: 1, options: [{ id: "writer", revision: 1, name: "Writer", description: "", capabilities: [], availability: { state: "unknown" } }], defaultId: "writer" }
    : { executionId: input.executionId, revision: 1, state: "running", stopConfirmed: false, createdAt: "now", updatedAt: "now" }) as never);
  const response = await call(`/tasks/${task.ref.id}/actions`, "hosty_provider.2.test.signature", { requestId, expectedRevision: task.revision, action: "ready" });
  expect(response.status).toBe(200); task = await response.json() as TaskRecord;
  expect(await service.store.dispatch(task.ref.id)).toEqual(dispatch);
  await service.close(); service = new TaskService({ store: { dataDir: directory } } as SessionManager); vi.spyOn(service.executor, "tick").mockResolvedValue();
  delegated.mockClear(); await service.tick();
  expect(delegated).toHaveBeenCalledWith(expect.objectContaining({ dispatch, operation: "get", executionId: task.attempts[0]!.executionId }), undefined);
  const state = await import("node:fs/promises").then(fs => fs.readFile(path.join(directory, "tasks", "tasks.json"), "utf8"));
  expect(state).not.toContain("hosty_provider.2.test.signature");
});

it("allows the current human owner to review through an application client", async () => {
  await start();
  const owner = { userId: "owner", appId: null };
  let task = await service.store.create(owner, { requestId: randomUUID(), input: { title: "Human review", markdown: "Review this", resources: [],
    assignee: { kind: "human", userId: "owner" }, review: { mode: "owner" } } });
  for (const action of ["ready", "start", "complete"] as const) task = await service.store.action(task.ref.id, owner,
    { requestId: randomUUID(), expectedRevision: task.revision, action, ...(action === "complete" ? { result: { markdown: "Evidence", resources: [] } } : {}) });
  const authority = { actor: { userId: "owner", appId: "independent.client", installationId: "one" }, scope: "client", principalId: "app:client",
    mediatedOperation: "action", validate: async () => {} };
  const accepted = await service.action(task.ref.id, authority, { requestId: randomUUID(), expectedRevision: task.revision, action: "accept", resultRef: task.resultRef });
  expect(accepted.status).toBe("Done");
});

it("continues executor polling while another recovery phase awaits explicit policy approval", async () => {
  await start();
  let answer!: () => void;
  const recovery = vi.spyOn(service.orchestration, "reconcile").mockImplementation(() => new Promise<void>(resolve => { answer = resolve; }));
  const executor = vi.spyOn(service.executor, "tick").mockResolvedValue();
  const first = service.tick();
  await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));
  try {
    await vi.waitFor(() => { void service.tick(); expect(executor.mock.calls.length).toBeGreaterThanOrEqual(2); });
    expect(recovery).toHaveBeenCalledTimes(1);
  } finally { answer(); await first; }
});
