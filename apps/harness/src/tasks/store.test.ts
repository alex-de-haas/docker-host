import { TaskAttention } from "./attention.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { TaskStore, activeAttempt } from "./store.js";
import type { TaskActor, TaskInput, TaskRecord, TaskExecutionReceipt, TaskAction } from "@hosty-sdk/app/tasks";
let directory: string, store: TaskStore;
const provider = { appId: "example.tasks", installationId: "installation-one", key: "default" };
const actor: TaskActor = { userId: "owner", appId: null };
const human: TaskInput = { title: "Check a result", markdown: "Describe the outcome.", review: { mode: "none" }, parentTaskRef: null, dependsOn: [], resources: [], assignee: { kind: "human", userId: "worker" } };
const app: TaskInput = { ...human, assignee: { kind: "app", executor: { appId: "unrelated.executor", installationId: "two", key: "plain" }, selection: { kind: "option", id: "default", revision: 1 } } };
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
  let t = await create({ ...human, review: { mode: "owner" } }); t = await action(t, "ready"); t = await action(t, "start");
  t = await action(t, "complete", { result: { markdown: "Answer", resources: [] } });
  expect(t).toMatchObject({ status: "Blocked", blocked: { reason: "needs_review" }, attempts: [] });
  await expect(action(t, "accept", { resultRef: { ...t.resultRef!, inputRevision: 0 } })).rejects.toMatchObject({ code: "review_changed" });
  t = await action(t, "request_changes", { resultRef: t.resultRef, feedback: "Include evidence" });
  expect(t.status).toBe("Ready"); expect(t.markdown).toContain("Include evidence");
  t = await action(t, "ready"); t = await action(t, "start");
  t = await action(t, "complete", { result: { markdown: "Evidence", resources: [] } });
  t = await action(t, "accept", { resultRef: t.resultRef }); expect(t.status).toBe("Done");
  t = await action(t, "draft"); expect(t.status).toBe("Draft"); expect(t.result?.markdown).toBe("Evidence");
  expect(t.outcomes?.map(o => o.result.markdown)).toEqual(["Answer", "Evidence"]);
});
it("freezes Ready input, replays before stale revision checks and never duplicates execution", async () => {
  let t = await create(app);
  const request: TaskAction = { requestId: randomUUID(), expectedRevision: t.revision, action: "ready" };
  t = await store.action(t.ref.id, actor, request);
  expect(await store.action(t.ref.id, actor, request)).toEqual(t);
  t = await action(t, "ready"); expect(t.attempts).toHaveLength(1);
  expect(t.attempts[0]!.request.content).toMatchObject({ resources: [], markdown: app.markdown });
  await expect(action(t, "draft")).rejects.toMatchObject({ code: "execution_active" });
  await expect(store.edit(t.ref.id, actor, { requestId: randomUUID(), expectedRevision: t.revision, expectedGraphRevision: t.graphRevision, input: human })).rejects.toMatchObject({ code: "task_not_editable" });
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
it("preserves resource references without treating them as workspace authority", async () => {
  let t = await create({ ...app, resources: [{ kind: "external", id: "https://example.test/result", owner: "example.materials", version: { mode: "pinned", revision: "v1" } }] });
  t = await action(t, "ready");
  expect(t.attempts[0]!.request.content).not.toHaveProperty("workspaceId");
  expect(t.attempts[0]!.request.content.resources[0]!.version).toEqual({ mode: "pinned", revision: "v1" });
});

it("defaults omitted review policy to none at the API boundary", async () => {
  const { review: _, ...input } = human;
  const task = await store.create(actor, { requestId: randomUUID(), input });
  expect(task.review.mode).toBe("none");
});

it("rejects obsolete task inputs instead of assigning source authority from them", async () => {
  await expect(store.create(actor, { requestId: randomUUID(), input: { ...app, workspaceId: "old" } as TaskInput }))
    .rejects.toMatchObject({ code: "task_invalid" });
  await expect(store.create(actor, { requestId: randomUUID(), input: { ...app, requiresReview: true } as TaskInput }))
    .rejects.toMatchObject({ code: "task_invalid" });
});

it.each(["accepted", "running", "awaiting_input", "cancelling", "interrupted"] as const)("restores %s after an outage using only identical current evidence", async state => {
  let task = await action(await create(app), "ready");
  const current = receipt(task, { state, revision: 4 });
  const before = await store.observe(task.ref.id, current.executionId, current);
  await store.unavailable(task.ref.id, "Temporary executor outage");
  task = await store.get(task.ref.id, actor);
  expect(task.blocked?.reason).toBe("executor_unavailable");
  expect(await store.observe(task.ref.id, current.executionId, { ...current, revision: 3 })).toEqual(task);
  expect(await store.observe(task.ref.id, current.executionId, { ...current, state: "completed", stopConfirmed: true, result: { markdown: "Changed without a new revision", resources: [] } })).toEqual(task);
  store = new TaskStore(directory, provider);
  const recovered = await store.observe(task.ref.id, current.executionId, current);
  expect(recovered.status).toBe(before.status);
  expect(recovered.blocked).toEqual(before.blocked);
  expect(recovered.revision).toBe(task.revision + 1);
  expect(recovered.attempts).toEqual(before.attempts);
  expect(recovered.outcomes).toEqual(before.outcomes);
  expect(await store.observe(task.ref.id, current.executionId, current)).toEqual(recovered);
  const completed = { ...current, revision: 5, state: "completed" as const, stopConfirmed: true, result: { markdown: "One outcome", resources: [] } };
  task = await store.observe(task.ref.id, current.executionId, completed);
  expect(task.outcomes).toHaveLength(1);
  await store.unavailable(task.ref.id, "A later outage must not reopen completed work");
  expect(await store.observe(task.ref.id, current.executionId, completed)).toEqual(task);
});

const child = async (parent: TaskRecord, input: Partial<TaskInput> = {}) => store.create(actor, {
  requestId: randomUUID(), expectedGraphRevision: (await store.get(parent.ref.id, actor)).graphRevision,
  input: { ...human, ...input, parentTaskRef: parent.ref },
});
const current = (t: TaskRecord) => store.get(t.ref.id, actor);
const completeHuman = async (task: TaskRecord) => {
  let t = await action(await current(task), "ready"); t = await action(t, "start");
  return action(t, "complete", { result: { markdown: "Verified result", resources: [] } });
};
it("derives immutable ancestry and serializes concurrent graph changes", async () => {
  const root = await create(), request = { requestId: randomUUID(), expectedGraphRevision: root.graphRevision, input: { ...human, parentTaskRef: root.ref } };
  const results = await Promise.allSettled([store.create(actor, request), store.create(actor, { ...request, requestId: randomUUID() })]);
  expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  const created = await store.create(actor, request);
  expect(created).toMatchObject({ rootTaskRef: root.ref, parentTaskRef: root.ref, depth: 1, graphRevision: 2 });
  const nested = await child(created);
  expect(nested).toMatchObject({ rootTaskRef: root.ref, parentTaskRef: created.ref, depth: 2 });
  const draft = await current(created);
  await expect(store.edit(draft.ref.id, actor, { requestId: randomUUID(), expectedRevision: draft.revision, expectedGraphRevision: draft.graphRevision,
    input: { ...human, parentTaskRef: null } })).rejects.toMatchObject({ code: "parent_immutable" });
});
it("rejects prerequisite cycles including implicit parent waits and cross-tree references", async () => {
  const root = await create(), a = await child(root), b = await child(root, { dependsOn: [a.ref] });
  const fresh = await current(a);
  await expect(store.edit(a.ref.id, actor, { requestId: randomUUID(), expectedRevision: fresh.revision, expectedGraphRevision: fresh.graphRevision,
    input: { ...human, parentTaskRef: root.ref, dependsOn: [b.ref] } })).rejects.toMatchObject({ code: "relations_cycle" });
  await expect(child(root, { dependsOn: [root.ref] })).rejects.toMatchObject({ code: "relations_cycle" });
  const unrelated = await create();
  await expect(child(root, { dependsOn: [unrelated.ref] })).rejects.toMatchObject({ code: "relations_invalid" });
  expect((await store.all())).toHaveLength(4);
});
it("arms a dependent once and pins the exact accepted prerequisite outcome", async () => {
  const root = await create(), prerequisite = await child(root, { review: { mode: "owner" } });
  const dependent = await child(root, { ...app, dependsOn: [prerequisite.ref] });
  let waiting = await action(await current(dependent), "ready");
  expect(waiting).toMatchObject({ status: "Blocked", armed: true, blocked: { reason: "prerequisites" }, attempts: [] });
  const result = await completeHuman(prerequisite);
  expect((await current(dependent)).attempts).toHaveLength(0);
  await action(result, "accept", { resultRef: result.resultRef });
  waiting = await current(dependent);
  expect(waiting.status).toBe("Ready"); expect(waiting.attempts).toHaveLength(1);
  expect(waiting.attempts[0]!.request.prerequisiteOutcomes).toEqual([result.resultRef]);
  expect((await action(waiting, "ready")).attempts).toHaveLength(1);
});
it("does not complete a parent before required children have accepted results", async () => {
  const root = await create(), c = await child(root, { review: { mode: "owner" } });
  const started = await action(await action(await current(root), "ready"), "start");
  await expect(action(started, "complete", { result: { markdown: "Premature", resources: [] } })).rejects.toMatchObject({ code: "children_incomplete" });
  const result = await completeHuman(c);
  await action(result, "accept", { resultRef: result.resultRef });
  expect((await current(root)).status).toBe("InProgress");
  const completed = await action(await current(root), "complete", { result: { markdown: "Reviewed child evidence", resources: [] } });
  expect(completed.status).toBe("Done");
  expect(completed.outcomes[0]?.childOutcomes).toEqual([result.resultRef]);
});
it("fences running dependants when an accepted prerequisite is reopened", async () => {
  const root = await create(), prerequisite = await child(root), dependent = await child(root, { ...app, dependsOn: [prerequisite.ref] });
  await completeHuman(prerequisite);
  let running = await action(await current(dependent), "ready");
  const execution = running.attempts[0]!.executionId;
  running = await store.observe(running.ref.id, execution, receipt(running));
  await action(await current(prerequisite), "draft");
  expect((await current(dependent)).attempts[0]).toMatchObject({ cancelRequested: true, invalidated: true });
  const late = await store.observe(dependent.ref.id, execution, receipt(running, { revision: 2, state: "completed", stopConfirmed: true, result: { markdown: "Stale work", resources: [] } }));
  expect(late).toMatchObject({ status: "Blocked", blocked: { reason: "prerequisite_changed" } });
  expect(late.acceptedResultRef).toBeUndefined(); expect(late.outcomes[0]?.invalidated).toBe(true);
});
it("keeps result revision and attempt identity in review and reassignment", async () => {
  let t = await action(await create({ ...app, review: { mode: "owner" } }), "ready");
  t = await store.observe(t.ref.id, t.attempts[0]!.executionId, receipt(t, { state: "completed", stopConfirmed: true, result: { markdown: "First", resources: [] } }));
  const old = t.resultRef!;
  t = await action(t, "request_changes", { resultRef: old, feedback: "Add evidence" });
  expect(t.attempts).toHaveLength(2); expect(t.ref).toEqual(old.taskRef);
  t = await store.observe(t.ref.id, t.attempts[1]!.executionId, receipt(t, { state: "completed", stopConfirmed: true, result: { markdown: "Second", resources: [] } }));
  await expect(action(t, "accept", { resultRef: old })).rejects.toMatchObject({ code: "review_changed" });
  t = await action(t, "accept", { resultRef: t.resultRef });
  expect(t.outcomes.map(o => o.ref.resultRevision)).toEqual([1, 2]);
  expect(t.status).toBe("Done");
});
it("cancels a subtree without forgetting an uncertain native exit", async () => {
  const root = await create(), c = await child(root, app), nested = await child(c, app);
  await action(await current(c), "ready"); await action(await current(nested), "ready");
  await action(await current(root), "cancel");
  for (const task of [c, nested]) {
    const row = await current(task);
    expect(row.cancelRequested).toBe(true); expect(activeAttempt(row)).toBeDefined();
    await expect(action(row, "retry")).rejects.toMatchObject({ code: "cancellation_pending" });
  }
});
it("keeps provider discovery outside the writer and rechecks revision after it returns", async () => {
  const task = await create(app);
  let finish!: (a: NonNullable<TaskInput["assignee"]>) => void;
  const discovery = new Promise<NonNullable<TaskInput["assignee"]>>(resolve => { finish = resolve; });
  const mutation = store.action(task.ref.id, actor, { requestId: randomUUID(), expectedRevision: task.revision, action: "ready" }, () => discovery);
  const other = await create();
  expect(other.number).toBe("HRN-2");
  await action(task, "cancel"); finish(app.assignee!);
  await expect(mutation).rejects.toMatchObject({ code: "task_changed" });
});


const removalScope = (...rows: TaskRecord[]) => rows.map(t => ({ taskRef: t.ref, revision: t.revision }));
it("removes and restores the reviewed subtree atomically without losing history or starting work", async () => {
  let root = await create();
  const child = await store.create(actor, { requestId: randomUUID(), expectedGraphRevision: root.graphRevision, input: { ...human, parentTaskRef: root.ref } });
  root = await store.get(root.ref.id, actor);
  await expect(action(root, "remove", { removalScope: removalScope(root) })).rejects.toMatchObject({ code: "removal_scope_changed" });
  const request: TaskAction = { requestId: randomUUID(), expectedRevision: root.revision, action: "remove", removalScope: removalScope(root, child) };
  root = await store.action(root.ref.id, actor, request);
  expect((await store.list(actor)).tasks).toHaveLength(0);
  const trash = (await store.list(actor, "", 100, undefined, { removed: true })).tasks;
  expect(trash).toHaveLength(2); expect(trash.every(t => t.removed?.batchId === request.requestId)).toBe(true);
  expect(await store.action(root.ref.id, actor, request)).toEqual(root);
  await expect(action(root, "ready")).rejects.toMatchObject({ code: "task_removed" });
  root = await action(root, "restore", { removalScope: removalScope(...trash) });
  expect(root.status).toBe("Draft"); expect(root.attempts).toHaveLength(0);
  expect((await store.list(actor)).tasks).toHaveLength(2);
  expect((await create()).number).toBe("HRN-3");
});
it("rejects removal of active or uncertain attempts and missing external dependency scope", async () => {
  let root = await action(await create(app), "ready");
  await expect(action(root, "remove", { removalScope: removalScope(root) })).rejects.toMatchObject({ code: "execution_active" });
  root = await store.observe(root.ref.id, root.attempts[0]!.executionId, receipt(root, { state: "interrupted", stopConfirmed: false }));
  await expect(action(root, "remove", { removalScope: removalScope(root) })).rejects.toMatchObject({ code: "execution_active" });
  const parent = await create();
  const child = await store.create(actor, { requestId: randomUUID(), expectedGraphRevision: parent.graphRevision, input: { ...human, parentTaskRef: parent.ref } });
  await expect(action(child, "remove", { removalScope: removalScope(child) })).rejects.toMatchObject({ code: "task_referenced" });
  await expect(store.action(parent.ref.id, { userId: "stranger", appId: null }, { requestId: randomUUID(), expectedRevision: parent.revision, action: "remove", removalScope: removalScope(parent) })).rejects.toMatchObject({ code: "task_not_found" });
});

it("keeps quarantined cleanup scoped, recoverable and idempotent without promoting malformed rows", async () => {
  await store.transaction(state => { state.legacyTasks = [{ id: "old", title: "Old work", owner: actor, status: "Cancelled", malformed: true }, null, { owner: { userId: "stranger", appId: null }, title: "Private" }]; });
  const page = await store.legacyList(actor); expect(page.tasks).toHaveLength(1);
  const id = page.tasks[0]!.id, request = { requestId: randomUUID(), action: "remove" };
  expect(await store.legacyAction(actor, id, request)).toEqual(await store.legacyAction(actor, id, request));
  expect((await store.legacyList(actor)).tasks[0]!.removed).toBe(true);
  await expect(store.legacyAction({ userId: "stranger", appId: null }, id, request)).rejects.toMatchObject({ code: "task_not_found" });
  await expect(store.legacyAction(actor, id, { ...request, action: "restore" })).rejects.toMatchObject({ code: "request_conflict" });
  await store.legacyAction(actor, id, { requestId: randomUUID(), action: "restore" });
  expect((await store.legacyList(actor)).tasks[0]!.removed).toBe(false);
  expect((await store.list(actor)).tasks).toHaveLength(0);
});

it("retains failed-attention delivery, retries once and scopes recovery to the owner", async () => {
  let task = await action(await create(app), "ready");
  task = await store.observe(task.ref.id, task.attempts[0]!.executionId, receipt(task, { state: "failed", stopConfirmed: true,
    sessionRef: { id: "failed-session", path: "/development?session=failed-session" }, error: { code: "task_failed", message: "Work incomplete" } }));
  let now = 1000; const publish = vi.fn(async () => {}), attention = new TaskAttention(store, publish, () => now);
  publish.mockRejectedValueOnce(new Error("Notification transport offline"));
  await attention.reconcile(); await attention.reconcile(); expect(publish).toHaveBeenCalledTimes(1);
  expect(await attention.projections("stranger")).toEqual([]);
  expect(await attention.projections("owner")).toEqual([expect.objectContaining({ taskId: task.ref.id, error: expect.stringContaining("could not be delivered") })]);
  now += 30000; await attention.reconcile(); await attention.reconcile(); expect(publish).toHaveBeenCalledTimes(2);
  expect((await attention.projections("owner"))[0]!.error).not.toContain("could not be delivered");
  await action(task, "remove", { removalScope: removalScope(task) }); expect(await attention.projections("owner")).toEqual([]);
});
