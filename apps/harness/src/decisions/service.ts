import { readNativeQuestions } from "../harness/questions.js";
import { fingerprint, uuid, taskError } from "../tasks/store.js";
import { continuationInput } from "./waits.js";
import { randomUUID } from "node:crypto";
import { DecisionError, type DecisionClient, type DecisionRecord, type DecisionResolve, type DecisionQuery, type DecisionContinuationState, type DecisionContinuationReason } from "@hosty-sdk/app/decisions";
import { DecisionServerClient } from "@hosty-sdk/app/decisions/server";
import type { SessionManager } from "../sessions/manager.js";
import type { SessionRecord } from "../sessions/store.js";
import { terminal, type WorkerReceipt } from "../worker/contracts.js";
import { DecisionWaitStore, newWait, waitId, nativeAnswers, type DecisionWait, type QuestionEvent } from "./waits.js";

const PARK_AFTER_MS = 5 * 60_000;
const closed = (wait: DecisionWait) => ["completed", "cancelled"].includes(wait.state);
export class DecisionsService {
  readonly waits: DecisionWaitStore;
  private credentials = new Map<string, string>();
  private active = new Set<Promise<void>>();
  private busy = new Set<string>();
  private listeners = new Map<string, Set<() => void>>();
  private timer: NodeJS.Timeout;
  private stopObserving?: () => void;
  private stopped = false;
  private ticking = false;
  constructor(private readonly manager: SessionManager, private readonly clientFactory = (token: () => string): DecisionClient => new DecisionServerClient(token),
    private readonly now = () => Date.now(), private readonly parkingMs = PARK_AFTER_MS) {
    this.waits = new DecisionWaitStore(manager.store.dataDir);
    this.stopObserving = manager.store.observeChanges?.(async id => {
      const record = await manager.store.readRecord(id);
      if (record) this.changed(record.createdBy);
      else for (const owner of this.listeners.keys()) this.changed(owner);
    });
    this.timer = setInterval(() => this.kick(), 10_000); this.timer.unref();
  }
  authorize(owner: string, credential: string): void { if (credential) this.credentials.set(owner, credential); this.kick(); }
  private client(owner: string): DecisionClient {
    if (!this.credentials.has(owner)) throw new DecisionError("identity_required", "Open Harness to authorize continuation. The saved answer is retained.", 401);
    return this.clientFactory(() => this.credentials.get(owner) ?? "");
  }
  events(owner: string, signal: AbortSignal): Promise<Response> { return this.client(owner).events(signal); }
  watch(owner: string, listener: () => void): () => void {
    const set = this.listeners.get(owner) ?? new Set(); set.add(listener); this.listeners.set(owner, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(owner); };
  }
  private changed(owner: string): void { this.listeners.get(owner)?.forEach(listener => listener()); }
  async register(record: SessionRecord, event: QuestionEvent): Promise<DecisionWait> {
    const initial = newWait(record, event);
    const wait = await this.waits.update(initial.id, previous => previous ?? initial);
    this.changed(wait.owner); this.kick(); return wait;
  }
  /** Task questions have a durable tool boundary, independent of native question support. */
  async registerTask(record: SessionRecord, input: Record<string, unknown>, title?: string): Promise<DecisionWait> {
    const id = uuid(input.requestId);
    if (!record.taskExecutionId) return taskError("task_binding_required", "Required input belongs to an admitted task.");
    if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 2000)
      return taskError("invalid_input", "Explain the required input in at most 2000 characters.", 400);
    let questions;
    try { questions = readNativeQuestions(input, "codex"); }
    catch (error) { return taskError("invalid_input", error instanceof Error ? error.message : "Invalid questions.", 400); }
    const hash = fingerprint({ executionId: record.taskExecutionId, input });
    const initial = newWait(record, { type: "question_request", questionId: id, questions, blocking: true });
    initial.taskInput = { requestHash: hash, barrierId: id, reason: input.reason };
    if (title) initial.create.input.title = title.slice(0, 160);
    initial.create.input.reason = input.reason;
    initial.create.input.originPath = `/decisions?session=${encodeURIComponent(record.id)}`;
    // The caller binds this wait and its barrier before scheduling registration/continuation.
    return this.waits.update(initial.id, previous => {
      if (previous && previous.taskInput?.requestHash !== hash) return taskError("request_conflict", "Recover the original required-input request.");
      return previous ?? initial;
    });
  }
  async requiredInput(sessionId: string): Promise<DecisionWait | undefined> {
    return (await this.waits.list()).find(wait => wait.sessionId === sessionId && wait.event.blocking !== false
      && !["running", "completed", "cancelled"].includes(wait.state));
  }
  kick(): void {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    const work = this.tick().catch(() => {}).finally(() => { this.ticking = false; this.active.delete(work); });
    this.active.add(work);
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    await this.waits.prune(this.now());
    // Re-delivery covers a crash after Core resolve or local inbox write, even without an SSE hint.
    for (const owner of this.credentials.keys()) {
      try {
        const client = this.client(owner); let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
          const result = await client.responses({ limit: 100, ...(cursor ? { cursor } : {}) });
          for (const row of result.items) await this.receive(owner, row);
          if (!result.cursor) break; cursor = result.cursor;
        }
      } catch { /* A fresh interactive credential or the next reconciliation retries the same outbox. */ }
    }
    for (const wait of await this.waits.list()) if (!closed(wait) || wait.state === "cancelled" && !wait.cancellationSettled || wait.continuation || wait.withdrawal || wait.inbox && !wait.core?.delivery?.receivedAt) await this.step(wait.id);
  }
  private async update(id: string, patch: Partial<DecisionWait>): Promise<DecisionWait> {
    let changed = false;
    const next = await this.waits.update(id, current => {
      if (!current) throw new Error("Decision wait is missing.");
      const next = { ...current, ...patch };
      changed = JSON.stringify(current) !== JSON.stringify(next); return next;
    });
    if (changed) this.changed(next.owner); return next;
  }
  private async receive(owner: string, row: DecisionRecord): Promise<void> {
    const id = row.input?.waitReference;
    if (!id || !/^[a-f0-9]{64}$/.test(id) || row.userId !== owner || !row.resolution) return;
    const wait = await this.waits.read(id);
    if (!wait || wait.owner !== owner || wait.create.input.correlationKey !== row.input?.correlationKey || wait.core && wait.core.id !== row.id) return;
    // Immutable response and its already allocated continuation command are committed before ack.
    await this.waits.update(id, current => {
      if (!current) throw new Error("Decision wait disappeared.");
      if (current.inbox && current.inbox.resolutionRevision !== row.resolution!.revision) throw new Error("Decision resolution changed.");
      return { ...current, core: row, inbox: current.inbox ?? { resolutionRevision: row.resolution!.revision, receivedAt: new Date(this.now()).toISOString() },
        state: ["registering", "waiting", "parked"].includes(current.state) ? "received" : current.state };
    });
    this.changed(owner);
  }
  private async report(wait: DecisionWait, state: DecisionContinuationState, reason?: DecisionContinuationReason): Promise<DecisionWait> {
    if (!wait.core?.continuation || !wait.core.delivery?.receivedAt || wait.core.state !== "answered") return wait;
    if (wait.continuation) {
      await this.client(wait.owner).continuation(wait.core.id, wait.continuation);
      // Replay returns its historical receipt. Read current state before a new CAS command.
      const core = await this.client(wait.owner).get(wait.core.id);
      wait = await this.update(wait.id, { core, continuation: undefined });
    }
    if (state === "running" && ["received", "blocked"].includes(wait.core!.continuation!.state)) wait = await this.report(wait, "admitted");
    const current = wait.core!.continuation!;
    if (["completed", "cancelled", "failed"].includes(current.state) || current.state === state && (current.reason ?? undefined) === reason) return wait;
    const command = { requestId: randomUUID(), commandId: wait.commandId, expectedRevision: current.revision, state, ...(reason ? { reason } : {}) };
    wait = await this.update(wait.id, { continuation: command });
    const core = await this.client(wait.owner).continuation(wait.core!.id, command);
    return this.update(wait.id, { core, continuation: undefined });
  }
  private async acknowledge(wait: DecisionWait): Promise<DecisionWait> {
    if (!wait.inbox || !wait.core?.delivery || wait.core.delivery.receivedAt) return wait;
    try {
      const core = await this.client(wait.owner).acknowledge(wait.core.id, { requestId: wait.acknowledgementId, resolutionRevision: wait.inbox.resolutionRevision });
      return this.update(wait.id, { core });
    } catch (error) {
      if (!(error instanceof DecisionError) || error.status !== 409) throw error;
      const core = await this.client(wait.owner).get(wait.core.id);
      if (!core.contentRemovedAt) throw error;
      return this.update(wait.id, { core });
    }
  }
  private async step(id: string): Promise<void> {
    if (this.busy.has(id) || this.stopped) return; this.busy.add(id);
    let wait: DecisionWait | null = null;
    try {
      wait = await this.waits.read(id);
      if (!wait || wait.contentRemovedAt) return;
      if (wait.state === "cancelled") { await this.cancel(wait, wait.error ?? "The originating work was cancelled."); return; }
      const session = await this.manager.getSession(wait.sessionId);
      if (!session || session.createdBy !== wait.owner || (session.decisionGeneration ?? 0) !== wait.cancellationGeneration || ["cancelled", "abandoned"].includes(session.status)) {
        await this.cancel(wait, "The originating work was cancelled or deleted."); return;
      }
      // Resource parking is independent of answer delivery and expiring browser authority.
      if (!wait.taskInput && wait.event.blocking !== false && !wait.control && !wait.resumeRequested
        && this.now() - Date.parse(wait.createdAt) >= this.parkingMs) {
        await this.park(wait); wait = (await this.waits.read(id))!;
      }
      wait = await this.acknowledge(wait);
      if (!wait.core) {
        try {
          const core = await this.client(wait.owner).create(wait.create);
          if (core.userId !== wait.owner) throw new DecisionError("identity_required", "The current actor does not own this wait.", 403);
          wait = await this.update(id, { core, state: wait.state === "registering" ? "waiting" : wait.state, error: undefined, reason: undefined });
        } catch (error) { await this.problem(wait, error, "missing_provider"); }
      }
      if (wait.core?.notificationPending && (wait.notificationRetryAt ?? 0) <= this.now()) {
        wait = await this.update(id, { notificationRetryAt: this.now() + 30000 });
        try { wait = await this.update(id, { core: await this.client(wait.owner).create(wait.create) }); }
        catch { /* Keep the visible pending notification and retry the same creation identity. */ }
      }
      if (wait.taskInput) {
        try { await this.manager.advanceTaskBarrier(wait.sessionId); }
        catch (error) { if ((error as { code?: string }).code !== "barrier_pending") throw error; }
        const barrier = (await this.manager.getSession(wait.sessionId))?.taskBarrier;
        if (barrier?.id === wait.taskInput.barrierId && barrier.state === "parked" && wait.core && !wait.inbox)
          wait = await this.update(id, { state: "parked", error: undefined, reason: undefined });
      }
      if (wait.withdrawal && wait.core) {
        const core = await this.client(wait.owner).withdraw(wait.core.id, wait.withdrawal);
        wait = await this.update(id, { core, withdrawal: undefined, state: "cancelled" });
      }
      if (wait.core && !wait.inbox && wait.core.resolution) { await this.receive(wait.owner, wait.core); wait = (await this.waits.read(id))!; }
      if (!wait.inbox) {
        await this.manager.checkDecision(wait);
        if (wait.core) {
          const core = await this.client(wait.owner).get(wait.core.id);
          wait = await this.update(id, { core });
          if (!["pending", "answered"].includes(core.state)) { await this.cancel(wait, "The question expired or was closed.", false); return; }
          if (core.resolution) { await this.receive(wait.owner, core); return; }
        }
        return;
      }
      wait = await this.acknowledge(wait);
      // Revalidate the authoritative question before every admission, not just when its answer arrived.
      const core = await this.client(wait.owner).get(wait.core!.id);
      wait = await this.update(id, { core });
      if (core.state !== "answered") { await this.cancel(wait, "This decision no longer authorizes continuation input.", false); return; }
      if (!wait.answeredEvent) {
        await this.manager.recordDecisionAnswer(wait, nativeAnswers(wait));
        wait = await this.update(id, { answeredEvent: true });
      }
      if (closed(wait)) return;
      if (wait.taskInput) { await this.continueTaskInput(wait); return; }
      if (wait.state === "running" || wait.state === "admitted" || wait.resumeRequested) { await this.observeContinuation(wait); return; }
      if (wait.park && wait.native.workerRunId && this.manager.worker) {
        const receipt = await this.manager.worker.request<WorkerReceipt>(`/v1/runs/${wait.native.workerRunId}`);
        if (receipt.state === "parking") { await this.park(wait); return; }
        if (!receipt.exitConfirmed) throw new DecisionError("unknown_stop", "The previous native execution has no confirmed exit. The answer is retained.", 409);
      }
      await this.manager.checkDecision(wait);
      const receipt = wait.native.workerRunId && this.manager.worker
        ? await this.manager.worker.request<WorkerReceipt>(`/v1/runs/${wait.native.workerRunId}`) : null;
      if (wait.control) {
        // An applied control is never sent through a new native segment, even after a lost response.
        const outcome = await this.manager.worker?.request<{ state: string }>(`/v1/runs/${wait.native.workerRunId}/controls/${wait.control.controlId}`);
        if (outcome?.state === "applied") { wait = await this.update(id, { state: "running" }); await this.report(wait, "running"); return; }
        if (outcome?.state === "unknown") throw new DecisionError("unknown_admission", "Native answer delivery is uncertain. Reconcile the original run before resuming.", 409);
      }
      if (receipt && !terminal(receipt.state)) {
        if (receipt.state === "parking" || receipt.state === "cancelling") throw new DecisionError("unknown_stop", "Wait for the original execution to stop.", 409);
        const frame = receipt.pending?.find(frame => frame.event.type === "question_request" && frame.event.questionId === wait!.questionId);
        if (!frame) throw new DecisionError("unsupported_resume", "The native callback is no longer pending. Review the saved answer before recovery.", 409);
        if (!wait.control || wait.control.expectedRevision !== receipt.revision) wait = await this.update(id, { control: { controlId: wait.commandId, kind: "question", id: wait.questionId,
          answers: nativeAnswers(wait), eventId: frame.sequence, expectedRevision: receipt.revision } });
        wait = await this.report(wait, "admitted");
        await this.update(id, { state: "delivering" });
        await this.manager.deliverDecision(wait);
        wait = await this.update(id, { state: "running", error: undefined, reason: undefined });
        await this.report(wait, "running"); return;
      }
      if (wait.control) throw new DecisionError("unknown_admission", "A previous native answer command must be reconciled before a new segment can start.", 409);
      if (!receipt?.exitConfirmed || receipt.state !== "parked") throw new DecisionError("unknown_stop", "The original question execution must be confirmed parked before automatic resume.", 409);
      if (!wait.native.sessionId || !["codex", "claude"].includes(wait.native.kind ?? "")) throw new DecisionError("unsupported_resume", "This provider has no supported saved native continuation. The answer is retained.", 409);
      wait = await this.report(wait, "admitted");
      wait = await this.update(id, { state: "admitted", resumeRequested: true });
      await this.manager.resumeDecision(wait, this.credentials.get(wait.owner)!);
      const currentSession = await this.manager.getSession(wait.sessionId);
      wait = await this.update(id, { state: "running", resumedRunId: currentSession?.decisionRunIds?.[wait.commandId], error: undefined, reason: undefined });
      await this.report(wait, "running");
    } catch (error) { if (wait) await this.problem(wait, error); }
    finally { this.busy.delete(id); }
  }
  private async park(wait: DecisionWait): Promise<void> {
    if (!wait.native.workerRunId || !this.manager.worker || wait.event.blocking === false) return;
    const receipt = await this.manager.worker.request<WorkerReceipt>(`/v1/runs/${wait.native.workerRunId}`);
    if (receipt.state === "parked" && receipt.exitConfirmed) { await this.update(wait.id, { state: wait.inbox ? "received" : "parked" }); return; }
    if (terminal(receipt.state)) return;
    if (wait.park && receipt.state !== "parking") {
      const outcome = await this.manager.worker.request<{ state: string }>(`/v1/runs/${wait.native.workerRunId}/controls/${wait.park.controlId}`);
      if (outcome.state === "unknown") throw new DecisionError("unknown_stop", "Parking admission is uncertain.", 409);
      if (outcome.state === "missing" && wait.park.expectedRevision !== receipt.revision) wait = await this.update(wait.id, { park: undefined });
    }
    if (!wait.park) {
      const frame = receipt.pending?.find(f => f.event.type === "question_request" && f.event.questionId === wait.questionId);
      if (!frame || receipt.pending?.some(f => f.event.type !== "question_request" || f.event.blocking === false)) return;
      wait = await this.update(wait.id, { state: "parking", park: { controlId: randomUUID(), id: wait.questionId, expectedRevision: receipt.revision, eventId: frame.sequence } });
    }
    await this.manager.parkDecision(wait);
    await this.update(wait.id, { state: wait.inbox ? "received" : "parked", error: undefined, reason: undefined });
  }
  private async observeContinuation(wait: DecisionWait): Promise<void> {
    if (!this.manager.worker) throw new DecisionError("missing_provider", "The original Worker is unavailable.", 503);
    if (wait.resumeRequested && !wait.resumedRunId) {
      // Only an explicit not-found receipt proves admission has not happened. Network/read errors
      // must never be treated as absence, and an unknown receipt never permits a new command.
      const receipt = await this.manager.messageReceipt(wait.sessionId, wait.commandId, wait.owner).catch(error => {
        if (error.code === "message_request_not_found") return null; throw error;
      });
      if (!receipt) {
        await this.manager.checkDecision(wait);
        await this.manager.resumeDecision(wait, this.credentials.get(wait.owner)!);
      } else if (receipt.state !== "accepted") throw new DecisionError("unknown_admission", "Continuation admission needs reconciliation. A second run was not started.", 409);
      const session = await this.manager.getSession(wait.sessionId);
      const resumedRunId = session?.decisionRunIds?.[wait.commandId];
      if (!resumedRunId || resumedRunId === wait.native.workerRunId) throw new DecisionError("unknown_admission", "Continuation run identity is unavailable.", 409);
      wait = await this.update(wait.id, { state: "running", resumedRunId, error: undefined, reason: undefined });
      wait = await this.report(wait, "running");
    }
    const runId = wait.resumedRunId ?? wait.native.workerRunId;
    if (!runId) throw new DecisionError("unsupported_resume", "This question has no durable native execution identity.", 409);
    const receipt = await this.manager.worker.request<WorkerReceipt>(`/v1/runs/${runId}`);
    if ((receipt.state === "completed" || receipt.state === "parked" && (receipt.barrier?.barrierId !== undefined && receipt.barrier.barrierId !== wait.taskInput?.barrierId || receipt.pending?.some(frame => frame.event.type === "question_request" && frame.event.questionId !== wait.questionId))) && receipt.exitConfirmed) {
      wait = await this.report(wait, "running"); wait = await this.report(wait, "completed");
      await this.update(wait.id, { state: "completed", error: undefined, reason: undefined }); await this.manager.finishDecision(wait); return;
    }
    if (terminal(receipt.state) && receipt.state !== "parked") {
      if (!receipt.exitConfirmed) throw new DecisionError("unknown_stop", "The continuation stopped without confirmed native exit.", 409);
      wait = await this.report(wait, receipt.state === "cancelled" ? "cancelled" : "failed", receipt.state === "cancelled" ? "cancelled" : "provider_failed");
      await this.update(wait.id, { state: "completed", error: "Continuation ended before successful completion." }); await this.manager.finishDecision(wait);
    }
  }
  private async continueTaskInput(wait: DecisionWait): Promise<void> {
    if (wait.resumedRunId) { await this.observeContinuation(wait); return; }
    await this.manager.checkDecision(wait);
    const session = await this.manager.getSession(wait.sessionId), barrier = session?.taskBarrier;
    if (barrier?.id !== wait.taskInput!.barrierId) throw new DecisionError("stale_input", "The required-input boundary changed.", 409);
    if (barrier.state !== "parked" && barrier.state !== "resuming") return;
    if (!wait.resumeRequested) {
      if (this.manager.beforeTaskDecisionResume && !await this.manager.beforeTaskDecisionResume(wait.sessionId)) return;
      wait = await this.report(wait, "admitted");
      wait = await this.update(wait.id, { resumeRequested: true, state: "admitted" });
    }
    // resumeTaskBarrier reuses the original durable command after uncertain admission.
    await this.manager.resumeTaskBarrier(wait.sessionId, wait.owner, continuationInput(wait), this.credentials.get(wait.owner));
    const receipt = await this.manager.messageReceipt(wait.sessionId, barrier.commandId, wait.owner);
    if (receipt.state !== "accepted") throw new DecisionError("unknown_admission", "The original continuation requires recovery.", 409);
    const current = await this.manager.getSession(wait.sessionId);
    const resumedRunId = current?.decisionRunIds?.[wait.commandId];
    if (!resumedRunId || resumedRunId === wait.native.workerRunId) throw new DecisionError("unknown_admission", "Continuation run identity is unavailable.", 409);
    wait = await this.update(wait.id, { state: "running", resumedRunId, error: undefined, reason: undefined });
    await this.report(wait, "running");
  }
  private async problem(wait: DecisionWait, error: unknown, fallback: DecisionContinuationReason = "missing_provider"): Promise<void> {
    const code = (error as { code?: string }).code;
    if (code === "stale_input" || code === "selection_conflict") {
      wait = await this.update(wait.id, { invalidateRequested: true });
      await this.cancel(wait, "The reviewed instructions, provider, account or inputs changed."); return;
    }
    const reason: DecisionContinuationReason = code === "unknown_stop" || code === "exit_unconfirmed" ? "unknown_stop"
      : code === "unknown_admission" || code === "control_uncertain" || code === "message_outcome_unknown" ? "unknown_admission"
      : code === "stale_input" || code === "selection_conflict" ? "stale_input" : code === "unsupported_resume" ? "unsupported_resume"
      : (error as { status?: number }).status === 401 || (error as { status?: number }).status === 403 ? "missing_authority" : fallback;
    const message = reason === "missing_authority" ? "Open Harness and review its required access to continue. Your answer is retained."
      : error instanceof Error ? error.message.slice(0, 1000) : "Continuation is unavailable. Your answer is retained.";
    wait = await this.update(wait.id, { state: "blocked", reason, error: message });
    try { await this.report(wait, "blocked", reason); } catch { /* Retain the same status command for reconciliation. */ }
  }
  private async cancel(wait: DecisionWait, message: string, withdraw = true): Promise<void> {
    wait = await this.update(wait.id, { state: "cancelled", reason: wait.invalidateRequested ? "stale_input" : "cancelled", error: message });
    if (wait.cancellationSettled && !(wait.core?.resolution && wait.core.delivery && !wait.core.delivery.receivedAt)) return;
    let stopped = true;
    try { await this.manager.stopDecisionExecution(wait); }
    catch {
      stopped = false;
      wait = await this.update(wait.id, { reason: "unknown_stop", error: "The question is closed, but its original execution has no confirmed exit. Source leases are retained." });
    }
    if (withdraw) {
      try {
        const close = wait.invalidateRequested ? this.client(wait.owner).invalidate.bind(this.client(wait.owner)) : this.client(wait.owner).withdraw.bind(this.client(wait.owner));
        // A lost create response can leave a pending Core question. Reconcile its original ID
        // before withdrawing; never abandon that registration intent on local cancellation.
        if (!wait.core) wait = await this.update(wait.id, { core: await this.client(wait.owner).create(wait.create) });
        if (wait.withdrawal) {
          try { await close(wait.core!.id, wait.withdrawal); }
          catch (error) { if (!(error instanceof DecisionError) || error.status !== 409) throw error; }
          // A definitive CAS rejection or successful replay permits reading the current revision.
          wait = await this.update(wait.id, { core: await this.client(wait.owner).get(wait.core!.id), withdrawal: undefined });
        } else wait = await this.update(wait.id, { core: await this.client(wait.owner).get(wait.core!.id) });
        if (wait.core!.resolution && wait.core!.delivery && !wait.core!.delivery.receivedAt) {
          await this.receive(wait.owner, wait.core!); wait = (await this.waits.read(wait.id))!;
          wait = await this.acknowledge(wait);
        }
        if (["pending", "answered"].includes(wait.core!.state) || wait.deleteRequested && !wait.core!.contentRemovedAt) {
          const command = { requestId: randomUUID(), expectedRevision: wait.core!.revision, reason: message, ...(wait.deleteRequested ? { removeContent: true } : {}) };
          wait = await this.update(wait.id, { withdrawal: command });
          const core = await close(wait.core!.id, command);
          wait = await this.update(wait.id, { core, withdrawal: undefined });
        }
      } catch { return; } // Keep the cleanup intent, without admitting or reviving work.
    }
    if (!stopped) return;
    await this.manager.finishDecision(wait);
    await this.update(wait.id, { cancellationSettled: true, continuation: undefined });
  }
  async deleteSession(owner: string, sessionId: string): Promise<void> {
    for (const wait of await this.waits.list(owner)) if (wait.sessionId === sessionId)
      await this.update(wait.id, { state: "cancelled", deleteRequested: true, cancellationSettled: false });
    this.kick();
  }
  async projections(owner: string) {
    const result = await this.manager.decisionProjections(owner);
    for (const wait of await this.waits.list(owner)) if (!closed(wait) && (!wait.core || wait.error)) result.items.push({
      id: `decision-wait:${wait.id}`, kind: "recovery", sessionId: wait.sessionId, title: wait.create.input.title,
      createdAt: wait.createdAt, available: true, error: wait.error ?? "The required question is saved locally and is waiting for Core registration.",
    });
    return result;
  }
  async list(owner: string, query: DecisionQuery = {}) { return this.client(owner).list(query); }
  async get(owner: string, id: string) { return this.client(owner).get(id); }
  async local(owner: string, id: string): Promise<DecisionWait> {
    const wait = await this.waits.read(id); if (!wait || wait.owner !== owner) throw new DecisionError("decision_not_found", "Decision is unavailable.", 404);
    return wait;
  }
  async resolve(owner: string, id: string, input: DecisionResolve): Promise<DecisionRecord> {
    const core = await this.client(owner).resolve(id, input); await this.receive(owner, core); this.kick(); this.changed(owner); return core;
  }
  async retry(owner: string, id: string): Promise<void> { const wait = await this.local(owner, id); await this.step(wait.id); }
  async close(): Promise<void> { this.stopped = true; this.stopObserving?.(); clearInterval(this.timer); await Promise.allSettled([...this.active]); this.credentials.clear(); await this.waits.drain(); }
}
