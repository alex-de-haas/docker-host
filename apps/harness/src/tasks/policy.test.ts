import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { TaskRecord, TaskAction } from "@hosty-sdk/app/tasks";
import { TaskStore } from "./store.js";
import { TaskPolicies, defaultTaskLimits } from "./policy.js";

let dir: string, store: TaskStore, policies: TaskPolicies;
const provider = { appId: "test.executor", installationId: "one", key: "default" };
const owner = { userId: "owner", appId: null };
const input = { title: "Work", markdown: "Do work", resources: [], assignee: { kind: "app" as const, executor: provider } };
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "task-limits-")); store = new TaskStore(dir, provider); policies = new TaskPolicies(store);
  store.beforeChild = (s, p) => policies.child(s, p); store.beforeAttempt = (s, t) => policies.attempt(s, t);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const action = (t: TaskRecord, action: TaskAction["action"], extra: Partial<TaskAction> = {}) => store.action(t.ref.id, owner, { requestId: randomUUID(), expectedRevision: t.revision, action, ...extra });
const createRoot = async () => action(await store.create(owner, { requestId: randomUUID(), input }), "ready");
const child = async (t: TaskRecord, requestId = randomUUID()) => store.create(owner, { requestId,
  expectedGraphRevision: (await store.get(t.ref.id, owner)).graphRevision, input: { ...input, parentTaskRef: t.ref } });
it("snapshots defaults and preserves explicit zero limits on existing roots", async () => {
  const defaults = await policies.defaults();
  await policies.updateDefaults("owner", { requestId: randomUUID(), expectedRevision: defaults.revision,
    values: { ...defaultTaskLimits, maxDescendants: 0, maxDelegationDepth: 0, maxRetriesPerTask: 0 } });
  const root = await createRoot();
  await expect(child(root)).rejects.toMatchObject({ code: "limit_exceeded" });
  const updated = await policies.defaults();
  await policies.updateDefaults("owner", { requestId: randomUUID(), expectedRevision: updated.revision, values: defaultTaskLimits });
  expect((await policies.get(root.ref.id, "owner")).limits.maxDescendants).toBe(0);
  await expect(policies.get(root.ref.id, "other")).rejects.toMatchObject({ code: "task_not_found" });
});
it("counts descendants at creation, preserves replay and never refunds cancelled work", async () => {
  const root = await createRoot(), initial = await policies.get(root.ref.id, "owner");
  await policies.updateRoot(root.ref.id, "owner", { requestId: randomUUID(), expectedRevision: initial.limitsRevision, values: { ...defaultTaskLimits, maxDescendants: 1 } });
  const request = { requestId: randomUUID(), expectedGraphRevision: root.graphRevision, input: { ...input, parentTaskRef: root.ref } };
  const a = await store.create(owner, request); expect(await store.create(owner, request)).toEqual(a);
  await action(a, "cancel");
  await expect(child(root)).rejects.toMatchObject({ code: "limit_exceeded" });
  expect((await policies.get(root.ref.id, "owner")).descendantCount).toBe(1);
});
it("enforces depth below the root and lifetime retries across Draft reopening", async () => {
  const root = await createRoot(), c1 = await child(root), c2 = await child(c1), c3 = await child(c2);
  await expect(child(c3)).rejects.toMatchObject({ code: "limit_exceeded" });
  let task = await store.get(root.ref.id, owner);
  for (let i = 0; i < 3; i++) {
    const id = task.attempts.at(-1)!.executionId;
    task = await store.observe(task.ref.id, id, { executionId: id, state: "failed", stopConfirmed: true, revision: 1, createdAt: "now", updatedAt: "now" });
    if (i < 2) task = await action(task, "retry");
  }
  await expect(action(task, "retry")).rejects.toMatchObject({ code: "limit_exceeded" });
  task = await action(task, "draft");
  await expect(action(task, "ready")).rejects.toMatchObject({ code: "limit_exceeded" });
  expect((await store.get(task.ref.id, owner)).attempts).toHaveLength(3);
});
it("reserves four native slots including the manager and releases only proven stops", async () => {
  const root = await createRoot(); const tasks = [root];
  for (let i = 0; i < 4; i++) tasks.push(await action(await child(root), "ready"));
  const admitted = await Promise.all(tasks.map(t => policies.reserve(t.ref.id, t.attempts.at(-1)!.executionId)));
  expect(admitted.filter(Boolean)).toHaveLength(4);
  const run = root.attempts[0]!.executionId;
  const receipt = { executionId: run, state: "interrupted" as const, revision: 1, createdAt: "now", updatedAt: "now", stopConfirmed: false };
  await policies.observe(root.ref.id, run, receipt);
  expect(await policies.reserve(tasks[4]!.ref.id, tasks[4]!.attempts[0]!.executionId)).toBe(false);
  await policies.observe(root.ref.id, run, { ...receipt, state: "awaiting_input", nativeStopConfirmed: true });
  expect(await policies.reserve(tasks[4]!.ref.id, tasks[4]!.attempts[0]!.executionId)).toBe(true);
});
it("keeps cumulative usage through replays, rejects unsupported cost caps and retains uncertain usage", async () => {
  const root = await createRoot(), run = root.attempts[0]!.executionId;
  const policy = await policies.get(root.ref.id, "owner");
  await expect(policies.updateRoot(root.ref.id, "owner", { requestId: randomUUID(), expectedRevision: policy.limitsRevision,
    values: { ...defaultTaskLimits, maxCost: { currency: "USD", micros: 100 } } })).rejects.toMatchObject({ code: "unsupported_budget" });
  await policies.updateRoot(root.ref.id, "owner", { requestId: randomUUID(), expectedRevision: policy.limitsRevision, values: { ...defaultTaskLimits, maxActiveSeconds: 2 } });
  await policies.reserve(root.ref.id, run);
  await policies.usage(root.ref.id, run, 1, 1000); await policies.usage(root.ref.id, run, 1, 1000);
  expect(Object.values((await policies.get(root.ref.id, "owner")).reservations)[0]!.activeMs).toBe(1000);
  await policies.usage(root.ref.id, run, 2, 2200);
  expect(policies.budgetReason(await policies.get(root.ref.id, "owner"))).toBe("time_budget");
  await policies.usage(root.ref.id, run, 3, 2200, true);
  expect(policies.budgetReason(await policies.get(root.ref.id, "owner"))).toBe("usage_unknown");
});
it("persists owner pause/stop fences and replays exact control requests", async () => {
  const root = await createRoot(), policy = await policies.get(root.ref.id, "owner"), run = root.attempts[0]!.executionId;
  const request = { requestId: randomUUID(), expectedRevision: policy.revision, action: "pause" as const };
  const paused = await policies.control(root.ref.id, "owner", request);
  expect(await policies.control(root.ref.id, "owner", request)).toEqual(paused);
  expect(await policies.reserve(root.ref.id, run)).toBe(false);
  const resume = { requestId: randomUUID(), expectedRevision: paused.revision, action: "resume" as const };
  const resumed = await policies.control(root.ref.id, "owner", resume, async () => {});
  expect(await policies.control(root.ref.id, "owner", resume, async () => { throw new Error("Already running"); })).toEqual(resumed);
  expect(await policies.reserve(root.ref.id, run)).toBe(true);
  const current = await policies.get(root.ref.id, "owner");
  expect(current.revision).toBeGreaterThan(resumed.revision);
  await policies.control(root.ref.id, "owner", { requestId: randomUUID(), expectedRevision: current.revision, action: "stop" });
  expect((await store.get(root.ref.id, owner)).cancelRequested).toBe(true);
  expect(await policies.reserve(root.ref.id, run)).toBe(false);
});
