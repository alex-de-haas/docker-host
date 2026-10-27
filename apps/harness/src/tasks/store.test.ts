import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { TaskStore, activeAttempt } from "./store.js";
import type { TaskActor, TaskInput, TaskRecord, TaskExecutionReceipt, TaskAction } from "@hosty-sdk/app/tasks";
let directory: string, store: TaskStore;
const provider = { appId: "example.tasks", installationId: "installation-one", key: "default" };
const actor: TaskActor = { userId: "owner", appId: null };
const human: TaskInput = { title: "Check a result", markdown: "Describe the outcome.", requiresReview: false, resources: [], assignee: { kind: "human", userId: "worker" } };
const app: TaskInput = { ...human, assignee: { kind: "app", executor: { appId: "unrelated.executor", installationId: "two", key: "plain" }, optionId: "default" } };
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "hosty-tasks-")); store = new TaskStore(directory, provider); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const create = (input = human) => store.create(actor, { requestId: randomUUID(), input });
const action = (t: TaskRecord, a: TaskAction["action"], extra: Partial<TaskAction> = {}) => store.action(t.ref.id, actor, { requestId: randomUUID(), expectedRevision: t.revision, action: a, ...extra });
function receipt(t: TaskRecord, input: Partial<TaskExecutionReceipt> = {}): TaskExecutionReceipt {
  return { executionId: t.attempts.at(-1)!.executionId, revision: 1, state: "running", stopConfirmed: false, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", ...input };
}
it("allocates numbers and creation receipts atomically under concurrent and replayed creates", async () => {
  const request = { requestId: randomUUID(), input: human };
  const rows = await Promise.all(Array.from({ length: 30 }, (_, i) => store.create(actor, i % 2 ? request : { ...request, requestId: randomUUID() })));
  expect(new Set(rows.map(t => t.ref.id)).size).toBe(16);
  expect(new Set((await store.all()).map(t => t.number)).size).toBe(16);
  store = new TaskStore(directory, provider, "NEW");
  expect((await store.create(actor, request)).number).toBe(rows[1]!.number);
  await expect(store.create(actor, { ...request, input: { ...human, title: "changed" } })).rejects.toMatchObject({ code: "request_conflict" });
  expect((await create()).number).toBe("NEW-17");
});
it("keeps numbering provider-local and references independent from display prefixes", async () => {
  const other = new TaskStore(path.join(directory, "other"), { ...provider, appId: "other.provider" });
  const a = await create(), b = await other.create(actor, { requestId: randomUUID(), input: human });
  expect(a.number).toBe(b.number); expect(a.ref).not.toEqual(b.ref);
});
it("supports human start, review, feedback and reopening without executions", async () => {
  let t = await create({ ...human, requiresReview: true }); t = await action(t, "ready"); t = await action(t, "start");
  t = await action(t, "complete", { result: { markdown: "Answer", resources: [] } });
  expect(t).toMatchObject({ status: "Blocked", blocked: { reason: "needs_review" }, attempts: [] });
  await expect(action(t, "accept", { resultInputRevision: 0 })).rejects.toMatchObject({ code: "review_changed" });
  t = await action(t, "request_changes", { resultInputRevision: t.inputRevision, feedback: "Include evidence" });
  expect(t.status).toBe("Draft"); expect(t.markdown).toContain("Include evidence");
  t = await action(t, "ready"); t = await action(t, "start");
  t = await action(t, "complete", { result: { markdown: "Evidence", resources: [] } });
  t = await action(t, "accept", { resultInputRevision: t.inputRevision }); expect(t.status).toBe("Done");
  t = await action(t, "draft"); expect(t.status).toBe("Draft"); expect(t.result?.markdown).toBe("Evidence");
  expect(t.outcomes?.map(o => o.result.markdown)).toEqual(["Answer", "Evidence"]);
});
it("freezes Ready input, replays before stale revision checks and never duplicates execution", async () => {
  let t = await create(app);
  const request: TaskAction = { requestId: randomUUID(), expectedRevision: t.revision, action: "ready" };
  t = await store.action(t.ref.id, actor, request);
  expect(await store.action(t.ref.id, actor, request)).toEqual(t);
  t = await action(t, "ready"); expect(t.attempts).toHaveLength(1);
  expect(t.attempts[0]!.request.input).toMatchObject({ resources: [], markdown: app.markdown });
  await expect(action(t, "draft")).rejects.toMatchObject({ code: "execution_active" });
  await expect(store.edit(t.ref.id, actor, { requestId: randomUUID(), expectedRevision: t.revision, input: human })).rejects.toMatchObject({ code: "task_not_editable" });
  const fast = receipt(t, { state: "completed", stopConfirmed: true, result: { markdown: "Explicit result", resources: [] } });
  t = await store.observe(t.ref.id, fast.executionId, fast); expect(t.status).toBe("Done");
  const after = await store.observe(t.ref.id, fast.executionId, { ...fast, revision: 2, state: "running", stopConfirmed: false });
  expect(after.status).toBe("Done");
});
it("treats an ordinary model turn and unknown termination as blocked, not successful", async () => {
  let t = await action(await create(app), "ready");
  t = await store.observe(t.ref.id, t.attempts[0]!.executionId, receipt(t, { state: "interrupted", stopConfirmed: false }));
  expect(t.status).toBe("Blocked"); expect(activeAttempt(t)).toBeTruthy();
  await expect(action(t, "draft")).rejects.toMatchObject({ code: "execution_active" });
  t = await store.observe(t.ref.id, t.attempts[0]!.executionId, receipt(t, { revision: 2, state: "completed", stopConfirmed: true }));
  expect(t.status).toBe("Blocked"); expect(activeAttempt(t)).toBeUndefined();
  t = await action(t, "draft"); t = await action(t, "ready"); expect(t.attempts).toHaveLength(2);
});
it("keeps cancellation pending until stop confirmation and ignores late results", async () => {
  let t = await action(await create(app), "ready"); t = await action(t, "cancel");
  expect(t.cancelRequested).toBe(true); expect(t.status).toBe("Ready");
  await expect(action(t, "draft")).rejects.toMatchObject({ code: "cancellation_pending" });
  t = await store.observe(t.ref.id, t.attempts[0]!.executionId, receipt(t, { state: "interrupted", stopConfirmed: false }));
  expect(t.cancelRequested).toBe(true);
  t = await store.observe(t.ref.id, t.attempts[0]!.executionId, receipt(t, { revision: 2, state: "completed", stopConfirmed: true, result: { markdown: "Too late", resources: [] } }));
  expect(t.status).toBe("Cancelled"); expect(t.result).toBeUndefined();
  t = await action(t, "draft"); expect(t.attempts).toHaveLength(1);
});
it("checks current access before request replay and isolates app installations", async () => {
  const t = await create();
  await expect(store.get(t.ref.id, { userId: "stranger", appId: null })).rejects.toMatchObject({ code: "task_not_found" });
  expect((await store.get(t.ref.id, { userId: "worker", appId: null })).ref.id).toBe(t.ref.id);
  const appActor = { userId: null, appId: "producer", installationId: "old" };
  const a = await store.create(appActor, { requestId: randomUUID(), input: human });
  await expect(store.get(a.ref.id, { ...appActor, installationId: "new" })).rejects.toMatchObject({ code: "task_not_found" });
});
it("preserves optional existing workspace and revision-pinned resource references", async () => {
  let t = await create({ ...app, workspaceId: "existing-workspace", resources: [{ kind: "external", id: "https://example.test/result", owner: "example.materials", version: { mode: "pinned", revision: "v1" } }] });
  t = await action(t, "ready");
  expect(t.attempts[0]!.request.input.workspaceId).toBe("existing-workspace");
  expect(t.attempts[0]!.request.input.resources[0]!.version).toEqual({ mode: "pinned", revision: "v1" });
});

it("defaults omitted review policy to false at the API boundary", async () => {
  const { requiresReview: _, ...input } = human;
  const task = await store.create(actor, { requestId: randomUUID(), input });
  expect(task.requiresReview).toBe(false);
});

it("removes an optional workspace before the next immutable dispatch", async () => {
  const original = await create({ ...app, workspaceId: "existing-workspace" });
  let task = await store.edit(original.ref.id, actor, { requestId: randomUUID(), expectedRevision: original.revision, input: app });
  expect(task.workspaceId).toBeUndefined();
  task = await action(task, "ready");
  expect(task.attempts[0]!.request.input.workspaceId).toBeUndefined();
});
