import path from "node:path";
import { createHash } from "node:crypto";
import { ProviderError, type MediatedProviderInvocation } from "@hosty-sdk/app/providers";
import type { AgentRun, AgentSession, AgentSessionPage, AgentSessionQuery, NativeSessionRef, ProviderRef, RunRef, RunCancel, RunCancelReceipt } from "@hosty-sdk/app/agent-sessions";
import { ExportCursors } from "../history/export-cursors.js";
import { AppContextError } from "../sessions/app-context.js";
import type { SessionManager } from "../sessions/manager.js";
import type { ObservedNativeSession, ObservedRun } from "./observations.js";

type Actor = Pick<MediatedProviderInvocation, "userId" | "principalId" | "hostRole">;
const stamp = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code: string, message: string, status = 400): never => { throw new ProviderError(code, message, status); };
const missing = (): never => fail("not_found", "Execution resource not found.", 404);
const same = (first: ProviderRef, second: ProviderRef) => first?.appId === second.appId && first.installationId === second.installationId && first.key === second.key;
const uuid = (id: string) => typeof id === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id) ? id.toLowerCase() : fail("invalid_input", "Use an execution identity or request UUID.");
export const executionCapabilities = ["session.read", "session.list", "run.cancel", "run.events"];

export class AgentSessionService {
  private readonly cursors: ExportCursors;
  private readonly mutations = new Map<string, Promise<unknown>>();
  constructor(private readonly manager: SessionManager, readonly provider: ProviderRef) {
    this.cursors = new ExportCursors(path.join(manager.store.dataDir, "agent-cursors"));
  }
  private actor(actor: Actor): void {
    if (!actor.userId || !actor.principalId || actor.hostRole !== "host.admin") fail("permission_denied", "Execution observations require the current administrator and resource owner.", 403);
  }
  private reference(ref: NativeSessionRef | RunRef): string { if (!ref || !same(ref.provider, this.provider)) return missing(); return uuid(ref.id); }
  private run(value: ObservedRun): AgentRun {
    const current = value.stopConfirmed || value.generation === this.manager.observations.generation;
    return { ref: { provider: this.provider, id: value.id }, revision: value.revision,
      state: !current && ["running", "waiting_for_input", "queued"].includes(value.state) ? "unknown" : value.state,
      observedAt: current ? new Date().toISOString() : value.observedAt, freshness: current ? "current" : "last_known", stopConfirmed: value.stopConfirmed,
      nativeSession: value.nativeSession ? { provider: this.provider, id: value.nativeSession } : null,
      conversation: value.conversation ? { provider: this.provider, id: value.conversation } : null };
  }
  private session(value: ObservedNativeSession, runs: ObservedRun[]): AgentSession {
    if (runs.filter(r => r.owner === value.owner && r.nativeSession === value.id && !r.stopConfirmed).length > 200)
      fail("budget_exceeded", "Reconcile retained unconfirmed native attempts before listing this session.", 429);
    return { ref: { provider: this.provider, id: value.id }, revision: value.revision,
      activeRuns: runs.filter(r => r.owner === value.owner && r.nativeSession === value.id && !r.stopConfirmed).map(r => ({ provider: this.provider, id: r.id })),
      capabilities: executionCapabilities, conversation: value.conversation ? { provider: this.provider, id: value.conversation } : null };
  }
  async getRun(actor: Actor, ref: RunRef): Promise<AgentRun> {
    this.actor(actor); const id = this.reference(ref);
    return this.manager.observations.change(state => {
      const run = state.runs.find(r => r.id === id && r.owner === actor.userId); return run ? this.run(run) : missing();
    });
  }
  async getSession(actor: Actor, ref: NativeSessionRef): Promise<AgentSession> {
    this.actor(actor); const id = this.reference(ref); await this.manager.observations.synchronize();
    return this.manager.observations.change(state => {
      const session = state.sessions.find(s => s.id === id && s.owner === actor.userId); return session ? this.session(session, state.runs) : missing();
    });
  }
  async list(actor: Actor, input: AgentSessionQuery): Promise<AgentSessionPage> {
    this.actor(actor); if (!same(input.provider, this.provider)) return missing();
    if (input.conversation && !same(input.conversation.provider, this.provider)) return missing();
    const limit = input.limit ?? 50; if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail("invalid_input", "Use page size 1–200.");
    await this.manager.observations.synchronize();
    return this.manager.observations.change(async state => {
      const sessions = state.sessions.filter(s => s.owner === actor.userId && (!input.conversation || s.conversation === input.conversation.id)).sort((a, b) => a.id.localeCompare(b.id));
      const scope = stamp({ actor, provider: this.provider, conversation: input.conversation ?? null, limit, ids: sessions.map(s => s.id) });
      const offset = input.cursor ? await this.cursors.read(scope, input.cursor) : 0;
      if (offset > sessions.length) return fail("rescan_required", "The source session collection changed. Start a fresh query.", 410);
      const end = Math.min(offset + limit, sessions.length);
      return { sessions: sessions.slice(offset, end).map(s => this.session(s, state.runs)), nextCursor: end < sessions.length ? await this.cursors.issue(scope, String(end)) : null,
        availability: "available", observedAt: new Date().toISOString() };
    });
  }
  async notifications(actor: Actor, input: { run: RunRef; cursor?: string; waitSeconds?: number }, signal?: AbortSignal) {
    this.actor(actor); const id = this.reference(input.run), seconds = input.waitSeconds ?? 20;
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 20) return fail("invalid_input", "Execution notification waits are bounded to 20 seconds.");
    const scope = stamp({ actor, run: input.run, generation: this.manager.observations.generation });
    let after: number | null = null, rescanRequired = !input.cursor;
    if (input.cursor) try { after = await this.cursors.read(scope, input.cursor); }
    catch (error) { if (!(error instanceof ProviderError) || error.code !== "rescan_required") throw error; rescanRequired = true; }
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const watcher = this.manager.observations.watch(id);
      let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
      try {
        const run = await this.getRun(actor, input.run);
        if (rescanRequired || after !== Number(run.revision) || Date.now() >= deadline)
          return { run, cursor: await this.cursors.issue(scope, run.revision), rescanRequired };
        const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); abort = resolve; signal?.addEventListener("abort", abort, { once: true }); });
        await Promise.race([watcher.changed, timeout]);
        if (signal?.aborted) return fail("request_cancelled", "The execution observer disconnected.", 499);
      } finally { watcher.close(); if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
    }
  }
  async cancel(actor: Actor, input: RunCancel, validate: () => Promise<unknown>): Promise<RunCancelReceipt> {
    this.actor(actor); const id = this.reference(input.run), requestId = uuid(input.requestId);
    if (typeof input.expectedRevision !== "string" || !/^[0-9]{1,40}$/.test(input.expectedRevision)) fail("invalid_input", "Use the observed decimal revision.");
    const key = stamp([actor.userId, actor.principalId, requestId]), fingerprint = stamp({ ...input, requestId });
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await validate();
      const admission = await this.manager.observations.change(state => {
        const run = state.runs.find(r => r.id === id && r.owner === actor.userId); if (!run) return missing();
        const receipt = state.cancellations.find(r => r.key === key);
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) return fail("request_conflict", "This cancellation UUID identifies different input.", 409);
          return { run: structuredClone(run), receipt, replay: true };
        }
        const created: import("./observations.js").CancellationReceipt = run.revision !== input.expectedRevision
          ? { key, fingerprint, runId: id, state: "rejected", error: { code: "revision_conflict", message: "Read the current run before cancelling it.", status: 409 } }
          : { key, fingerprint, runId: id, state: "pending" };
        state.cancellations.push(created);
        return { run: structuredClone(run), receipt: created, replay: false };
      });
      if (admission.receipt.state === "rejected") { const error = admission.receipt.error!; throw new ProviderError(error.code, error.message, error.status); }
      if (admission.receipt.state !== "completed" && !admission.run.stopConfirmed) {
        if (!admission.run.conversation) return fail("provider_unavailable", "The native execution handle is unavailable; no exit is assumed.", 503);
        try { await this.manager.cancelObservedRun(admission.run.conversation, id, actor.userId, admission.replay ? null : input.expectedRevision, validate); }
        catch (error) {
          if ((error instanceof AppContextError || error instanceof ProviderError) && error.status < 500 && ![408, 429].includes(error.status))
            await this.manager.observations.change(state => { const receipt = state.cancellations.find(r => r.key === key)!; receipt.state = "rejected"; receipt.error = { code: error.code, message: error.message, status: error.status }; });
          throw error;
        }
      }
      await this.manager.observations.change(state => { state.cancellations.find(r => r.key === key)!.state = "completed"; });
      const run = await this.getRun(actor, input.run);
      return { requestId, state: run.stopConfirmed ? "completed" : "accepted", run } as RunCancelReceipt;
    });
    this.mutations.set(key, operation);
    try { return await operation; } finally { if (this.mutations.get(key) === operation) this.mutations.delete(key); }
  }
}
