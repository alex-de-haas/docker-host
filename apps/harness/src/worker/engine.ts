import { SUGGESTION_DEADLINE_MS, suggestionText, successfulResult } from "../harness/prompt-suggestion.js";
import type { HarnessAdapter, HarnessEvent, HarnessRun } from "../harness/adapter.js";
import { WorkerJournal } from "./journal.js";
import { WorkerApiError, terminal, safeIdentity, validateRun, validateMcpServers, type WorkerRunRequest, type WorkerControl, type WorkerPark, type WorkerReceipt, type WorkerRecovery } from "./contracts.js";

export interface WorkerExecution {
  adapter(request: WorkerRunRequest): Promise<HarnessAdapter>;
  cwd(request: WorkerRunRequest): Promise<string>;
  validateSelection(request: WorkerRunRequest): Promise<void>;
  reserve(request: WorkerRunRequest): Promise<() => void>;
}

/** Application execution orchestration; it owns no Docker or Core lifecycle surface. */
export class WorkerEngine {
  private active = new Map<string, { run: HarnessRun; release: () => void; request: WorkerRunRequest; collecting?: NodeJS.Timeout; suggestions?: boolean }>();
  private admitted = new Set<string>();
  private disabledSuggestions = new Set<string>();
  private readonly quarantined = new Set<string>();
  private readonly failureFinalizations = new Map<string, Promise<void>>();
  private starts = new Set<Promise<void>>();
  private closing = false;
  private readonly usageTimer: NodeJS.Timeout;
  constructor(readonly journal: WorkerJournal, private readonly execution: WorkerExecution, private readonly capacity: number) {
    this.usageTimer = setInterval(() => {
      void this.journal.exclusive(async () => { for (const id of this.admitted) if (!this.quarantined.has(id)) await this.journal.sample(id); }).catch(error => {
        // A failed durable sample cannot become successful usage or exit evidence. The journal
        // already retries transient sharing violations before this permanent admission fence.
        if (!this.closing) {
          console.warn("[worker] Usage persistence failed; admission fenced.", { code: journalErrorCode(error) });
          void this.close("Worker stopped after usage persistence failed. Check worker logs.")
            .catch(error => console.warn("[worker] Shutdown finalization remains unconfirmed.", { code: journalErrorCode(error) }));
        }
      });
    }, 1000);
    this.usageTimer.unref();
  }

  get occupied(): number { return this.admitted.size; }
  get available(): boolean { return !this.closing; }
  async submit(id: string, input: unknown): Promise<WorkerReceipt> {
    validateRun(input);
    // Foreground work preempts optional collection, including Docker's single execution slot.
    const retry = await this.journal.exclusive(() => this.journal.load(id).catch(error => {
      if (error instanceof WorkerApiError && error.status === 404) return null; throw error;
    }));
    if (!retry && !this.closing) for (const [otherId, active] of this.active) {
      if (active.collecting && (this.admitted.size >= this.capacity || active.request.binding.connectionId === input.binding.connectionId))
        await this.finishSuggestion(otherId);
    }
    return this.journal.exclusive(async () => {
      // Observe an existing receipt before admission: a retry is not a new workload.
      const existing = await this.journal.load(id).catch(error => { if (error instanceof WorkerApiError && error.status === 404) return null; throw error; });
      // Existing accepted identities remain observable during a fence. worker_stopping therefore
      // proves rejection before admission, including when the coordinator repeats an uncertain PUT.
      if (!existing && this.closing) throw new WorkerApiError(503, "worker_stopping", "Worker is stopping.");
      if (!existing && this.admitted.size >= this.capacity) throw new WorkerApiError(409, "worker_busy", "Worker capacity is occupied.");
      if (!existing) await this.execution.validateSelection(input);
      const accepted = await this.journal.accept(id, input);
      if (accepted.fresh) {
        this.admitted.add(id);
        // Acceptance is durable before execution. No work is replayed after worker restart.
        const start = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.start(id, input));
        this.starts.add(start);
        void start.finally(() => this.starts.delete(start)).catch(() => { this.closing = true; });
      }
      return accepted.receipt;
    });
  }
  private async start(id: string, request: WorkerRunRequest): Promise<void> {
    let release: (() => void) | undefined, adapter: HarnessAdapter | undefined;
    let started = false;
    try {
      release = await this.execution.reserve(request);
      const cwd = await this.execution.cwd(request); adapter = await this.execution.adapter(request);
      const health = await adapter.probe();
      if (!health.available) throw new Error(health.reason ?? "Provider unavailable.");
      await this.journal.exclusive(async () => {
        if ((await this.journal.load(id)).receipt.state === "cancelling") {
          await this.journal.update(id, "cancelled"); this.admitted.delete(id); this.disabledSuggestions.delete(id); release?.(); release = undefined; return;
        }
        await this.journal.update(id, "running");
        const suggestions = request.options.promptSuggestions === true && adapter!.capabilities.promptSuggestions === true && !this.disabledSuggestions.has(id);
        const run = adapter!.start({ ...request.options, promptSuggestions: suggestions, sessionId: request.conversationId, cwd, resource: request.resource, workerRunId: id,
          ...request.selection,
          isAutoAllowed: tool => request.autoAllowedPrefixes.some(prefix => tool.startsWith(prefix)),
          onEvent: event => { void this.event(id, event).catch(error => console.warn("[worker] Provider event finalization remains unconfirmed.", { code: journalErrorCode(error) })); } });
        const claim = release!; let released = false;
        this.active.set(id, { run, request, suggestions, release: () => { if (!released) { released = true; claim(); } } }); release = undefined; started = true;
        run.send(request.input);
      });
    } catch (error) {
      release?.();
      await this.fail(id, error instanceof Error ? error.message : "Provider failed to start.");
    } finally { if (!started) await adapter?.dispose?.(); }
  }
  private async event(id: string, event: HarnessEvent): Promise<void> {
    try {
      await this.journal.exclusive(async () => {
        if (this.quarantined.has(id)) return;
        const state = (await this.journal.load(id)).receipt.state;
        if (terminal(state)) return;
        const active = this.active.get(id);
        if (state === "suggesting") {
          if (event.type === "prompt_suggestion") {
            await this.journal.append(id, { type: "prompt_suggestion", text: suggestionText(event.text),
              ...(["unavailable", "unsupported", "timeout"].includes(event.reason ?? "") ? { reason: event.reason } : {}) });
            await this.finishSuggestionLocked(id);
          } else if (event.type === "error") await this.finishSuggestionLocked(id);
          // Prediction output cannot become another transcript/tool/approval/turn.
          return;
        }
        if (state === "parking") {
          // Shutdown can race a native tool start. Retain effect evidence before confirming parking.
          if (["native_effect", "tool_use", "tool_result", "command_result"].includes(event.type)) await this.journal.append(id, event);
          return;
        }
        if (event.type === "prompt_suggestion" || event.type === "answer_complete") return;
        await this.journal.append(id, event);
        if (event.type === "approval_request" || event.type === "question_request" && event.blocking !== false) await this.journal.update(id, "awaiting_input");
        if (event.type === "result" && successfulResult(event.status) && active?.suggestions && state !== "cancelling") {
          active.collecting = setTimeout(() => { void this.finishSuggestion(id, true).catch(error => console.warn("[worker] Prediction finalization remains unconfirmed.", { code: journalErrorCode(error) })); }, SUGGESTION_DEADLINE_MS);
          active.collecting.unref();
          await this.journal.update(id, "suggesting");
          await this.journal.append(id, { type: "answer_complete" });
          return;
        }
        if (event.type === "result" || event.type === "error") {
          await this.stopNative(id);
          await this.journal.update(id, state === "cancelling" ? "cancelled" : event.type === "error" ? "failed" : "completed");
          this.admitted.delete(id);
        }
      });
    } catch { await this.fail(id, "Worker could not persist or finalize provider output. Execution may require recovery."); }
  }
  private async stopNative(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    clearTimeout(active.collecting);
    if (active.run.stopAndWait) await active.run.stopAndWait(); else await active.run.stop();
    active.release(); this.active.delete(id); this.disabledSuggestions.delete(id);
  }
  private async finishSuggestionLocked(id: string, timeout = false): Promise<void> {
    if (this.quarantined.has(id) || (await this.journal.load(id)).receipt.state !== "suggesting") return;
    if (timeout) await this.journal.append(id, { type: "prompt_suggestion", text: null, reason: "timeout" });
    await this.stopNative(id);
    await this.journal.update(id, "completed");
    this.admitted.delete(id);
  }
  private async finishSuggestion(id: string, timeout = false): Promise<void> {
    try { await this.journal.exclusive(() => this.finishSuggestionLocked(id, timeout)); }
    catch { await this.fail(id, "Prediction cleanup could not confirm native execution exit."); }
  }
  private async fail(id: string, message: string): Promise<void> {
    const pending = this.failureFinalizations.get(id);
    if (pending) return pending;
    // Quarantine before native cleanup yields: usage ticks and late callbacks must not retry a
    // fenced journal or turn one run's storage failure into a Worker-wide shutdown.
    this.quarantined.add(id);
    const finalization = (async () => {
      const active = this.active.get(id);
      let stopped = !active;
      if (active) {
        clearTimeout(active.collecting); delete active.collecting;
        try {
          if (active.run.stopAndWait) { await active.run.stopAndWait(); stopped = true; }
          else await active.run.stop(); // Best-effort Stop does not attest native exit.
        }
        catch { /* Preserve occupied capacity and the connection claim when exit is uncertain. */ }
      }
      try {
        await this.journal.exclusive(async () => { await this.journal.update(id, stopped ? "failed" : "interrupted", message); });
        this.quarantined.delete(id);
      } catch (error) {
        // The journal keeps its original identity and uncertainty fence. Native exit alone does
        // not authorize a replacement receipt, a new execution or another physical control.
        console.warn("[worker] Run finalization requires storage recovery.", { code: journalErrorCode(error) });
      }
      if (stopped) { active?.release(); this.active.delete(id); this.admitted.delete(id); this.disabledSuggestions.delete(id); }
    })();
    this.failureFinalizations.set(id, finalization);
    try { await finalization; }
    finally { if (this.failureFinalizations.get(id) === finalization) this.failureFinalizations.delete(id); }
  }
  async respond(id: string, input: WorkerControl): Promise<WorkerReceipt> {
    if (!input || !Number.isSafeInteger(input.eventId) || !Number.isSafeInteger(input.expectedRevision) || typeof input.id !== "string"
      || !["approval", "question"].includes(input.kind)
      || input.kind === "approval" && (!["allow", "deny"].includes(input.decision) || input.message !== undefined && typeof input.message !== "string")
      || input.kind === "question" && (!input.answers || Array.isArray(input.answers) || typeof input.answers !== "object" || Object.values(input.answers).some(value => typeof value !== "string")))
      throw new WorkerApiError(400, "invalid_control", "Invalid worker decision.");
    return this.journal.exclusive(async () => {
      const current = await this.journal.load(id);
      const validate = () => {
        const frame = current.receipt.pending?.find(frame => frame.sequence === input.eventId);
        const event = frame?.event;
        if (!this.active.has(id) || current.receipt.revision !== input.expectedRevision || !["awaiting_input", "running"].includes(current.receipt.state)
          || !(input.kind === "approval" && event?.type === "approval_request" && event.approvalId === input.id
            || input.kind === "question" && event?.type === "question_request" && event.questionId === input.id))
          throw new WorkerApiError(409, "stale_control", "Decision does not match a pending request.");
      };
      const fresh = await this.journal.control(id, input.controlId, input, async () => {
        const run = this.active.get(id)!.run;
        const accepted = await (input.kind === "approval" ? run.resolveApproval(input.id, input.decision, input.message)
          : run.resolveQuestion(input.id, input.answers));
        if (!accepted) throw new WorkerApiError(409, "stale_control", "Native request is no longer pending.");
      }, validate);
      return fresh ? this.journal.update(id, (await this.journal.load(id)).receipt.pending?.some(frame => frame.event.type === "approval_request" || frame.event.type === "question_request" && frame.event.blocking !== false) ? "awaiting_input" : "running") : (await this.journal.load(id)).receipt;
    });
  }
  async park(id: string, input: WorkerPark): Promise<WorkerReceipt> {
    const receipt = await this.journal.exclusive(async () => {
      const stored = await this.journal.load(id), current = stored.receipt;
      if (Object.values(stored.controls).some(control => !control.applied)) throw new WorkerApiError(409, "control_uncertain", "Reconcile uncertain native delivery before parking.");
      await this.journal.control(id, input.controlId, { kind: "park", ...input }, async () => {}, () => {
        const pending = current.pending ?? [];
        if (!this.active.has(id) || current.state !== "awaiting_input" || current.revision !== input.expectedRevision
          || !pending.some(frame => frame.sequence === input.eventId && frame.event.type === "question_request" && frame.event.questionId === input.id && frame.event.blocking !== false)
          || pending.some(frame => frame.event.type !== "question_request" || frame.event.blocking === false))
          throw new WorkerApiError(409, "stale_parking", "Only execution blocked exclusively on these questions can be parked.");
      });
      return terminal(current.state) || current.state === "parking" ? current : this.journal.update(id, "parking");
    });
    if (terminal(receipt.state)) return receipt;
    return this.finishPark(id);
  }
  /** Park only after the native stream acknowledged the exact orchestration tool result. */
  async barrier(id: string, input: import("./contracts.js").WorkerBarrier): Promise<WorkerReceipt> {
    if (!input || !["task_adoption", "child_wait", "source_rebind", "limits", "human_input"].includes(input.kind)
      || input.origin !== undefined && input.origin !== "coordinator"
      || input.origin === "coordinator" && !["source_rebind", "limits"].includes(input.kind)
      || !safeIdentity(input.barrierId) || !Number.isSafeInteger(input.generation) || input.generation < 1
      || !Number.isSafeInteger(input.acknowledgedSequence) || input.acknowledgedSequence < (input.origin === "coordinator" ? 0 : 1))
      throw new WorkerApiError(400, "invalid_barrier", "Supply the typed barrier and acknowledged native event sequence.");
    const receipt = await this.journal.exclusive(async () => {
      const stored = await this.journal.load(id), current = stored.receipt;
      if (Object.values(stored.controls).some(control => !control.applied))
        throw new WorkerApiError(409, "control_uncertain", "Reconcile uncertain native delivery before parking.");
      await this.journal.control(id, input.controlId, { kind: "task_barrier", input }, async record => {
        record.receipt.barrier = { ...input };
      }, () => {
        const acknowledged = stored.events.find(frame => frame.sequence === input.acknowledgedSequence)?.event;
        const marker = `hosty_task_barrier:${input.barrierId}:${input.generation}`;
        const expectedTool = { task_adoption: "task_adopt", child_wait: "task_wait", source_rebind: "task_bind_workspace", human_input: "task_request_input", limits: null }[input.kind];
        const call = acknowledged?.type === "tool_result" ? stored.events.find(frame => frame.event.type === "tool_use"
          && frame.event.toolUseId === acknowledged.toolUseId)?.event : undefined;
        const pending = new Set<string>(); let unknown = false;
        for (const { event } of stored.events) {
          if (event.type === "native_effect" && event.state === "settled") pending.delete(event.id);
          if (event.type === "tool_use") { if (event.toolUseId) pending.add(event.toolUseId); else if (event.toolName !== "FileChange") unknown = true; }
          if (event.type === "tool_result" || event.type === "command_result") {
            if (event.status === "unknown") unknown = true;
            else pending.delete(event.toolUseId);
          }
        }
        if (current.revision !== input.expectedRevision || !current.snapshot?.nativeSessionId
          || input.origin !== "coordinator" && (acknowledged?.type !== "tool_result" || acknowledged.status !== "completed" || !acknowledged.output.includes(marker)
            || call?.type !== "tool_use" || !(call.mcp?.tool === expectedTool || call.toolName.endsWith("__" + expectedTool) || call.toolName.endsWith(": " + expectedTool)))
          || unknown || pending.size || current.pending?.length || Object.keys(current.effects ?? {}).length
          || !["running", "completed"].includes(current.state)
          || current.state === "running" && !this.active.get(id)?.run.stopAndWait)
          throw new WorkerApiError(409, "barrier_pending", "Wait for this tool acknowledgement, settled effects and a resumable native checkpoint.");
      });
      const fresh = (await this.journal.load(id)).receipt;
      if (fresh.state === "completed" && fresh.exitConfirmed) return this.journal.update(id, "parked");
      return terminal(fresh.state) || fresh.state === "parking" ? fresh : this.journal.update(id, "parking");
    });
    if (terminal(receipt.state)) return receipt;
    return this.finishPark(id);
  }
  private async finishPark(id: string): Promise<WorkerReceipt> {
    const active = this.active.get(id);
    if (!active) throw new WorkerApiError(409, "exit_unconfirmed", "The original execution must be reconciled before parking.");
    try {
      if (!active.run.stopAndWait) throw new Error("Native exit confirmation is unsupported.");
      await active.run.stopAndWait();
      await this.journal.exclusive(async () => {
        const stored = await this.journal.load(id), state = stored.receipt.state;
        const pending = new Set<string>(); let unknown = false;
        for (const { event } of stored.events) {
          if (event.type === "native_effect" && event.state === "settled") pending.delete(event.id);
          if (event.type === "tool_use" && event.toolUseId) pending.add(event.toolUseId);
          if (event.type === "tool_result" || event.type === "command_result") {
            if (event.status === "unknown") unknown = true; else pending.delete(event.toolUseId);
          }
        }
        if (state === "parking" && (unknown || pending.size || Object.keys(stored.receipt.effects ?? {}).length))
          throw new WorkerApiError(409, "effects_unconfirmed", "Native exit alone does not prove external tool effects settled.");
        if (state === "parking") await this.journal.update(id, "parked");
        else if (state === "cancelling") await this.journal.update(id, "cancelled");
      });
      if (this.active.get(id) === active) { active.release(); this.active.delete(id); this.admitted.delete(id); this.disabledSuggestions.delete(id); }
    } catch { throw new WorkerApiError(503, "exit_unconfirmed", "Parking could not confirm native execution exit."); }
    return (await this.journal.load(id)).receipt;
  }

  async cancel(id: string, controlId: string): Promise<WorkerReceipt> {
    if (this.quarantined.has(id)) {
      // An explicit Stop may retry the retained native handle; its sealed receipt stays unavailable.
      if (this.active.has(id)) await this.fail(id, "Cancellation could not durably finalize this execution.");
      return (await this.journal.load(id)).receipt;
    }
    const receipt = await this.journal.exclusive(async () => {
      await this.journal.control(id, controlId, { kind: "cancel" }, async () => {});
      const current = (await this.journal.load(id)).receipt;
      return terminal(current.state) || current.state === "suggesting" ? current : this.journal.update(id, "cancelling");
    });
    if (receipt.state === "suggesting") {
      await this.finishSuggestion(id);
      return (await this.journal.load(id)).receipt;
    }
    const active = this.active.get(id);
    if ((!terminal(receipt.state) || receipt.state === "interrupted" && !receipt.exitConfirmed) && active) {
      try {
        await active.run.interrupt();
        if (active.run.stopAndWait) await active.run.stopAndWait(); else await active.run.stop();
        await this.journal.exclusive(async () => {
          const current = (await this.journal.load(id)).receipt;
          if (!terminal(current.state) || current.state === "interrupted" && !current.exitConfirmed) await this.journal.update(id, "cancelled");
        });
        if (this.active.get(id) === active) { active.release(); this.active.delete(id); this.admitted.delete(id); this.disabledSuggestions.delete(id); }
      } catch { await this.fail(id, "Cancellation could not confirm native execution exit."); }
    }
    return (await this.journal.load(id)).receipt;
  }
  async recover(id: string, input: WorkerRecovery): Promise<WorkerReceipt> {
    return this.journal.exclusive(async () => {
      if (this.active.has(id) || this.admitted.has(id))
        throw new WorkerApiError(409, "recovery_active", "The worker still owns this execution. Retry Stop to verify native exit.");
      return this.journal.recover(id, input);
    });
  }
  async disableSuggestions(id: string, controlId: string): Promise<WorkerReceipt> {
    return this.journal.exclusive(async () => {
      await this.journal.control(id, controlId, { kind: "disable_suggestions" }, async record => {
        if (!terminal(record.receipt.state)) this.disabledSuggestions.add(id);
        const active = this.active.get(id);
        if (active) {
          active.suggestions = false;
          await active.run.disableSuggestions?.();
        }
      });
      // Change the receipt only after control intent/delivery is persisted; control owns its snapshot.
      // No foreground cancellation: the original answer remains active until its result.
      await this.finishSuggestionLocked(id);
      return (await this.journal.load(id)).receipt;
    });
  }
  async configure(id: string, servers: Record<string, unknown>, prefixes: string[] = []): Promise<{ applied: boolean }> {
    if (this.quarantined.has(id)) throw new WorkerApiError(503, "run_storage_uncertain", "Reconcile the retained execution before changing its native configuration.");
    const active = this.active.get(id);
    if (!active) throw new WorkerApiError(409, "run_inactive", "Run is no longer active.");
    validateMcpServers(servers);
    if (!Array.isArray(prefixes) || prefixes.some(prefix => typeof prefix !== "string" || !/^mcp__[A-Za-z0-9_-]+__$/.test(prefix)))
      throw new WorkerApiError(400, "invalid_configuration", "Invalid approval policy.");
    active.request.autoAllowedPrefixes = prefixes;
    return { applied: await active.run.setMcpServers(servers) };
  }
  async close(reason = "Worker is shutting down."): Promise<void> {
    this.closing = true; clearInterval(this.usageTimer);
    await Promise.allSettled([...this.starts]);
    await Promise.allSettled([...this.active].map(([id, active]) => active.collecting ? this.finishSuggestion(id) : this.fail(id, reason)));
    await this.journal.exclusive(async () => {});
  }
}

/** Log only bounded classifications; storage errors may include private paths or provider data. */
function journalErrorCode(error: unknown): string {
  const code = error instanceof WorkerApiError ? error.code : (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,60}$/.test(code) ? code : error instanceof SyntaxError ? "invalid_json" : "unknown";
}
