import { readFile, stat } from "node:fs/promises";
import { MAX_ATTACHMENT_BYTES } from "./resources.js";
import { randomUUID, createHmac } from "node:crypto";
import type { HarnessAdapter, HarnessCapabilities, HarnessEvent, HarnessRun, HarnessStartOptions } from "../harness/adapter.js";
import type { ConnectionBinding } from "../connections/registry.js";
import type { ServiceIdentity } from "./auth.js";
import { WORKER_PROTOCOL, WorkerApiError, terminal, type WorkerRunRequest, type WorkerReceipt, type WorkerEvent, type WorkerControl } from "./contracts.js";

const pause = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 500);
  signal.addEventListener("abort", abort, { once: true });
});
// A coordinator callback may be queued behind the operation stopping this observer.
// Abort the wait, not the callback's persistence work; the coordinator guards late work by epoch.
async function deliverEvent(action: () => void | Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return action(); }), aborted]);
  } finally { signal.removeEventListener("abort", abort); }
}
export class WorkerClient {
  constructor(readonly origin: string, private readonly identity: ServiceIdentity) {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error("Invalid worker service URL.");
  }
  callbackKey(runId: string, scope: "apps" | "workspaces"): string {
    return createHmac("sha256", this.identity.secret).update(JSON.stringify(["hosty-mcp-callback-v1", this.identity.installation, runId, scope])).digest("base64url");
  }
  headers(): Record<string, string> { return { authorization: `Bearer ${this.identity.secret}`,
    "x-hosty-worker-installation": this.identity.installation, "content-type": "application/json" }; }
  async request<T>(route: string, method = "GET", body?: unknown, retry = false, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`${this.origin.replace(/\/$/, "")}${route}`, { method, headers: this.headers(),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000), redirect: "error" });
        const value = await response.json() as { code?: string; message?: string };
        if (!response.ok) throw new WorkerApiError(response.status, value.code ?? "worker_error", value.message ?? "Worker request failed.");
        return value as T;
      } catch (error) {
        if (!retry || attempt >= 2 || error instanceof WorkerApiError && error.status < 500) throw error;
        await pause(AbortSignal.timeout(1000));
      }
    }
  }
  async upload(id: string, name: string, file: string): Promise<string> {
    if ((await stat(file)).size > MAX_ATTACHMENT_BYTES) throw new WorkerApiError(413, "attachment_limit", "Attachment exceeds 20 MiB.");
    const response = await fetch(`${this.origin.replace(/\/$/, "")}/v1/conversations/${id}/attachments/${encodeURIComponent(name)}`, {
      method: "PUT", headers: { ...this.headers(), "content-type": "application/octet-stream" }, body: await readFile(file), redirect: "error", signal: AbortSignal.timeout(60000),
    });
    const value = await response.json() as { path?: string; message?: string };
    if (!response.ok || !value.path) throw new WorkerApiError(response.status, "attachment_failed", value.message ?? "Worker attachment upload failed.");
    return value.path;
  }
  async capabilities(): Promise<{ protocol: number; capacity: number; resources?: { trees?: string } }> {
    const value = await this.request<{ protocol: number; capacity: number; resources?: { trees?: string } }>("/v1/capabilities");
    if (value.protocol !== WORKER_PROTOCOL) throw new WorkerApiError(409, "protocol_mismatch", "Harness and Worker versions are incompatible.");
    return value;
  }
  async events(id: string, onEvent: (event: WorkerEvent) => void | Promise<void>, signal: AbortSignal,
    onNotice?: (message: string) => void | Promise<void>): Promise<WorkerReceipt> {
    let cursor = 0, generation: string | undefined;
    for (;;) {
      signal.throwIfAborted();
      try {
        const response = await fetch(`${this.origin.replace(/\/$/, "")}/v1/runs/${id}/events?after=${cursor}`,
          { headers: this.headers(), signal, redirect: "error" });
        if (!response.ok || !response.body) throw new WorkerApiError(response.status, "event_stream_unavailable", "Worker events are unavailable.");
        let buffer = "";
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          if (buffer.length > 2 * 1024 * 1024) throw new WorkerApiError(413, "event_limit", "Worker event exceeds its limit.");
          for (;;) {
            const index = buffer.indexOf("\n\n"); if (index < 0) break;
            const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            const type = block.match(/^event: (.+)$/m)?.[1], data = block.match(/^data: (.+)$/m)?.[1];
            if (!data) continue;
            if (type === "run") {
              const frame = JSON.parse(data) as WorkerEvent;
              if (frame.runId !== id || generation && frame.generation !== generation)
                throw new WorkerApiError(409, "generation_mismatch", "Worker run generation changed.");
              generation = frame.generation;
              if (frame.sequence > cursor) { await deliverEvent(() => onEvent(frame), signal); cursor = frame.sequence; }
            } else if (type === "state" || type === "resync") {
              const receipt = JSON.parse(data) as WorkerReceipt;
              if (receipt.runId !== id || generation && receipt.generation !== generation)
                throw new WorkerApiError(409, "generation_mismatch", "Worker run generation changed.");
              if (type === "state") return receipt;
              if (!terminal(receipt.state)) throw new WorkerApiError(410, "replay_expired", "Active run replay is unavailable.");
              // Restore the observation before synthetic text advances the durable cursor.
              const context = receipt.snapshot?.contextUsage;
              if (context) await deliverEvent(() => onEvent(context), signal);
              if (receipt.snapshot?.text) await deliverEvent(() => onEvent({ runId: id, generation: receipt.generation, sequence: receipt.revision - 1,
                event: { type: "assistant_text", text: receipt.snapshot!.text! } }), signal);
              // Resync metadata has no durable run sequence; reserve the receipt revision for its terminal event.
              await deliverEvent(() => onNotice?.("Detailed worker replay expired; the saved final snapshot is shown."), signal);
              return receipt;
            }
          }
        }
      } catch (error) { if (signal.aborted || error instanceof WorkerApiError && error.status < 500) throw error; }
      await pause(signal);
    }
  }
  attach(id: string, options: HarnessStartOptions): HarnessRun {
    const run = new RemoteRun(this, null, options); run.attach(id); return run;
  }
  adapter(binding: ConnectionBinding, capabilities: HarnessCapabilities, name: string): HarnessAdapter {
    return { name, capabilities, probe: async () => { await this.capabilities(); return { available: true }; },
      start: options => new RemoteRun(this, binding, options) };
  }
}

class RemoteRun implements HarnessRun {
  private id: string | null = null;
  private controller: AbortController | null = null;
  private finished: Promise<void> = Promise.resolve();
  private resume: string | undefined;
  private pending = new Map<string, WorkerEvent>();
  private stopped = false;
  private busy = false;
  private submitted?: WorkerRunRequest;
  private confirmed = true;
  private deliveringTerminal = false;
  constructor(private readonly client: WorkerClient, private readonly binding: ConnectionBinding | null, private readonly options: HarnessStartOptions) {
    this.resume = options.resumeHarnessSessionId;
  }
  send(input: string): void {
    if (this.busy || this.stopped) throw new WorkerApiError(409, "run_busy", "Wait for the current turn to finish.");
    this.busy = true; this.id = this.options.workerRunId ?? randomUUID(); this.controller = new AbortController();
    const id = this.id, signal = this.controller.signal;
    const request: WorkerRunRequest = { conversationId: this.options.sessionId, binding: this.binding!,
      selection: { model: this.options.model ?? null, reasoningEffort: this.options.reasoningEffort ?? null },
      resource: this.options.resource ?? { kind: "conversation", id: this.options.sessionId }, input,
      options: { autonomy: this.options.autonomy, systemPrompt: this.options.systemPrompt, resumeHarnessSessionId: this.resume, mcpServers: this.options.mcpServers },
      autoAllowedPrefixes: Object.keys(this.options.mcpServers ?? {}).map(name => `mcp__${name}__`).filter(prefix => this.options.isAutoAllowed?.(`${prefix}probe`)) };
    this.submitted = request; this.confirmed = false;
    this.observe(id, signal, request);
  }
  attach(id: string): void {
    this.id = id; this.busy = true; this.confirmed = false; this.controller = new AbortController();
    this.observe(id, this.controller.signal);
  }
  private observe(id: string, signal: AbortSignal, request?: WorkerRunRequest): void {
    this.finished = (async () => {
      let final: HarnessEvent | undefined, accepted = false;
      try {
        const current = request ? await this.client.request<WorkerReceipt>(`/v1/runs/${id}`, "PUT", request, true)
          : await this.client.request<WorkerReceipt>(`/v1/runs/${id}`);
        accepted = true;
        for (const frame of current.pending ?? []) {
          const event = frame.event;
          if (event.type === "approval_request") this.pending.set(event.approvalId, frame);
          if (event.type === "question_request") this.pending.set(event.questionId, frame);
        }
        await this.options.onWorkerPending?.(current.pending ?? []);
        const receipt = await this.client.events(id, async frame => {
          const event = frame.event;
          if (event.type === "harness_session") this.resume = event.harnessSessionId;
          if (event.type === "approval_request") this.pending.set(event.approvalId, frame);
          if (event.type === "question_request") this.pending.set(event.questionId, frame);
          if (event.type === "result" || event.type === "error") final = event;
          else if (this.options.onWorkerEvent) await this.options.onWorkerEvent(frame);
          else this.options.onEvent(event);
        }, signal, message => this.options.onEvent({ type: "notice", message }));
        final ??= receipt.snapshot?.result;
        if (receipt.snapshot?.nativeSessionId) this.options.onEvent({ type: "harness_session", harnessSessionId: receipt.snapshot.nativeSessionId });
        this.confirmed = receipt.exitConfirmed ?? receipt.state !== "interrupted"; this.busy = false; this.pending.clear();
        if (!this.stopped) {
          const event: HarnessEvent = final && (receipt.state === "completed" || receipt.state === "failed" && final.type === "error") ? final
            : { type: "error", message: receipt.error ?? `Worker run ${receipt.state}.` };
          if (this.options.onWorkerEvent && this.confirmed) {
            // The terminal receipt revision is stable even after detailed event replay expires.
            const frame: WorkerEvent = { runId: id, generation: receipt.generation, sequence: receipt.revision, event };
            this.deliveringTerminal = true;
            try {
              for (;;) {
                try { await deliverEvent(() => this.options.onWorkerEvent!(frame), signal); break; }
                catch (error) { if (signal.aborted) throw error; await pause(signal); }
              }
            } finally { this.deliveringTerminal = false; }
          } else this.options.onEvent(event);
        }
      } catch (error) {
        if (request && !accepted && error instanceof WorkerApiError && error.status < 500 && error.code !== "run_conflict") this.confirmed = true;
        this.busy = false;
        if (!this.stopped) this.options.onEvent({ type: "error", message: error instanceof Error ? error.message : "Worker disconnected." });
      }
    })();
  }
  private async respond(id: string, value: { kind: "approval"; decision: "allow" | "deny"; message?: string } | { kind: "question"; answers: Record<string, string> }): Promise<boolean> {
    const event = this.pending.get(id), runId = this.id;
    if (!event || !runId) return false;
    const receipt = await this.client.request<WorkerReceipt>(`/v1/runs/${runId}`);
    const control: WorkerControl = { ...value, id, eventId: event.sequence, expectedRevision: receipt.revision, controlId: randomUUID() };
    await this.client.request(`/v1/runs/${runId}/responses`, "POST", control, true);
    this.pending.delete(id); return true;
  }
  resolveApproval(id: string, decision: "allow" | "deny", message?: string): Promise<boolean> { return this.respond(id, { kind: "approval", decision, message }); }
  resolveQuestion(id: string, answers: Record<string, string>): Promise<boolean> { return this.respond(id, { kind: "question", answers }); }
  async setMcpServers(servers: Record<string, unknown>): Promise<boolean> {
    this.options.mcpServers = servers;
    if (!this.busy || !this.id) return true;
    return this.client.request<{ applied: boolean }>(`/v1/runs/${this.id}/configuration`, "POST", { servers, autoAllowedPrefixes: Object.keys(servers).map(name => `mcp__${name}__`).filter(prefix => this.options.isAutoAllowed?.(`${prefix}probe`)) }).then(value => value.applied);
  }
  async interrupt(): Promise<void> {
    if (!this.id || this.confirmed) return;
    if (this.submitted) await this.client.request(`/v1/runs/${this.id}`, "PUT", this.submitted, true);
    let receipt = await this.client.request<WorkerReceipt>(`/v1/runs/${this.id}/cancel`, "POST", { controlId: randomUUID() }, true);
    const unconfirmed = () => new WorkerApiError(503, "exit_unconfirmed", "Worker execution exit is not confirmed; keep source leases.");
    // Startup/reservation can still be unwinding after the cancellation command is acknowledged.
    // Observe its receipt without resubmitting work; a bounded failure still retains source leases.
    const signal = AbortSignal.timeout(35000);
    try {
      while (!terminal(receipt.state)) {
        await pause(signal);
        receipt = await this.client.request<WorkerReceipt>(`/v1/runs/${this.id}`, "GET", undefined, false, signal);
      }
    } catch { throw unconfirmed(); }
    if (receipt.state === "interrupted" && !receipt.exitConfirmed) throw unconfirmed();
    this.confirmed = true;
  }
  async stop(): Promise<void> {
    await this.interrupt(); this.stopped = true;
    // Native exit is already confirmed here. Terminal persistence can itself call stop while
    // holding the coordinator queue; it must finish (and retry writes) without waiting on itself.
    if (this.deliveringTerminal) return;
    this.controller?.abort(); await this.finished;
  }
  stopAndWait(): Promise<void> { return this.stop(); }
  async detach(): Promise<void> { this.stopped = true; this.controller?.abort(); await this.finished; }
}
