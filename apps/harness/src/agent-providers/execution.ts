import { sameProviderRef } from "../../shared/provider-reference.js";
import { createHash } from "node:crypto";
import type {
  AgentCancelInput, AgentConfiguration, AgentConfigurationCreate, AgentControlReceipt, AgentPreparedRequest, AgentResponseInput,
  AgentRunControlInput, AgentRunInput, AgentRunRef, AgentRunSnapshot, AgentSession, AgentSessionCreate, AgentSessionWorkflowBinding, AgentWatchItem,
} from "@hosty-sdk/app/agent";
import { workflowCapabilities } from "./subagent-workflow.js";
import { AgentApiError } from "@hosty-sdk/app/agent";
import {
  AgentClient, prepareAgentCancel, prepareAgentConfiguration, prepareAgentControl, prepareAgentResponse, prepareAgentRun,
  prepareAgentSessionCreate,
} from "@hosty-sdk/app/agent/client";
import { validateAgentControlReceipt, validateAgentRequest } from "@hosty-sdk/app/agent/server";
import type { AgentConnectionSelection, AgentConsumerAuthority } from "./types.js";

export type AgentClientFactory = (selection: AgentConnectionSelection, authority: AgentConsumerAuthority) => AgentClient;
export function providerStartWasFenced(snapshot: AgentRunSnapshot): boolean {
  return snapshot.state === "cancelled" && snapshot.phase === "terminal" && snapshot.stopConfirmed
    && snapshot.result?.status === "cancelled" && snapshot.result.error?.code === "run_not_admitted";
}

export function providerStartWasObserved(state: ProviderExecutionState, snapshot: AgentRunSnapshot): boolean {
  return Object.values(state.settledMutations ?? {}).some(({ request, proof }) => request.operation === "runs.start"
    && request.sessionId === snapshot.sessionId && request.runId === snapshot.ref.id
    && proof.generation === snapshot.generation && proof.admissionObserved);
}

export type ProviderContinuation = {
  requestId: string; sourceRunId: string; run: AgentRunRef;
  state: NonNullable<AgentControlReceipt["continuation"]>["state"];
  input: AgentRunInput; deadline?: string;
  workflow?: AgentSessionWorkflowBinding;
  decisionId?: string; response?: AgentResponseInput["response"];
};
export type ProviderExecutionState = {
  version: 1;
  /** Selects this conversation segment's durable outbox after an owner-confirmed context change. */
  contextId?: string;
  reconnect?: { requestId: string; expectedSessionRevision: string };
  selection: AgentConnectionSelection;
  sessionId: string;
  session?: AgentSession;
  appliedConfiguration?: { revision: string; digest: string; value: AgentConfiguration };
  runId?: string;
  run?: AgentRunSnapshot;
  historyClock?: import("./history-projection.js").HistoryProjectionClock;
  cursor?: string;
  lastRunInput?: { runId: string; input: AgentRunInput; deadline?: string; workflow?: AgentSessionWorkflowBinding };
  continuations?: Record<string, ProviderContinuation>;
  /** A control acknowledgement does not end its run. Preserve the first cancellation's bytes. */
  cancellations?: Record<string, { request: AgentPreparedRequest<AgentControlReceipt>; receipt?: AgentControlReceipt }>;
  settledMutations?: Record<string, { request: AgentPreparedRequest;
    proof: Pick<AgentRunSnapshot, "ref" | "generation" | "revision" | "observedAt"> & { admissionObserved?: true } }>;
  /** Exact non-secret request bytes survive a lost admission response and consumer restart. */
  mutations?: Record<string, AgentPreparedRequest>;
};

export interface ProviderExecutionPersistence {
  save(state: ProviderExecutionState): Promise<void>;
  /** Merge run/cursor into the latest durable sidecar; never overwrite concurrently saved mutations/session. */
  observe(item: AgentWatchItem, state: ProviderExecutionState, replayed?: boolean): Promise<void>;
}

type MutationLane = { tail: Promise<unknown>; starting: boolean; configuring: boolean; cancelling: Map<string, Promise<AgentControlReceipt>> };
const mutationLanes = new WeakMap<ProviderExecutionState, MutationLane>();

/** The consumer observes and commands public executions; it owns no native process or renewal timer. */
export class ProviderExecution {
  private observer: AbortController | null = null;
  private readonly mutations: MutationLane;
  private projectionTail: Promise<unknown> = Promise.resolve();
  constructor(private readonly client: AgentClient, readonly state: ProviderExecutionState,
    private readonly persistence: ProviderExecutionPersistence) {
    let mutations = mutationLanes.get(state);
    if (!mutations) { mutations = { tail: Promise.resolve(), starting: false, configuring: false, cancelling: new Map() }; mutationLanes.set(state, mutations); }
    this.mutations = mutations;
  }

  private change<T>(action: () => Promise<T>): Promise<T> {
    const next = this.mutations.tail.catch(() => {}).then(action); this.mutations.tail = next; return next;
  }
  private key(prepared: AgentPreparedRequest): string { return `${prepared.method}:${prepared.path}:${prepared.bodyHash}`; }
  private async save(next: ProviderExecutionState): Promise<void> {
    const committed = structuredClone(next);
    await this.persistence.save(structuredClone(committed));
    for (const key of ["session", "appliedConfiguration", "runId", "run", "historyClock", "cursor", "mutations", "lastRunInput", "continuations", "cancellations", "settledMutations"] as const)
      if (!(key in committed)) delete this.state[key];
    Object.assign(this.state, committed);
  }
  private async execute<T>(prepared: AgentPreparedRequest<T>, stage?: (next: ProviderExecutionState) => void): Promise<T> {
    await this.change(async () => {
      const next = structuredClone(this.state);
      stage?.(next);
      if (prepared.operation === "runs.cancel") this.rememberCancellation(next, prepared as AgentPreparedRequest<AgentControlReceipt>);
      (next.mutations ??= {})[this.key(prepared)] = prepared;
      await this.save(next);
    });
    // Keep the admitted/uncertain request until its resource/control receipt is durably projected.
    return this.client.execute(prepared);
  }

  async create(configuration: AgentConfiguration, correlation?: AgentSessionCreate["correlation"]): Promise<AgentSession> {
    const request: AgentSessionCreate = { configuration, ...(correlation ? { correlation } : {}) };
    const prepared = prepareAgentSessionCreate(this.state.sessionId, request);
    const session = await this.execute(prepared);
    this.sessionIdentity(session);
    await this.change(async () => {
      const next = structuredClone(this.state); next.session = session;
      this.rememberConfiguration(next, session, (JSON.parse(prepared.body) as AgentSessionCreate).configuration);
      delete next.mutations?.[this.key(prepared)];
      await this.save(next);
    });
    return session;
  }

  async configure(configurationId: string, input: AgentConfigurationCreate): Promise<AgentSession> {
    if (this.mutations.configuring || this.mutations.starting || this.state.run && !this.state.run.stopConfirmed
      || Object.keys(this.state.mutations ?? {}).length)
      throw new Error("Reconcile the previous provider mutation or execution before configuring this session.");
    this.mutations.configuring = true;
    try {
      const prepared = prepareAgentConfiguration(this.state.sessionId, configurationId, input);
      const session = await this.execute(prepared);
      this.sessionIdentity(session);
      await this.change(async () => {
        const next = structuredClone(this.state); next.session = session;
        this.rememberConfiguration(next, session, (JSON.parse(prepared.body) as AgentConfigurationCreate).configuration);
        delete next.mutations?.[this.key(prepared)];
        await this.save(next);
      });
      return session;
    } finally { this.mutations.configuring = false; }
  }

  private rememberConfiguration(next: ProviderExecutionState, session: AgentSession, configuration: AgentConfiguration): void {
    next.appliedConfiguration = { revision: session.configurationRevision, digest: session.configurationDigest, value: structuredClone(configuration) };
  }
  private sessionIdentity(session: AgentSession): void {
    const actual = session.ref.provider, selected = this.state.selection.provider;
    if (session.ref.id !== this.state.sessionId || !sameProviderRef(actual, selected))
      throw new Error("Provider configuration belongs to another session or installation.");
  }
  async session(): Promise<AgentSession> {
    const session = await this.client.session(this.state.sessionId);
    this.sessionIdentity(session);
    await this.change(() => this.save({ ...structuredClone(this.state), session }));
    return session;
  }

  async start(runId: string, input: AgentRunInput, originalDeadline?: string, workflow?: AgentSessionWorkflowBinding): Promise<AgentRunSnapshot> {
    if (this.mutations.starting || this.mutations.configuring || this.state.run && !this.state.run.stopConfirmed
      || Object.keys(this.state.mutations ?? {}).length)
      throw new Error("Reconcile the previous provider execution before starting another turn.");
    this.mutations.starting = true;
    try {
      const prepared = prepareAgentRun(this.state.sessionId, runId, workflow ? { ...input,
        requiredCapabilities: [...new Set([...(input.requiredCapabilities ?? []), ...workflowCapabilities(workflow)])],
      } : input);
      this.bindConfiguration(prepared, this.state.session);
      const deadline = originalDeadline ?? (input.limits?.maxDurationMs ? new Date(Date.now() + input.limits.maxDurationMs).toISOString() : undefined);
      if (deadline) prepared.ceiling = { ...prepared.ceiling, deadline };
      if (workflow) prepared.ceiling = { ...prepared.ceiling, workflow: structuredClone(workflow) };
      const snapshot = await this.execute(prepared, next => {
        next.runId = runId; delete next.run; delete next.historyClock; delete next.cursor;
        next.lastRunInput = { runId, input: structuredClone(JSON.parse(prepared.body) as AgentRunInput), ...(deadline ? { deadline } : {}), ...(workflow ? { workflow: structuredClone(workflow) } : {}) };
      });
      await this.retain(snapshot);
      await this.change(async () => {
        const next = structuredClone(this.state); delete next.mutations?.[this.key(prepared)];
        await this.save(next);
      });
      if (providerStartWasFenced(snapshot))
        throw new AgentApiError("run_not_admitted", "The original send was stopped before it ran.", 409);
      return snapshot;
    } finally { this.mutations.starting = false; }
  }

  private bindConfiguration(prepared: AgentPreparedRequest, session: AgentSession | undefined): void {
    const input = JSON.parse(prepared.body) as AgentRunInput;
    if (!session || prepared.sessionId !== this.state.sessionId || session.configurationRevision !== input.configurationRevision)
      throw new AgentApiError("configuration_unknown", "Confirm the original provider configuration before authorizing this turn.", 409);
    this.sessionIdentity(session);
    // The provider includes its resolved immutable skills in this opaque digest. A consumer's
    // configuration comparison or request-body hash cannot recreate that execution identity.
    if (prepared.configurationDigest !== undefined && prepared.configurationDigest !== session.configurationDigest)
      throw new AgentApiError("configuration_changed", "The retained turn names another provider configuration.", 409);
    prepared.configurationDigest = session.configurationDigest;
  }

  /** Retry the exact persisted mutation; transport renewal cannot change its input or identity. */
  async reconcileMutation(prepared: AgentPreparedRequest): Promise<unknown> {
    if (!this.state.mutations?.[this.key(prepared)]) throw new Error("The exact pending request is not retained.");
    if (prepared.operation === "runs.cancel") await this.change(async () => {
      const next = structuredClone(this.state);
      this.rememberCancellation(next, prepared as AgentPreparedRequest<AgentControlReceipt>); await this.save(next);
    });
    if (prepared.operation === "runs.start" && prepared.configurationDigest === undefined) {
      // Older consumers persisted the exact command without authorization's configuration digest.
      // Enrich only that metadata after reading the same revision from the selected provider;
      // never rewrite its body, optimistic revisions, deadline, or run UUID to make it admissible.
      const session = await this.session(), bound = structuredClone(prepared);
      this.bindConfiguration(bound, session);
      await this.change(() => this.save({ ...structuredClone(this.state), mutations: {
        ...this.state.mutations, [this.key(bound)]: bound,
      } }));
      prepared = bound;
    }
    // A previous save may have failed before publication. Retry only its identical durable bytes
    // and confirm persistence before any possible external dispatch.
    await this.change(() => this.persistence.save(structuredClone(this.state)));
    const result = await this.client.execute(prepared);
    if (prepared.operation === "runs.start") await this.retain(result as AgentRunSnapshot);
    await this.change(async () => {
      const next = structuredClone(this.state);
      if (prepared.operation === "sessions.create" || prepared.operation === "sessions.configure") {
        const session = result as AgentSession;
        this.sessionIdentity(session);
        next.session = session;
        this.rememberConfiguration(next, session, (JSON.parse(prepared.body) as AgentSessionCreate | AgentConfigurationCreate).configuration);
      }
      if (prepared.operation === "runs.respond") this.rememberContinuation(next, result as AgentControlReceipt, prepared);
      if (prepared.operation === "runs.cancel") this.rememberCancellation(next, prepared as AgentPreparedRequest<AgentControlReceipt>, result as AgentControlReceipt);
      const control = result as Partial<AgentControlReceipt>;
      if (!["runs.respond", "runs.cancel", "runs.control"].includes(prepared.operation)
        || control.state !== "unknown" && control.state !== "accepted") delete next.mutations?.[this.key(prepared)];
      await this.save(next);
    });
    return result;
  }

  async read(project: boolean | "replay" = true): Promise<AgentRunSnapshot> {
    if (!this.state.runId) throw new Error("This conversation has no provider run.");
    const snapshot = await this.client.run(this.state.runId);
    this.runIdentity(snapshot);
    if (project) await this.install(snapshot, project === "replay");
    return snapshot;
  }

  private runIdentity(snapshot: AgentRunSnapshot): void {
    const actual = snapshot.ref.provider, selected = this.state.selection.provider;
    if (snapshot.ref.id !== this.state.runId || snapshot.sessionId !== this.state.sessionId
      || !sameProviderRef(actual, selected))
      throw new AgentApiError("provider_identity_changed", "Provider execution belongs to another session or installation.", 409);
    if (this.state.run?.ref.id === snapshot.ref.id && this.state.run.generation !== snapshot.generation)
      throw new AgentApiError("provider_identity_changed", "The provider execution generation changed; reconcile the original attempt before controlling it.", 409);
  }
  /** Persist admission/stop facts without projecting or acknowledging unobserved event history. */
  async retain(snapshot: AgentRunSnapshot): Promise<void> {
    this.runIdentity(snapshot);
    await this.change(() => this.save({ ...structuredClone(this.state), run: snapshot }));
  }
  /** Settle the start outbox using a read of the original run. Never send the saved body. */
  async acknowledgeObservedStart(snapshot: AgentRunSnapshot): Promise<void> {
    await this.change(async () => {
      this.runIdentity(snapshot);
      const next = structuredClone(this.state);
      if (!next.run || BigInt(snapshot.revision) >= BigInt(next.run.revision)) next.run = structuredClone(snapshot);
      for (const [key, request] of Object.entries(next.mutations ?? {})) {
        if (request.operation !== "runs.start" || request.runId !== snapshot.ref.id || request.sessionId !== snapshot.sessionId) continue;
        (next.settledMutations ??= {})[key] = { request, proof: { ref: snapshot.ref, generation: snapshot.generation,
          revision: snapshot.revision, observedAt: snapshot.observedAt, admissionObserved: true } };
        delete next.mutations![key];
      }
      await this.save(next);
    });
  }
  /** An authoritative exit/fence settles only commands for that same public attempt. */
  async settleStopped(snapshot: AgentRunSnapshot): Promise<void> {
    this.runIdentity(snapshot);
    if (!snapshot.stopConfirmed) throw new Error("Native exit has not been confirmed.");
    await this.change(async () => {
      this.runIdentity(snapshot);
      const next = structuredClone(this.state); next.run = structuredClone(snapshot);
      for (const [key, request] of Object.entries(next.mutations ?? {})) {
        if (request.runId !== snapshot.ref.id || !["runs.start", "runs.cancel"].includes(request.operation)) continue;
        (next.settledMutations ??= {})[key] = { request, proof: { ref: snapshot.ref, generation: snapshot.generation,
          revision: snapshot.revision, observedAt: snapshot.observedAt } };
        delete next.mutations![key];
      }
      await this.save(next);
    });
  }
  private async install(snapshot: AgentRunSnapshot, replayed = false): Promise<void> {
    this.runIdentity(snapshot);
    await this.project({ kind: "snapshot", snapshot }, snapshot, replayed);
  }
  private project(item: AgentWatchItem, snapshot?: AgentRunSnapshot, replayed = false): Promise<void> {
    const operation = this.projectionTail.catch(() => {}).then(async () => {
      const runId = item.kind === "snapshot" ? item.snapshot.ref.id : item.event.runId;
      if (this.state.runId !== runId) return;
      const cursor = item.kind === "snapshot" ? item.snapshot.cursor : item.cursor;
      const next = { ...structuredClone(this.state), ...(snapshot ? { run: snapshot } : {}), cursor };
      // Manager projection may wait on its own control lane. Never hold the mutation lane here.
      await this.persistence.observe(item, next, replayed);
      await this.change(async () => {
        if (this.state.runId !== runId) return;
        // A control caller can project a newer stopped snapshot while this observer
        // waits on the consumer's lane. Do not rewind that committed watermark.
        const sequence = item.kind === "snapshot" ? item.snapshot.lastSequence : item.event.sequence;
        const current = this.state.run;
        if (current && current.cursor === this.state.cursor && BigInt(current.lastSequence) > BigInt(sequence)) return;
        if (snapshot) this.state.run = snapshot;
        this.state.cursor = cursor;
      });
    });
    this.projectionTail = operation;
    return operation;
  }

  async observe(signal?: AbortSignal, onContinuation?: (continuation: ProviderContinuation) => Promise<void>,
    recovery?: { observed(): Promise<void>; readOnlySnapshots: boolean }): Promise<void> {
    if (!this.state.runId) throw new Error("This conversation has no provider run.");
    this.observer?.abort();
    const controller = this.observer = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const observedRunId = this.state.runId;
    let failures = 0;
    try {
      while (!combined.aborted && this.state.runId === observedRunId) {
        try {
          for await (const item of this.client.watchRun(observedRunId, { signal: combined, cursor: this.state.cursor })) {
            if (combined.aborted) return;
            if (item.kind === "snapshot") {
              await this.install(item.snapshot, recovery?.readOnlySnapshots);
              // Projection may detach this handle on a confirmed exit. The committed snapshot
              // still restores contact for that run.
              await recovery?.observed();
            } else {
              const snapshot = item.event.type === "run.updated" ? item.event.data.snapshot as AgentRunSnapshot : undefined;
              if (snapshot) this.runIdentity(snapshot);
              await this.project(item, snapshot);
            }
            if (combined.aborted) return;
            // A reconnect reads existing facts. Only a live receipt can advance an authorized
            // continuation after a read-only attachment.
            if (item.kind !== "snapshot" || !recovery?.readOnlySnapshots) await this.observeControls(item, onContinuation);
          }
          return;
        } catch (error) {
          if (combined.aborted || this.state.runId !== observedRunId || !retryableObservation(error) || ++failures > 3) throw error;
          // The public watcher begins with an authoritative snapshot. Retry from the last committed
          // cursor; partially appended consumer events retain their stable provider identities.
          await observationPause(100 * 2 ** (failures - 1), combined);
        }
      }
    } catch (error) {
      if (controller.signal.aborted && this.observer !== controller) return;
      throw error;
    } finally { if (this.observer === controller) this.observer = null; }
  }

  async observeControls(item: AgentWatchItem, onContinuation?: (continuation: ProviderContinuation) => Promise<void>): Promise<void> {
    if (item.kind === "event" && item.event.type === "control.updated" && item.event.data.receipt) {
      const receipt = item.event.data.receipt as AgentControlReceipt;
      if (receipt.run.id !== item.event.runId || receipt.generation && receipt.generation !== item.event.generation)
        throw new AgentApiError("provider_identity_changed", "The observed control belongs to another execution.", 409);
      await this.retainControl(receipt);
      const continuation = this.state.continuations?.[this.continuationKey(receipt.run.id, receipt.requestId)];
      if (continuation?.state === "awaiting_authorization") await onContinuation?.(continuation);
    }
    const snapshot = item.kind === "snapshot" ? item.snapshot : item.event.type === "run.updated" ? item.event.data.snapshot as AgentRunSnapshot : undefined;
    for (const pending of snapshot?.pendingContinuations ?? []) {
      if (pending.state !== "awaiting_authorization") continue;
      const receipt = await this.client.control(snapshot!.ref.id, pending.requestId);
      if (receipt.requestId !== pending.requestId || receipt.run.id !== snapshot!.ref.id
        || receipt.continuation?.run.id !== pending.run.id) throw new AgentApiError("provider_identity_changed", "The provider changed a reserved continuation identity.", 409);
      await this.retainControl(receipt);
      const continuation = this.state.continuations?.[this.continuationKey(receipt.run.id, receipt.requestId)];
      if (continuation?.state === "awaiting_authorization") await onContinuation?.(continuation);
    }
  }

  private continuationKey(sourceRunId: string, requestId: string): string { return JSON.stringify([sourceRunId, requestId]); }
  private rememberContinuation(next: ProviderExecutionState, receipt: AgentControlReceipt, prepared?: AgentPreparedRequest): void {
    if (!receipt.continuation) return;
    validateAgentControlReceipt(receipt);
    const actual = receipt.continuation.run.provider, sourceProvider = receipt.run.provider, selected = next.selection.provider;
    if ([actual, sourceProvider].some(value => !sameProviderRef(value, selected)))
      throw new AgentApiError("provider_identity_changed", "The continuation belongs to another provider installation.", 409);
    if (prepared && (prepared.runId !== receipt.run.id || (JSON.parse(prepared.body) as AgentResponseInput).requestId !== receipt.requestId))
      throw new AgentApiError("provider_identity_changed", "The continuation belongs to another response request.", 409);
    const key = this.continuationKey(receipt.run.id, receipt.requestId), previous = next.continuations?.[key];
    const source = next.lastRunInput?.runId === receipt.run.id ? next.lastRunInput : previous;
    if (!source) {
      if (receipt.continuation.state === "superseded") return;
      throw new AgentApiError("continuation_unavailable", "The original admitted continuation context is unavailable; it was not reconstructed.", 409);
    }
    if (previous && (previous.run.id !== receipt.continuation.run.id || previous.sourceRunId !== receipt.run.id))
      throw new AgentApiError("provider_identity_changed", "The provider changed a reserved continuation identity.", 409);
    const response = prepared?.operation === "runs.respond" ? JSON.parse(prepared.body) as AgentResponseInput : undefined;
    (next.continuations ??= {})[key] = { ...previous, requestId: receipt.requestId, sourceRunId: receipt.run.id,
      run: structuredClone(receipt.continuation.run), state: receipt.continuation.state, input: structuredClone(source.input),
      ...(source.deadline ? { deadline: source.deadline } : {}),
      ...(source.workflow ? { workflow: structuredClone(source.workflow) } : {}),
      ...(response ? { decisionId: response.decisionId, response: structuredClone(response.response) } : {}) };
  }
  async retainControl(receipt: AgentControlReceipt): Promise<void> {
    validateAgentControlReceipt(receipt);
    const selected = this.state.selection.provider, actual = receipt.run.provider;
    if (!sameProviderRef(actual, selected))
      throw new AgentApiError("provider_identity_changed", "The control belongs to another provider installation.", 409);
    await this.change(async () => {
      const next = structuredClone(this.state);
      const matches = Object.entries(next.mutations ?? {}).filter(([, request]) => request.runId === receipt.run.id
        && ["runs.respond", "runs.cancel", "runs.control"].includes(request.operation)
        && (JSON.parse(request.body) as { requestId: string }).requestId === receipt.requestId);
      if (matches.length > 1) throw new AgentApiError("provider_identity_changed", "A retained control identity is ambiguous.", 409);
      const response = matches[0]?.[1];
      this.rememberContinuation(next, receipt, response?.operation === "runs.respond" ? response : undefined);
      const cancelled = response?.operation === "runs.cancel" ? response : next.cancellations?.[receipt.run.id]?.request;
      if (cancelled && (JSON.parse(cancelled.body) as AgentCancelInput).requestId === receipt.requestId)
        this.rememberCancellation(next, cancelled as AgentPreparedRequest<AgentControlReceipt>, receipt);
      if (receipt.state !== "unknown" && receipt.state !== "accepted") for (const [key] of matches) delete next.mutations?.[key];
      await this.save(next);
    });
  }
  /** Observe a retained control receipt without delivering its mutation again. */
  async readControl(prepared: AgentPreparedRequest): Promise<AgentControlReceipt> {
    if (!["runs.respond", "runs.cancel", "runs.control"].includes(prepared.operation) || !prepared.runId)
      throw new Error("This request is not a retained run control.");
    const input = JSON.parse(prepared.body) as { requestId: string; expectedGeneration?: string };
    const requestId = input.requestId;
    const receipt = await this.client.control(prepared.runId, requestId);
    validateAgentControlReceipt(receipt);
    if (receipt.run.id !== prepared.runId || receipt.requestId !== requestId)
      throw new Error("The observed receipt belongs to another control.");
    if (input.expectedGeneration !== undefined && receipt.generation !== input.expectedGeneration)
      throw new AgentApiError("provider_identity_changed", "The observed control belongs to another execution generation.", 409);
    await this.retainControl(receipt);
    return receipt;
  }
  /** Terminal streams may end before their accepted controls finish. GET never replays them. */
  async refreshControls(): Promise<void> {
    for (const request of Object.values(this.state.mutations ?? {})) if (["runs.respond", "runs.cancel", "runs.control"].includes(request.operation)) {
      try { await this.readControl(request); }
      catch (error) { if (!(error instanceof AgentApiError && error.status === 404)) throw error; }
    }
  }
  async markContinuation(continuation: ProviderContinuation, state: ProviderContinuation["state"]): Promise<void> {
    await this.change(async () => {
      const next = structuredClone(this.state), current = next.continuations?.[this.continuationKey(continuation.sourceRunId, continuation.requestId)];
      if (!current || current.run.id !== continuation.run.id) throw new Error("The reserved continuation is no longer retained.");
      current.state = state; await this.save(next);
    });
  }

  async respond(input: AgentResponseInput): Promise<AgentControlReceipt> {
    return this.controlMutation(prepareAgentResponse(this.requiredRun(), input));
  }
  async cancel(input: AgentCancelInput): Promise<AgentControlReceipt> {
    const runId = this.requiredRun(), pending = this.mutations.cancelling.get(runId);
    if (pending) return pending;
    const operation = this.cancelRun(runId, input).finally(() => { this.mutations.cancelling.delete(runId); });
    this.mutations.cancelling.set(runId, operation); return operation;
  }
  private async cancelRun(runId: string, input: AgentCancelInput): Promise<AgentControlReceipt> {
    const known = this.state.cancellations?.[runId];
    const retained = Object.values(this.state.mutations ?? {}).filter(request => request.operation === "runs.cancel" && request.runId === runId);
    if (retained.length > 1 || known && retained.some(request => this.key(request) !== this.key(known.request)))
      throw new AgentApiError("control_unknown", "The retained cancellation identity is ambiguous. Reconcile its original command.", 409);
    const original = known?.request ?? retained[0] as AgentPreparedRequest<AgentControlReceipt> | undefined;
    if (!original) return this.controlMutation(prepareAgentCancel(runId, input));
    try {
      const receipt = await this.readControl(original);
      // An accepted/applied cancel can leave external effects unknown. Observe that same logical
      // operation instead of preparing another request with newer optimistic revisions.
      if (receipt.state !== "unknown" || known?.receipt?.state === "applied") return receipt;
    } catch (error) {
      if (!(error instanceof AgentApiError && error.status === 404)) throw error;
      if (known?.receipt && known.receipt.state !== "unknown")
        throw new AgentApiError("control_unknown", "The provider lost a previously acknowledged cancellation receipt. Its input was not replayed.", 409);
    }
    return this.controlMutation(original);
  }
  private rememberCancellation(next: ProviderExecutionState, request: AgentPreparedRequest<AgentControlReceipt>, receipt?: AgentControlReceipt): void {
    const runId = request.runId, input = JSON.parse(request.body) as AgentCancelInput;
    const parsed = validateAgentRequest(request.method, request.path, request.body, "runs.cancel");
    if (request.operation !== "runs.cancel" || !runId || parsed.runId !== runId
      || input.fenceIfNotAdmitted && input.fenceIfNotAdmitted.sessionId !== next.sessionId)
      throw new AgentApiError("provider_identity_changed", "The retained request is not a run cancellation.", 409);
    if (request.bodyHash !== createHash("sha256").update(request.body).digest("hex"))
      throw new AgentApiError("request_digest_mismatch", "The retained cancellation bytes changed.", 409);
    const previous = next.cancellations?.[runId];
    if (previous && this.key(previous.request) !== this.key(request))
      throw new AgentApiError("control_unknown", "The original cancellation bytes cannot be replaced.", 409);
    if (receipt) {
      validateAgentControlReceipt(receipt);
      const actual = receipt.run.provider, selected = next.selection.provider;
      if (receipt.requestId !== input.requestId || receipt.run.id !== runId || !sameProviderRef(actual, selected)
        || input.expectedGeneration !== undefined && receipt.generation !== undefined && input.expectedGeneration !== receipt.generation
        || next.run?.ref.id === runId && receipt.generation !== undefined && next.run.generation !== receipt.generation)
        throw new AgentApiError("provider_identity_changed", "The cancellation receipt belongs to another execution.", 409);
    }
    (next.cancellations ??= {})[runId] = { request: structuredClone(previous?.request ?? request),
      ...(receipt ? { receipt: structuredClone(previous?.receipt?.state === "applied" && ["accepted", "unknown"].includes(receipt.state) ? previous.receipt : receipt) }
        : previous?.receipt ? { receipt: previous.receipt } : {}) };
  }
  async control(input: AgentRunControlInput): Promise<AgentControlReceipt> {
    return this.controlMutation(prepareAgentControl(this.requiredRun(), input));
  }
  private async controlMutation(prepared: AgentPreparedRequest<AgentControlReceipt>): Promise<AgentControlReceipt> {
    const receipt = await this.execute(prepared);
    await this.change(async () => {
      const next = structuredClone(this.state);
      if (prepared.operation === "runs.respond") this.rememberContinuation(next, receipt, prepared);
      if (prepared.operation === "runs.cancel") this.rememberCancellation(next, prepared, receipt);
      if (receipt.state !== "unknown" && receipt.state !== "accepted") delete next.mutations?.[this.key(prepared)];
      await this.save(next);
    });
    return receipt;
  }
  private requiredRun(): string {
    if (!this.state.runId) throw new Error("This conversation has no provider run.");
    return this.state.runId;
  }

  /** Detach only the observation. Core/provider lifecycle and admitted execution remain independent. */
  detach(): void { this.observer?.abort(); this.observer = null; }
}

export function retryableObservation(error: unknown): boolean {
  if (error instanceof AgentApiError) return error.retryable || [429, 503, 504].includes(error.status);
  if (error instanceof Error && error.name === "TimeoutError") return true;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  // A sealed/corrupt source and a malformed projection require reconciliation, not another append.
  if (code?.startsWith("session_storage_") || code === "resync_required") return false;
  return code === undefined || ["EAGAIN", "EBUSY", "EMFILE", "ENFILE", "ENOSPC", "EIO", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"].includes(code);
}
function observationPause(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delay);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
