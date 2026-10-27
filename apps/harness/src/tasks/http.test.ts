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
const auth = vi.hoisted(() => ({ revoked: false }));
vi.mock("../auth.js", () => ({
  resolveAdminActor: async (request: { headers: { authorization?: string } }) => auth.revoked ? null : { userId: request.headers.authorization?.slice(7) ?? "owner", via: "delegated-token" },
  isSameOriginRequest: () => true,
}));
vi.mock("../session-delegation.js", () => ({ delegationCredential: async () => undefined }));
let directory: string, server: Server, service: TaskService, origin: string;
const provider = { appId: "example.harness", installationId: "one", key: "default" };
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "hosty-task-http-")); auth.revoked = false;
  vi.stubEnv("HOSTY_APP_ID", provider.appId); vi.stubEnv("HOSTY_APP_INSTALLATION_ID", provider.installationId);
});
afterEach(async () => { await service?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
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
  expect(created.requiresReview).toBe(false);
  expect(await (await call("/tasks", "owner", input)).json()).toEqual(created);
  expect((await call(`/tasks/${created.ref.id}`, "other")).status).toBe(404);
  auth.revoked = true;
  expect((await call("/tasks", "owner", input)).status).toBe(401);
});
it("projects historical results for a human assignee without the owner's private conversation", async () => {
  const store = new TaskStore(directory, provider), owner = { userId: "owner", appId: null };
  const input = { title: "Private execution", markdown: "Work", requiresReview: false, resources: [], assignee: { kind: "app" as const, executor: provider, optionId: "writer" } };
  let task = await store.create(owner, { requestId: randomUUID(), input });
  task = await store.action(task.ref.id, owner, { requestId: randomUUID(), expectedRevision: task.revision, action: "ready" });
  const executionId = task.attempts[0]!.executionId;
  task = await store.observe(task.ref.id, executionId, { executionId, revision: 1, state: "completed", stopConfirmed: true, createdAt: "now", updatedAt: "now", result: { markdown: "Public result", resources: [] }, sessionRef: { id: "private", path: "/assistant?session=private" } });
  task = await store.action(task.ref.id, owner, { requestId: randomUUID(), expectedRevision: task.revision, action: "draft" });
  await store.edit(task.ref.id, owner, { requestId: randomUUID(), expectedRevision: task.revision, input: { ...input, assignee: { kind: "human", userId: "reviewer" } } });
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
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  expect((await reader.read()).done).toBe(true);
  expect(closed).toBe(false);
  finish(); await closing; await tick; await service.tick();
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect((await call("/tasks")).status).toBe(503);
});
