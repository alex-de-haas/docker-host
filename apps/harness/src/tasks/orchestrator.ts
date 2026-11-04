import { writeScope } from "./writers.js";
import { randomUUID } from "node:crypto";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import type { TaskDispatchRef, TaskWorkflowBinding, TaskWorkflowRequest } from "@hosty-sdk/app/providers";
import type { TaskAction, TaskCreate, TaskRecord, TaskRef, TaskSelection } from "@hosty-sdk/app/tasks";
import type { SessionManager } from "../sessions/manager.js";
import type { HarnessTaskExecutor } from "./executor.js";
import type { TaskPolicies } from "./policy.js";
import { TaskStore, activeAttempt, fingerprint, selection, taskError, taskRef, uuid } from "./store.js";
import { assertTaskCoordinator } from "./workflow.js";

type Bound = { binding: TaskWorkflowBinding; task: TaskRecord; sessionId: string; owner: string };
type Delegation = {
  id: string; hash: string; context: Bound; create: TaskCreate; readyId: string;
  state: "creating" | "arming" | "armed"; task?: TaskRecord; error?: string;
  rationale: string; writeScope?: unknown;
};
export type ChildEvent = { id: string; parentTaskRef: TaskRef; taskRef: TaskRef; rootGeneration: number; taskRevision: number;
  resultRevision: number; receiptRevision: number; resultRef?: TaskRecord["resultRef"]; status: string; summary: string; delivered: boolean };
type Wait = {
  id: string; hash: string; context: Bound; generation: number; mode: "any" | "all"; children: TaskRef[];
  observed: Array<{ taskRef: TaskRef; resultRevision: number; receiptRevision: number }>;
  state: "registered" | "parked" | "resuming" | "resumed" | "ready" | "cancelled"; events: ChildEvent[]; prompt?: string; error?: string;
};
type Plan = { revision: number; markdown: string; updatedAt: string; executionId: string };
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : taskError("invalid_input", "Supply an object.", 400);

/** Durable local orchestration; Core remains the authority for each outgoing task operation. */
export class TaskOrchestrator {
  private readonly delegations = new Map<string, Promise<TaskRecord>>();
  beforeResume?: (sessionId: string) => Promise<boolean>;
  async reserveContinuation(sessionId: string) { const context = await this.context(sessionId); return this.policies.reserve(context.task.ref.id, context.binding.parentExecutionId); }
  constructor(private readonly store: TaskStore, private readonly manager: SessionManager, private readonly executor: HarnessTaskExecutor,
    private readonly policies: TaskPolicies, private readonly call: <T>(input: TaskWorkflowRequest) => Promise<T> = input => new ProviderClient().taskWorkflow(input)) {}

  async context(sessionId: string): Promise<Bound> {
    const session = await this.manager.getSession(sessionId);
    if (!session?.taskContext || !session.taskExecutionId) return taskError("root_task_required", "Adopt a root task before delegating work from chat.");
    const task = await this.store.get(session.taskContext.taskRef.id, { userId: session.createdBy, appId: null });
    const rootDispatch = await this.store.dispatch(task.rootTaskRef.id), coordinator = task.coordination;
    if (!rootDispatch || !coordinator || coordinator.executionId !== session.taskExecutionId)
      return taskError("workflow_authority_required", "This task needs its retained Core root execution authorization.");
    const binding: TaskWorkflowBinding = { rootDispatch, rootTaskRef: task.rootTaskRef, parentTaskRef: task.ref,
      parentExecutionId: session.taskExecutionId, coordinatorEpoch: coordinator.coordinatorEpoch, rootGeneration: coordinator.rootGeneration };
    await this.store.transaction(s => assertTaskCoordinator(this.store, s, binding, session.createdBy));
    return { binding, task, sessionId, owner: session.createdBy };
  }
  private async send<T>(context: Bound, operation: TaskWorkflowRequest["operation"], requestId: string, payload: Record<string, unknown>) {
    await this.manager.authorizeTaskWorkflow?.(context.sessionId, operation, payload);
    return this.call<T>({ ...context.binding, operation, requestId, payload });
  }
  async bindNative(taskId: string, executionId: string, sessionId: string, dispatch?: TaskDispatchRef): Promise<void> {
    if (!dispatch) return;
    const context = await this.context(sessionId);
    if (context.task.ref.id !== taskId || context.binding.parentExecutionId !== executionId) return taskError("stale_input", "Native admission changed.");
    // Deterministic session command identity is retained before the external call.
    const key = "native-task-binding:" + executionId;
    const request = await this.store.transaction(s => {
      assertTaskCoordinator(this.store, s, context.binding, context.owner);
      const previous = s.journal?.[key] as { requestId: string; sessionId: string; applied: boolean } | undefined;
      if (previous) { if (previous.sessionId !== sessionId) return taskError("session_task_conflict", "The attempt already owns another native session."); return previous; }
      const intent = { requestId: randomUUID(), sessionId, applied: false }; (s.journal ??= {})[key] = intent; return intent;
    });
    // Revalidate even after a successful binding; service identity alone is not execution authority.
    await this.send(context, "bind_session", request.requestId, { sessionId });
    await this.manager.bindTaskDispatch(sessionId, executionId, dispatch);
    await this.store.writeJournal(key, { ...request, applied: true });
  }
  async prepare(sessionId: string, input: Record<string, unknown>) {
    const context = await this.context(sessionId), parent = (await this.manager.getSession(sessionId))!;
    await this.send(context, "observe", uuid(input.requestId), {});
    if (input.option !== undefined) {
      const choice = selection({ kind: "option", ...object(input.option) }), directory = await this.executor.options();
      const option = directory.options.find(o => o.id === choice.id && o.revision === choice.revision);
      if (input.directoryRevision !== directory.revision || !option) return taskError("stale_input", "Read the current executor directory before choosing a saved profile.");
      if (Object.keys(input).some(k => !["requestId", "directoryRevision", "option"].includes(k))) return taskError("invalid_input", "Saved profiles retain their own instructions, skills and model.", 400);
      return { selection: choice, name: option.name, provenance: "saved_profile" };
    }
    const configuration = await this.executor.configurations.prepare({ owner: context.owner, rootTaskRef: context.task.rootTaskRef,
      parentTaskRef: context.task.ref, parentExecutionId: context.binding.parentExecutionId, parentSessionId: sessionId,
      generation: context.binding.rootGeneration, coordinatorEpoch: context.binding.coordinatorEpoch }, parent, input);
    return { selection: configuration.selection, name: configuration.name, rationale: configuration.rationale, provenance: "task_specific" };
  }
  async delegate(sessionId: string, input: Record<string, unknown>) {
    const context = await this.context(sessionId), id = uuid(input.requestId), hash = fingerprint({ sessionId, input });
    const chosen = selection(input.selection), scope = writeScope(input.writeScope);
    if (typeof input.rationale !== "string" || !input.rationale.trim() || input.rationale.length > 2000)
      return taskError("invalid_input", "Explain why this executor fits the child task.", 400);
    const intent = await this.store.transaction(s => {
      const existing = s.journal?.["delegation:" + id] as Delegation | undefined;
      if (existing) { if (existing.hash !== hash || existing.context.owner !== context.owner) return taskError("request_conflict", "Recover the original delegation request."); return existing; }
      assertTaskCoordinator(this.store, s, context.binding, context.owner);
      const create: TaskCreate = { requestId: id, expectedGraphRevision: Number(input.expectedGraphRevision), input: {
        title: input.title as string, markdown: input.markdown as string, resources: input.resources as TaskRecord["resources"],
        review: { mode: "delegator" }, parentTaskRef: context.task.ref, dependsOn: (input.dependsOn ?? []) as TaskRef[],
        assignee: { kind: "app", executor: this.store.provider, selection: chosen },
      } };
      const value: Delegation = { id, hash, context, create, readyId: randomUUID(), state: "creating", rationale: input.rationale as string, writeScope: scope };
      (s.journal ??= {})["delegation:" + id] = value; return value;
    });
    return this.advanceDelegation(intent);
  }
  private advanceDelegation(intent: Delegation): Promise<TaskRecord> {
    const pending = this.delegations.get(intent.id);
    if (pending) return pending;
    const work = this.advanceDelegationLocked(intent).finally(() => { this.delegations.delete(intent.id); });
    this.delegations.set(intent.id, work);
    return work;
  }
  private async advanceDelegationLocked(intent: Delegation): Promise<TaskRecord> {
    if (intent.state === "armed") return this.store.get(intent.task!.ref.id, { userId: intent.context.owner, appId: null });
    if (intent.state === "creating") {
      intent.task = await this.send<TaskRecord>(intent.context, "create_child", intent.id, intent.create as unknown as Record<string, unknown>);
      await this.store.writeJournal("write-scope:" + intent.task.ref.id, intent.writeScope ?? { mode: "exclusive", paths: [] });
      intent.state = "arming"; delete intent.error; await this.store.writeJournal("delegation:" + intent.id, intent);
    }
    const task = await this.send<TaskRecord>(intent.context, "action", intent.readyId, { taskRef: intent.task!.ref,
      input: { requestId: intent.readyId, expectedRevision: intent.task!.revision, action: "ready" } });
    intent.task = task; intent.state = "armed"; delete intent.error; await this.store.writeJournal("delegation:" + intent.id, intent); return task;
  }
  async plan(sessionId: string, input: Record<string, unknown>) {
    const context = await this.context(sessionId); await this.send(context, "observe", uuid(input.requestId), {});
    if (typeof input.markdown !== "string" || !input.markdown.trim() || input.markdown.length > 32000) return taskError("invalid_input", "Use a nonempty execution plan of at most 32,000 characters.", 400);
    return this.store.transaction(s => {
      assertTaskCoordinator(this.store, s, context.binding, context.owner);
      const key = "plan:" + context.task.rootTaskRef.id, requestKey = "plan-request:" + context.owner + ":" + input.requestId;
      const hash = fingerprint(input), prior = s.journal?.[requestKey] as { hash: string; result: Plan } | undefined;
      if (prior) { if (prior.hash !== hash) return taskError("request_conflict", "Recover the original plan update."); return prior.result; }
      const plan = s.journal?.[key] as Plan | undefined;
      if (input.expectedRevision !== (plan?.revision ?? 0)) return taskError("revision_conflict", "Reload the execution plan before changing it.");
      const next = { revision: (plan?.revision ?? 0) + 1, markdown: input.markdown as string, updatedAt: new Date().toISOString(), executionId: context.binding.parentExecutionId };
      (s.journal ??= {})[key] = next; s.journal[requestKey] = { hash, result: next }; return next;
    });
  }
  private relevant(wait: Wait, events: ChildEvent[]) {
    const current = new Map<string, ChildEvent>();
    for (const event of events) if (wait.children.some(c => fingerprint(c) === fingerprint(event.taskRef)) && event.rootGeneration === wait.context.binding.rootGeneration
      && !wait.observed.some(o => o.taskRef.id === event.taskRef.id && o.resultRevision >= event.resultRevision && o.receiptRevision >= event.receiptRevision)) {
      const prior = current.get(event.taskRef.id);
      if (!prior || event.taskRevision >= prior.taskRevision) current.set(event.taskRef.id, event);
    }
    return [...current.values()];
  }
  private ready(wait: Wait, events: ChildEvent[]) {
    return events.length > 0 && (wait.mode === "any" || events.some(e => ["Cancelled", "execution_failed", "executor_unavailable", "needs_input", "prerequisite_changed"].includes(e.status))
      || wait.children.every(ref => events.some(e => e.taskRef.id === ref.id)));
  }
  async wait(sessionId: string, input: Record<string, unknown>) {
    const context = await this.context(sessionId), id = uuid(input.requestId), hash = fingerprint({ sessionId, input });
    await this.send(context, "observe", id, {});
    if (!Array.isArray(input.children) || !input.children.length || input.children.length > 100 || !["any", "all"].includes(String(input.mode)))
      return taskError("invalid_input", "Wait for one or more direct children in any/all mode.", 400);
    const children = input.children.map(taskRef), observed = (input.observed ?? []) as Wait["observed"];
    if (!Array.isArray(observed) || observed.some(o => !Number.isSafeInteger(o.resultRevision) || o.resultRevision < 0 || !Number.isSafeInteger(o.receiptRevision) || o.receiptRevision < 0))
      return taskError("invalid_input", "Supply the child result and receipt revisions already observed.", 400);
    await this.deliverEvents();
    const wait = await this.store.transaction(s => {
      const existing = s.journal?.["wait:" + id] as Wait | undefined;
      if (existing) { if (existing.hash !== hash || existing.context.owner !== context.owner) return taskError("request_conflict", "Recover the original wait."); return existing; }
      assertTaskCoordinator(this.store, s, context.binding, context.owner);
      for (const ref of children) {
        const child = this.store.find(s, ref.id);
        if (fingerprint(ref) !== fingerprint(child.ref) || child.parentTaskRef?.id !== context.task.ref.id) return taskError("permission_denied", "Wait only for direct children in this tree.", 403);
      }
      const waits = Object.entries(s.journal ?? {}).filter(([key]) => key.startsWith("wait:")).map(([, value]) => value as Wait)
        .filter(w => w.context.task.ref.id === context.task.ref.id);
      for (const previous of waits) if (["registered", "parked", "resuming"].includes(previous.state)
        && previous.context.binding.parentExecutionId !== context.binding.parentExecutionId) previous.state = "cancelled";
      if (waits.some(w => ["registered", "parked", "resuming"].includes(w.state))) return taskError("wait_pending", "Recover this parent's current wait before creating another.");
      const value: Wait = { id, hash, context, generation: waits.length + 1, mode: input.mode as "any" | "all", children, observed, state: "registered", events: [] };
      value.events = this.relevant(value, s.journal?.["inbox:" + context.task.ref.id] as ChildEvent[] ?? []);
      if (this.ready(value, value.events)) value.state = "ready";
      (s.journal ??= {})["wait:" + id] = value; return value;
    });
    if (wait.state === "ready" || wait.state === "resumed") return { waitId: id, state: "ready", events: wait.events.slice(0, 20) };
    const barrier = await this.manager.armTaskBarrier(sessionId, context.owner, id, "child_wait", wait.generation);
    return { barrier, waitId: id, state: "pending", instruction: "Yield this turn. The same native context resumes after relevant child results; do not poll or launch another manager." };
  }
  private deliverEvents(): Promise<void> {
    return this.store.transaction(s => {
      for (const [key, value] of Object.entries(s.journal ?? {})) {
        if (!key.startsWith("child-outbox:")) continue;
        const event = value as ChildEvent; if (event.delivered) continue;
        const inbox = (s.journal!["inbox:" + event.parentTaskRef.id] ??= []) as ChildEvent[];
        if (!inbox.some(e => e.id === event.id)) inbox.push({ ...event, delivered: true });
        event.delivered = true;
      }
    });
  }
  async reconcile(): Promise<void> {
    await this.deliverEvents();
    for (const [, delegation] of await this.store.journalEntries<Delegation>("delegation:")) {
      if (delegation.state === "armed") continue;
      try { await this.advanceDelegation(delegation); }
      catch (error) { const message = error instanceof Error ? error.message : "Delegation needs recovery."; if (delegation.error !== message) { delegation.error = message; await this.store.writeJournal("delegation:" + delegation.id, delegation); } }
    }
    for (const [, wait] of await this.store.journalEntries<Wait>("wait:")) {
      if (!["registered", "parked", "resuming"].includes(wait.state)) continue;
      try {
        await this.store.transaction(s => assertTaskCoordinator(this.store, s, wait.context.binding, wait.context.owner));
        const session = await this.manager.getSession(wait.context.sessionId);
        if (!session) return taskError("session_missing", "The waiting coordinator's session is unavailable.");
        if (!session.taskBarrier) continue; // Tool request has not armed its boundary yet.
        await this.manager.advanceTaskBarrier(session.id);
        const parked = await this.manager.getSession(session.id);
        if (parked?.taskBarrier?.state !== "parked" && wait.state !== "resuming") continue;
        wait.state = wait.state === "resuming" ? "resuming" : "parked";
        wait.events = this.relevant(wait, await this.store.readJournal<ChildEvent[]>("inbox:" + wait.context.task.ref.id) ?? []);
        if (!this.ready(wait, wait.events)) { if (fingerprint(wait) !== fingerprint(await this.store.readJournal("wait:" + wait.id))) await this.store.writeJournal("wait:" + wait.id, wait); continue; }
        await this.send(wait.context, "observe", wait.id, {});
        if (this.beforeResume && !await this.beforeResume(session.id)) continue;
        if (!await this.policies.reserve(wait.context.task.ref.id, wait.context.binding.parentExecutionId)) continue;
        wait.state = "resuming";
        wait.prompt ??= "Continue the same task after its child wait. Review exact result refs before acceptance; use task_get for full evidence.\n" + JSON.stringify({ events: wait.events.slice(0, 20), totalEvents: wait.events.length,
          remainingEvents: Math.max(0, wait.events.length - 20), instruction: "Read task_execution_get pages from cursor 0 for all current task outcomes." });
        await this.store.writeJournal("wait:" + wait.id, wait);
        await this.manager.resumeTaskBarrier(session.id, wait.context.owner, wait.prompt);
        wait.state = "resumed"; delete wait.error; await this.store.writeJournal("wait:" + wait.id, wait);
      } catch (error) {
        if ((error as { code?: string }).code === "stale_input") wait.state = "cancelled";
        const message = error instanceof Error ? error.message : "Continuation needs recovery.";
        if (wait.error !== message) { wait.error = message; await this.store.writeJournal("wait:" + wait.id, wait); }
      }
    }
  }
  async sourceSummary(rootId: string) {
    const source = await this.store.readJournal<import("./sources.js").ExecutionSourceContext>("source:" + rootId);
    return source ? { id: source.id, revision: source.revision, workspaceId: source.workspaceId,
      operation: source.operation ? { id: source.operation.id, state: source.operation.state, error: source.operation.error } : null,
      associations: Object.values(source.associations).map(a => ({ taskRef: a.taskRef, executionId: a.executionId, sessionId: a.sessionId, state: a.state, error: a.error })) } : null;
  }
  async summary(sessionId: string, input: Record<string, unknown>) {
    const context = await this.context(sessionId); await this.send(context, "observe", randomUUID(), {});
    const cursor = Number(input.cursor ?? 0), limit = Number(input.limit ?? 50);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return taskError("invalid_input", "Use a bounded page size and cursor.", 400);
    const rows = (await this.store.all()).filter(t => t.rootTaskRef.id === context.task.rootTaskRef.id && t.owner.userId === context.owner);
    return { task: context.task, root: await this.policies.get(context.task.rootTaskRef.id, context.owner),
      plan: await this.store.readJournal<Plan>("plan:" + context.task.rootTaskRef.id),
      source: await this.sourceSummary(context.task.rootTaskRef.id),
      tasks: rows.slice(cursor, cursor + limit), nextCursor: cursor + limit < rows.length ? String(cursor + limit) : null };
  }
  async action(sessionId: string, input: Record<string, unknown>) {
    const context = await this.context(sessionId), { taskId, ...action } = input;
    return this.send<TaskRecord>(context, "action", uuid(action.requestId), { taskRef: { ...this.store.provider, id: uuid(taskId) }, input: action as unknown as TaskAction });
  }
  async edit(sessionId: string, input: Record<string, unknown>) {
    const context = await this.context(sessionId), { taskId, ...edit } = input;
    return this.send<TaskRecord>(context, "edit", uuid(edit.requestId), { taskRef: { ...this.store.provider, id: uuid(taskId) }, input: edit });
  }
  async create(sessionId: string, input: Record<string, unknown>) {
    const context = await this.context(sessionId);
    return this.send<TaskRecord>(context, "create_child", uuid(input.requestId), input);
  }
  async get(sessionId: string, taskId: unknown) {
    const context = await this.context(sessionId);
    return this.send<TaskRecord>(context, "read", randomUUID(), { taskRef: { ...this.store.provider, id: uuid(taskId) } });
  }
}
