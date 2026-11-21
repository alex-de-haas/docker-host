import { randomUUID } from "node:crypto";
import { workflowCapabilities } from "./subagent-workflow.js";
import { AGENT_CAPABILITIES, AgentApiError, type AgentConfiguration, type AgentMcpSelection, type AgentPendingDecision,
  type AgentRunInput, type AgentRunSnapshot, type AgentResponseInput, type AgentControlReceipt, type AgentSessionWorkflowBinding } from "@hosty-sdk/app/agent";
import type { AgentClient } from "@hosty-sdk/app/agent/client";
import type { HarnessRun, HarnessStartOptions } from "../harness/adapter.js";
import { ProviderExecution, retryableObservation, type ProviderContinuation, type ProviderExecutionPersistence, type ProviderExecutionState } from "./execution.js";
import { providerDecisionCardId, type QuestionAnswers } from "./decision-identity.js";

export type ProviderRunContext = {
  client: AgentClient;
  state: ProviderExecutionState;
  persistence: ProviderExecutionPersistence;
  configuration: AgentConfiguration;
  workflow?: AgentSessionWorkflowBinding;
  negotiatedCapabilities?: string[];
  dispatchRunId?: string;
  installationHistory?(): Promise<boolean>;
  observationContact?(runId: string, error: unknown | null): Promise<void>;
  input(text: string): Promise<Omit<AgentRunInput, "expectedSessionRevision" | "configurationRevision" | "continuation">>;
  refreshResources?(previous: AgentRunInput["resources"]): Promise<AgentRunInput["resources"]>;
  unavailable(error: unknown): Promise<void>;
};

/** A Harness-local handle for a public provider execution, not an engine or process transport. */
export class ProviderHarnessRun implements HarnessRun {
  private context: ProviderRunContext | null = null;
  private execution: ProviderExecution | null = null;
  private admission: Promise<void> = Promise.resolve();
  private observation: Promise<void> = Promise.resolve();
  private busy = false;
  private detached = false;
  private observationWaiting = false;
  private installationObservedRun?: string;
  private observationFailures = 0;
  private retryTimer?: NodeJS.Timeout;
  private readonly controls = new Map<string, string>();
  private confirmedStop: AgentRunSnapshot | null = null;
  private stopRequested = false;
  private disablingSuggestions?: Promise<void>;
  private readonly continuing = new Map<string, Promise<void>>();
  constructor(private readonly load: (admitting?: boolean) => Promise<ProviderRunContext>, private readonly options: HarnessStartOptions) {}

  send(text: string): void {
    if (this.busy || this.detached) throw new AgentApiError("session_busy", "Reconcile the current provider turn before sending another input.", 409);
    this.busy = true;
    this.stopRequested = false;
    this.confirmedStop = null;
    this.admission = this.admit(text);
    this.observation = this.admission.then(async () => {
      if (this.detached) return;
      await this.observe();
      if (this.context!.state.run?.stopConfirmed) this.busy = false;
    }).catch(async error => {
      if (!this.detached) await this.context?.unavailable(error);
    });
  }

  private async admit(text: string): Promise<void> {
    const context = this.context = await this.load(true);
    const execution = this.execution = new ProviderExecution(context.client, context.state, context.persistence);
    await this.requireWorkflowCapability(context.workflow, context.negotiatedCapabilities);
    const configuration: AgentConfiguration = { ...structuredClone(context.configuration),
      ...(this.options.autonomy !== undefined ? { approvalMode: this.options.autonomy } : {}),
      ...(this.options.promptSuggestions !== undefined ? { predictions: { enabled: this.options.promptSuggestions } } : {}) };
    for (const request of Object.values(context.state.mutations ?? {})) if (["runs.respond", "runs.cancel", "runs.control"].includes(request.operation)) {
      try { await execution.readControl(request); }
      catch (error) { if (!(error instanceof AgentApiError && error.status === 404)) throw error; }
    }
    const pending = Object.values(context.state.mutations ?? {});
    if (pending.some(request => request.operation !== "sessions.create" && request.operation !== "sessions.configure"))
      throw new AgentApiError("mutation_unresolved", "Reconcile the retained provider request before starting another turn.", 409);
    if (context.state.runId) {
      const previous = await execution.read(false);
      if (!previous.stopConfirmed) throw new AgentApiError("stop_unconfirmed", "The previous provider execution has not confirmed native exit.", 409);
      await execution.retain(previous);
    }
    const creations = pending.filter(request => request.operation === "sessions.create");
    if (creations.length) {
      if (creations.length !== 1 || configurationKey(JSON.parse(creations[0]!.body).configuration) !== configurationKey(configuration))
        throw new AgentApiError("configuration_unknown", "Reconcile the original session configuration before changing it.", 409);
      await execution.reconcileMutation(creations[0]!);
    } else if (!context.state.session) await execution.create(configuration);
    // Refresh mutable session metadata before preparing a new immutable request; never rewrite an
    // already prepared uncertain start just to acquire a more recent optimistic revision.
    let session = await execution.session();
    const configurations = Object.values(context.state.mutations ?? {}).filter(request => request.operation === "sessions.configure");
    if (configurations.length) {
      if (configurations.length !== 1 || configurationKey(JSON.parse(configurations[0]!.body).configuration) !== configurationKey(configuration))
        throw new AgentApiError("configuration_unknown", "Reconcile the original configuration change before requesting another policy.", 409);
      session = await execution.reconcileMutation(configurations[0]!) as typeof session;
    }
    if (session.activeRun) throw new AgentApiError("session_busy", "The provider session still owns an execution. Reconcile its stop before continuing.", 409);
    const known = () => session.configuration ?? (context.state.appliedConfiguration?.revision === session.configurationRevision
      && context.state.appliedConfiguration.digest === session.configurationDigest ? context.state.appliedConfiguration.value : undefined);
    if (configurationKey(known()) !== configurationKey(configuration)) {
      const requestId = randomUUID();
      session = await execution.configure(requestId, { requestId, expectedSessionRevision: session.revision, configuration });
      if (configurationKey(known()) !== configurationKey(configuration))
        throw new AgentApiError("configuration_unconfirmed", "The provider did not confirm the requested session configuration.", 502);
    }
    const input = await context.input(text);
    if (this.stopRequested) throw new AgentApiError("execution_cancelled", "This admission was stopped before execution.", 409);
    await execution.start(context.dispatchRunId ?? randomUUID(), { ...input, expectedSessionRevision: session.revision,
      configurationRevision: session.configurationRevision,
      continuation: session.nativeState === "not_created" ? "start" : "resume" }, undefined, context.workflow);
  }

  waitForAdmission(): Promise<void> { return this.admission; }

  /** A lost native start response prevents send() from entering its observer. */
  async observeConfirmedAdmission(): Promise<void> {
    try { await this.admission; }
    catch {
      await this.observation;
      await this.attach(true);
      this.admission = Promise.resolve();
    }
  }

  private async observe(readOnlySnapshots = false, useInstallationHistory = true): Promise<void> {
    const context = this.context!, runId = context.state.runId!;
    try {
      const execution = this.execution!;
      const shared = useInstallationHistory && await context.installationHistory?.();
      if (this.detached || this.execution !== execution || context.state.runId !== runId) return;
      if (shared) { this.installationObservedRun = runId; return; }
      this.installationObservedRun = undefined;
      await execution.observe(undefined, continuation => this.continueReserved(continuation), {
        observed: async () => {
          this.observationFailures = 0;
          await context.observationContact?.(runId, null);
        }, readOnlySnapshots,
      });
      if (context.state.run?.stopConfirmed) this.busy = false;
    } catch (error) {
      if (this.detached || context.state.runId !== runId) return;
      if (!context.observationContact) throw error;
      this.observationWaiting = true;
      const retry = retryableObservation(error);
      if (retry) {
        clearTimeout(this.retryTimer);
        const delay = Math.min(30000, 1000 * 2 ** Math.min(this.observationFailures++, 5));
        this.retryTimer = setTimeout(() => this.retryObservation(), delay);
        this.retryTimer.unref();
      }
      console.warn("[provider-observation]", { stage: "watch-run", retry: retry ? "scheduled" : "awaiting-refresh" });
      await context.observationContact(runId, error);
    }
  }

  /** Resume the read side of this same admission, without replaying mutations or opening a second watch. */
  retryObservation(): void {
    if (this.detached || !this.observationWaiting) return;
    this.observationWaiting = false;
    clearTimeout(this.retryTimer);
    this.observation = this.observe(true).catch(async error => { if (!this.detached) await this.context?.unavailable(error); });
  }

  /** A provider downgrade ends this subscription. The same live actor can still read this run. */
  onInstallationHistoryUnsupported(): void {
    const state = this.context?.state;
    if (this.detached || this.stopRequested || !state?.runId || this.installationObservedRun !== state.runId || state.run?.stopConfirmed) return;
    this.installationObservedRun = undefined;
    this.observation = this.observe(true, false).catch(async error => { if (!this.detached) await this.context?.unavailable(error); });
  }

  /** Receipts may resume an existing operator-authorized control. The feed cannot admit one. */
  onHistoryObserved(item: import("@hosty-sdk/app/agent").AgentWatchItem): void {
    const runId = item.kind === "snapshot" ? item.snapshot.ref.id : item.event.runId;
    if (this.detached || this.context?.state.runId !== runId || !this.execution) return;
    if (this.context.state.run?.stopConfirmed) this.busy = false;
    const snapshot = item.kind === "snapshot" ? item.snapshot : item.event.type === "run.updated" ? item.event.data.snapshot as AgentRunSnapshot : undefined;
    if (!(item.kind === "event" && item.event.type === "control.updated") && !snapshot?.pendingContinuations?.length) return;
    const execution = this.execution;
    this.observation = this.observation.catch(() => {}).then(async () => {
      if (!this.detached && this.context?.state.runId === runId)
        await execution.observeControls(item, continuation => this.continueReserved(continuation));
    }).catch(async error => { if (!this.detached) await this.context?.unavailable(error); });
  }

  private async requireWorkflowCapability(workflow: AgentSessionWorkflowBinding | undefined, known?: string[]): Promise<void> {
    if (!workflow) return;
    const available = known ?? (await this.context!.client.capabilities()).capabilities;
    const missing = workflowCapabilities(workflow).find(capability => !available.includes(capability));
    if (missing) throw new AgentApiError("workflow_provider_unsupported", missing === AGENT_CAPABILITIES.consumerWorkflow
      ? "The selected provider does not support consumer task workflows. Update it or choose a compatible provider before running this task."
      : "The selected provider no longer supports this chat workflow.", 422);
  }

  async attach(observationOnly = false): Promise<void> {
    if (this.detached) return;
    const context = this.context = await this.load();
    if (this.detached) return;
    if (!context.state.runId) throw new AgentApiError("run_not_found", "There is no retained provider run to observe.", 404);
    this.execution = new ProviderExecution(context.client, context.state, context.persistence);
    if (!observationOnly) await this.reconcileRetainedCommands(context);
    this.busy = !context.state.run?.stopConfirmed;
    this.observation = this.observe(observationOnly).catch(async error => {
      if (!this.detached) await context.unavailable(error);
    });
  }

  private async reconcileRetainedCommands(context: ProviderRunContext): Promise<void> {
    const execution = this.execution!;
    for (const request of Object.values(context.state.mutations ?? {})) if (["runs.respond", "runs.cancel", "runs.control"].includes(request.operation)) {
      try { await execution.readControl(request); }
      catch (error) {
        if (!(error instanceof AgentApiError && error.status === 404)) throw error;
        // Persisted Stop intent takes precedence over recovering an uncertain admission. A
        // not-yet-delivered cancellation fence must reach the provider before the old start.
        if (request.operation === "runs.cancel") await execution.reconcileMutation(request);
      }
    }
    const starts = Object.values(context.state.mutations ?? {}).filter(request => request.operation === "runs.start");
    if (starts.length) {
      if (starts.length !== 1 || starts[0]!.runId !== context.state.runId)
        throw new AgentApiError("mutation_unresolved", "The retained provider admission identity is ambiguous.", 409);
      if (Object.values(context.state.mutations ?? {}).some(request => request.operation === "runs.cancel"))
        throw new AgentApiError("stop_unconfirmed", "Confirm the retained cancellation before recovering this admission.", 409);
      // The original UUID/body is idempotent even when its first response was lost. A confirmed
      // pre-admission cancellation returns its tombstone here without starting native execution.
      await execution.reconcileMutation(starts[0]!);
    }
  }

  private async pending(id: string, kind: AgentPendingDecision["kind"], runId?: string): Promise<{ snapshot: AgentRunSnapshot; decision: AgentPendingDecision } | null> {
    await this.admission;
    if (!this.execution) return null;
    const snapshot = await this.execution.read(false);
    if (runId !== undefined && snapshot.ref.id !== runId) return null;
    const decision = snapshot.pending.find(candidate => candidate.id === id && candidate.kind === kind);
    return decision ? { snapshot, decision } : null;
  }

  private async respond(id: string, response: AgentResponseInput["response"], runId?: string): Promise<boolean> {
    await this.admission;
    const continuation = Object.values(this.context?.state.continuations ?? {}).find(value => value.decisionId === id
      && (runId === undefined || value.sourceRunId === runId)
      && value.state === "awaiting_authorization");
    if (continuation) {
      if (continuation.response && configurationKey(continuation.response) !== configurationKey(response))
        throw new AgentApiError("control_unknown", "Reconcile the original answer before changing its continuation.", 409);
      await this.continueReserved(continuation); return true;
    }
    const retained = Object.values(this.context?.state.mutations ?? {}).find(request => request.operation === "runs.respond"
      && (runId === undefined || request.runId === runId)
      && (JSON.parse(request.body) as AgentResponseInput).decisionId === id);
    if (retained) {
      const previous = JSON.parse(retained.body) as AgentResponseInput;
      if (JSON.stringify(previous.response) !== JSON.stringify(response))
        throw new AgentApiError("control_unknown", "Reconcile the earlier response before changing this decision.", 409);
      return this.responseAccepted(await this.execution!.reconcileMutation(retained) as AgentControlReceipt);
    }
    const current = await this.pending(id, response.kind, runId);
    if (!current) return false;
    const key = JSON.stringify([id, current.decision.revision, response]);
    let requestId = this.controls.get(key);
    if (!requestId) { requestId = randomUUID(); this.controls.set(key, requestId); }
    const receipt = await this.execution!.respond({ requestId, expectedGeneration: current.snapshot.generation,
      expectedRevision: current.snapshot.revision, decisionId: id, decisionRevision: current.decision.revision, response });
    return this.responseAccepted(receipt);
  }
  private async responseAccepted(receipt: AgentControlReceipt): Promise<boolean> {
    if (receipt.state === "unknown") throw new AgentApiError("control_unknown", "The response outcome is uncertain. Reconcile this response before sending it again.", 409, false, { requestId: receipt.requestId });
    if (receipt.continuation?.state === "awaiting_authorization") {
      const continuation = Object.values(this.context?.state.continuations ?? {}).find(value => value.requestId === receipt.requestId && value.sourceRunId === receipt.run.id);
      if (!continuation) throw new AgentApiError("continuation_unavailable", "The exact reserved continuation is not retained.", 409);
      await this.continueReserved(continuation);
    }
    return receipt.state !== "rejected" && receipt.state !== "superseded";
  }
  private continueReserved(continuation: ProviderContinuation): Promise<void> {
    const key = JSON.stringify([continuation.sourceRunId, continuation.requestId]);
    const previous = this.continuing.get(key); if (previous) return previous;
    const operation = this.admitContinuation(continuation).finally(() => { this.continuing.delete(key); });
    this.continuing.set(key, operation); return operation;
  }
  private async admitContinuation(continuation: ProviderContinuation): Promise<void> {
    if (this.detached || this.stopRequested) return;
    const context = this.context!, execution = this.execution!;
    await this.requireWorkflowCapability(continuation.workflow);
    const retained = Object.values(context.state.mutations ?? {}).find(request => request.operation === "runs.start" && request.runId === continuation.run.id);
    if (retained) await execution.reconcileMutation(retained);
    else {
      const receipt = await context.client.control(continuation.sourceRunId, continuation.requestId);
      await execution.retainControl(receipt);
      if (receipt.continuation?.state === "superseded") return;
      if (receipt.continuation?.state === "admitted" && receipt.continuation.run.id === continuation.run.id
        && context.state.runId === continuation.run.id && context.state.run?.ref.id === continuation.run.id) {
        await execution.markContinuation(continuation, "admitted"); this.observeContinuation(); return;
      }
      if (receipt.continuation?.state !== "awaiting_authorization" || receipt.continuation.run.id !== continuation.run.id)
        throw new AgentApiError("continuation_changed", "The reserved continuation is no longer awaiting admission. Reconcile its existing run.", 409);
      const original = await context.client.run(continuation.sourceRunId);
      if (original.sessionId !== context.state.sessionId || !original.stopConfirmed
        || original.configurationRevision !== continuation.input.configurationRevision)
        throw new AgentApiError("continuation_unconfirmed", "The original execution must stop with its original configuration before continuing.", 409);
      if (context.state.runId !== continuation.sourceRunId)
        throw new AgentApiError("continuation_changed", "Another execution now owns this conversation.", 409);
      await execution.retain(original);
      const session = await execution.session();
      if (session.configurationRevision !== continuation.input.configurationRevision || session.nativeState !== "available" || session.activeRun)
        throw new AgentApiError("continuation_configuration_changed", "The original native session/configuration is unavailable. Its answer was not reconstructed.", 409);
      const input = structuredClone(continuation.input);
      input.input = { decisionResponseRef: { runId: continuation.sourceRunId, requestId: continuation.requestId } };
      if (context.refreshResources) {
        const original = structuredClone(input.resources ?? []);
        const refreshed = await context.refreshResources(structuredClone(original)) ?? [];
        if (original.length !== refreshed.length || original.some(value => refreshed.filter(next => next.kind === value.kind && next.id === value.id).length !== 1))
          throw new AgentApiError("continuation_resources_changed", "A decision continuation must retain its original selected worktrees.", 409);
        // The first resource selects CWD. Refresh revisions without changing that original order.
        input.resources = original.map(value => ({ ...value, revision: refreshed.find(next => next.kind === value.kind && next.id === value.id)!.revision }));
      }
      input.expectedSessionRevision = session.revision; input.continuation = "resume";
      if (continuation.deadline) {
        const remaining = Math.floor(Date.parse(continuation.deadline) - Date.now());
        if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new AgentApiError("continuation_expired", "The original execution's bounded deadline expired.", 409);
        input.limits = { ...input.limits, maxDurationMs: Math.min(remaining, input.limits?.maxDurationMs ?? remaining) };
      }
      if (this.detached || this.stopRequested) return;
      execution.detach(); this.busy = true; this.confirmedStop = null;
      await execution.start(continuation.run.id, input, continuation.deadline, continuation.workflow);
    }
    await execution.markContinuation(continuation, "admitted");
    this.observeContinuation();
  }
  private observeContinuation(): void {
    if (!this.detached && !this.stopRequested) this.observation = this.observe()
      .then(() => { if (this.context!.state.run?.stopConfirmed) this.busy = false; })
      .catch(async error => { if (!this.detached) await this.context?.unavailable(error); });
  }
  resolveApproval(id: string, decision: "allow" | "deny", message?: string): Promise<boolean> {
    return this.respond(id, { kind: "approval", decision, ...(message ? { message } : {}) });
  }
  resolveQuestion(id: string, answers: QuestionAnswers): Promise<boolean> {
    return this.respond(id, { kind: "question", answers });
  }

  /** The UI names a run-qualified card; only this bridge translates to the provider's opaque ID. */
  async respondToCard(cardId: string, response: AgentResponseInput["response"]): Promise<boolean> {
    await this.admission;
    if (!this.execution || !this.context) return false;
    for (const continuation of Object.values(this.context.state.continuations ?? {}))
      if (continuation.state === "awaiting_authorization" && continuation.decisionId
        && providerDecisionCardId(continuation.sourceRunId, continuation.decisionId) === cardId)
        return this.respond(continuation.decisionId, response, continuation.sourceRunId);
    for (const request of Object.values(this.context.state.mutations ?? {})) if (request.operation === "runs.respond" && request.runId) {
      const input = JSON.parse(request.body) as AgentResponseInput;
      if (input.response.kind === response.kind && providerDecisionCardId(request.runId, input.decisionId) === cardId)
        return this.respond(input.decisionId, response, request.runId);
    }
    const snapshot = await this.execution.read(false);
    const decision = snapshot.pending.find(value => value.kind === response.kind && providerDecisionCardId(snapshot.ref.id, value.id) === cardId);
    return decision ? this.respond(decision.id, response, snapshot.ref.id) : false;
  }

  async setMcpServers(_servers: Record<string, unknown>): Promise<boolean> {
    // Execution receives logical target references at admission. Raw consumer callback URLs are
    // never installed in another app by this compatibility interface.
    return false;
  }
  async configureMcp(mcp: AgentMcpSelection): Promise<void> {
    await this.admission;
    if (!this.execution || !this.context) throw new AgentApiError("run_not_found", "There is no public provider execution to configure.", 404);
    const capabilities = new Set((await this.context.client.capabilities()).capabilities);
    const retained = Object.values(this.context.state.mutations ?? {}).find(request => request.operation === "runs.control"
      && ["mcpPolicy", "liveConfigure"].includes((JSON.parse(request.body) as { command: string }).command));
    if (retained) {
      const original = JSON.parse(retained.body) as { command: "mcpPolicy" | "liveConfigure"; mcp: AgentMcpSelection };
      if (configurationKey(original.mcp) !== configurationKey(mcp))
        throw new AgentApiError("control_unknown", "Reconcile the retained MCP update before changing its policy.", 409);
      const capability = original.command === "mcpPolicy" ? "mcp.policy-update" : "runs.live-configure";
      if (!capabilities.has(capability)) throw new AgentApiError("unsupported_control", "The provider no longer declares the retained MCP control.", 422);
      this.mcpControlAccepted(await this.execution.reconcileMutation(retained) as AgentControlReceipt); return;
    }
    const lastInput = this.context.state.lastRunInput;
    const admitted = lastInput && lastInput.runId === this.context.state.runId ? lastInput.input.mcp : undefined;
    const command = mcpSubset(mcp, admitted) && capabilities.has("mcp.policy-update") ? "mcpPolicy"
      : capabilities.has("runs.live-configure") ? "liveConfigure" : undefined;
    if (!command) throw new AgentApiError("unsupported_control", "The provider cannot apply this MCP change during its current execution. Start a new turn with the desired selection.", 422);
    const snapshot = await this.execution!.read(false);
    this.mcpControlAccepted(await this.execution.control({ requestId: randomUUID(), expectedGeneration: snapshot.generation,
      expectedRevision: snapshot.revision, command, mcp }));
  }
  private mcpControlAccepted(receipt: AgentControlReceipt): void {
    if (receipt.state === "unknown") throw new AgentApiError("control_unknown", "The MCP update outcome is uncertain. Reconcile its retained command before changing policy.", 409, false, { requestId: receipt.requestId });
    if (receipt.state === "rejected" || receipt.state === "superseded") throw new AgentApiError(receipt.error?.code ?? "control_rejected",
      receipt.error?.message ?? "The provider did not apply this MCP update.", 409);
  }

  interrupt(): Promise<void> { return this.stopAndWait(); }
  stop(): Promise<void> { return this.stopAndWait(); }
  async stopAndWait(): Promise<void> {
    this.stopRequested = true;
    await this.admission.catch(() => undefined);
    await Promise.allSettled([...this.continuing.values()]);
    if (!this.execution || !this.context?.state.runId) return;
    let snapshot: AgentRunSnapshot, cancellationRequested = false;
    for (const pending of Object.values(this.context.state.mutations ?? {}))
      if (pending.operation === "runs.respond") await this.execution.readControl(pending);
    const reservations = () => Object.values(this.context!.state.continuations ?? {}).filter(value => value.sourceRunId === this.context!.state.runId
      && ["pending", "awaiting_authorization"].includes(value.state));
    try { snapshot = await this.execution.read(false); }
    catch (error) {
      const start = Object.values(this.context.state.mutations ?? {}).find(request => request.operation === "runs.start");
      if (!start) throw error;
      await this.execution.cancel({ requestId: randomUUID(), fenceIfNotAdmitted: { sessionId: this.context.state.sessionId, startDigest: start.bodyHash } });
      cancellationRequested = true;
      snapshot = await this.execution.read(false);
    }
    if (snapshot.stopConfirmed && !reservations().length
      && !Object.values(this.context.state.mutations ?? {}).some(request => request.operation === "runs.respond")) return this.acceptStop(snapshot);
    if (!cancellationRequested) {
      await this.execution.cancel({ requestId: randomUUID(), expectedGeneration: snapshot.generation, expectedRevision: snapshot.revision });
    }
    const deadline = Date.now() + 30000;
    do {
      snapshot = await this.execution.read(false);
      if (snapshot.stopConfirmed) {
        for (const pending of reservations()) {
          const receipt = await this.context.client.control(pending.sourceRunId, pending.requestId);
          await this.execution.retainControl(receipt);
          if (receipt.continuation?.run.id !== pending.run.id || receipt.continuation.state !== "superseded")
            throw new AgentApiError("stop_unconfirmed", "The provider has not confirmed cancellation of its reserved continuation.", 503, true);
        }
        return this.acceptStop(snapshot);
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    throw new AgentApiError("stop_unconfirmed", "Provider execution has not confirmed native exit. Its resources remain reserved.", 503, true);
  }
  private async acceptStop(snapshot: AgentRunSnapshot): Promise<void> {
    if (this.context?.state.runId !== snapshot.ref.id) throw new AgentApiError("stop_unconfirmed", "The active execution changed during Stop. Reconcile the current attempt.", 409);
    if (Object.values(this.context.state.mutations ?? {}).some(request => request.operation === "runs.respond"))
      throw new AgentApiError("stop_unconfirmed", "A retained decision response remains unresolved. Its continuation has not been fenced.", 503, true);
    await this.execution!.settleStopped(snapshot);
    this.confirmedStop = snapshot; this.busy = false;
  }
  get stopProof(): AgentRunSnapshot | null { return this.confirmedStop; }

  disableSuggestions(): Promise<void> {
    if (this.disablingSuggestions) return this.disablingSuggestions;
    const operation = this.disablePredictions().finally(() => {
      if (this.disablingSuggestions === operation) this.disablingSuggestions = undefined;
    });
    this.disablingSuggestions = operation; return operation;
  }
  private async disablePredictions(): Promise<void> {
    await this.admission;
    if (!this.execution || !this.context) return;
    const retained = Object.values(this.context.state.mutations ?? {}).filter(request => {
      if (request.operation !== "runs.control" || request.runId !== this.context!.state.runId) return false;
      const input = JSON.parse(request.body) as { command: string; enabled?: boolean };
      return input.command === "predictions" && input.enabled === false;
    });
    if (retained.length > 1) throw new AgentApiError("control_unknown", "Reconcile the original prediction control before changing it.", 409);
    if (retained[0]) { await this.execution.readControl(retained[0]); return; }
    const snapshot = await this.execution.read(false);
    if (snapshot.stopConfirmed) return;
    await this.execution.control({ requestId: randomUUID(), expectedGeneration: snapshot.generation,
      expectedRevision: snapshot.revision, command: "predictions", enabled: false });
  }
  finishSuggestions(): Promise<void> { return this.disableSuggestions(); }
  async detach(): Promise<void> {
    this.detached = true;
    clearTimeout(this.retryTimer);
    this.execution?.detach();
  }
}

/** Object member order is not a policy change; instruction/skill array order remains significant. */
function configurationKey(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, normalize(entry)])) : item;
  return JSON.stringify(normalize(value));
}

/** Policy/filter edits retain the admitted logical interfaces and external account revisions. */
function mcpSubset(requested: AgentMcpSelection, admitted: AgentMcpSelection | undefined): boolean {
  const targets = new Set((admitted?.targets ?? []).map(value => configurationKey(value.target)));
  const connections = new Set((admitted?.connections ?? []).map(value => configurationKey(value)));
  return (requested.targets ?? []).every(value => targets.has(configurationKey(value.target)))
    && (requested.connections ?? []).every(value => connections.has(configurationKey(value)));
}
