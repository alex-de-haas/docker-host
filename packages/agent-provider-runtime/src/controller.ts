import path from "node:path";
import { sameProvider } from "./provider-ref.js";
import { ConnectionError } from "./internal/connections/errors.js";
import { mkdir, readdir } from "node:fs/promises";
import { questionAnswers } from "./decision-answers.js";
import { projectAppliedDecisionControls } from "./projection.js";
import { randomUUID } from "node:crypto";
import type { AgentCapabilities, AgentConfiguration, AgentConfigurationCreate, AgentSessionCreate, AgentRunInput, AgentRunSnapshot, AgentResponseInput, AgentCancelInput, AgentRunControlInput, AgentControlReceipt } from "@hosty-sdk/app/agent";
import { AgentApiError } from "@hosty-sdk/app/agent";
import { ProviderStore, sameActor, bytesHash, valueHash, increment, type VerifiedOperation, type Actor, type ConfigurationRecord, type SessionRecord, type RunRecord } from "./store.js";
import type { ProviderAuthority } from "./core.js";
import type { ConnectionBinding, ProviderConnections } from "./internal/connections/registry.js";

export interface ExecutionDriver {
  readonly durableCommands?: boolean;
  start(sessionId: string, runId: string, generation?: string): Promise<void>;
  stopOwnedOnStorageFailure?(runId: string, generation: string): void;
  cancel(runId: string, requestId: string): Promise<void>;
  respond(runId: string, input: AgentResponseInput): Promise<void>;
  control(runId: string, input: AgentRunControlInput): Promise<void>;
  synchronize(runId: string): Promise<void>;
  retirementEvidence?(run: RunRecord): Promise<{ nativeGeneration: string; nativeRevision: number }>;
  releaseRetired?(runId: string): Promise<void>;
  close(): Promise<void>;
}
const conflict = (message: string, code = "stale_revision"): never => { throw new AgentApiError(code, message, 409); };
function sameRetainedAccount(previous: ConnectionBinding, current?: ConnectionBinding | null): current is ConnectionBinding {
  return !!current && previous.connectionId === current.connectionId && previous.harnessKind === current.harnessKind
    && previous.connectionIdentity === current.connectionIdentity
    && (previous.connectionRevision === current.connectionRevision || Boolean(previous.connectionIdentity));
}

function assertContinuityIdle(record: SessionRecord): void {
  if (record.retirement) conflict("This native session has been retired.", "session_retired");
  const pendingContinuation = (value?: { state: string }) => value?.state === "pending" || value?.state === "awaiting_authorization";
  const busy = Object.values(record.runs).some(run =>
    run.reservedFor || run.snapshot.phase !== "terminal" || !run.snapshot.stopConfirmed || run.snapshot.pending.length
    || run.snapshot.pendingContinuations?.some(pendingContinuation)
    || Object.values(run.controls).some(({ receipt }) => receipt.state === "accepted" || pendingContinuation(receipt.continuation))
    || run.snapshot.agents?.some(child => child.stopConfirmed === false)
    || (run.input || run.startIntent || run.workspaces?.length) && run.workspaceRelease?.state !== "released");
  if (record.session.activeRun || busy) conflict("The previous execution still has outstanding work.", "session_busy");
}

/** Public concurrency and idempotency never depend on an SDK's mutable thread state. */
export class ProviderController {
  readonly capabilities: AgentCapabilities;
  readonly tasks = new Set<Promise<unknown>>();
  driver!: ExecutionDriver;
  private closing = false;
  constructor(readonly store: ProviderStore, readonly authority: ProviderAuthority, readonly connections: ProviderConnections, capabilities: AgentCapabilities, readonly capacity = 4) { this.capabilities = structuredClone(capabilities); }
  requireCapabilities(required: string[] = []): void {
    const missing = required.filter(value => !this.capabilities.capabilities.includes(value));
    if (missing.length) throw new AgentApiError("unsupported_capability", "The provider cannot enforce a required capability.", 422, false, { missing });
  }
  private async configuration(input: AgentConfiguration, actor: VerifiedOperation, configurationId: string): Promise<ConfigurationRecord> {
    if (input.nativeTools === "none" && !this.capabilities.nativeTools?.none) throw new AgentApiError("unsupported_capability", "This provider cannot enforce nativeTools.none.", 422);
    if (input.subagents && (input.subagents.maxConcurrency !== undefined || input.subagents.enabled !== this.capabilities.subagents?.defaultEnabled && this.capabilities.subagents?.policy !== "enforceable"))
      throw new AgentApiError("unsupported_capability", "This provider cannot enforce the selected native subagent policy.", 422);
    if (input.predictions?.enabled) this.requireCapabilities(["predictions"]);
    const binding = await this.connections.binding(input.connection.id);
    if (!binding || String(binding.connectionRevision) !== input.connection.revision) conflict("Select the exact current connection.", "connection_revision_mismatch");
    // Empty selection is explicit too: native discovery uses this provider-owned isolated snapshot.
    const empty = path.resolve(this.store.directory, "..", "skill-snapshots", "empty");
    if (!input.skills?.length) { await mkdir(empty, { recursive: true, mode: 0o700 }); if ((await readdir(empty)).length) throw new AgentApiError("skill_snapshot_unavailable", "The empty native discovery snapshot is not empty.", 503); }
    const snapshot = input.skills?.length ? await this.authority.skills(actor.admissionRef, configurationId, configurationId, input.skills)
      : { id: valueHash([]), path: empty, digest: valueHash([]), skills: [] };
    const resolvedSkills = snapshot.skills.map(({ skillId, digest }) => ({ skillId, digest }));
    return { configuration: structuredClone(input), binding: binding!, digest: valueHash({ configuration: input, skills: resolvedSkills }), skillPath: snapshot.path, snapshotId: snapshot.id, snapshotDigest: snapshot.digest, pinRequestId: configurationId, resolvedSkills };
  }
  async createSession(id: string, input: AgentSessionCreate, body: string, actor: VerifiedOperation, onFresh?: () => void) {
    this.requireCapabilities(input.requiredCapabilities);
    const existing = await this.store.load(id, actor).catch(error => { if (error instanceof AgentApiError && error.status === 404) return null; throw error; });
    if (existing) { if (existing.hash !== bytesHash(body)) conflict("Session identity has different input.", "request_conflict"); return existing.session; }
    const config = await this.configuration(input.configuration, actor, id);
    return this.store.create(id, actor, body, input, config, onFresh);
  }
  private async continuityRecord(id: string, actor: VerifiedOperation) {
    const record = await this.store.load(id), original = record.session.ref.provider;
    if (record.deleted || !sameActor(record.owner, actor) || !sameProvider(actor.provider, this.store.provider)
      || !sameProvider({ ...original, installationId: this.store.provider.installationId }, this.store.provider))
      throw new AgentApiError("session_not_found", "Session not found.", 404);
    return record;
  }

  private async inspectContinuity(record: SessionRecord, selectedId?: string) {
    assertContinuityIdle(record);
    const previous = record.configurations[record.session.configurationRevision]?.binding;
    if (!previous || selectedId !== undefined && selectedId !== previous.connectionId)
      throw new AgentApiError("connection_fixed", "The original account binding cannot be confirmed.", 409);
    const current = await this.connections.binding(previous.connectionId).catch(error => {
      if (error instanceof ConnectionError && error.code === "provider_not_found") return null;
      throw new AgentApiError("continuity_unavailable", "The original account cannot be checked now.", 503, true);
    });
    if (!sameRetainedAccount(previous, current))
      throw new AgentApiError("connection_fixed", "The original account binding has changed.", 409);
    const directory = await this.connections.list().catch(() => {
      throw new AgentApiError("continuity_unavailable", "The current account is unavailable.", 503, true);
    });
    const account = directory.connections.find(value => value.id === previous.connectionId);
    if (!account || account.revision !== current.connectionRevision)
      throw new AgentApiError("connection_fixed", "The original account binding has changed.", 409);
    if (!account.available) throw new AgentApiError("continuity_unavailable", "The current account is unavailable.", 503, true);
    if (!record.nativeId) return "missing";
    if (!this.connections.inspectNativeContext) throw new AgentApiError("unsupported_capability", "The provider cannot inspect the original context.", 422);
    try { return await this.connections.inspectNativeContext(record.id, record.nativeId); }
    catch (error) {
      if (error instanceof ConnectionError && error.code === "unsupported_capability")
        throw new AgentApiError("unsupported_capability", "This native runtime cannot inspect the original thread.", 422);
      throw new AgentApiError("continuity_unavailable", "The original native thread cannot be checked now.", 503, true);
    }
  }

  async readSession(id: string, actor: VerifiedOperation) {
    if (!this.capabilities.capabilities.includes("session.reconnect")) return (await this.store.load(id, actor)).session;
    const record = await this.continuityRecord(id, actor);
    if (sameProvider(record.session.ref.provider, this.store.provider)) return record.session;
    const nativeState = await this.inspectContinuity(record);
    return { ...record.session, ref: { provider: this.store.provider, id }, nativeState };
  }

  private async reconnectSession(id: string, input: AgentConfigurationCreate, body: string, actor: VerifiedOperation, onFresh?: () => void) {
    const hash = bytesHash(body);
    const initial = await this.continuityRecord(id, actor);
    const replay = (record: SessionRecord) => {
      const receipt = record.configurationRequests[input.requestId];
      if (!receipt) return false;
      if (!sameProvider(record.session.ref.provider, this.store.provider) || receipt.hash !== hash)
        conflict("Configuration request has different input.", "request_conflict");
      return true;
    };
    if (replay(initial)) return initial.session;
    if (initial.session.revision !== input.expectedSessionRevision) conflict("The session changed.");
    if (await this.inspectContinuity(initial, input.configuration.connection.id) !== "available")
      conflict("The original native thread is missing.", "native_session_missing");
    const configuration = await this.configuration(input.configuration, actor, input.requestId);
    const previous = initial.configurations[initial.session.configurationRevision]!.binding!;
    if (!sameRetainedAccount(previous, configuration.binding))
      conflict("The original account binding has changed.", "connection_fixed");
    return this.store.exclusive(async () => {
      const record = await this.continuityRecord(id, actor);
      const moved = !sameProvider(record.session.ref.provider, this.store.provider);
      if (replay(record)) return record.session;
      if (record.session.revision !== input.expectedSessionRevision || record.nativeId !== initial.nativeId) conflict("The session changed.");
      assertContinuityIdle(record);
      const revision = increment(record.session.configurationRevision);
      if (moved) {
        await this.store.archiveInstallation(record);
        record.priorRunIds = [...record.priorRunIds ?? [], ...Object.keys(record.runs)];
        record.runs = {};
        record.configurations = {};
        record.configurationRequests = {};
        // A create from the old installation must never replay as a newly authorized creation.
        record.hash = hash;
        record.owner = { userId: actor.userId, principalId: actor.principalId, callerAppId: actor.callerAppId, callerInstallation: actor.callerInstallation };
      }
      record.configurations[revision] = configuration;
      record.configurationRequests[input.requestId] = { hash, revision };
      record.session = { ...record.session, ref: { provider: this.store.provider, id }, nativeState: "available",
        revision: increment(record.session.revision), configurationRevision: revision, configurationDigest: configuration.digest,
        configuration: configuration.configuration, resolvedSkills: configuration.resolvedSkills };
      await this.store.save(record);
      onFresh?.();
      return record.session;
    });
  }

  async configureSession(id: string, input: AgentConfigurationCreate, body: string, actor: VerifiedOperation, onFresh?: () => void) {
    this.requireCapabilities(input.requiredCapabilities);
    if (input.requiredCapabilities?.includes("session.reconnect")) return this.reconnectSession(id, input, body, actor, onFresh);
    const hash = bytesHash(body), current = await this.store.load(id, actor), previous = current.configurationRequests[input.requestId];
    if (previous) { if (previous.hash !== hash) conflict("Configuration request has different input.", "request_conflict"); return current.session; }
    if (current.retirement) conflict("This native session has been retired.", "session_retired");
    if (current.session.activeRun) conflict("The previous execution must stop before configuring this session.", "session_busy");
    if (current.session.revision !== input.expectedSessionRevision) conflict("The session changed.");
    if (current.nativeId && valueHash(current.session.configuration?.connection) !== valueHash(input.configuration.connection)) conflict("The native session is bound to its original connection revision.", "connection_fixed");
    const configuration = await this.configuration(input.configuration, actor, input.requestId);
    return this.store.exclusive(async () => {
      const fresh = await this.store.load(id, actor), receipt = fresh.configurationRequests[input.requestId];
      if (receipt) { if (receipt.hash !== hash) conflict("Configuration request has different input.", "request_conflict"); return fresh.session; }
      if (fresh.retirement) conflict("This native session has been retired.", "session_retired");
      if (fresh.session.activeRun) conflict("The previous execution must stop before configuring this session.", "session_busy");
      if (fresh.session.revision !== input.expectedSessionRevision) conflict("The session changed.");
      const revision = increment(fresh.session.configurationRevision);
      this.supersedeReservations(fresh);
      fresh.configurations[revision] = configuration; fresh.configurationRequests[input.requestId] = { hash, revision };
      fresh.session = { ...fresh.session, revision: increment(fresh.session.revision), configurationRevision: revision, configurationDigest: configuration.digest, configuration: input.configuration, resolvedSkills: configuration.resolvedSkills };
      await this.store.save(fresh); onFresh?.(); return fresh.session;
    });
  }
  async startRun(sessionId: string, runId: string, input: AgentRunInput, body: string, actor: VerifiedOperation, onFresh?: () => void): Promise<AgentRunSnapshot> {
    const accepted = await this.store.exclusive(async () => {
      const session = await this.store.load(sessionId, actor, runId), old = session.runs[runId], hash = bytesHash(body);
      if (old && !old.reservedFor) { if (old.hash !== hash) conflict("Run identity has different exact input bytes.", "request_conflict"); return { snapshot: old.snapshot, fresh: false }; }
      if (session.retirement) conflict("This native session has been retired.", "session_retired");
      const stops = this.store.pendingStops(runId, actor);
      if (stops.length) {
        const run = this.fenceUnstarted(session, runId, actor, hash);
        this.store.lifecycle(run);
        await this.store.save(session);
        return { snapshot: run.snapshot, fresh: false };
      }
      if (this.closing) throw new AgentApiError("provider_stopping", "Provider is stopping; this new run was not admitted.", 503, true);
      this.store.history.requireDeliveryCapacity(actor, sessionId);
      this.requireCapabilities(input.requiredCapabilities);
      const selection = session.configurations[input.configurationRevision]?.configuration;
      if (this.driver.durableCommands && input.resources?.some(resource => resource.kind === "worktree"))
        this.requireCapabilities(["workspace.edit"]);
      if (this.capabilities.capabilities.includes("scope.restricted-native-tools") &&
        (selection?.approvalMode === "autonomous" || selection?.subagents?.enabled === true))
        throw new AgentApiError("unsupported_capability", "This native host cannot run the requested tool configuration.", 422);
      if (session.session.activeRun) conflict("The previous execution still owns this session.", "session_busy");
      if (session.session.revision !== input.expectedSessionRevision || session.session.configurationRevision !== input.configurationRevision) conflict("The session configuration changed.");
      if (actor.configurationDigest != null && actor.configurationDigest !== session.session.configurationDigest) conflict("Authorization names another configuration.", "configuration_mismatch");
      if (input.continuation === "resume" && !session.nativeId) conflict("The original native session is unavailable; it was not reconstructed.", "native_session_missing");
      if (input.continuation === "start" && (session.nativeId || session.session.nativeState !== "not_created")) conflict("This session already has a native continuation.", "continuation_required");
      if (input.mcp?.connections?.length) throw new AgentApiError("unsupported_capability", "This provider does not expose external MCP connections.", 422);
      if (input.limits?.maxDurationMs && input.limits.maxDurationMs > this.capabilities.limits.maxDurationMs!) throw new AgentApiError("unsupported_limit", "Requested duration exceeds the provider limit.", 422);
      if (input.limits?.maxOutputTokens !== undefined || input.limits?.maxToolCalls !== undefined) throw new AgentApiError("unsupported_limit", "This adapter cannot enforce the requested native token/tool limit.", 422);
      if (old?.reservedFor) {
        if (!("decisionResponseRef" in input.input) || input.input.decisionResponseRef.runId !== old.reservedFor.runId || input.input.decisionResponseRef.requestId !== old.reservedFor.requestId
          || old.reservedFor.configurationRevision !== input.configurationRevision) conflict("Start the reserved continuation with its original decision response and configuration.", "decision_continuation_mismatch");
        const original = session.runs[old.reservedFor.runId]?.controls[old.reservedFor.requestId];
        if (original?.receipt.continuation?.state !== "awaiting_authorization") conflict("This decision continuation was superseded or admitted.", "decision_continuation_stale");
      } else if ("decisionResponseRef" in input.input) conflict("Use the provider-reserved continuation run identity.", "decision_continuation_missing");
      const occupied = this.store.occupiedSlots();
      const ownReservation = Object.values(session.runs).some(run => run.reservedFor);
      if (!ownReservation && occupied >= this.capacity) conflict("Provider capacity is occupied, including executions whose stop is unconfirmed.", "provider_busy");
      const reservation = old?.reservedFor;
      const run = old ?? this.store.makeRun(session, runId, actor, body, input);
      if (actor.expiresAt) run.authorityExpiresAt = actor.expiresAt;
      if (reservation) {
        run.hash = hash; run.input = structuredClone(input); run.admissionRef = actor.admissionRef; delete run.reservedFor;
        run.snapshot.stopConfirmed = false; run.snapshot.admissionRef = actor.admissionRef; run.snapshot.revision = increment(run.snapshot.revision);
        const source = session.runs[reservation.runId]!, response = source.controls[reservation.requestId]!;
        response.receipt.continuation!.state = "admitted";
        source.snapshot.pending = source.snapshot.pending.filter(decision => decision.id !== reservation.decisionId);
        this.store.lifecycle(source); this.store.emit(source, "decision.resolved", { decisionId: reservation.decisionId, response: response.response });
        this.store.emit(source, "control.updated", { requestId: reservation.requestId, receipt: response.receipt });
      }
      this.supersedeReservations(session, runId);
      if (input.limits?.maxDurationMs) run.deadline = new Date(Date.now() + input.limits.maxDurationMs).toISOString();
      session.runs[runId] = run; session.session.activeRun = run.snapshot.ref; session.session.revision = increment(session.session.revision);
      this.store.lifecycle(run); await this.store.save(session);
      return { snapshot: run.snapshot, fresh: true };
    });
    if (accepted.fresh) { onFresh?.(); this.background(this.driver.start(sessionId, runId, accepted.snapshot.generation)); }
    return accepted.snapshot;
  }
  background(task: Promise<unknown>): void { this.tasks.add(task); void task.catch(() => {}).finally(() => this.tasks.delete(task)); }
  private checkControl(run: RunRecord, input: { expectedGeneration: string; expectedRevision: string }): void {
    if (run.snapshot.generation !== input.expectedGeneration || run.snapshot.revision !== input.expectedRevision) conflict("Run control revision changed; reload its authoritative snapshot.");
  }
  private oldControl(run: RunRecord, id: string, hash: string): AgentControlReceipt | undefined {
    const old = run.controls[id]; if (old && old.hash !== hash) conflict("Control identity has different exact bytes.", "request_conflict"); return old?.receipt;
  }
  private receipt(run: RunRecord, id: string): AgentControlReceipt { return { requestId: id, state: "accepted", run: run.snapshot.ref, revision: run.snapshot.revision, generation: run.snapshot.generation }; }
  private fenceUnstarted(session: SessionRecord, runId: string, actor: VerifiedOperation, startDigest: string): RunRecord {
    const run = this.store.makeRun(session, runId, actor, "");
    const stops = this.store.pendingStops(runId, actor);
    if (stops.length) run.snapshot.generation = stops[0]!.generation;
    for (const stop of stops) run.controls[stop.request] = { hash: stop.hash, stop: true,
      receipt: { ...this.receipt(run, stop.request), revision: "1", state: "applied" } };
    run.hash = startDigest;
    run.cancelFence = true;
    run.decisionsFenced = true;
    this.store.markNotAdmitted(run);
    run.snapshot.state = "cancelled";
    run.snapshot.phase = "terminal";
    run.snapshot.stopConfirmed = true;
    run.completedAt = new Date().toISOString();
    session.runs[runId] = run;
    return run;
  }
  async discardDelivery(runId: string, requestId: string, actor: VerifiedOperation) {
    if (!actor.cleanupOnly || !actor.sessionId || actor.runId !== runId || actor.operation !== "runs.discard")
      throw new AgentApiError("permission_denied", "Discard requires the original attempt cleanup authorization.", 403);
    const sessionId = actor.sessionId;
    return this.store.exclusive(async () => {
      const old = this.store.history.discardedDelivery(actor, sessionId, runId);
      if (old) {
        if (old.admission !== actor.admissionRef || old.request !== requestId)
          throw new AgentApiError("request_conflict", "A different confirmed request owns this delivery receipt.", 409);
      } else {
        const { session, record } = await this.store.run(runId, actor);
        if (session.id !== sessionId || record.admissionRef !== actor.admissionRef)
          throw new AgentApiError("permission_denied", "The run belongs to another admission.", 403);
        if (!record.snapshot.stopConfirmed || record.reservedFor || record.snapshot.pending.length ||
          record.snapshot.pendingContinuations?.some(item => item.state === "pending" || item.state === "awaiting_authorization") ||
          (record.input || record.startIntent || record.workspaces?.length) && record.workspaceRelease?.state !== "released" ||
          Object.values(record.controls).some(control => control.receipt.state === "accepted") ||
          Object.values(record.decisionDeliveries ?? {}).some(delivery => !delivery.done))
          throw new AgentApiError("discard_pending", "The attempt still has an open execution, decision or workspace claim.", 409, true);
        delete session.runs[runId];
        if (session.session.activeRun?.id === runId) session.session.activeRun = null;
        await this.store.save(session, { run: runId, admission: actor.admissionRef, request: requestId });
      }
      return { runId, requestId, state: "discarded" as const };
    });
  }
  async cancel(runId: string, input: AgentCancelInput, body: string, actor: VerifiedOperation): Promise<AgentControlReceipt> {
    const result = await this.store.exclusive(async () => {
      let existing = await this.store.run(runId, actor).catch(error => { if (error instanceof AgentApiError && error.status === 404) return null; throw error; });
      const hash = bytesHash(body);
      const original = actor.originalStartDigest && actor.sessionId ? { sessionId: actor.sessionId, startDigest: actor.originalStartDigest } : undefined;
      const fence = input.fenceIfNotAdmitted ?? original;
      if (original && fence && (fence.sessionId !== original.sessionId || fence.startDigest !== original.startDigest))
        conflict("Stop must target the originally authorized session and bytes.", "request_conflict");
      if (!existing && fence) {
        const session = await this.store.load(fence.sessionId, actor, runId);
        if (session.retirement) conflict("This native session has been retired.", "session_retired");
        const run = this.fenceUnstarted(session, runId, actor, fence.startDigest);
        this.store.lifecycle(run);
        if (run.controls[input.requestId]) await this.store.save(session);
        existing = { session, record: run };
      }
      if (!existing) {
        if (input.expectedGeneration !== undefined) throw new AgentApiError("run_not_found", "Run generation not found.", 404);
        return { receipt: this.store.stopBeforeAdmission(runId, actor, input.requestId, hash), execute: false };
      }
      const { session, record: run } = existing, old = this.oldControl(run, input.requestId, hash);
      if (old) return { receipt: old, execute: !session.retirement && !run.snapshot.stopConfirmed };
      if (session.retirement) conflict("This native session has been retired.", "session_retired");
      if (fence) { if (session.id !== fence.sessionId || run.hash !== fence.startDigest) conflict("Cancellation fence names different admission bytes.", "request_conflict"); }
      else if (input.expectedGeneration !== undefined && input.expectedGeneration !== run.snapshot.generation) conflict("Stop names a different execution generation.");
      const receipt = this.receipt(run, input.requestId);
      run.decisionsFenced = true;
      for (const decision of run.snapshot.pending) this.store.emit(run, "decision.resolved", { decisionId: decision.id, decision, state: "superseded" }, decision.source);
      run.snapshot.pending = [];
      this.store.lifecycle(run);
      if (run.reservedFor) this.supersedeReservations(session);
      for (const control of Object.values(run.controls)) if (control.receipt.continuation?.state === "awaiting_authorization") this.supersedeReservations(session);
      if (run.snapshot.stopConfirmed) {
        receipt.state = "applied";
        if (run.snapshot.phase === "parked") {
          run.snapshot.state = "cancelled"; run.snapshot.phase = "terminal"; this.store.lifecycle(run);
        }
      } else { run.snapshot.phase = "cancelling"; this.store.lifecycle(run); }
      receipt.revision = run.snapshot.revision; run.controls[input.requestId] = { hash, receipt, stop: true }; this.store.emit(run, "control.updated", { requestId: input.requestId, receipt });
      try { await this.store.save(session); }
      catch (error) {
        // Authorization, immutable run identity and command replay checks have succeeded.
        // Stop the live owner if we still hold it. Only a committed transaction can acknowledge Stop.
        if (error instanceof AgentApiError && error.code === "storage_unavailable" && !run.snapshot.stopConfirmed && run.nativeGeneration)
          this.driver.stopOwnedOnStorageFailure?.(runId, run.snapshot.generation);
        throw error;
      }
      return { receipt, execute: receipt.state !== "applied" };
    }).catch(error => {
      // The database can fail before the caller and generation can be checked.
      // Keep the exact Stop retryable without signalling an unverified owner.
      if (error?.code === "ERR_SQLITE_ERROR" && [8, 10, 11, 13, 14, 26].includes(Number(error.errcode) & 255))
        throw new AgentApiError("storage_unavailable", "The retained execution could not be verified.", 503, true);
      throw error;
    });
    if (result.execute) this.background(this.dispatchControl(runId, input.requestId, () => this.driver.cancel(runId, input.requestId)));
    return result.receipt;
  }
  async respond(runId: string, input: AgentResponseInput, body: string, actor: VerifiedOperation): Promise<AgentControlReceipt> {
    const result = await this.store.exclusive(async () => {
      const { session, record: run } = await this.store.run(runId, actor), hash = bytesHash(body), old = this.oldControl(run, input.requestId, hash); if (old) return { receipt: old, execute: false };
      if (session.retirement || run.decisionsFenced) conflict("This run no longer accepts decision responses.", "run_fenced");
      this.checkControl(run, input);
      const decision = run.snapshot.pending.find(value => value.id === input.decisionId && value.revision === input.decisionRevision);
      if (!decision || decision.kind !== input.response.kind) conflict("Decision is no longer pending.", "stale_decision");
      if (Object.keys(run.controls).length >= this.capabilities.limits.maxControls) throw new AgentApiError("control_limit", "Ordinary control limit exceeded; cancellation remains available.", 413);
      questionAnswers(decision!, input.response);
      if (Object.values(run.controls).some(control => control.decisionId === input.decisionId && !["rejected", "superseded"].includes(control.receipt.state))) conflict("A response for this exact decision is already retained. Observe its original request identity.", "decision_response_exists");
      const receipt = this.receipt(run, input.requestId);
      if (decision!.delivery === "next_turn") {
        const id = randomUUID(), reserved = this.store.makeRun(session, id, actor, "");
        reserved.reservedFor = { runId, requestId: input.requestId, decisionId: input.decisionId, configurationRevision: run.snapshot.configurationRevision };
        reserved.snapshot.stopConfirmed = true; delete reserved.snapshot.admissionRef;
        this.store.lifecycle(reserved); session.runs[id] = reserved;
        receipt.state = "applied"; receipt.continuation = { run: reserved.snapshot.ref, state: "awaiting_authorization" };
      }
      run.controls[input.requestId] = { hash, receipt, decisionId: input.decisionId, decision: structuredClone(decision!), response: input.response };
      this.store.lifecycle(run); receipt.revision = run.snapshot.revision;
      this.store.emit(run, "control.updated", { requestId: input.requestId, receipt }); await this.store.save(session);
      return { receipt, execute: decision!.delivery === "continue_run" };
    });
    if (result.execute) this.background(this.dispatchControl(runId, input.requestId, () => this.driver.respond(runId, input)));
    return result.receipt;
  }
  async control(runId: string, input: AgentRunControlInput, body: string, actor: VerifiedOperation): Promise<AgentControlReceipt> {
    if (input.command === "retire") return this.retire(runId, input, body, actor);
    this.requireCapabilities([{ park: "runs.park", barrier: "runs.barrier", reconcile: "runs.reconcile", mcpPolicy: "mcp.policy-update", liveConfigure: "runs.live-configure", predictions: "predictions" }[input.command]]);
    const result = await this.store.exclusive(async () => {
      const { session, record: run } = await this.store.run(runId, actor), hash = bytesHash(body), old = this.oldControl(run, input.requestId, hash); if (old) return { receipt: old, execute: false };
      if (session.retirement) conflict("This native session has been retired.", "session_retired");
      this.checkControl(run, input);
      if (Object.keys(run.controls).length >= this.capabilities.limits.maxControls) throw new AgentApiError("control_limit", "Ordinary control limit exceeded; cancellation remains available.", 413);
      const receipt = this.receipt(run, input.requestId); run.controls[input.requestId] = { hash, receipt, command: structuredClone(input) };
      this.store.lifecycle(run); receipt.revision = run.snapshot.revision;
      this.store.emit(run, "control.updated", { requestId: input.requestId, receipt }); await this.store.save(session); return { receipt, execute: true };
    });
    if (result.execute) this.background(this.dispatchControl(runId, input.requestId, () => this.driver.control(runId, input)));
    return result.receipt;
  }

  private async retire(runId: string, input: Extract<AgentRunControlInput, { command: "retire" }>, body: string, actor: VerifiedOperation): Promise<AgentControlReceipt> {
    this.requireCapabilities(["runs.retire"]);
    const receipt = await this.store.exclusive(async () => {
      const { session, record } = await this.store.run(runId, actor), hash = bytesHash(body);
      const old = this.oldControl(record, input.requestId, hash);
      if (old) return old;
      if (session.retirement) conflict("Reuse the original retirement request.", "session_retired");
      if (this.closing) throw new AgentApiError("provider_stopping", "The provider is stopping; retirement was not admitted.", 503, true);
      this.checkControl(record, input);
      if (session.session.activeRun ? session.session.activeRun.id !== runId
        : !record.snapshot.stopConfirmed || Object.keys(session.runs).at(-1) !== runId)
        conflict("A newer attempt owns this session.", "retirement_stale");
      if (!this.driver.retirementEvidence || !this.driver.releaseRetired)
        throw new AgentApiError("unsupported_capability", "The provider cannot retire this execution.", 422);
      const evidence = await this.driver.retirementEvidence(record);
      session.retirement = { runId, requestId: input.requestId, ...evidence };
      this.supersedeReservations(session);
      for (const retained of Object.values(session.runs)) {
        retained.decisionsFenced = true;
        if (!retained.snapshot.pending.length) continue;
        for (const decision of retained.snapshot.pending)
          this.store.emit(retained, "decision.resolved", { decisionId: decision.id, decision, state: "superseded" });
        retained.snapshot.pending = [];
        if (retained !== record) this.store.lifecycle(retained);
      }
      this.store.lifecycle(record);
      const accepted = this.receipt(record, input.requestId);
      record.controls[input.requestId] = { hash, receipt: accepted };
      this.store.emit(record, "control.updated", { requestId: input.requestId, receipt: accepted });
      await this.store.save(session);
      return accepted;
    });
    if (receipt.state === "applied") return receipt;
    return this.finishRetirement(runId, input.requestId);
  }

  /** A pending retirement survives a lost reply or provider restart and can only finish its own run. */
  async finishRetirement(runId: string, requestId: string): Promise<AgentControlReceipt> {
    await this.driver.releaseRetired?.(runId);
    return this.store.exclusive(async () => {
      const { session, record } = await this.store.run(runId);
      const receipt = record.controls[requestId]?.receipt;
      if (session.retirement?.runId !== runId || session.retirement.requestId !== requestId || !receipt)
        throw new AgentApiError("retirement_stale", "The retained retirement request is unavailable.", 409);
      if (receipt.state === "applied") return receipt;
      if (record.workspaceRelease?.state !== "released")
        throw new AgentApiError("retirement_cleanup_pending", "The provider is still releasing the retired execution's workspace leases.", 503, true);
      session.session.activeRun = null;
      session.session.revision = increment(session.session.revision);
      this.store.lifecycle(record);
      receipt.state = "applied"; receipt.revision = record.snapshot.revision;
      this.store.emit(record, "control.updated", { requestId, receipt });
      await this.store.save(session);
      return receipt;
    });
  }

  private supersedeReservations(session: SessionRecord, except?: string): void {
    for (const record of Object.values(session.runs)) {
      const reserved = record.reservedFor; if (!reserved || record.snapshot.ref.id === except) continue;
      const source = session.runs[reserved.runId], control = source?.controls[reserved.requestId];
      if (control?.receipt.continuation) { control.receipt.continuation.state = "superseded"; this.store.emit(source!, "control.updated", { requestId: reserved.requestId, receipt: control.receipt });
        source!.snapshot.pending = source!.snapshot.pending.filter(decision => decision.id !== reserved.decisionId); this.store.lifecycle(source!); this.store.emit(source!, "decision.resolved", { decisionId: reserved.decisionId, state: "superseded" }); }
      delete record.reservedFor; record.snapshot.state = "cancelled"; record.snapshot.phase = "terminal"; record.snapshot.stopConfirmed = true; this.store.lifecycle(record);
    }
  }
  private dispatchControl(id: string, requestId: string, dispatch: () => Promise<void>): Promise<void> {
    // The detached supervisor settles its durable command inside its own lifetime.
    return this.driver.durableCommands ? dispatch() : this.applyControl(id, requestId, dispatch);
  }
  async resumeCommands(id: string): Promise<void> {
    const { record } = await this.store.run(id);
    for (const [requestId, command] of Object.entries(record.controls)) {
      if (command.receipt.state !== "accepted") continue;
      if (command.stop) {
        await this.applyControl(id, requestId, async () => {
          await this.driver.cancel(id, requestId);
          await this.driver.synchronize(id);
          if (!(await this.store.run(id)).record.snapshot.stopConfirmed)
            throw new AgentApiError("stop_in_progress", "The supervisor is closing the attempt.", 503, true);
        });
      } else if (command.decision && command.response && command.decision.delivery === "continue_run") {
        const response = { requestId, expectedGeneration: record.snapshot.generation, expectedRevision: command.receipt.revision,
          decisionId: command.decision.id, decisionRevision: command.decision.revision, response: command.response as AgentResponseInput["response"] };
        await this.applyControl(id, requestId, () => this.driver.respond(id, response));
      } else if (command.command) {
        await this.applyControl(id, requestId, () => this.driver.control(id, command.command!));
      }
    }
  }
  private async applyControl(id: string, requestId: string, apply: () => Promise<void>): Promise<void> {
    let error: unknown;
    try { await apply(); await this.driver.synchronize(id); } catch (caught) { error = caught; }
    await this.store.exclusive(async () => {
      const { session, record } = await this.store.run(id), control = record.controls[requestId]; if (!control) return;
      if (control.stop && (control.receipt.state === "applied" || !error && !record.snapshot.stopConfirmed)) return;
      if (error instanceof AgentApiError && ["core_unavailable", "core_response_invalid", "stop_in_progress"].includes(error.code)) return;
      control.receipt.state = error ? error instanceof AgentApiError && error.status >= 400 && error.status < 500 ? "rejected" : "unknown" : "applied";
      projectAppliedDecisionControls(this.store, record);
      this.store.lifecycle(record); control.receipt.revision = record.snapshot.revision;
      if (error) control.receipt.error = { code: error instanceof AgentApiError ? error.code : "control_unconfirmed", message: error instanceof AgentApiError ? error.message : "Control delivery could not be confirmed. Do not issue a replacement identity.", retryable: false };
      this.store.emit(record, "control.updated", { requestId, receipt: control.receipt }); await this.store.save(session);
    });
  }
  async snapshot(id: string, actor?: Actor, options?: { committedOnly: boolean }) {
    if (!options?.committedOnly) await this.driver.synchronize(id);
    const current = (await this.store.run(id, actor)).record;
    // The atomic aggregate is authoritative at its cursor. Synchronization can continue while native output arrives.
    if (options?.committedOnly && !current.snapshot.stopConfirmed) this.background(this.driver.synchronize(id));
    if (!projectAppliedDecisionControls(this.store, current)) return current.snapshot;
    return this.store.exclusive(async () => {
      const { session, record } = await this.store.run(id, actor);
      if (projectAppliedDecisionControls(this.store, record)) { this.store.lifecycle(record); await this.store.save(session); }
      return record.snapshot;
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    // Native shutdown must unblock pending starts/controls before their receipts can drain.
    // Waiting for a stalled interrupt first would prevent the owned stop path from running.
    await this.driver.close();
    await Promise.allSettled([...this.tasks]);
  }
}
