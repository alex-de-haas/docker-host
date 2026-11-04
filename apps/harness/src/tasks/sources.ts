import { randomUUID } from "node:crypto";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import type { TaskSourceReference, TaskWorkflowRequest, TaskWorkspaceRequest } from "@hosty-sdk/app/providers";
import type { TaskExecutionInput, TaskRecord, TaskRef } from "@hosty-sdk/app/tasks";
import type { SessionManager } from "../sessions/manager.js";
import type { SessionRecord } from "../sessions/store.js";
import type { WorkspaceParticipation } from "../sessions/development.js";
import type { TaskOrchestrator } from "./orchestrator.js";
import type { ExecutionAuthority } from "./executor.js";
import { TaskWriters } from "./writers.js";
import { TaskStore, fingerprint, taskError, uuid, type TaskState } from "./store.js";

type Association = { sessionId: string; taskRef: TaskRef; executionId: string; state: "pending" | "attached" | "detached" | "unavailable";
  request?: TaskWorkspaceRequest; error?: string };
type SourceIntent = { id: string; hash: string; sessionId: string; owner: string; command: TaskWorkflowRequest;
  state: "boundary" | "selecting" | "associating" | "resuming" | "applied"; error?: string; participants?: Record<string, { id: string; owner: string; resumed?: boolean }> };
export type ExecutionSourceContext = { id: string; rootTaskRef: TaskRef; revision: number; workspaceId: string | null;
  reference?: TaskSourceReference; operation?: SourceIntent; associations: Record<string, Association> };
type View = { association: { workspace: WorkspaceParticipation }; sources: { workspaces: import("../sessions/development.js").DevelopmentWorkspace[] } };

export class TaskSources {
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> { const work = this.queue.then(fn); this.queue = work.catch(() => {}); return work; }
  bind(sessionId: string, input: Record<string, unknown>) { return this.serial(() => this.bindLocked(sessionId, input)); }
  reconcile() { return this.serial(() => this.reconcileLocked()); }
  readonly writers: TaskWriters;
  capacityAvailable?: () => Promise<boolean>;
  admit?: (state: TaskState, taskId: string, executionId: string) => boolean;
  constructor(private readonly store: TaskStore, private readonly manager: SessionManager, private readonly orchestration: TaskOrchestrator,
    private readonly workflow: <T>(input: TaskWorkflowRequest) => Promise<T> = input => new ProviderClient().taskWorkflow(input),
    private readonly workspace: <T>(input: TaskWorkspaceRequest) => Promise<T> = <T>(input: TaskWorkspaceRequest) => new ProviderClient().taskWorkspace(input) as Promise<T>) { this.writers = new TaskWriters(store); }
  async projections(owner: string) {
    const rows = [];
    for (const [, context] of await this.store.journalEntries<ExecutionSourceContext>("source:")) {
      const operation = context.operation;
      if (!operation || operation.owner !== owner || operation.state === "applied" || !operation.error) continue;
      const root = await this.store.get(context.rootTaskRef.id, { userId: owner, appId: null });
      if (["Done", "Cancelled"].includes(root.status)) continue;
      rows.push({ id: "task-source:" + operation.id, kind: "recovery" as const, sessionId: operation.sessionId,
        title: root.title, createdAt: root.updatedAt, available: false, error: operation.error });
    }
    return rows;
  }
  context(rootId: string) { return this.store.readJournal<ExecutionSourceContext>("source:" + rootId); }
  private async bindLocked(sessionId: string, input: Record<string, unknown>) {
    const parent = await this.orchestration.context(sessionId), id = uuid(input.requestId), hash = fingerprint({ sessionId, input });
    if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0 || (!!input.workspaceId === !!input.prepare))
      return taskError("source_invalid", "Select an existing workspace or prepare one repository at the current source revision.", 400);
    const context = await this.store.transaction(s => {
      const key = "source:" + parent.task.rootTaskRef.id;
      const current = s.journal?.[key] as ExecutionSourceContext | undefined;
      const replay = s.journal?.["source-request:" + id] as { hash: string; rootId: string } | undefined;
      if (replay) { if (replay.hash !== hash || replay.rootId !== parent.task.rootTaskRef.id) return taskError("request_conflict", "Recover the original source request."); return current!; }
      if (input.expectedRevision !== (current?.revision ?? 0)) return taskError("revision_conflict", "Read the current source context before binding.");
      if (current?.operation && current.operation.state !== "applied") return taskError("source_pending", "Recover the root's current source operation.");
      const next: ExecutionSourceContext = current ?? { id: randomUUID(), rootTaskRef: parent.task.rootTaskRef, revision: 0, workspaceId: null, associations: {} };
      const prepare = input.prepare as { appId: string; name: string; targetBranch?: string } | undefined;
      if (prepare && (Object.keys(prepare).some(k => !["appId", "name", "targetBranch"].includes(k)) || !prepare.appId || !prepare.name))
        return taskError("source_invalid", "Use a known source application, workspace name and optional target branch.", 400);
      next.operation = { id, hash, sessionId, owner: parent.owner, state: "boundary", command: { ...parent.binding,
        operation: prepare ? "prepare_source" : "bind_source", requestId: id, payload: { contextId: next.id, expectedRevision: next.revision, sessionId,
          ...(prepare ? { prepare: { ...prepare, requestId: id, sessionId, sessionPath: `/assistant?session=${encodeURIComponent(sessionId)}` } } : { workspaceId: input.workspaceId }) } } };
      (s.journal ??= {})[key] = next; s.journal["source-request:" + id] = { hash, rootId: next.rootTaskRef.id }; return next;
    });
    if (context.operation?.id !== id || context.operation.state === "applied") return { state: "applied", source: context };
    const barrier = await this.manager.armTaskBarrier(sessionId, parent.owner, id, "source_rebind");
    return { state: "pending", barrier, contextId: context.id, instruction: "Yield this turn. The same session resumes after source binding and association are confirmed." };
  }
  async beforeLaunch(input: TaskExecutionInput, executionId: string, sessionId: string, authority: ExecutionAuthority): Promise<boolean> {
    if (this.capacityAvailable && !await this.capacityAvailable()) return false;
    let context = await this.context(input.relations.rootTaskRef.id);
    const record = await this.manager.getSession(sessionId);
    const binding = authority.taskDispatch ? (await this.orchestration.context(sessionId)).binding : undefined;
    // Recover an uncertain source selection before replacing its coordinator. Observe under
    // the new exact attempt; never replay an old mutation with changed request arguments.
    if (binding && !input.relations.parentTaskRef && context?.operation
      && context.operation.command.parentExecutionId !== executionId && context.operation.state !== "applied") {
      const recovered = await this.workflow<TaskSourceReference | null>({ ...binding, operation: "observe_source", requestId: randomUUID(), payload: {} });
      context.reference = recovered ?? undefined; context.workspaceId = recovered?.workspaceId ?? null;
      context.revision = recovered?.contextRevision ?? 0;
      context.operation.state = "resuming";
      await this.store.writeJournal("source:" + input.relations.rootTaskRef.id, context);
    }
    const inherited = context?.workspaceId ?? (!input.relations.parentTaskRef ? record?.workspaceAssociation?.id : undefined);
    if (binding && inherited && (!context?.reference || fingerprint(context.reference.rootDispatch) !== fingerprint(binding.rootDispatch))) {
      const key = "source-authority:" + executionId;
      let command = await this.store.readJournal<TaskWorkflowRequest>(key);
      if (!command) {
        command = { ...binding, operation: "bind_source", requestId: randomUUID(), payload: { contextId: context?.id ?? randomUUID(),
          expectedRevision: context?.revision ?? 0, sessionId, workspaceId: inherited } };
        await this.store.writeJournal(key, command);
      }
      await this.manager.authorizeTaskWorkflow?.(sessionId, command.operation, command.payload);
      const reference = await this.workflow<TaskSourceReference>(command);
      context = { ...context, id: reference.contextId, rootTaskRef: input.relations.rootTaskRef, reference,
        workspaceId: reference.workspaceId, revision: reference.contextRevision, associations: context?.associations ?? {} };
      await this.store.writeJournal("source:" + input.relations.rootTaskRef.id, context);
    }
    if (!context) return this.admit ? this.store.transaction(s => this.admit!(s, input.taskRef.id, executionId)) : true;
    if (context.operation && !["applied", "resuming"].includes(context.operation.state)) return false;
    if (!context.workspaceId) return this.admit ? this.store.transaction(s => this.admit!(s, input.taskRef.id, executionId)) : true;
    if (!context.reference || !authority.taskDispatch) return taskError("source_authority_missing", "Recover the retained source binding before admission.");
    await this.manager.prepareTaskWorkspace(sessionId, authority.taskDispatch, executionId, context.reference.workspaceId, context.reference);
    const session = (await this.manager.getSession(sessionId))!;
    return this.writers.reserve(input.relations.rootTaskRef.id, input.taskRef.id, executionId, context.reference.workspaceId, session.developmentWorkspaces ?? [], this.admit ? state => this.admit!(state, input.taskRef.id, executionId) : undefined);
  }
  async beforeResume(sessionId: string): Promise<boolean> {
    const session = await this.manager.getSession(sessionId);
    if (!session?.taskContext || !session.taskExecutionId) return false;
    const task = await this.store.get(session.taskContext.taskRef.id, { userId: session.createdBy, appId: null });
    const attempt = task.attempts.find(a => a.executionId === session.taskExecutionId), dispatch = await this.store.dispatch(task.ref.id);
    if (!attempt || !dispatch) return false;
    if (session.autonomy !== "autonomous") return false;
    const admitted = await this.beforeLaunch(attempt.request, attempt.executionId, sessionId, { taskDispatch: dispatch, actor: task.owner, scope: "", validate: async () => {} });
    if (admitted && session.taskBarrier?.state === "parked" && (await this.manager.getSession(sessionId))?.taskWorkspace)
      await this.manager.finishTaskSourceBoundary(sessionId, session.createdBy, session.taskBarrier.id);
    return admitted;
  }
  private async associate(context: ExecutionSourceContext, task: TaskRecord, executionId: string, sessionId: string): Promise<void> {
    const session = await this.manager.getSession(sessionId), key = executionId;
    const association = context.associations[key] ??= { sessionId, taskRef: task.ref, executionId, state: "pending" };
    if (!session || session.createdBy !== task.owner.userId) { association.state = "unavailable"; association.error = "The retained conversation is unavailable."; return; }
    if (association.state === "detached" || association.state === "attached") return;
    const base: TaskWorkspaceRequest = { kind: "history_observe", source: context.reference!, dispatch: context.reference!.rootDispatch,
      taskRef: task.ref, executionId, sessionId, leaseId: executionId };
    try {
      const observed = await this.workspace<View>(base);
      const existing = observed.association.workspace.sessions.find(row => row.sessionId === sessionId && row.appId === this.store.provider.appId && row.userId === task.owner.userId);
      if (existing && !existing.attached) { association.state = "detached"; association.error = "The user detached this session."; return; }
      if (!existing) {
        association.request ??= { ...base, kind: "associate_history", requestId: randomUUID(), expectedRevision: observed.association.workspace.revision,
          title: session.title ?? task.title, navigationPath: `/assistant?session=${encodeURIComponent(sessionId)}` };
        await this.store.writeJournal("source:" + context.rootTaskRef.id, context);
        await this.workspace(association.request);
      }
      association.state = "attached"; delete association.error;
      await this.manager.recordTaskHistoryAssociation(sessionId, task.owner.userId!, context.reference!.workspaceId, observed.association.workspace.revision);
    } catch (error) {
      association.error = error instanceof Error ? error.message : "Association needs recovery.";
      if ((error as { code?: string }).code === "revision_conflict") delete association.request;
      if ((error as { code?: string }).code === "session_detached") association.state = "detached";
    }
  }
  async summary(workspaceId: string, owner: string, credential: string, cursor = "0", limit = 100) {
    const inventory = await this.manager.workspaceInventory(credential) as { workspaces: Array<{ id: string; participation?: WorkspaceParticipation }> };
    const workspace = inventory.workspaces.find(row => row.id === workspaceId);
    if (!workspace?.participation) return taskError("workspace_unavailable", "This workspace is not available to the current user.", 404);
    const offset = Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return taskError("invalid_input", "Use a bounded cursor and page size.", 400);
    const contexts = (await this.store.journalEntries<ExecutionSourceContext>("source:")).map(([, value]) => value).filter(value => value.workspaceId === workspaceId);
    const tasks = (await this.store.all()).filter(task => task.owner.userId === owner && contexts.some(context => context.rootTaskRef.id === task.rootTaskRef.id));
    const roots = tasks.filter(task => !task.parentTaskRef).map(task => ({ taskRef: task.ref, title: task.title, number: task.number, status: task.status, path: `/tasks?task=${encodeURIComponent(task.ref.id)}` }));
    const rows = [];
    for (const task of tasks) for (const attempt of task.attempts) {
      const ref = attempt.receipt?.sessionRef; if (!ref || fingerprint(attempt.executor) !== fingerprint(this.store.provider)) continue;
      const record = await this.manager.getSession(ref.id);
      const label = await this.store.readJournal<{ owner: string; sessionId: string; kind: "option" | "configuration" | "none"; name: string }>("executor-label:" + attempt.executionId);
      const association = contexts.find(context => context.rootTaskRef.id === task.rootTaskRef.id)?.associations[attempt.executionId];
      const current = workspace.participation.sessions.find(row => row.appId === this.store.provider.appId && row.userId === owner && row.sessionId === ref.id);
      const available = record?.createdBy === owner;
      const associationState = current ? current.attached ? "attached" : "detached" : !available ? "unavailable" : association?.error ? "failed" : "pending";
      const executor = label?.owner === owner && label.sessionId === ref.id ? { kind: label.kind, name: label.name }
        : available && record?.taskContext?.executor ? { kind: record.taskContext.executor.kind, name: record.taskContext.executor.name } : null;
      rows.push({ appId: this.store.provider.appId, installationId: this.store.provider.installationId, ownerId: owner, sessionId: ref.id,
        taskRef: task.ref, executionId: attempt.executionId, rootTaskRef: task.rootTaskRef, executor, title: available ? record.title ?? task.title : task.title,
        status: attempt.receipt?.state ?? "unknown", historyPath: available ? `/assistant?session=${encodeURIComponent(ref.id)}` : null,
        associationState, error: association?.error });
    }
    rows.sort((a, b) => a.executionId.localeCompare(b.executionId));
    return { revision: fingerprint({ contexts: contexts.map(c => [c.id, c.revision]), participation: workspace.participation.revision, roots, rows }),
      roots, sessions: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
  }

  private async parkConsumers(context: ExecutionSourceContext): Promise<boolean> {
    const operation = context.operation!; let ready = true;
    for (const task of (await this.store.all()).filter(t => t.rootTaskRef.id === context.rootTaskRef.id)) {
      for (const attempt of task.attempts) {
        if (attempt.receipt?.stopConfirmed) continue;
        const id = attempt.receipt?.sessionRef?.id;
        if (!id || id === operation.sessionId) continue;
        const record = await this.manager.getSession(id);
        if (!record || record.createdBy !== operation.owner) { ready = false; continue; }
        if (!record.workerRun) {
          if (record.taskRun?.started && !record.taskRun.exitConfirmed) ready = false;
          continue;
        }
        if (!record.taskBarrier || record.taskBarrier.state === "resuming") {
          const participant = (operation.participants ??= {})[id] ??= { id: randomUUID(), owner: record.createdBy };
          await this.store.writeJournal("source:" + context.rootTaskRef.id, context);
          await this.manager.armTaskBarrier(id, participant.owner, participant.id, "source_rebind", 1, "coordinator");
        }
        await this.manager.advanceTaskBarrier(id);
        const parked = await this.manager.getSession(id);
        if (parked?.taskBarrier?.state !== "parked" || parked.taskRun?.exitConfirmed !== true) ready = false;
      }
    }
    return ready;
  }
  private async reconcileLocked(): Promise<void> {
    for (const [, context] of await this.store.journalEntries<ExecutionSourceContext>("source:")) {
      const before = fingerprint(context), operation = context.operation;
      try {
        if (operation && !["applied", "resuming"].includes(operation.state)) {
          await this.manager.advanceTaskBarrier(operation.sessionId);
          const session = await this.manager.getSession(operation.sessionId);
          if (session?.taskBarrier?.id !== operation.id)
            return taskError("source_boundary_missing", "Source selection is retained, but its original native boundary is missing. Recover the original task session before retrying; no replacement execution was started.");
          if (session.taskBarrier.state !== "parked") continue;
          await this.orchestration.context(operation.sessionId);
          if (operation.state === "boundary" || operation.state === "selecting") {
            if (!await this.parkConsumers(context)) continue;
            operation.state = "selecting"; await this.store.writeJournal("source:" + context.rootTaskRef.id, context);
            await this.manager.authorizeTaskWorkflow?.(operation.sessionId, operation.command.operation, operation.command.payload);
            context.reference = await this.workflow<TaskSourceReference>(operation.command);
            if (context.workspaceId !== context.reference.workspaceId) context.associations = {};
            context.workspaceId = context.reference.workspaceId; context.revision = context.reference.contextRevision;
            operation.state = "associating"; await this.store.writeJournal("source:" + context.rootTaskRef.id, context);
          }
        }
        if (context.reference) {
          const tasks = (await this.store.all()).filter(t => t.rootTaskRef.id === context.rootTaskRef.id);
          for (const task of tasks) for (const attempt of task.attempts) if (attempt.receipt?.sessionRef)
            await this.associate(context, task, attempt.executionId, attempt.receipt.sessionRef.id);
        }
        if (operation && ["associating", "resuming"].includes(operation.state)) {
          operation.state = "resuming"; await this.store.writeJournal("source:" + context.rootTaskRef.id, context);
          const ownerSession = await this.manager.getSession(operation.sessionId);
          const ownerTask = ownerSession?.taskContext ? await this.store.get(ownerSession.taskContext.taskRef.id, { userId: operation.owner, appId: null }) : null;
          if (ownerTask?.coordination?.executionId === operation.command.parentExecutionId && ownerSession?.taskBarrier?.id === operation.id && ownerSession.taskBarrier.state !== "resuming") {
            if (!await this.beforeResume(operation.sessionId)) continue;
            if (!await this.orchestration.reserveContinuation(operation.sessionId)) continue;
            await this.manager.resumeTaskBarrier(operation.sessionId, operation.owner,
              "Continue the same task in its selected workspace. All task execution sessions inherit this source context. Read task_execution_get for current association and source state.");
          }
          let resumed = true;
          for (const [id, participant] of Object.entries(operation.participants ?? {})) {
            if (participant.resumed) continue;
            const record = await this.manager.getSession(id);
            if (!record || record.status === "cancelled" || record.taskBarrier?.id === participant.id && record.taskBarrier.state === "resuming") { participant.resumed = true; continue; }
            if (!await this.beforeResume(id)) { resumed = false; continue; }
            await this.manager.resumeTaskBarrier(id, participant.owner, "Continue your original task using the root's updated workspace. Inspect task_execution_get for source state.");
            participant.resumed = true;
          }
          if (resumed) operation.state = "applied";
          delete operation.error;
        }
      } catch (error) { if (operation) operation.error = error instanceof Error ? error.message : "Source binding needs recovery."; }
      if (fingerprint(context) !== before) await this.store.writeJournal("source:" + context.rootTaskRef.id, context);
    }
  }
}
