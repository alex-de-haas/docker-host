import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TaskRecord } from "@hosty-sdk/app/tasks";
import type { SessionRecord } from "../sessions/store.js";
import type { SessionManager } from "../sessions/manager.js";
import { TaskStore } from "./store.js";
import { TaskSources } from "./sources.js";
import { TaskControls } from "./controls.js";
import { TaskPolicies, defaultTaskLimits } from "./policy.js";
import type { TaskOrchestrator } from "./orchestrator.js";

let dir: string, store: TaskStore, policies: TaskPolicies, sources: TaskSources, controls: TaskControls, root: TaskRecord;
let sessions: Map<string, SessionRecord>, unsettled: Set<string>, manager: SessionManager, orchestration: TaskOrchestrator;
const owner = { userId: "owner", appId: null }, provider = { appId: "custom.executor", installationId: "one", key: "default" };
const dispatch = { userId: owner.userId, principalId: "operator", requestId: randomUUID() };
const select = vi.fn(), resumed = vi.fn();
async function task(parent?: TaskRecord) {
  let t = await store.create(owner, { requestId: randomUUID(), expectedGraphRevision: parent && (await store.get(parent.ref.id, owner)).graphRevision,
    input: { title: "Implement", markdown: "Build the requested change", resources: [], assignee: { kind: "app", executor: provider }, parentTaskRef: parent?.ref } });
  t = await store.action(t.ref.id, owner, { requestId: randomUUID(), expectedRevision: t.revision, action: "ready" }, undefined, undefined, dispatch);
  const executionId = t.attempts[0]!.executionId, id = randomUUID();
  t = await store.observe(t.ref.id, executionId, { executionId, state: "running", revision: 1, stopConfirmed: false, sessionRef: { id, path: "/assistant?session=" + id }, createdAt: "now", updatedAt: "now" });
  sessions.set(id, { id, createdBy: "owner", autonomy: "autonomous", taskExecutionId: executionId, workerRun: { id: randomUUID() },
    taskRun: { started: true, exitConfirmed: false }, taskContext: { taskRef: t.ref, rootTaskRef: t.rootTaskRef, parentTaskRef: t.parentTaskRef } } as SessionRecord);
  await store.writeJournal("write-scope:" + t.ref.id, { mode: "read", paths: ["src"] });
  return t;
}
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "task-boundaries-")); store = new TaskStore(dir, provider); policies = new TaskPolicies(store);
  store.beforeAttempt = (s, t) => policies.attempt(s, t); store.beforeChild = (s, t) => policies.child(s, t);
  sessions = new Map(); unsettled = new Set(); select.mockReset(); resumed.mockReset();
  manager = {
    getSession: async (id: string) => structuredClone(sessions.get(id) ?? null),
    armTaskBarrier: async (id: string, user: string, barrierId: string, kind: string, generation: number, origin?: string) => {
      const s = sessions.get(id)!;
      s.taskBarrier ??= { id: barrierId, kind, generation, owner: user, origin, runId: s.workerRun!.id, state: "armed", commandId: randomUUID(), snapshot: "original" } as SessionRecord["taskBarrier"];
      return `hosty_task_barrier:${barrierId}:${generation}`;
    },
    advanceTaskBarrier: async (id: string) => {
      const s = sessions.get(id)!;
      if (unsettled.has(id)) return;
      s.taskBarrier!.state = "parked"; s.taskBarrier!.nativeSessionId = "retained"; s.taskRun!.exitConfirmed = true; delete s.workerRun;
    },
    prepareTaskWorkspace: async (id: string, authority: unknown, executionId: string, workspaceId: string) => {
      const s = sessions.get(id)!;
      s.taskWorkspace = { dispatch: authority, executionId, workspaceId, leaseId: randomUUID() } as SessionRecord["taskWorkspace"];
      s.developmentWorkspaces = [{ id: "repo", path: dir }] as SessionRecord["developmentWorkspaces"];
    },
    finishTaskSourceBoundary: async () => {}, recordTaskHistoryAssociation: async () => {},
    resumeTaskBarrier: async (id: string) => { resumed(id); sessions.get(id)!.taskBarrier!.state = "resuming"; },
  } as unknown as SessionManager;
  orchestration = {
    context: async (id: string) => {
      const s = sessions.get(id)!, current = await store.get(s.taskContext!.taskRef.id, owner);
      return { task: current, owner: "owner", binding: { rootDispatch: (await store.dispatch(current.rootTaskRef.id)) ?? dispatch, rootTaskRef: current.rootTaskRef, parentTaskRef: current.ref,
        parentExecutionId: s.taskExecutionId, coordinatorEpoch: current.coordination!.coordinatorEpoch, rootGeneration: current.coordination!.rootGeneration } };
    }, reserveContinuation: async () => true,
  } as unknown as TaskOrchestrator;
  sources = new TaskSources(store, manager, orchestration, async <T>(command: any) => {
    select(command); return { rootDispatch: command.rootDispatch, contextId: command.payload.contextId, contextRevision: command.payload.expectedRevision + 1,
      workspaceId: command.payload.workspaceId } as T;
  }, async <T>() => ({ association: { workspace: { id: "workspace", revision: 1, sessions: [] } } }) as T);
  controls = new TaskControls(store, manager, policies, orchestration);
  root = await task();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const sessionId = (t: TaskRecord) => t.attempts[0]!.receipt!.sessionRef!.id;

it("blocks late source binding until every active child confirms its original stop", async () => {
  const planning = await task(root), planningSession = sessionId(planning), planningAttempt = planning.attempts[0]!;
  await store.observe(planning.ref.id, planningAttempt.executionId, { ...planningAttempt.receipt!, revision: 2, state: "completed", stopConfirmed: true, result: { markdown: "Analysis before source selection", resources: [] } });
  delete sessions.get(planningSession)!.workerRun; sessions.get(planningSession)!.taskRun!.exitConfirmed = true;
  const history = vi.spyOn(manager, "recordTaskHistoryAssociation");
  const child = await task(root), rootSession = sessionId(root), childSession = sessionId(child);
  unsettled.add(childSession);
  const input = { requestId: randomUUID(), expectedRevision: 0, workspaceId: "workspace" };
  await sources.bind(rootSession, input); await sources.reconcile();
  expect(select).not.toHaveBeenCalled(); expect(resumed).not.toHaveBeenCalled();
  expect(sessions.get(childSession)!.taskBarrier).toMatchObject({ kind: "source_rebind", origin: "coordinator" });
  unsettled.clear(); await sources.reconcile(); await sources.reconcile();
  expect(select).toHaveBeenCalledTimes(1); expect(resumed.mock.calls.map(c => c[0]).sort()).toEqual([rootSession, childSession].sort());
  expect((await sources.context(root.ref.id))!.associations).toHaveProperty(child.attempts[0]!.executionId);
  expect((await sources.context(root.ref.id))!.associations).toHaveProperty(planningAttempt.executionId);
  expect(history).toHaveBeenCalledWith(planningSession, "owner", "workspace", 1);
  expect(sessions.get(planningSession)!.taskWorkspace).toBeUndefined();
  expect((await sources.bind(rootSession, input)).state).toBe("applied");
  expect((await store.get(child.ref.id, owner)).attempts).toHaveLength(1);
});

it("adopts the existing root chat workspace without inventing another source allocation", async () => {
  const id = sessionId(root); sessions.get(id)!.workspaceAssociation = { id: "already-selected", revision: 4 };
  await sources.beforeLaunch(root.attempts[0]!.request, root.attempts[0]!.executionId, id, { actor: owner, scope: "", taskDispatch: dispatch, validate: async () => {} });
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ operation: "bind_source", payload: expect.objectContaining({ workspaceId: "already-selected" }) }));
  expect((await sources.context(root.ref.id))!.workspaceId).toBe("already-selected");
});

it("parks on measured budget exhaustion, retains overshoot, and resumes the same attempt after an owner increase", async () => {
  const id = sessionId(root), run = root.attempts[0]!.executionId;
  const initial = await policies.get(root.ref.id, "owner");
  await policies.updateRoot(root.ref.id, "owner", { requestId: randomUUID(), expectedRevision: initial.limitsRevision, values: { ...defaultTaskLimits, maxActiveSeconds: 1 } });
  await policies.reserve(root.ref.id, run); await policies.usage(root.ref.id, run, 1, 1250);
  unsettled.add(id); await controls.reconcile();
  expect((await policies.get(root.ref.id, "owner")).reservations[run]!.held).toBe(true);
  expect(resumed).not.toHaveBeenCalled();
  unsettled.clear(); await controls.reconcile();
  expect(sessions.get(id)!.taskBarrier!.state).toBe("parked");
  const current = await policies.get(root.ref.id, "owner");
  await policies.updateRoot(root.ref.id, "owner", { requestId: randomUUID(), expectedRevision: current.limitsRevision, values: { ...defaultTaskLimits, maxActiveSeconds: 2 } });
  await controls.reconcile(); await controls.reconcile();
  expect(resumed).toHaveBeenCalledExactlyOnceWith(id);
  expect((await policies.get(root.ref.id, "owner")).reservations[run]!.activeMs).toBe(1250);
  expect((await store.get(root.ref.id, owner)).attempts).toHaveLength(1);
});

it("queues an unstarted task while shared native capacity is occupied", async () => {
  const id = sessionId(root), attempt = root.attempts[0]!;
  sources.capacityAvailable = async () => false;
  expect(await sources.beforeLaunch(attempt.request, attempt.executionId, id, { actor: owner, scope: "local", validate: async () => {} })).toBe(false);
  expect(select).not.toHaveBeenCalled();
  sources.capacityAvailable = async () => true;
  expect(await sources.beforeLaunch(attempt.request, attempt.executionId, id, { actor: owner, scope: "local", validate: async () => {} })).toBe(true);
  expect((await store.get(root.ref.id, owner)).attempts).toHaveLength(1);
});

it("keeps a paused root fenced until all original checkpoints are confirmed", async () => {
  const id = sessionId(root), p = await policies.get(root.ref.id, "owner");
  await policies.control(root.ref.id, "owner", { requestId: randomUUID(), expectedRevision: p.revision, action: "pause" });
  unsettled.add(id); await controls.reconcile();
  await expect(controls.validateResume(root.ref.id, "owner")).rejects.toMatchObject({ code: "boundary_pending" });
  expect((await policies.get(root.ref.id, "owner")).paused).toBe(true);
  unsettled.clear(); await controls.reconcile();
  await controls.validateResume(root.ref.id, "owner");
  sessions.get(id)!.taskBarrier!.nativeSessionId = undefined;
  await expect(controls.validateResume(root.ref.id, "owner")).rejects.toMatchObject({ code: "boundary_pending" });
});

it("does not block another root's pause when one control has unavailable policy", async () => {
  const other = await task();
  const p = await policies.get(other.ref.id, "owner");
  await policies.control(other.ref.id, "owner", { requestId: randomUUID(), expectedRevision: p.revision, action: "pause" });
  const get = policies.get.bind(policies);
  vi.spyOn(policies, "get").mockImplementation((id, owner) => id === root.ref.id ? Promise.reject(new Error("Unavailable root")) : get(id, owner));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await controls.reconcile();
  expect(sessions.get(sessionId(other))!.taskBarrier!.state).toBe("parked");
  expect(log).toHaveBeenCalled(); log.mockRestore();
});

it("projects a retained source intent whose native boundary is missing without selecting source", async () => {
  const id = sessionId(root);
  await sources.bind(id, { requestId: randomUUID(), expectedRevision: 0, workspaceId: "workspace" });
  delete sessions.get(id)!.taskBarrier;
  vi.spyOn(manager, "advanceTaskBarrier").mockResolvedValue();
  await sources.reconcile();
  expect(select).not.toHaveBeenCalled();
  expect(await sources.projections("owner")).toEqual([expect.objectContaining({ kind: "recovery", sessionId: id, available: false })]);
  expect(await sources.projections("someone-else")).toEqual([]);
});

it("observes an uncertain source selection before rebinding it to a replacement coordinator", async () => {
  const originalSession = sessionId(root), originalAttempt = root.attempts[0]!;
  const earlier = await task(root);
  const input = { requestId: randomUUID(), expectedRevision: 0, workspaceId: "workspace" };
  await sources.bind(originalSession, input);
  const pending = (await sources.context(root.ref.id))!;
  pending.operation!.state = "selecting";
  await store.writeJournal("source:" + root.ref.id, pending);
  root = await store.observe(root.ref.id, originalAttempt.executionId, { ...originalAttempt.receipt!, revision: 2, state: "failed", stopConfirmed: true, error: { code: "confirmed_failure", message: "Stopped" } });
  root = await store.action(root.ref.id, owner, { requestId: randomUUID(), expectedRevision: root.revision, action: "retry" }, undefined, undefined, { ...dispatch, requestId: randomUUID() });
  const next = root.attempts.at(-1)!, id = randomUUID();
  sessions.set(id, { ...sessions.get(originalSession)!, id, workerRun: undefined, taskBarrier: undefined, taskRun: { started: false, exitConfirmed: false }, taskExecutionId: next.executionId } as SessionRecord);
  const commands: any[] = [];
  sources = new TaskSources(store, manager, orchestration, async <T>(command: any) => {
    commands.push(command);
    return { rootDispatch: command.operation === "observe_source" ? dispatch : command.rootDispatch, contextId: pending.id,
      contextRevision: command.operation === "observe_source" ? 1 : 2, workspaceId: "workspace" } as T;
  });
  const currentDispatch = (await store.dispatch(root.ref.id))!;
  expect(await sources.beforeLaunch(next.request, next.executionId, id, { actor: owner, scope: "local", taskDispatch: currentDispatch, validate: async () => {} })).toBe(true);
  expect(commands.map(c => c.operation)).toEqual(["observe_source", "bind_source"]);
  expect(commands.every(c => c.parentExecutionId === next.executionId && c.requestId !== input.requestId)).toBe(true);
  expect(commands[1].payload).toMatchObject({ contextId: pending.id, expectedRevision: 1, sessionId: id, workspaceId: "workspace" });
  expect((await sources.context(root.ref.id))!.reference!.rootDispatch).toEqual(currentDispatch);
  expect((await store.get(earlier.ref.id, owner)).rootTaskRef).toEqual(root.ref);
  expect(resumed).not.toHaveBeenCalled();
  expect((await store.get(root.ref.id, owner)).attempts).toHaveLength(2);
});
