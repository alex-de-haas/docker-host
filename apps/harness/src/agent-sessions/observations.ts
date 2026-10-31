import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentRun } from "@hosty-sdk/app/agent-sessions";
import type { HarnessRun } from "../harness/adapter.js";
import type { SessionRecord, SessionStore } from "../sessions/store.js";

export type ObservedNativeSession = { id: string; owner: string; conversation: string | null; binding: string; revision: string };
export type ObservedRun = { id: string; owner: string; conversation: string | null; nativeSession: string | null;
  revision: string; state: AgentRun["state"]; observedAt: string; stopConfirmed: boolean; generation: string | null };
export type CancellationReceipt = { key: string; fingerprint: string; runId: string; state: "pending" | "completed" | "rejected"; error?: { code: string; message: string; status: number } };
type Observations = { sessions: ObservedNativeSession[]; runs: ObservedRun[]; cancellations: CancellationReceipt[] };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const next = (revision: string) => (BigInt(revision) + 1n).toString();

/** Durable execution metadata owned by Harness. This is neither a native checkpoint nor a transcript. */
export class AgentObservations {
  readonly generation = randomUUID();
  private closed = false;
  private gate: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: () => void;
  private readonly file: string;
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(private readonly conversations: SessionStore) {
    this.file = path.join(conversations.dataDir, "agent-observations.json");
    this.unsubscribe = conversations.observeChanges(id => this.observe(id));
  }
  close(): void { this.closed = true; this.unsubscribe(); for (const listeners of this.listeners.values()) for (const notify of listeners) notify(); this.listeners.clear(); }
  watch(id: string): { changed: Promise<void>; close: () => void } {
    let notify!: () => void;
    const changed = new Promise<void>(resolve => { notify = resolve; });
    const listeners = this.listeners.get(id) ?? new Set<() => void>(); listeners.add(notify); this.listeners.set(id, listeners);
    return { changed, close: () => { listeners.delete(notify); if (!listeners.size) this.listeners.delete(id); } };
  }
  async change<T>(action: (state: Observations) => T | Promise<T>): Promise<T> {
    const work = this.gate.catch(() => undefined).then(async () => {
      let state: Observations;
      try { state = JSON.parse(await readFile(this.file, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; state = { sessions: [], runs: [], cancellations: [] }; }
      const before = JSON.stringify(state), result = await action(state), after = JSON.stringify(state);
      if (before !== after) {
        await mkdir(path.dirname(this.file), { recursive: true });
        const temp = this.file + "." + randomUUID() + ".tmp";
        try {
          const file = await open(temp, "wx", 0o600); try { await file.writeFile(after); await file.sync(); } finally { await file.close(); }
          await rename(temp, this.file);
          if (process.platform !== "win32") {
            const directory = await open(path.dirname(this.file), "r"); try { await directory.sync(); } finally { await directory.close(); }
          }
        } finally { await rm(temp, { force: true }); }
        const prior = new Map((JSON.parse(before) as Observations).runs.map(r => [r.id, r.revision]));
        for (const run of state.runs) if (prior.get(run.id) !== run.revision) for (const notify of this.listeners.get(run.id) ?? []) notify();
      }
      return result;
    });
    this.gate = work; return work;
  }
  private binding(state: Observations, record: SessionRecord): ObservedNativeSession | null {
    if (!record.harnessSessionId) return null;
    const binding = digest([record.id, record.createdBy, record.harnessKind, record.connectionId, record.connectionIdentity, record.harnessSessionId]);
    let native = state.sessions.find(s => s.binding === binding);
    if (!native) { native = { id: randomUUID(), owner: record.createdBy, conversation: record.id, binding, revision: "1" }; state.sessions.push(native); }
    return native;
  }
  async begin(record: SessionRecord, recovered = false): Promise<string> {
    return this.change(state => {
      if (state.runs.filter(r => r.owner === record.createdBy).length >= 100000) throw new Error("The retained execution metadata budget is exhausted.");
      const run: ObservedRun = { id: randomUUID(), owner: record.createdBy, conversation: record.id, nativeSession: this.binding(state, record)?.id ?? null,
        revision: "1", state: "queued", observedAt: new Date().toISOString(), stopConfirmed: false, generation: recovered ? null : this.generation };
      state.runs.push(run);
      const native = state.sessions.find(s => s.id === run.nativeSession); if (native) native.revision = next(native.revision);
      return run.id;
    });
  }
  async observe(id: string): Promise<void> {
    const record = await this.conversations.readRecord(id);
    await this.change(state => {
      if (!record) {
        for (const value of [...state.runs, ...state.sessions].filter(r => r.conversation === id)) { value.conversation = null; value.revision = next(value.revision); }
        return;
      }
      const native = this.binding(state, record), run = state.runs.find(r => r.id === record.agentRunId && r.owner === record.createdBy);
      if (!run) return;
      const status: AgentRun["state"] = record.status === "running" || record.status === "suggesting" ? "running"
        : record.status === "idle" ? run.stopConfirmed ? "succeeded" : "waiting_for_input"
        : record.status === "awaiting_approval" || record.status === "awaiting_question" ? "waiting_for_input"
        : record.status === "failed" ? "failed" : "cancelled";
      const current = run.generation === this.generation;
      const visibleState = run.stopConfirmed && status === "running" ? run.state : current ? status : run.state;
      if (run.state !== visibleState || native && run.nativeSession !== native.id) {
        const previous = state.sessions.find(s => s.id === run.nativeSession);
        if (native && previous && previous.id !== native.id) previous.revision = next(previous.revision);
        run.state = visibleState; if (native) run.nativeSession = native.id;
        run.revision = next(run.revision); run.observedAt = new Date().toISOString();
        if (native) native.revision = next(native.revision);
      }
    });
  }
  private async stopped(id: string, confirmed: boolean): Promise<void> {
    if (this.closed) return; // Shutdown must not wait on a new metadata write; the next generation observes uncertainty.
    await this.change(state => {
      const run = state.runs.find(r => r.id === id); if (!run || run.stopConfirmed) return;
      run.stopConfirmed = confirmed; run.generation = confirmed ? this.generation : null;
      if (run.state === "running" || run.state === "waiting_for_input" || run.state === "queued") run.state = "unknown";
      run.revision = next(run.revision); run.observedAt = new Date().toISOString();
      const native = state.sessions.find(s => s.id === run.nativeSession); if (native) native.revision = next(native.revision);
    });
  }
  async markCurrent(id: string): Promise<void> {
    await this.change(state => {
      const observation = state.runs.find(r => r.id === id);
      if (observation && !observation.stopConfirmed && observation.generation !== this.generation) {
        observation.generation = this.generation; observation.revision = next(observation.revision); observation.observedAt = new Date().toISOString();
      }
    });
  }
  attach(id: string, run: HarnessRun): HarnessRun {
    // Keep adapter methods bound to their native object. Only the executor's exit promise supplies proof.
    return new Proxy(run, { get: (target, key) => {
      if (key === "stopAndWait" && target.stopAndWait) return async () => { await target.stopAndWait!(); await this.stopped(id, true); };
      if (key === "stop") return async () => { try { await target.stop(); } finally { await this.stopped(id, false); } };
      if (key === "detach" && target.detach) return async () => { await target.detach!(); await this.stopped(id, false); };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  async synchronize(): Promise<void> { for (const record of await this.conversations.listRecords()) await this.observe(record.id); }
}
