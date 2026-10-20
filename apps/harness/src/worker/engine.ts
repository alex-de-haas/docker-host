import type { HarnessAdapter, HarnessEvent, HarnessRun } from "../harness/adapter.js";
import { WorkerJournal } from "./journal.js";
import { WorkerApiError, terminal, validateRun, validateMcpServers, type WorkerRunRequest, type WorkerControl, type WorkerReceipt } from "./contracts.js";

export interface WorkerExecution {
  adapter(request: WorkerRunRequest): Promise<HarnessAdapter>;
  cwd(request: WorkerRunRequest): Promise<string>;
  validateSelection(request: WorkerRunRequest): Promise<void>;
  reserve(request: WorkerRunRequest): Promise<() => void>;
}

/** Application execution orchestration; it owns no Docker or Core lifecycle surface. */
export class WorkerEngine {
  private active = new Map<string, { run: HarnessRun; release: () => void; request: WorkerRunRequest }>();
  private admitted = new Set<string>();
  private starts = new Set<Promise<void>>();
  private closing = false;
  constructor(readonly journal: WorkerJournal, private readonly execution: WorkerExecution, private readonly capacity: number) {}

  async submit(id: string, input: unknown): Promise<WorkerReceipt> {
    if (this.closing) throw new WorkerApiError(503, "worker_stopping", "Worker is stopping.");
    validateRun(input);
    return this.journal.exclusive(async () => {
      // Observe an existing receipt before admission: a retry is not a new workload.
      const existing = await this.journal.load(id).catch(error => { if (error instanceof WorkerApiError && error.status === 404) return null; throw error; });
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
          await this.journal.update(id, "cancelled"); this.admitted.delete(id); release?.(); release = undefined; return;
        }
        await this.journal.update(id, "running");
        const run = adapter!.start({ ...request.options, sessionId: request.conversationId, cwd,
          ...request.selection,
          isAutoAllowed: tool => request.autoAllowedPrefixes.some(prefix => tool.startsWith(prefix)),
          onEvent: event => { void this.event(id, event); } });
        const claim = release!; let released = false;
        this.active.set(id, { run, request, release: () => { if (!released) { released = true; claim(); } } }); release = undefined; started = true;
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
        const state = (await this.journal.load(id)).receipt.state;
        if (terminal(state)) return;
        await this.journal.append(id, event);
        if (event.type === "approval_request" || event.type === "question_request") await this.journal.update(id, "awaiting_input");
        if (event.type === "result" || event.type === "error") {
          // Closing a known native client is ordinary lifecycle, not a service restart.
          const active = this.active.get(id);
          if (active) { if (active.run.stopAndWait) await active.run.stopAndWait(); else await active.run.stop(); active.release(); this.active.delete(id); }
          await this.journal.update(id, state === "cancelling" ? "cancelled" : event.type === "error" ? "failed" : "completed");
          this.admitted.delete(id);
        }
      });
    } catch { await this.fail(id, "Worker could not persist or finalize provider output. Execution may require recovery."); }
  }
  private async fail(id: string, message: string): Promise<void> {
    const active = this.active.get(id);
    let stopped = !active;
    if (active) {
      try { if (active.run.stopAndWait) await active.run.stopAndWait(); else await active.run.stop(); stopped = true; }
      catch { /* Preserve occupied capacity and the connection claim when exit is uncertain. */ }
    }
    await this.journal.exclusive(async () => { await this.journal.update(id, stopped ? "failed" : "interrupted", message); });
    if (stopped) { active?.release(); this.active.delete(id); this.admitted.delete(id); }
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
        if (!this.active.has(id) || current.receipt.revision !== input.expectedRevision || current.receipt.state !== "awaiting_input"
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
      return fresh ? this.journal.update(id, (await this.journal.load(id)).receipt.pending?.length ? "awaiting_input" : "running") : (await this.journal.load(id)).receipt;
    });
  }
  async cancel(id: string, controlId: string): Promise<WorkerReceipt> {
    const receipt = await this.journal.exclusive(async () => {
      await this.journal.control(id, controlId, { kind: "cancel" }, async () => {});
      const current = (await this.journal.load(id)).receipt;
      return terminal(current.state) ? current : this.journal.update(id, "cancelling");
    });
    const active = this.active.get(id);
    if (!terminal(receipt.state) && active) {
      try {
        await active.run.interrupt();
        if (active.run.stopAndWait) await active.run.stopAndWait(); else await active.run.stop();
        await this.journal.exclusive(async () => {
          const current = (await this.journal.load(id)).receipt;
          if (!terminal(current.state)) await this.journal.update(id, "cancelled");
        });
        active.release(); this.active.delete(id); this.admitted.delete(id);
      } catch { await this.fail(id, "Cancellation could not confirm native execution exit."); }
    }
    return (await this.journal.load(id)).receipt;
  }
  async configure(id: string, servers: Record<string, unknown>, prefixes: string[] = []): Promise<{ applied: boolean }> {
    const active = this.active.get(id);
    if (!active) throw new WorkerApiError(409, "run_inactive", "Run is no longer active.");
    validateMcpServers(servers);
    if (!Array.isArray(prefixes) || prefixes.some(prefix => typeof prefix !== "string" || !/^mcp__[A-Za-z0-9_-]+__$/.test(prefix)))
      throw new WorkerApiError(400, "invalid_configuration", "Invalid approval policy.");
    active.request.autoAllowedPrefixes = prefixes;
    return { applied: await active.run.setMcpServers(servers) };
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.starts]);
    await Promise.allSettled([...this.active.keys()].map(id => this.fail(id, "Worker is shutting down.")));
    await this.journal.exclusive(async () => {});
  }
}
