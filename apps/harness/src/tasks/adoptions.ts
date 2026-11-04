import { randomUUID } from "node:crypto";
import type { TaskRecord } from "@hosty-sdk/app/tasks";
import type { SessionManager } from "../sessions/manager.js";
import type { SessionRecord } from "../sessions/store.js";
import { decisionSnapshot } from "../decisions/waits.js";
import type { TaskConfiguration } from "./configurations.js";
import { TaskStore, fingerprint, taskError, taskInput, uuid } from "./store.js";

export type TaskAdoption = {
  id: string; sessionId: string; owner: string; revision: number; hash: string; createdAt: string;
  state: "prepared" | "awaiting_consent" | "awaiting_boundary" | "binding" | "admitted" | "declined" | "stale";
  input: { title: string; markdown: string; resources: TaskRecord["resources"]; review: TaskRecord["review"] };
  before: string; configurationSnapshot: string; autonomyRevision: number; cancellationGeneration: number;
  snapshot: Pick<SessionRecord, "agentProfile" | "instructionSnapshot" | "skillIds" | "connectionId" | "connectionRevision" | "connectionIdentity" | "harnessKind" | "executionSelection">; root?: TaskRecord; createId: string; replaceRoot?: TaskRecord; readyId: string; readyRevision?: number;
  approved: boolean; error?: string;
};
export const adoptionConfigurationSnapshot = (record: SessionRecord) => decisionSnapshot({ ...record, autonomy: "normal" });

/** Human mode consent is local Harness authority; no Core question answer can grant it. */
export class TaskAdoptions {
  private credentials = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> { const work = this.queue.then(fn); this.queue = work.catch(() => {}); return work; }
  adopt(sessionId: string, input: Record<string, unknown>) { return this.serial(() => this.adoptLocked(sessionId, input)); }
  consent(id: string, owner: string, input: { requestId: string; expectedRevision: number; choice: "approve" | "decline" }, credential: string) {
    return this.serial(() => this.consentLocked(id, owner, input, credential));
  }
  reconcile() { return this.serial(() => this.reconcileLocked()); }
  constructor(private readonly store: TaskStore, private readonly manager: SessionManager,
    private readonly launch: (task: TaskRecord, requestId: string, credential: string) => Promise<TaskRecord>) {}
  private view(value: TaskAdoption) {
    return { id: value.id, sessionId: value.sessionId, owner: value.owner, revision: value.revision, state: value.state,
      title: value.input.title, rootTaskRef: value.root?.ref, error: value.error, createdAt: value.createdAt };
  }
  async get(id: string, owner: string) {
    const value = await this.store.readJournal<TaskAdoption>("adoption:" + uuid(id));
    if (!value || value.owner !== owner) return taskError("task_not_found", "Task adoption not found.", 404);
    return this.view(value);
  }
  private async adoptLocked(sessionId: string, input: Record<string, unknown>) {
    const session = await this.manager.getSession(sessionId);
    if (!session) return taskError("session_missing", "This session is unavailable.", 404);
    if (session.taskContext) return { state: "admitted", rootTaskRef: session.taskContext.rootTaskRef, taskRef: session.taskContext.taskRef };
    const id = uuid(input.requestId), hash = fingerprint({ sessionId, input });
    const value = await this.store.transaction(s => {
      const previous = s.journal?.["adoption:" + id] as TaskAdoption | undefined;
      if (previous) { if (previous.owner !== session.createdBy || previous.hash !== hash) return taskError("request_conflict", "Recover the original adoption request."); return previous; }
      const activeId = s.journal?.["adoption-session:" + sessionId] as string | undefined;
      const active = activeId ? s.journal?.["adoption:" + activeId] as TaskAdoption | undefined : undefined;
      if (active && !["declined", "stale"].includes(active.state)) return taskError("adoption_pending", "Recover this conversation's existing root adoption before proposing another.");
      const existingRoot = active?.root ? this.store.find(s, active.root.ref.id) : undefined;
      if (active && (!existingRoot || existingRoot.status !== "Draft" || existingRoot.attempts.length))
        return taskError("adoption_pending", "Recover the retained root before starting another proposal.");
      if (active && session.taskBarrier && session.taskBarrier.state !== "resuming")
        return taskError("barrier_pending", "Finish the previous conversation boundary before proposing another transition.");
      if (input.selectionRevision !== (session.selectionRevision ?? 0) || input.contextRevision !== (session.appContextRevision ?? 0)
        || input.autonomyRevision !== (session.autonomyRevision ?? 0)) return taskError("stale_input", "Read the current session revisions before adopting work.");
      const task = taskInput({ title: input.title, markdown: input.markdown, resources: input.resources, review: input.review ?? { mode: "none" }, assignee: null });
      if (!task.title || !task.markdown.trim() || task.review.mode === "delegator") return taskError("invalid_input", "Provide a root objective with none/owner final review.", 400);
      const intent: TaskAdoption = { id, hash, sessionId, owner: session.createdBy, revision: 1, createdAt: new Date().toISOString(), state: "prepared",
        input: { title: task.title, markdown: task.markdown, resources: task.resources, review: task.review }, before: decisionSnapshot(session),
        configurationSnapshot: adoptionConfigurationSnapshot(session), autonomyRevision: session.autonomyRevision ?? 0,
        cancellationGeneration: session.decisionGeneration ?? 0, snapshot: { agentProfile: session.agentProfile, instructionSnapshot: session.instructionSnapshot, skillIds: session.skillIds, connectionId: session.connectionId, connectionRevision: session.connectionRevision, connectionIdentity: session.connectionIdentity, harnessKind: session.harnessKind, executionSelection: session.executionSelection }, replaceRoot: existingRoot, createId: randomUUID(), readyId: randomUUID(), approved: session.autonomy === "autonomous" };
      (s.journal ??= {})["adoption:" + id] = intent; s.journal["adoption-session:" + sessionId] = id; return intent;
    });
    if (value.state === "prepared") {
      const rootInput = { ...value.input, parentTaskRef: null, dependsOn: [], assignee: { kind: "app", executor: this.store.provider,
        selection: { kind: "configuration", id: value.id, revision: 1 } } };
      value.root = await this.manager.invokeCoreTask(sessionId, value.replaceRoot ? "task-edit" : "task-create", {
        requestId: value.createId, input: rootInput, ...(value.replaceRoot ? { taskId: value.replaceRoot.ref.id,
          expectedRevision: value.replaceRoot.revision, expectedGraphRevision: value.replaceRoot.graphRevision } : {}),
      }, this.store.provider) as TaskRecord;
      value.readyRevision = value.root.revision;
      value.state = value.approved ? "awaiting_boundary" : "awaiting_consent"; value.revision++;
      await this.store.transaction(s => {
        (s.journal ??= {})["adoption:" + id] = value;
        s.journal["configuration:" + id] = this.configuration(value);
      });
    }
    if (["declined", "stale", "admitted"].includes(value.state)) return this.view(value);
    const barrier = await this.manager.armTaskBarrier(sessionId, value.owner, id, "task_adoption");
    if (value.approved && value.root?.status === "Draft" && (await this.manager.getSession(value.sessionId))?.taskBarrier?.state === "parked") await this.start(value);
    return { ...this.view(value), barrier, instruction: "Yield this turn. Root work continues in this same session after its authorized boundary; mode approval is only through the user's Decisions action." };
  }
  private configuration(value: TaskAdoption): TaskConfiguration {
    const record = value.snapshot, name = record.agentProfile?.name ?? "Chat configuration";
    return { version: 1, selection: { kind: "configuration", id: value.id, revision: 1 }, name, rationale: "Adopted from the user's existing conversation.",
      directoryRevision: 0, requestHash: value.hash, createdAt: value.createdAt, launchMode: "adopt", sessionId: value.sessionId,
      scope: { owner: value.owner, rootTaskRef: value.root!.ref, parentTaskRef: value.root!.ref, parentExecutionId: value.id,
        parentSessionId: value.sessionId, generation: 1, coordinatorEpoch: 1 },
      profile: record.agentProfile ?? { id: value.id, revision: 1, name, description: "Existing chat configuration", instructions: record.instructionSnapshot ?? "",
        skillIds: record.skillIds ?? [], connectionId: record.connectionId ?? null, model: record.executionSelection?.model ?? null, reasoningEffort: record.executionSelection?.reasoningEffort ?? null },
      binding: { connectionId: record.connectionId, connectionRevision: record.connectionRevision, connectionIdentity: record.connectionIdentity, harnessKind: record.harnessKind },
      adoption: { id: value.id, before: value.before, configurationSnapshot: value.configurationSnapshot, autonomyRevision: value.autonomyRevision,
        cancellationGeneration: value.cancellationGeneration, approved: value.approved },
    };
  }
  private async start(value: TaskAdoption, credential?: string) {
    if (!value.approved || !value.root) return;
    const input = { requestId: value.readyId, expectedRevision: value.readyRevision!, action: "ready" };
    credential ??= this.credentials.get(value.id);
    value.root = credential ? await this.launch(value.root, value.readyId, credential)
      : await this.manager.invokeCoreTask(value.sessionId, "task-action", { taskId: value.root.ref.id, ...input }, this.store.provider) as TaskRecord;
    this.credentials.delete(value.id);
    value.state = "binding"; value.revision++; delete value.error;
    await this.store.writeJournal("adoption:" + value.id, value);
  }
  private async consentLocked(id: string, owner: string, input: { requestId: string; expectedRevision: number; choice: "approve" | "decline" }, credential: string) {
    uuid(input.requestId);
    const proposal = await this.store.readJournal<TaskAdoption>("adoption:" + uuid(id));
    if (!proposal || proposal.owner !== owner) return taskError("task_not_found", "Task adoption not found.", 404);
    const session = await this.manager.getSession(proposal.sessionId);
    const originalResponse = await this.store.readJournal("adoption-consent:" + owner + ":" + input.requestId);
    if (!originalResponse && (!session || (session.decisionGeneration ?? 0) !== proposal.cancellationGeneration
      || (session.autonomyRevision ?? 0) !== proposal.autonomyRevision || adoptionConfigurationSnapshot(session) !== proposal.configurationSnapshot))
      return taskError("stale_input", "The chat changed after this mode proposal. Review a fresh proposal.");
    const value = await this.store.transaction(s => {
      const value = s.journal?.["adoption:" + uuid(id)] as TaskAdoption | undefined;
      if (!value || value.owner !== owner) return taskError("task_not_found", "Task adoption not found.", 404);
      const key = "adoption-consent:" + owner + ":" + input.requestId, hash = fingerprint({ id, input });
      const receipt = s.journal?.[key] as { hash: string } | undefined;
      if (receipt) { if (receipt.hash !== hash) return taskError("request_conflict", "Recover the original consent action."); return value; }
      if (value.revision !== input.expectedRevision || !(value.state === "awaiting_consent" || value.state === "awaiting_boundary" && value.approved && input.choice === "approve")) return taskError("revision_conflict", "This mode proposal changed. Reload before answering.");
      if (!["approve", "decline"].includes(input.choice)) return taskError("invalid_input", "Explicitly approve or decline Autonomous mode.", 400);
      value.approved = input.choice === "approve"; value.state = value.approved ? "awaiting_boundary" : "declined"; value.revision++;
      (s.journal ??= {})[key] = { hash }; s.journal["configuration:" + id] = this.configuration(value); return value;
    });
    if (value.approved) this.credentials.set(value.id, credential);
    if (value.approved && value.root?.status === "Draft" && (await this.manager.getSession(value.sessionId))?.taskBarrier?.state === "parked") await this.start(value, credential);
    return this.view(value);
  }
  private async reconcileLocked() {
    for (const [, value] of await this.store.journalEntries<TaskAdoption>("adoption:")) {
      if (["prepared", "admitted", "stale"].includes(value.state)) continue;
      try {
        await this.manager.advanceTaskBarrier(value.sessionId);
        const session = await this.manager.getSession(value.sessionId);
        if (!session) return taskError("session_missing", "The adopted conversation is unavailable.");
        if (value.state === "declined") {
          if (session.taskBarrier?.id === value.id && session.taskBarrier.state === "parked") await this.manager.resumeTaskBarrier(session.id, value.owner, "Autonomous task execution was declined. Continue ordinary chat in the existing mode; the prepared root remains unstarted.");
          continue;
        }
        if (session.taskAdoptionApplied?.id === value.id && session.taskExecutionId) {
          value.state = "admitted"; value.revision++; delete value.error; await this.store.writeJournal("adoption:" + value.id, value); continue;
        }
        if (adoptionConfigurationSnapshot(session) !== value.configurationSnapshot || (session.autonomyRevision ?? 0) !== value.autonomyRevision && !(session.autonomy === "autonomous" && (session.autonomyRevision ?? 0) === value.autonomyRevision + 1) || (session.decisionGeneration ?? 0) !== value.cancellationGeneration)
          return taskError("stale_input", "The proposal's provider, instructions or context changed; consent cannot apply.");
        if (!value.approved && session.autonomy === "autonomous" && (session.autonomyRevision ?? 0) > value.autonomyRevision) {
          value.approved = true; value.state = "awaiting_boundary"; value.revision++;
          await this.store.transaction(s => { s.journal!["adoption:" + value.id] = value; s.journal!["configuration:" + value.id] = this.configuration(value); });
        }
        if (value.approved && value.root?.status === "Draft" && (await this.manager.getSession(value.sessionId))?.taskBarrier?.state === "parked") await this.start(value);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Task adoption needs recovery.";
        if ((error as { code?: string }).code === "stale_input" && value.state !== "binding") value.state = "stale";
        if (value.error !== message) { value.error = message; value.revision++; await this.store.writeJournal("adoption:" + value.id, value); }
      }
    }
  }
  async projections(owner: string) {
    return (await this.store.journalEntries<TaskAdoption>("adoption:")).map(([, value]) => value)
      .filter(value => value.owner === owner && (value.state === "awaiting_consent" || value.error && value.state !== "admitted"))
      .map(value => ({ id: value.id, kind: "task_mode" as const, sessionId: value.sessionId, title: value.input.title,
        createdAt: value.createdAt, revision: value.revision, approved: value.approved, available: value.state === "awaiting_consent" || value.state === "awaiting_boundary" && value.approved, error: value.error }));
  }
}
