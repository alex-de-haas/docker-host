import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import type { TaskCreate, TaskEdit, TaskRecord, TaskExecutionInput } from "@hosty-sdk/app/tasks";
import { SessionManager } from "../sessions/manager.js";
import type { SessionRecord } from "../sessions/store.js";
import { decisionSnapshot } from "../decisions/waits.js";
import { TaskPolicies } from "./policy.js";
import { TaskStore } from "./store.js";
import { TaskAdoptions, type TaskAdoption } from "./adoptions.js";
import type { TaskConfiguration } from "./configurations.js";

let dir: string, store: TaskStore, manager: SessionManager, adoptions: TaskAdoptions, session: SessionRecord;
let loseReply: boolean;
const actor = { userId: "owner", appId: null }, provider = { appId: "independent.runner", installationId: "one", key: "default" };
const resume = vi.fn();
const command = () => ({ requestId: randomUUID(), title: "Build an app", markdown: "Implement and verify the described app.", resources: [], selectionRevision: 0, contextRevision: 0, autonomyRevision: 0 });
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "task-adoptions-")); store = new TaskStore(dir, provider); loseReply = false; resume.mockReset();
  const policies = new TaskPolicies(store);
  store.afterCreate = (state, task) => { if (task.assignee?.kind === "app") policies.ensure(state, task, task.assignee.executor); };
  store.beforeAttempt = (state, task) => policies.attempt(state, task);
  session = { id: "original-chat", createdBy: "owner", harnessSessionId: "original-native-context", harnessKind: "codex", autonomy: "normal",
    title: "Original chat", context: null, lastEventSeq: 4, status: "running", appIds: [], instructionSnapshot: "Existing instructions", skillIds: [], createdAt: "now", updatedAt: "now",
    workerRun: { id: "original-run", sequence: 4 } } as SessionRecord;
  const core = async (_session: string, action: string, input: Record<string, unknown>) => {
    if (action === "task-create") {
      const root = await store.create(actor, input as unknown as TaskCreate);
      if (loseReply) { loseReply = false; throw new Error("Reply lost after root creation"); } return root;
    }
    if (action === "task-edit") return store.edit(String(input.taskId), actor, input as unknown as TaskEdit);
    return store.action(String(input.taskId), actor, input as never);
  };
  manager = { getSession: async () => structuredClone(session), invokeCoreTask: core,
    armTaskBarrier: async (_session: string, owner: string, id: string) => {
      session.taskBarrier ??= { id, owner, generation: 1, kind: "task_adoption", state: "armed", runId: session.workerRun!.id,
        snapshot: decisionSnapshot(session), commandId: randomUUID() };
      return `hosty_task_barrier:${id}:1`;
    },
    advanceTaskBarrier: async () => {},
    resumeTaskBarrier: async (...args: unknown[]) => { resume(...args); session.taskBarrier!.state = "resuming"; },
    serialize: async (_id: string, fn: () => Promise<unknown>) => fn(), requireLive: async () => ({ record: session }),
    store: { saveRecord: vi.fn(async () => {}) },
  } as unknown as SessionManager;
  adoptions = new TaskAdoptions(store, manager, (task, requestId) => store.action(task.ref.id, actor, { requestId, expectedRevision: task.revision, action: "ready" }));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function adopted(id: string) { return (await store.readJournal<TaskAdoption>("adoption:" + id))!; }
async function bind(id: string) {
  const config = (await store.readJournal<TaskConfiguration>("configuration:" + id))!, value = await adopted(id);
  const root = (await store.get(value.root!.ref.id, actor))!;
  const input = root.attempts[0]!.request as TaskExecutionInput;
  return SessionManager.prototype.adoptTaskSession.call(manager, config, input, root.attempts[0]!.executionId, "owner");
}
function park() { session.taskBarrier!.state = "parked"; session.taskBarrier!.nativeSessionId = session.harnessSessionId!; delete session.workerRun; }
it("recovers a lost root-create reply and repeated adoption without duplicate roots or autonomous work", async () => {
  const input = command(); loseReply = true;
  await expect(adoptions.adopt(session.id, input)).rejects.toThrow("Reply lost");
  const result = await adoptions.adopt(session.id, input);
  expect(result).toMatchObject({ state: "awaiting_consent" });
  await adoptions.adopt(session.id, input); await adoptions.reconcile();
  expect(await store.all()).toHaveLength(1); expect((await store.all())[0]!.attempts).toHaveLength(0);
  expect(session.autonomy).toBe("normal"); expect(resume).not.toHaveBeenCalled();
  expect(await adoptions.projections("another-owner")).toEqual([]);
});
it("applies owner consent only at the original parked checkpoint and keeps the profile-free session", async () => {
  const input = command(); await adoptions.adopt(session.id, input);
  const value = await adopted(input.requestId), answer = { requestId: randomUUID(), expectedRevision: value.revision, choice: "approve" as const };
  await expect(adoptions.consent(value.id, "another-owner", answer, "credential")).rejects.toMatchObject({ code: "task_not_found" });
  await adoptions.consent(value.id, "owner", answer, "credential");
  expect(session.autonomy).toBe("normal"); expect((await store.all())[0]!.attempts).toHaveLength(0);
  park(); await adoptions.reconcile(); expect(await bind(value.id)).toBe(true); expect(await bind(value.id)).toBe(true);
  expect(session.autonomy).toBe("autonomous"); expect(session.autonomyRevision).toBe(1);
  expect(session.id).toBe("original-chat"); expect(session.harnessSessionId).toBe("original-native-context");
  expect(session.agentProfile).toBeUndefined(); expect(session.taskContext?.executor.name).toBe("Chat configuration");
  expect(session.taskBarrier!.snapshot).toBe(decisionSnapshot(session));
  await adoptions.consent(value.id, "owner", answer, "credential");
  expect((await store.all())[0]!.attempts).toHaveLength(1);
});
it("rejects stale consent and a manual mode reversal after approval", async () => {
  const input = command(); await adoptions.adopt(session.id, input);
  let value = await adopted(input.requestId);
  session.selectionRevision = 1;
  await expect(adoptions.consent(value.id, "owner", { requestId: randomUUID(), expectedRevision: value.revision, choice: "approve" }, "credential")).rejects.toMatchObject({ code: "stale_input" });
  session.selectionRevision = 0;
  await adoptions.consent(value.id, "owner", { requestId: randomUUID(), expectedRevision: value.revision, choice: "approve" }, "credential");
  park(); await adoptions.reconcile(); session.autonomyRevision = 2; session.autonomy = "normal";
  await expect(bind(value.id)).rejects.toMatchObject({ code: "stale_input" });
  expect(session.taskExecutionId).toBeUndefined(); expect(session.autonomy).toBe("normal");
});
it("leaves a declined root unstarted and reuses it for a fresh proposal", async () => {
  const input = command(); await adoptions.adopt(session.id, input); const value = await adopted(input.requestId);
  await adoptions.consent(value.id, "owner", { requestId: randomUUID(), expectedRevision: value.revision, choice: "decline" }, "credential");
  park(); await adoptions.reconcile(); await adoptions.reconcile();
  expect(resume).toHaveBeenCalledTimes(1); expect(session.autonomy).toBe("normal");
  session.workerRun = { id: "continued-chat", sequence: 1 };
  const again = command(); await adoptions.adopt(session.id, again);
  expect(await store.all()).toHaveLength(1);
  expect((await adopted(again.requestId)).root!.ref).toEqual(value.root!.ref);
  expect((await store.all())[0]!.attempts).toHaveLength(0);
  // An old declined proposal must never resume a new proposal's checkpoint.
  session.taskBarrier = { ...session.taskBarrier!, id: again.requestId, state: "parked" };
  await adoptions.reconcile();
  expect(resume).toHaveBeenCalledTimes(1);
  expect(session.taskBarrier.state).toBe("parked");
  expect((await adopted(again.requestId)).state).toBe("awaiting_consent");
});
it("does not ask again when the conversation already runs autonomously", async () => {
  session.autonomy = "autonomous"; const input = command(); await adoptions.adopt(session.id, input);
  expect(await adoptions.projections("owner")).toEqual([]);
  expect((await store.all())[0]!.attempts).toHaveLength(0);
  park(); await adoptions.reconcile(); await bind(input.requestId); expect(session.autonomyRevision).toBe(0);
});

it("adopts and starts a new root while retaining pre-tree version-one records", async () => {
  const legacy = { ref: { ...provider, id: randomUUID() }, number: "HRN-1", title: "Old task", status: "Draft" };
  await mkdir(path.join(dir, "tasks"), { recursive: true });
  await writeFile(path.join(dir, "tasks/tasks.json"), JSON.stringify({ version: 1, next: 2, tasks: [legacy], requests: [] }));
  const input = command();
  await adoptions.adopt(session.id, input);
  let value = await adopted(input.requestId);
  expect(value.root!.number).toBe("HRN-2");
  await store.action(value.root!.ref.id, actor, { requestId: randomUUID(), expectedRevision: value.root!.revision, action: "ready" });
  const root = (await store.all())[0]!;
  expect(root.attempts).toHaveLength(1);
  const policy = await new TaskPolicies(store).get(root.ref.id, "owner");
  expect(policy.descendantCount).toBe(0);
  const saved = JSON.parse(await readFile(path.join(dir, "tasks/tasks.json"), "utf8"));
  expect(saved.legacyTasks).toEqual([legacy]);
  expect(saved.tasks).toHaveLength(1);
  const reloaded = new TaskStore(dir, provider);
  expect(await reloaded.all()).toHaveLength(1);
  await reloaded.writeJournal("test-reload", true);
  expect(JSON.parse(await readFile(path.join(dir, "tasks/tasks.json"), "utf8")).legacyTasks).toEqual([legacy]);
});
