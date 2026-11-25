import { type WriterScope } from "./writer-scope.js";
import { automaticParkId, overdueBlockingQuestion } from "./native-parking.js";
import { TrackedNativeProcesses } from "./tracked-process.js";
import { trackedAdapter } from "./tracked-adapter.js";
import { questionAnswers } from "./decision-answers.js";
import { syncDecisionDeliveries } from "./decision-continuation.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentResponseInput, AgentRunControlInput, AgentPendingDecision, AgentQuestionResponse, AgentAuthorizationRequest } from "@hosty-sdk/app/agent";
import { AgentApiError } from "@hosty-sdk/app/agent";
import type { DecisionAnswers, DecisionRecord } from "@hosty-sdk/app/decisions";
import { WorkerEngine } from "./internal/worker/engine.js";
import { WorkerJournal, digest } from "./internal/worker/journal.js";
import { WorkerApiError, type WorkerRunRequest } from "./internal/worker/contracts.js";
import { prepareNativeInput, type NativeInputPreparer } from "./engine.js";
import type { ProviderConnections } from "./internal/connections/registry.js";
import type { ProviderController, ExecutionDriver } from "./controller.js";
import type { ProviderAuthority } from "./core.js";
import type { AttachmentStore } from "./attachments.js";
import { ProviderMcp, mcpTargetKey } from "./mcp.js";
import { projectEvent, projectReceipt, publicToolId, publicSource } from "./projection.js";
import { ProviderStore, increment, type ConfigurationRecord, type SessionRecord, type RunRecord } from "./store.js";

const stableUuid = (input: string) => { const hash = createHash("sha256").update(input).digest("hex"); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`; };
/** Core stores a bounded summary; the public/provider decision retains its original detail. */
export function coreDecisionTitle(value: string | undefined, fallback: string): string {
  let title = "";
  for (const character of (value ?? "").replace(/\p{Cc}/gu, " ").trim()) {
    if (title.length + character.length > 160) break;
    title += character;
  }
  return title.trim() || fallback;
}
export class NativeExecution implements ExecutionDriver {
  readonly engine: WorkerEngine;
  readonly mcp: ProviderMcp;
  private readonly journal: WorkerJournal;
  private processes = new Map<string, TrackedNativeProcesses>();
  private subscriptions = new Map<string, () => void>();
  private requests = new WeakMap<WorkerRunRequest, string>();
  private pendingSync = new Map<string, Promise<void>>();
  private pendingCleanup = new Map<string, Promise<void>>();
  private syncAgain = new Set<string>();
  private readonly pendingAdmission = new Map<string, string>();
  private readonly admittedPreparations = new Set<string>();
  private timer?: NodeJS.Timeout;
  private maintenance?: Promise<void>;
  private closing = false;
  constructor(private readonly controller: ProviderController, private readonly store: ProviderStore, private readonly authority: ProviderAuthority,
    private readonly connections: ProviderConnections, private readonly attachments: AttachmentStore, private readonly data: string, origin: () => string, private readonly prepareInput: NativeInputPreparer = prepareNativeInput, gitSkillWorkflowTimeoutMs?: number, private readonly ownedAttempt?: string, private readonly writerScope?: WriterScope) {
    this.journal = new WorkerJournal(path.join(data, "native-attempts-v2"), undefined, undefined, "local", store.databasePath);
    this.mcp = new ProviderMcp(authority, origin, (id, event) => this.proxyDecision(id, event), (id, decisionId, _tool, allowed, automatic) => this.proxySettled(id, decisionId, allowed, automatic), gitSkillWorkflowTimeoutMs, !!writerScope);
    const deliver = async <T>(id: string, start: () => Promise<T>): Promise<T> => {
      const started = await store.exclusive(async () => {
        const { session, record } = await store.run(id);
        if (session.retirement || record.decisionsFenced || record.snapshot.stopConfirmed || deadlineReached(record))
          throw new AgentApiError("run_fenced", "The attempt has closed its tool gates.", 409);
        return { result: start() };
      });
      return started.result;
    };
    this.mcp.proxy.dispatch = deliver;
    this.mcp.workflow.dispatch = deliver;
    this.engine = new WorkerEngine(this.journal, {
      launch: (id, action) => store.exclusive(async () => {
        const { session, record } = await store.run(id);
        if (session.retirement || record.decisionsFenced || record.snapshot.stopConfirmed || deadlineReached(record)) return false;
        action();
        return true;
      }),
      validateSelection: async request => { const binding = await connections.binding(request.binding.connectionId); if (!binding || binding.connectionRevision !== request.binding.connectionRevision) throw new AgentApiError("connection_revision_mismatch", "Provider connection changed.", 409); },
      reserve: request => connections.reserve(request.binding),
      cwd: async request => { const id = this.requests.get(request); if (!id) throw new Error("Missing admitted execution identity."); const { record } = await store.run(id); return record.workspaces?.[0]?.path ?? path.join(data, "workspaces", request.conversationId); },
      adapter: async request => { const { session, record } = await store.run(this.requests.get(request)!); const configuration = session.configurations[record.snapshot.configurationRevision]!;
        if (!configuration.skillPath) throw new Error("The immutable skill snapshot is unavailable.");
        const isolated = await connections.prepareAdapter(configuration.binding!, { skillPath: configuration.skillPath, sessionDirectory: path.join(data, "native-sessions", session.id) });
        const writable = record.input?.resources?.some(resource => resource.kind === "worktree") === true;
        if (this.ownedAttempt && writable && !this.writerScope) throw new AgentApiError("unsupported_capability", "A verified writable workspace scope is unavailable on this host.", 422);
        const processes = await TrackedNativeProcesses.create(data, record.snapshot.ref.id, record.snapshot.generation, this.writerScope); this.processes.set(record.snapshot.ref.id, processes);
        return trackedAdapter(isolated, processes); },
    }, controller.capacity);
  }
  async initialize(): Promise<void> {
    await this.journal.initialize(this.store.historicalRunIds, this.ownedAttempt);
    const due = this.ownedAttempt ? [(await this.store.run(this.ownedAttempt)).session] : await this.store.recordsDue();
    for (const session of due) for (const run of Object.values(session.runs)) {
      const id = run.snapshot.ref.id;
      if (this.ownedAttempt && id !== this.ownedAttempt) continue;
      this.observe(id);
      await this.synchronize(id);
      if (session.retirement?.runId === id || run.reservedFor || run.snapshot.stopConfirmed) continue;
      await this.reconcileOwnedStop(id).catch(() => {});
      if (this.ownedAttempt && session.session.activeRun?.id === id) {
        const native = await this.journal.load(id).catch(error => {
          if (error instanceof WorkerApiError && error.status === 404) return null;
          throw error;
        });
        if (!native) this.controller.background(this.start(session.id, id));
      } else if (session.session.activeRun?.id === id) {
        await this.failBeforeStart(id, "Provider restarted before native admission; the input was not replayed.");
      }
    }
    this.timer = setInterval(() => { void this.maintain().catch(() => {}); }, 2000); this.timer.unref();
  }
  private observe(id: string) { if (!this.subscriptions.has(id)) this.subscriptions.set(id, this.journal.subscribe(id, () => { void this.synchronize(id).catch(() => {}); })); }
  async start(sessionId: string, runId: string): Promise<void> {
    this.observe(runId);
    try {
      const initial = await this.store.run(runId); if (initial.record.snapshot.stopConfirmed) return;
      if (initial.record.decisionsFenced) { await this.failBeforeStart(runId, "Cancelled before native admission.", true); return; }
      const admittedAuthority = await this.authority.admit(initial.record.admissionRef, initial.record.snapshot.generation) as { ceiling?: AgentAuthorizationRequest["ceiling"] } | null;
      this.admittedPreparations.add(runId);
      const grantedUntil = (admittedAuthority as { expiresAt?: string } | null)?.expiresAt;
      if (grantedUntil && Number.isFinite(Date.parse(grantedUntil))) await this.store.exclusive(async () => {
        const admitted = await this.store.run(runId); admitted.record.authorityExpiresAt = grantedUntil; await this.store.save(admitted.session);
      });
      let { session, record } = await this.store.run(runId);
      if (record.snapshot.stopConfirmed) return;
      if (record.decisionsFenced || record.snapshot.phase === "cancelling") { await this.failBeforeStart(runId, "Cancelled before native admission.", true); return; }
      await this.mcp.workflow.configure(runId, record.admissionRef, admittedAuthority?.ceiling?.workflow);
      const input = record.input!, configuration = session.configurations[input.configurationRevision]!;
      if (configuration.configuration.skills?.length) {
        if (!configuration.pinRequestId) throw new AgentApiError("skill_snapshot_unavailable", "The original skill snapshot identity is unavailable.", 503);
        const pinned = await this.authority.skills(record.admissionRef, configuration.pinRequestId, configuration.pinRequestId, configuration.configuration.skills);
        requirePinnedSnapshot(configuration, pinned);
      }
      const resources = input.resources ?? [], workspaces = resources.filter(value => value.kind === "worktree"), workspace = workspaces[0];
      if (resources.some(value => value.kind !== "worktree")) throw new AgentApiError("unsupported_resource", "Only a revisioned Core worktree is supported as an execution directory.", 422);
      for (const workspace of workspaces) {
        const resolved = await this.authority.workspace<{ id: string; revision: string; path: string }>(record.admissionRef, "resolve", { workspaceId: workspace.id, expectedRevision: workspaceRevision(workspace.revision) });
        const leaseId = stableUuid(`${runId}:${workspace.id}:lease-id`);
        const pending = await this.store.exclusive(async () => {
          const fresh = await this.store.run(runId);
          if (fresh.record.decisionsFenced || fresh.record.snapshot.stopConfirmed || fresh.record.snapshot.phase === "cancelling") return false;
          if (!fresh.record.workspaces?.some(value => value.leaseId === leaseId)) (fresh.record.workspaces ??= []).push({ ...resolved, revision: String(resolved.revision), leaseId, leasePending: true });
          await this.store.save(fresh.session);
          return true;
        });
        if (!pending) { this.mcp.close(runId); await this.failBeforeStart(runId, "Cancelled before native admission.", true); return; }
        await this.authority.workspace(record.admissionRef, "lease", { workspaceId: workspace.id, leaseId, requestId: stableUuid(`${runId}:${workspace.id}:lease`), title: "Native agent execution", viewerPath: "/" });
        ({ session, record } = await this.store.exclusive(async () => {
          const fresh = await this.store.run(runId);
          const binding = fresh.record.workspaces!.find(value => value.leaseId === leaseId)!;
          delete binding.leasePending;
          await this.store.save(fresh.session);
          return fresh;
        }));
        if (record.snapshot.stopConfirmed) return;
      }
      if (!workspace) await mkdir(path.join(this.data, "workspaces", sessionId), { recursive: true, mode: 0o700 });
      const mcp = await this.mcp.configure(runId, record.admissionRef, input.mcp, configuration.configuration.approvalMode === "autonomous");
      let text: string;
      if ("text" in input.input) text = input.input.text;
      else {
        const source = session.runs[input.input.decisionResponseRef.runId], response = source?.controls[input.input.decisionResponseRef.requestId];
        if (!response?.response || response.receipt.continuation?.run.id !== runId) throw new AgentApiError("decision_continuation_missing", "The original decision response is unavailable.", 409);
        text = "The user answered your previous question:\n" + JSON.stringify(response.decision ? questionAnswers(response.decision, response.response as AgentResponseInput["response"]) : response.response);
      }
      const refs = "text" in input.input ? input.input.attachments ?? [] : [];
      if (refs.length > 20 || refs.reduce((total, ref) => total + ref.sizeBytes, 0) > 100 * 1024 * 1024) throw new AgentApiError("attachment_limit", "Turn attachments exceed the provider limit.", 413);
      const resolvedAttachments = await Promise.all(refs.map(async ref => ({ ...ref, path: await this.attachments.resolve(ref, session.owner) })));
      const prepared = await this.prepareInput({ text, attachments: resolvedAttachments, configuration: configuration.configuration, skillPath: configuration.skillPath! });
      text = prepared.text;
      const systemPrompt = [prepared.instructions, ...(configuration.configuration.instructions ?? []).map(value => value.text), configuration.configuration.systemPrompt?.text, ...(record.workspaces ?? []).map(value => `Authorized worktree ${value.id} at revision ${value.revision}: ${value.path}`), ...(input.context ?? []).map(value => value.text)].filter(Boolean).join("\n\n");
      const request: WorkerRunRequest = { conversationId: sessionId, binding: configuration.binding!, input: text, selection: input.selection ?? { model: null, reasoningEffort: null },
        resource: workspace ? { kind: "worktree", id: workspace.id, revision: workspace.revision } : { kind: "conversation", id: sessionId },
        operation: "chat", skillExportId: configuration.snapshotId, autoAllowedPrefixes: mcp.prefixes,
        options: { systemPrompt, autonomy: configuration.configuration.approvalMode ?? "normal", mcpServers: mcp.servers,
          promptSuggestions: configuration.configuration.predictions?.enabled === true, nativeTools: configuration.configuration.nativeTools, subagents: configuration.configuration.subagents,
          ...(session.nativeId ? { resumeHarnessSessionId: session.nativeId, requireNativeResume: true } : {}) } };
      this.requests.set(request, runId);
      const stopReason = await this.store.exclusive(async () => { const fresh = await this.store.run(runId);
        if (fresh.record.decisionsFenced || fresh.record.snapshot.phase === "cancelling" || fresh.record.snapshot.stopConfirmed) return "Cancelled before native admission.";
        if (deadlineReached(fresh.record)) return "Execution deadline reached before native dispatch.";
        fresh.record.startIntent = true; await this.store.save(fresh.session); return null; });
      if (stopReason) { this.mcp.close(runId); await this.failBeforeStart(runId, stopReason, true); }
      else await this.engine.submit(runId, request);
      await this.synchronize(runId);
    } catch (error) {
      this.mcp.close(runId);
      const { record } = await this.store.run(runId);
      if (error instanceof AgentApiError && error.retryable && error.status >= 500 && !record.startIntent
        && !record.decisionsFenced && !record.snapshot.stopConfirmed && !deadlineReached(record)) {
        // Every operation before native admission reuses the original Core identity and lease IDs.
        this.pendingAdmission.set(runId, sessionId);
      } else {
        await this.failBeforeStart(runId, error instanceof AgentApiError ? error.message : "Native execution could not be prepared. Inspect provider availability.");
      }
    }
    finally { this.admittedPreparations.delete(runId); }
  }
  private async failBeforeStart(id: string, message: string, cancelled = false): Promise<void> {
    const native = await this.journal.load(id).catch(error => { if (error instanceof WorkerApiError && error.status === 404) return null; throw error; });
    if (native) { await this.synchronize(id); return; }
    await this.store.exclusive(async () => { const { session, record } = await this.store.run(id); if (record.snapshot.stopConfirmed) return;
      const stopped = cancelled || record.decisionsFenced || record.snapshot.phase === "cancelling";
      record.snapshot.state = stopped ? "cancelled" : "failed"; record.snapshot.phase = "terminal"; record.snapshot.stopConfirmed = true;
      record.snapshot.result = stopped ? { status: "cancelled" } : { status: "failed", error: { code: "native_admission_failed", message, retryable: false } };
      if (session.session.activeRun?.id === id) { session.session.activeRun = null; session.session.revision = increment(session.session.revision); }
      this.store.lifecycle(record); this.store.emit(record, "result.available", { result: record.snapshot.result }); await this.store.save(session);
    });
    await this.cleanup(id);
  }
  synchronize(id: string): Promise<void> {
    if (this.closing) return this.pendingSync.get(id) ?? Promise.resolve();
    return this.scheduleSync(id);
  }
  private scheduleSync(id: string): Promise<void> {
    const old = this.pendingSync.get(id); if (old) { this.syncAgain.add(id); return old; }
    const task = (async () => {
      do {
        this.syncAgain.delete(id);
        await this.store.exclusive(async () => {
          const native = await this.journal.load(id).catch(error => { if (error instanceof WorkerApiError && error.status === 404) return null; throw error; }); if (!native) return;
          const { session, record } = await this.store.run(id);
          if (record.nativeRevision === native.receipt.revision && record.nativeUsageSequence === native.receipt.usage?.sequence) return;
          record.nativeUsageSequence = native.receipt.usage?.sequence;
          for (const frame of native.events) projectEvent(this.store, session, record, frame);
          projectReceipt(this.store, session, record, native.receipt); await this.store.save(session);
        });
      } while (this.syncAgain.has(id));
      const { record } = await this.store.run(id); if (record.snapshot.stopConfirmed && !record.reservedFor) await this.cleanup(id);
    })();
    this.pendingSync.set(id, task);
    void task.finally(() => { if (this.pendingSync.get(id) === task) { this.pendingSync.delete(id); if (this.syncAgain.delete(id)) void this.scheduleSync(id).catch(() => {}); } }).catch(() => {});
    return task;
  }
  async cancel(id: string, requestId: string): Promise<void> {
    this.mcp.close(id);
    const native = await this.journal.load(id).catch(error => { if (error instanceof WorkerApiError && error.status === 404) return null; throw error; });
    if (native) await this.engine.cancel(id, requestId);
    else await this.failBeforeStart(id, "Cancelled before native admission.", true);
    // A preparing start observes the durable cancelling phase before native admission.
  }
  async respond(id: string, input: AgentResponseInput): Promise<void> {
    const { session, record } = await this.store.run(id);
    if (session.retirement || record.decisionsFenced) throw new AgentApiError("run_fenced", "This run no longer accepts decision responses.", 409);
    await this.authority.renew(record.admissionRef);
    const dispatch = async (action: () => boolean | Promise<boolean>) => {
      const launched = await this.store.exclusive(async () => {
        const { record: fresh } = await this.store.run(id);
        if (fresh.decisionsFenced || fresh.snapshot.stopConfirmed || deadlineReached(fresh))
          throw new AgentApiError("run_fenced", "The attempt has stopped accepting decisions.", 409);
        return { delivery: action() };
      });
      return launched.delivery;
    };
    const prior = await this.journal.controlOutcome(id, input.requestId);
    if (prior.state === "applied") return;
    if (prior.state === "unknown") throw new AgentApiError("decision_delivery_unknown", "The prior native decision was dispatched without a receipt.", 502);
    if (input.response.kind === "approval") {
      const allowed = input.response.decision === "allow";
      if (await dispatch(() => this.mcp.resolve(id, input.decisionId, allowed))) return;
    }
    const native = await this.journal.load(id), frame = native.receipt.pending?.find(frame => {
      const event = frame.event; return event.type === "approval_request" && event.approvalId === input.decisionId || event.type === "question_request" && event.questionId === input.decisionId;
    });
    if (!frame) throw new AgentApiError("stale_decision", "The native request is no longer pending.", 409);
    await this.engine.respond(id, { controlId: input.requestId, expectedRevision: native.receipt.revision, eventId: frame.sequence,
      ...(input.response.kind === "approval" ? { kind: "approval", id: input.decisionId, decision: input.response.decision, message: input.response.message }
        : { kind: "question", id: input.decisionId, answers: questionAnswers(record.controls[input.requestId]!.decision!, input.response) }) }, dispatch);
  }
  async control(id: string, input: AgentRunControlInput): Promise<void> {
    const { session, record } = await this.store.run(id);
    if (session.retirement) throw new AgentApiError("session_retired", "This native session has been retired.", 409);
    if (input.command === "reconcile") { await this.reconcileOwnedStop(id, input.requestId); return; }
    const native = await this.journal.load(id);
    if (input.command === "park") {
      const frame = native.receipt.pending?.find(frame => frame.event.type === "question_request" && frame.event.questionId === input.decisionId && String(frame.sequence) === input.decisionRevision);
      if (!frame) throw new AgentApiError("stale_decision", "The native question cannot be parked.", 409);
      await this.engine.park(id, { controlId: input.requestId, eventId: frame.sequence, expectedRevision: native.receipt.revision, id: input.decisionId });
    } else if (input.command === "barrier") {
      // Public event sequence and native sequence are distinct domains. Match the exact projected acknowledgement.
      const event = record.events.find(event => event.sequence === input.acknowledgedSequence), toolId = event?.data.toolCallId;
      const frame = native.events.find(frame => frame.event.type === "tool_result" && publicToolId(frame.event.toolUseId, publicSource(frame.event.source).agentId) === toolId);
      if (!frame && input.kind !== "source_rebind" && input.kind !== "limits") throw new AgentApiError("barrier_pending", "The exact native acknowledgement is unavailable.", 409);
      await this.engine.barrier(id, { controlId: input.requestId, expectedRevision: native.receipt.revision, barrierId: input.barrierId, kind: input.kind,
        generation: Number(input.generation), acknowledgedSequence: frame?.sequence ?? 0, ...(!frame ? { origin: "coordinator" as const } : {}) });
    } else if (input.command === "predictions") {
      if (input.enabled) throw new AgentApiError("unsupported_control", "Predictions must be selected before a native turn starts.", 422);
      await this.engine.disableSuggestions(id, input.requestId);
    } else if (input.command === "mcpPolicy") {
      await this.authority.renew(record.admissionRef);
      const admitted = new Set((record.input?.mcp?.targets ?? []).map(value => mcpTargetKey(value.target)));
      if (input.mcp.connections?.length || (input.mcp.targets ?? []).some(value => !admitted.has(mcpTargetKey(value.target)))) throw new AgentApiError("configuration_outside_ceiling", "Policy updates can narrow admitted targets; a new target requires a freshly authorized turn.", 422);
      await this.mcp.configure(id, record.admissionRef, input.mcp, session.configurations[record.snapshot.configurationRevision]!.configuration.approvalMode === "autonomous");
    } else if (input.command === "liveConfigure") {
      await this.authority.renew(record.admissionRef);
      const mcp = await this.mcp.configure(id, record.admissionRef, input.mcp, session.configurations[record.snapshot.configurationRevision]!.configuration.approvalMode === "autonomous");
      if (!(await this.engine.configure(id, mcp.servers, mcp.prefixes)).applied) throw new AgentApiError("configuration_not_applied", "Native configuration was not applied.", 409);
    }
  }
  async retirementEvidence(run: RunRecord): Promise<{ nativeGeneration: string; nativeRevision: number }> {
    const id = run.snapshot.ref.id;
    const native = await this.journal.load(id).catch(error => {
      if (error instanceof WorkerApiError && error.status === 404) return null;
      throw error;
    });
    const receipt = native?.receipt;
    if (run.input && !run.reservedFor && !this.engine.ownsExecution(id)
      && receipt?.conversationId === run.snapshot.sessionId && receipt.generation === run.nativeGeneration
      && (receipt.state === "interrupted" || receipt.exitConfirmed === true && ["completed", "failed", "cancelled"].includes(receipt.state))) {
      // A provider crash can leave an interrupted journal after the tracked SDK and tree have stopped.
      const evidence = await TrackedNativeProcesses.readEvidence(this.data, id, run.snapshot.generation);
      if (evidence.stopped && evidence.allClosed)
        return { nativeGeneration: receipt.generation, nativeRevision: receipt.revision };
    }
    throw new AgentApiError("retirement_exit_unconfirmed", "The provider has not confirmed native exit for this execution.", 409);
  }

  async releaseRetired(id: string): Promise<void> {
    await this.cleanup(id, true);
  }

  private async reconcileOwnedStop(id: string, requestId = stableUuid(`${id}:native-stop-proof`)): Promise<void> {
    const { record } = await this.store.run(id), native = await this.journal.load(id).catch(error => { if (error instanceof WorkerApiError && error.status === 404) return null; throw error; });
    if (record.snapshot.stopConfirmed) return;
    if (!native || native.receipt.state !== "interrupted" || native.receipt.exitConfirmed)
      throw new AgentApiError("exit_unconfirmed", "The retained native execution is not eligible for provider-owned stop reconciliation.", 409);
    if (this.engine.ownsExecution(id)) return;
    const evidence = await TrackedNativeProcesses.readEvidence(this.data, id, record.snapshot.generation, this.ownedAttempt === id);
    if (!evidence.stopped || !evidence.allClosed) throw new AgentApiError("exit_unconfirmed", "Awaiting the execution scope's exit receipt.", 409);
    await this.journal.exclusive(async () => {
      if ((await this.journal.load(id)).receipt.state === "interrupted")
        await this.journal.update(id, record.decisionsFenced ? "cancelled" : "failed", "The original execution supervisor exited.");
    });
    await this.synchronize(id);
    const nativeId = native.receipt.snapshot?.nativeSessionId, checkpoint = this.journal.observations(id);
    const observations = checkpoint?.read() as { items?: unknown[] } | undefined;
    if (this.ownedAttempt === id && nativeId && checkpoint && observations?.items?.length && this.connections.recoverChildObservations) {
      // Physical closure was published before reading history. Replay only missing observations;
      // this read-only provider API cannot start a turn or repeat an external tool.
      const writes: Promise<unknown>[] = [];
      await this.connections.recoverChildObservations({ sessionId: record.snapshot.sessionId, nativeId, attemptId: id,
        checkpoint: { ...checkpoint, flush: async () => { await Promise.all(writes); } },
        emit: event => {
          const write = this.journal.exclusive(async () => {
            const current = await this.journal.load(id);
            const identity = digest(event);
            if (!current.events.some(frame => digest(frame.event) === identity)) await this.journal.append(id, event);
          });
          writes.push(write);
          void write.catch(() => {});
        },
      }).catch(() => {});
      await Promise.allSettled(writes);
      await this.synchronize(id);
    }
  }
  private async proxyDecision(id: string, event: { approvalId: string; toolName: string; input: unknown }) {
    await this.store.exclusive(async () => { const { session, record } = await this.store.run(id);
      if (session.retirement || record.decisionsFenced || record.snapshot.stopConfirmed) throw new AgentApiError("run_fenced", "The attempt has stopped accepting decisions.", 409);
      const decision: AgentPendingDecision = { id: event.approvalId, revision: "1", kind: "approval", delivery: "continue_run", toolName: event.toolName, input: event.input };
      (record.proxyDecisions ??= []).push(decision.id); record.snapshot.pending.push(decision); record.snapshot.state = "waiting_for_input"; record.snapshot.phase = "waiting";
      this.store.lifecycle(record); this.store.emit(record, "decision.requested", { decisionId: decision.id, decision }); await this.store.save(session);
    });
  }
  private async proxySettled(id: string, decisionId: string, allowed: boolean, automatic: boolean) {
    if (automatic) return;
    await this.store.exclusive(async () => { const { session, record } = await this.store.run(id); record.proxyDecisions = record.proxyDecisions?.filter(value => value !== decisionId); record.snapshot.pending = record.snapshot.pending.filter(value => value.id !== decisionId);
      if (record.snapshot.phase === "waiting" && !record.snapshot.pending.length) { record.snapshot.state = "running"; record.snapshot.phase = "executing"; }
      this.store.lifecycle(record); this.store.emit(record, "decision.resolved", { decisionId, state: allowed ? "allowed" : "denied" }); await this.store.save(session);
    });
  }
  /** Periodic provider-owned renewal, question parking and Decision delivery. */
  maintain(): Promise<void> {
    if (this.maintenance) return this.maintenance;
    const task = this.pump().finally(() => { if (this.maintenance === task) this.maintenance = undefined; });
    this.maintenance = task; return task;
  }
  private async pump(): Promise<void> {
    for (const [id, sessionId] of this.pendingAdmission) {
      this.pendingAdmission.delete(id);
      this.controller.background(this.start(sessionId, id));
    }
    const sessions = this.ownedAttempt ? [(await this.store.run(this.ownedAttempt)).session] : await this.store.recordsDue();
    for (const session of sessions) for (const record of Object.values(session.runs)) {
      const id = record.snapshot.ref.id;
      if (this.ownedAttempt && id !== this.ownedAttempt) continue;
      if (this.ownedAttempt && record.snapshot.phase === "interrupted") await this.reconcileOwnedStop(id).catch(() => {});
      if (record.input && record.snapshot.stopConfirmed && !record.reservedFor && record.workspaceRelease?.state !== "released")
        await this.cleanup(id, true).catch(() => {});
      if (session.retirement) {
        const { runId, requestId } = session.retirement;
        if (runId === id && record.controls[requestId]?.receipt.state !== "applied")
          await this.controller.finishRetirement(id, requestId).catch(() => {});
        if (record.decisionLinks || record.decisionDeliveries)
          await syncDecisionDeliveries(this.store, this.controller, this.authority, id).catch(() => {});
        continue;
      }
      if (!record.snapshot.stopConfirmed) {
        try {
          if (deadlineReached(record)) throw new Error("Execution deadline reached.");
          // Core rejects renewal until it has acknowledged admission. Native revisions also cover retained older runs.
          if (this.admittedPreparations.has(id) || record.startIntent || record.nativeRevision >= 0)
            await this.renewExecution(session, record);
        } catch (error) {
          // A temporary Core outage can use only the original unexpired grant.
          const temporary = error instanceof AgentApiError && error.status >= 500;
          if (!temporary || !record.authorityExpiresAt || Date.parse(record.authorityExpiresAt) <= Date.now()) {
            const command = { requestId: stableUuid(`${id}:authority-expired`) };
            await this.controller.cancel(id, command, JSON.stringify(command), {
              ...session.owner, provider: this.store.provider, operation: "runs.cancel", admissionRef: record.admissionRef,
            }).catch(() => {});
          }
        }
      }
      await this.parkOverdueQuestion(id).catch(() => {});
      if (record.snapshot.pending.length) await this.decisions(session, record).catch(() => {});
      if (record.decisionLinks || record.decisionDeliveries || record.snapshot.pending.length) await syncDecisionDeliveries(this.store, this.controller, this.authority, id).catch(() => {});
    }
  }
  private async renewExecution(session: SessionRecord, record: RunRecord): Promise<void> {
    const renewed = await this.authority.renew(record.admissionRef) as { expiresAt?: string } | null;
    if (renewed?.expiresAt && Number.isFinite(Date.parse(renewed.expiresAt))) {
      const expiry = renewed.expiresAt;
      await this.store.exclusive(async () => {
        const fresh = await this.store.run(record.snapshot.ref.id);
        fresh.record.authorityExpiresAt = expiry; await this.store.save(fresh.session);
      });
    }
    const pinned = session.configurations[record.snapshot.configurationRevision];
    if (pinned?.configuration.skills?.length) {
      if (!pinned.pinRequestId) throw new AgentApiError("skill_snapshot_unavailable", "The original skill snapshot identity is unavailable.", 503);
      requirePinnedSnapshot(pinned, await this.authority.skills(record.admissionRef, pinned.pinRequestId, pinned.pinRequestId, pinned.configuration.skills));
    }
    for (const workspace of record.workspaces ?? []) {
      if (workspace.leasePending) continue;
      const activity = await this.authority.workspace<{ stopRequested?: boolean }>(record.admissionRef, "activity", { workspaceId: workspace.id, leaseId: workspace.leaseId, requestId: randomUUID(), sequence: Date.now(), status: record.snapshot.state });
      if (activity.stopRequested) throw new AgentApiError("workspace_stop_requested", "Core requested this execution to stop using its workspace.", 409);
    }
  }
  private async parkOverdueQuestion(id: string): Promise<void> {
    const { record } = await this.store.run(id);
    if (record.snapshot.stopConfirmed || record.snapshot.phase !== "waiting") return;
    const native = await this.journal.load(id), frame = overdueBlockingQuestion(record, native, Date.now());
    if (!frame || frame.event.type !== "question_request") return;
    await this.engine.park(id, { controlId: automaticParkId(id, native.receipt.generation, frame.sequence),
      expectedRevision: native.receipt.revision, eventId: frame.sequence, id: frame.event.questionId });
    await this.synchronize(id);
  }
  private async decisions(session: SessionRecord, record: RunRecord): Promise<void> {
    const client = this.authority.decisions(record.admissionRef), id = record.snapshot.ref.id;
    for (const pending of record.snapshot.pending) {
      let decisionId = record.decisionLinks?.[pending.id];
      if (!decisionId) {
        const created = await client.create({ requestId: stableUuid(`${id}:${pending.id}:decision`), input: { correlationKey: `${id}:${pending.id}`, title: coreDecisionTitle(pending.title, pending.kind === "approval" ? "Allow agent tool execution?" : "Agent needs your answer"),
          subject: { kind: "agent-run", id, revision: record.snapshot.generation }, waitReference: record.admissionRef,
          questions: pending.kind === "approval" ? [{ id: "approval", question: pending.toolName ?? "Allow this action?", options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }], allowText: true }]
            : (pending.questions ?? []).map(q => ({ id: q.id, question: q.text, header: q.header, options: q.options, allowText: q.allowText, multiple: q.multiple })) } });
        decisionId = created.id;
        await this.store.exclusive(async () => { const fresh = await this.store.run(id); (fresh.record.decisionLinks ??= {})[pending.id] = created.id; await this.store.save(fresh.session); });
      }
      const decision = await client.get(decisionId);
      if (decision.state !== "answered" || !decision.resolution) continue;
      const response = responseFromDecision(pending, decision.resolution.answers), fresh = await this.store.run(id);
      const current = fresh.record.snapshot.pending.find(value => value.id === pending.id); if (!current) continue;
      const input: AgentResponseInput = { requestId: stableUuid(`${decision.id}:${decision.resolution.revision}:deliver`), expectedGeneration: fresh.record.snapshot.generation, expectedRevision: fresh.record.snapshot.revision,
        decisionId: current.id, decisionRevision: current.revision, response };
      await this.store.exclusive(async () => {
        const fresh = await this.store.run(id), deliveries = fresh.record.decisionDeliveries ??= {};
        deliveries[decision.id] ??= { decisionId: decision.id, resolutionRevision: decision.resolution!.revision,
          input, commandId: stableUuid(`${decision.id}:${decision.resolution!.revision}:continuation`) };
        await this.store.save(fresh.session);
      });
      await syncDecisionDeliveries(this.store, this.controller, this.authority, id);
    }
  }
  private cleanup(id: string, retryPending = false): Promise<void> {
    this.mcp.close(id);
    const old = this.pendingCleanup.get(id); if (old) return old;
    const task = this.releaseWorkspace(id, retryPending).finally(() => { if (this.pendingCleanup.get(id) === task) this.pendingCleanup.delete(id); });
    this.pendingCleanup.set(id, task); return task;
  }
  private async releaseWorkspace(id: string, retryPending: boolean): Promise<void> {
    const intent = await this.store.exclusive(async () => {
      const { session, record } = await this.store.run(id);
      // Reservation/cancel-fence placeholders never admitted an execution or acquired its leases.
      const stopped = record.snapshot.stopConfirmed || session.retirement?.runId === id;
      if (!record.input || !stopped || record.reservedFor) return null;
      const fresh = !record.workspaceRelease;
      if (fresh) {
        record.workspaceRelease = { requestId: stableUuid(`${id}:release-all`), state: "pending" };
        await this.store.save(session);
      }
      return { admissionRef: record.admissionRef, release: { ...record.workspaceRelease! }, fresh };
    });
    if (!intent) return;
    this.processes.delete(id);
    // Reads may synchronize a terminal run repeatedly; only the maintenance pump retries an existing intent.
    if (intent.release.state === "released" || !intent.fresh && !retryPending) return;
    let receipt: { state?: string } | null;
    try { receipt = await this.authority.workspace(intent.admissionRef, "release_all", { requestId: intent.release.requestId }); }
    catch { return; } // Ambiguous delivery retains the original durable identity for the next pump/restart.
    if (receipt?.state !== "released") return;
    await this.store.exclusive(async () => {
      const { session, record } = await this.store.run(id);
      if (record.workspaceRelease?.requestId !== intent.release.requestId || record.workspaceRelease.state === "released") return;
      record.workspaceRelease.state = "released"; await this.store.save(session);
    });
  }
  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.engine.close("Provider is shutting down.");
    if (this.maintenance) await Promise.allSettled([this.maintenance]);
    for (const dispose of this.subscriptions.values()) dispose();
    this.closing = true;
    // Journal notifications can queue another projection during the preceding pass's final read.
    while (this.pendingSync.size || this.pendingCleanup.size) {
      await Promise.allSettled([...this.pendingSync.values(), ...this.pendingCleanup.values()]);
    }
    this.journal.close();
    await this.connections.shutdown();
  }
}
function deadlineReached(record: RunRecord): boolean { return !!record.deadline && Date.now() >= Date.parse(record.deadline); }
function requirePinnedSnapshot(configuration: ConfigurationRecord, pinned: Awaited<ReturnType<ProviderAuthority["skills"]>>): void {
  const identities = (skills: Array<{ skillId: string; digest: string }>) => JSON.stringify(skills.map(skill => ({ skillId: skill.skillId, digest: skill.digest })).sort((a, b) => a.skillId.localeCompare(b.skillId) || a.digest.localeCompare(b.digest)));
  if (!configuration.snapshotId || !configuration.skillPath || !configuration.snapshotDigest)
    throw new AgentApiError("skill_snapshot_unavailable", "The original immutable skill snapshot evidence is unavailable.", 503);
  if (pinned.id !== configuration.snapshotId || pinned.path !== configuration.skillPath || pinned.digest !== configuration.snapshotDigest
    || !Array.isArray(pinned.skills) || identities(pinned.skills) !== identities(configuration.resolvedSkills))
    throw new AgentApiError("skill_snapshot_changed", "The original immutable skill snapshot could not be revalidated.", 409);
}
export function responseFromDecision(pending: AgentPendingDecision, answers: DecisionAnswers): AgentResponseInput["response"] {
  if (pending.kind === "approval") return { kind: "approval", decision: answers.approval?.optionIds?.includes("allow") ? "allow" : "deny", ...(answers.approval?.text ? { message: answers.approval.text } : {}) };
  return { kind: "question", answers: Object.fromEntries((pending.questions ?? []).flatMap(q => {
    const answer = answers[q.id]; if (!answer) return [];
    const ids = answer.optionIds ?? [], text = answer.text?.trim();
    const value = text ? [...ids.map(id => (() => { const option = q.options?.find(option => option.id === id); return option && q.options!.filter(other => other.label === option.label).length > 1 ? `${option.label} [${option.id}]` : option?.label ?? id; })()), text].join(", ")
      : ids.length === 1 ? ids[0]! : ids;
    return [[q.id, value]];
  })) };
}

function workspaceRevision(value: string): number { if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AgentApiError("invalid_resource", "A Core worktree requires its numeric participation revision.", 422); return Number(value); }
