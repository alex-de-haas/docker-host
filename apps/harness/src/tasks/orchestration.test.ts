import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { TaskCreate, TaskRecord, TaskAction } from "@hosty-sdk/app/tasks";
import type { TaskWorkflowRequest } from "@hosty-sdk/app/providers";
import type { SessionManager } from "../sessions/manager.js";
import type { SessionRecord } from "../sessions/store.js";
import type { HarnessTaskExecutor } from "./executor.js";
import { TaskStore, fingerprint } from "./store.js";
import { TaskPolicies } from "./policy.js";
import { TaskOrchestrator } from "./orchestrator.js";
import { assertTaskCoordinator } from "./workflow.js";

let directory: string, store: TaskStore, policies: TaskPolicies, orchestration: TaskOrchestrator, root: TaskRecord, session: SessionRecord;
let revoked: boolean, loseCreateReply: boolean;
const owner = { userId: "owner", appId: null }, provider = { appId: "independent.runner", installationId: "one", key: "default" };
const profile = { kind: "option" as const, id: "developer", revision: 1 };
const resume = vi.fn();
beforeEach(async () => {
  revoked = false; loseCreateReply = false; resume.mockReset();
  directory = await mkdtemp(path.join(os.tmpdir(), "task-orchestration-")); store = new TaskStore(directory, provider); policies = new TaskPolicies(store);
  store.beforeChild = (s, t) => policies.child(s, t); store.beforeAttempt = (s, t) => policies.attempt(s, t);
  root = await store.create(owner, { requestId: randomUUID(), input: { title: "Application", markdown: "Build and verify", resources: [], assignee: { kind: "app", executor: provider, selection: profile } } });
  const dispatch = { userId: "owner", principalId: "operator", requestId: randomUUID() };
  root = await store.action(root.ref.id, owner, { requestId: dispatch.requestId, expectedRevision: root.revision, action: "ready" }, undefined, undefined, dispatch);
  session = { id: "manager-session", createdBy: "owner", taskExecutionId: root.attempts[0]!.executionId,
    taskContext: { taskRef: root.ref, rootTaskRef: root.ref, parentTaskRef: null, executor: { ...profile, name: "Developer" } } } as SessionRecord;
  const manager = {
    getSession: async (id: string) => id === session.id ? structuredClone(session) : null,
    armTaskBarrier: async (_id: string, user: string, id: string, kind: "child_wait", generation: number) => {
      session.taskBarrier = { id, owner: user, kind, generation, state: "armed", runId: "native-segment", snapshot: "snapshot", commandId: randomUUID() };
      return `hosty_task_barrier:${id}:${generation}`;
    },
    advanceTaskBarrier: async () => { session.taskBarrier!.state = "parked"; session.taskBarrier!.nativeSessionId = "same-context"; },
    resumeTaskBarrier: async (...args: unknown[]) => { resume(...args); session.taskBarrier!.state = "resuming"; },
  } as unknown as SessionManager;
  const call = async <T>(input: TaskWorkflowRequest): Promise<T> => {
    if (revoked) throw new Error("Authority revoked");
    const binding = { ...input, rootTaskRef: root.ref };
    await store.transaction(s => assertTaskCoordinator(store, s, binding, "owner"));
    if (input.operation === "create_child") {
      const child = await store.create(owner, input.payload as unknown as TaskCreate, "operator", s => { assertTaskCoordinator(store, s, binding, "owner"); });
      if (loseCreateReply) { loseCreateReply = false; throw new Error("Reply lost after durable creation"); }
      return child as T;
    }
    if (input.operation === "action") {
      const action = input.payload as unknown as { taskRef: TaskRecord["ref"]; input: TaskAction };
      return await store.action(action.taskRef.id, owner, action.input, undefined, "operator", undefined,
        (t, s) => { assertTaskCoordinator(store, s, binding, "owner", t); }) as T;
    }
    return {} as T;
  };
  orchestration = new TaskOrchestrator(store, manager, {} as HarnessTaskExecutor, policies, call);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function delegate() {
  const current = await store.get(root.ref.id, owner);
  const input = { requestId: randomUUID(), expectedGraphRevision: current.graphRevision, title: "Implement", markdown: "Implement and test", resources: [], selection: profile, rationale: "Existing developer profile fits this work" };
  return { input, invoke: () => orchestration.delegate(session.id, input) };
}
async function complete(task: TaskRecord) {
  const executionId = task.attempts[0]!.executionId;
  return store.observe(task.ref.id, executionId, { executionId, revision: 1, state: "completed", stopConfirmed: true,
    createdAt: "now", updatedAt: "now", result: { markdown: "Verified implementation", resources: [] } });
}
it("recovers a child create after reply loss without allocating another task or attempt", async () => {
  const command = await delegate(); loseCreateReply = true;
  await expect(command.invoke()).rejects.toThrow("Reply lost");
  expect((await store.all())).toHaveLength(2);
  const recovered = await command.invoke();
  expect(recovered.parentTaskRef).toEqual(root.ref); expect(recovered.review.mode).toBe("delegator");
  expect(recovered.attempts).toHaveLength(1);
  expect((await command.invoke()).ref).toEqual(recovered.ref);
  expect((await policies.get(root.ref.id, "owner")).descendantCount).toBe(1);
});
it("atomically retains a child result delivery and resumes a parked parent once before review", async () => {
  const child = await (await delegate()).invoke();
  const waited = await orchestration.wait(session.id, { requestId: randomUUID(), children: [child.ref], mode: "all" });
  expect(waited.state).toBe("pending");
  const outcome = await complete(child);
  expect(outcome.blocked?.reason).toBe("needs_review");
  expect(await store.journalEntries("child-outbox:")).toHaveLength(1);
  await orchestration.reconcile(); await orchestration.reconcile();
  expect(resume).toHaveBeenCalledTimes(1);
  expect(resume.mock.calls[0]![2]).toContain(JSON.stringify(outcome.resultRef));
  expect((await store.get(child.ref.id, owner)).acceptedResultRef).toBeUndefined();
  expect(await store.readJournal("inbox:" + root.ref.id)).toHaveLength(1);
});
it("returns already available child output synchronously without creating a parked run", async () => {
  const child = await complete(await (await delegate()).invoke());
  const result = await orchestration.wait(session.id, { requestId: randomUUID(), children: [child.ref], mode: "any" });
  expect(result.state).toBe("ready"); expect(session.taskBarrier).toBeUndefined();
  await orchestration.reconcile(); expect(resume).not.toHaveBeenCalled();
});
it("retains output without resuming after authority revocation or parent cancellation", async () => {
  const child = await (await delegate()).invoke();
  await orchestration.wait(session.id, { requestId: randomUUID(), children: [child.ref], mode: "all" });
  await complete(child); revoked = true;
  await orchestration.reconcile(); expect(resume).not.toHaveBeenCalled();
  revoked = false;
  const current = await store.get(root.ref.id, owner);
  await store.action(root.ref.id, owner, { requestId: randomUUID(), expectedRevision: current.revision, action: "cancel" });
  await orchestration.reconcile(); expect(resume).not.toHaveBeenCalled();
  const retained = await store.readJournal<Array<{ resultRef?: unknown; status: string }>>("inbox:" + root.ref.id);
  expect(retained?.some(event => event.resultRef)).toBe(true);
  expect(retained?.some(event => event.status === "Cancelled")).toBe(true);
});
it("rejects unrelated child waits and stale coordinator commands", async () => {
  const other = await store.create(owner, { requestId: randomUUID(), input: { title: "Other", markdown: "Independent", resources: [], assignee: null } });
  await expect(orchestration.wait(session.id, { requestId: randomUUID(), children: [other.ref], mode: "all" })).rejects.toMatchObject({ code: "permission_denied" });
  await store.transaction(s => { store.find(s, root.ref.id).coordination!.coordinatorEpoch++; });
  const binding = { ...(await orchestration.context(session.id)).binding, coordinatorEpoch: 1 };
  await expect(store.transaction(s => assertTaskCoordinator(store, s, binding, "owner"))).rejects.toMatchObject({ code: "stale_input" });
});
it("keeps execution plans revisioned independently of the immutable task objective", async () => {
  const before = fingerprint(root.attempts[0]!.request), request = { requestId: randomUUID(), expectedRevision: 0, markdown: "Analyze, implement, review" };
  const plan = await orchestration.plan(session.id, request);
  expect(await orchestration.plan(session.id, request)).toEqual(plan);
  await expect(orchestration.plan(session.id, { ...request, requestId: randomUUID(), markdown: "Replace" })).rejects.toMatchObject({ code: "revision_conflict" });
  expect(fingerprint((await store.get(root.ref.id, owner)).attempts[0]!.request)).toBe(before);
});

it("coalesces foreground and recovery delegation before asking policy or creating a child", async () => {
  const command = await delegate();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = (orchestration as any).send.bind(orchestration);
  const send = vi.spyOn(orchestration as any, "send").mockImplementation(async (...args: any[]) => {
    if (args[1] === "create_child") await gate;
    return original(...args);
  });
  const foreground = command.invoke();
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  const background = orchestration.reconcile();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(send).toHaveBeenCalledTimes(1);
  release(); await foreground; await background;
  expect((await store.all())).toHaveLength(2);
  expect(send.mock.calls.filter(args => args[1] === "create_child")).toHaveLength(1);
});

it("delivers an existing child's late result to a replacement manager without dispatching another child", async () => {
  const child = await (await delegate()).invoke();
  const oldWait = await orchestration.wait(session.id, { requestId: randomUUID(), children: [child.ref], mode: "all" });
  const original = root.attempts[0]!.executionId;
  root = await store.observe(root.ref.id, original, { executionId: original, revision: 1, state: "failed", stopConfirmed: true, createdAt: "now", updatedAt: "now", error: { code: "stopped", message: "Confirmed coordinator failure" } });
  root = await store.action(root.ref.id, owner, { requestId: randomUUID(), expectedRevision: root.revision, action: "retry" }, undefined, undefined, { userId: "owner", principalId: "operator", requestId: randomUUID() });
  session = { ...session, id: "replacement-session", taskExecutionId: root.attempts.at(-1)!.executionId, taskBarrier: undefined };
  await orchestration.wait(session.id, { requestId: randomUUID(), children: [child.ref], mode: "all" });
  const outcome = await complete(child);
  await orchestration.reconcile(); await orchestration.reconcile();
  expect(resume).toHaveBeenCalledTimes(1); expect(resume.mock.calls[0]![0]).toBe("replacement-session");
  expect(resume.mock.calls[0]![2]).toContain(JSON.stringify(outcome.resultRef));
  expect(await store.readJournal("wait:" + oldWait.waitId)).toMatchObject({ state: "cancelled" });
  expect((await store.get(child.ref.id, owner)).attempts).toHaveLength(1);
  expect(await store.all()).toHaveLength(2);
});
