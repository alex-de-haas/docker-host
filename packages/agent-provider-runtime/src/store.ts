import { sameProvider } from "./provider-ref.js";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentConfiguration, AgentSession, AgentSessionCreate, AgentRunInput, AgentRunSnapshot, AgentEvent, AgentControlReceipt, AgentProviderRef, AgentPendingDecision, AgentWatchItem } from "@hosty-sdk/app/agent";
import { AgentApiError } from "@hosty-sdk/app/agent";
import type { AgentApprovalResponse, AgentQuestionResponse } from "@hosty-sdk/app/agent";
import { durableMkdir, durableWriteFile, isUncertainWrite } from "./internal/persistence.js";
import { InstallationHistory } from "./history.js";

export type Actor = { userId: string; principalId: string; callerAppId: string; callerInstallation: string };
export type VerifiedOperation = Actor & { admissionRef: string; operation: string; provider: AgentProviderRef; sessionId?: string; runId?: string; configurationDigest?: string; ceiling?: unknown; expiresAt?: string };
export type ConfigurationRecord = { configuration: AgentConfiguration; digest: string; skillPath?: string; snapshotId?: string; snapshotDigest?: string; pinRequestId?: string; binding?: import("./internal/connections/registry.js").ConnectionBinding; resolvedSkills: Array<{ skillId: string; digest: string }> };
export type ControlRecord = { hash: string; receipt: AgentControlReceipt; decisionId?: string; decision?: AgentPendingDecision; response?: unknown };
export type RunRecord = {
  historyVersion?: 1; historyOutbox?: AgentWatchItem[]; historyReceipt?: { sequence: string; kind: AgentWatchItem["kind"] }; historyPartial?: boolean;
  hash: string; input?: AgentRunInput; admissionRef: string; snapshot: AgentRunSnapshot;
  retiredDecisionIds?: string[];
  decisionDeliveries?: Record<string, import("./decision-continuation.js").DecisionDelivery>;
  events: AgentEvent[]; firstSequence: string; controls: Record<string, ControlRecord>;
  nativeMessageIds?: Record<string, string>;
  blockingQuestionSince?: Record<string, string>;
  workspaceRelease?: { requestId: string; state: "pending" | "released" };
  nativeSequence: number; nativeRevision: number; nativeUsageSequence?: number; nativeGeneration?: string; privateRequest?: unknown;
  cancelFence?: boolean; decisionsFenced?: boolean; reservedFor?: { runId: string; requestId: string; decisionId: string; configurationRevision: string }; startIntent?: boolean; nativeMessageId?: string; completedAt?: string; workspaces?: Array<{ id: string; revision: string; path: string; leaseId: string; leasePending?: boolean }>; decisionLinks?: Record<string, string>; proxyDecisions?: string[]; deadline?: string;
};
export type SessionRecord = {
  version: 1; id: string; hash: string; owner: Actor; session: AgentSession; configurations: Record<string, ConfigurationRecord>;
  configurationRequests: Record<string, { hash: string; revision: string }>;
  runs: Record<string, RunRecord>; nativeId?: string; deleted?: boolean; createdAt: string;
  retirement?: { runId: string; requestId: string; nativeGeneration: string; nativeRevision: number };
};
export const bytesHash = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
export const valueHash = (value: unknown) => bytesHash(JSON.stringify(value));
export const increment = (value: string) => (BigInt(value) + 1n).toString();
export const sameActor = (a: Actor, b: Actor) => a.userId === b.userId && a.principalId === b.principalId && a.callerAppId === b.callerAppId && a.callerInstallation === b.callerInstallation;
const safe = (value: string) => /^[A-Za-z0-9-]{1,100}$/.test(value);

/** One atomic session aggregate owns admission, its active slot, controls, events and snapshots. */
export class ProviderStore {
  history!: InstallationHistory;
  private initialized = false;
  private tail: Promise<unknown> = Promise.resolve();
  private runs = new Map<string, string>();
  private uncertain = new Set<string>();
  private listeners = new Map<string, Set<() => void>>();
  constructor(readonly directory: string, readonly provider: AgentProviderRef, readonly maxReplayBytes = 64 * 1024 * 1024, readonly replayRetentionMs = 7 * 24 * 60 * 60 * 1000) {}
  async initialize(): Promise<void> {
    await durableMkdir(this.directory);
    this.history = new InstallationHistory(path.join(this.directory, "installation-history.sqlite"), this.provider);
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith(".json") || !safe(file.slice(0, -5))) continue;
      const record = await this.load(file.slice(0, -5));
      for (const id of Object.keys(record.runs)) {
        if (this.runs.has(id)) throw new Error("Duplicate retained provider run identity.");
        this.runs.set(id, record.id);
      }
      let changed = false;
      for (const run of Object.values(record.runs)) {
        // Adopt the available detailed replay before its independent TTL can expire.
        if (!run.historyVersion || this.history.needsRecovery(record, run)) { this.stageRetainedHistory(run); changed = true; }
        if (this.expireReplay(run)) changed = true;
      }
      if (changed) await this.save(record);
      else this.history.publish(record);
    }
    this.initialized = true;
  }
  private stageRetainedHistory(run: RunRecord): void {
    run.historyVersion = 1;
    const pending = run.historyOutbox ?? [];
    delete run.historyOutbox;
    delete run.historyReceipt;
    const latest = structuredClone(run.snapshot);
    // The crash receipt can still hold public events which the per-run replay has already compacted.
    const events = new Map(run.events.map(event => [event.sequence, event]));
    for (const item of pending) if (item.kind === "event") events.set(item.event.sequence, item.event);
    const ordered = [...events.values()].sort((a, b) => Number(BigInt(a.sequence) - BigInt(b.sequence)));
    const gap = BigInt(ordered.length) !== BigInt(latest.lastSequence);
    if (gap) run.historyPartial = true;
    if (latest.lastSequence !== "0" && (ordered[0]?.type !== "run.updated" || gap)) {
      // A trimmed replay cannot identify the initial status; never backdate the current lifecycle.
      const initial: AgentRunSnapshot = { ref: latest.ref, generation: latest.generation, sessionId: latest.sessionId,
        revision: "0", configurationRevision: latest.configurationRevision, lastSequence: "0", cursor: this.cursor(latest.generation, "0"),
        state: "unknown", phase: "interrupted", freshness: "unavailable", stopConfirmed: false,
        observedAt: ordered[0]?.occurredAt ?? latest.observedAt, pending: [], effects: { certainty: "unknown", unresolvedCallIds: [] },
        coverage: { messages: "truncated", tools: "truncated", decisions: "truncated" } };
      this.history.stage(run, { kind: "snapshot", snapshot: initial });
    }
    for (const event of ordered)
      this.history.stage(run, { kind: "event", event, cursor: this.cursor(event.generation, event.sequence) });
    if (gap) latest.coverage = { messages: "truncated", tools: "truncated", decisions: "truncated" };
    latest.cursor ||= this.cursor(latest.generation, latest.lastSequence);
    this.history.stage(run, { kind: "snapshot", snapshot: latest });
  }
  exclusive<T>(action: () => Promise<T>): Promise<T> { const next = this.tail.catch(() => {}).then(action); this.tail = next; return next; }
  private file(id: string) { if (!safe(id)) throw new AgentApiError("invalid_id", "Invalid resource identity.", 400); return path.join(this.directory, id + ".json"); }
  async load(id: string, actor?: Actor): Promise<SessionRecord> {
    if (this.uncertain.has(id)) throw new AgentApiError("storage_uncertain", "Retained provider state requires recovery.", 503);
    let record: SessionRecord;
    try { record = JSON.parse(await readFile(this.file(id), "utf8")) as SessionRecord; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AgentApiError("session_not_found", "Session not found.", 404); throw new AgentApiError("storage_unavailable", "Retained provider state is unavailable; do not resubmit its identities.", 503); }
    if (record.version !== 1 || record.id !== id || !record.owner || !record.session || !record.runs || !record.configurations)
      throw new AgentApiError("storage_unavailable", "Invalid retained provider state.", 503);
    if (actor && (!sameActor(record.owner, actor) || !sameProvider(record.session.ref.provider, this.provider))) throw new AgentApiError("session_not_found", "Session not found.", 404);
    // After startup, committed outboxes have been published before the writer advances. A new
    // loaded aggregate starts with an empty outbox. The on-disk copy remains a crash receipt.
    if (this.initialized) for (const run of Object.values(record.runs)) this.history.acknowledge(run);
    return record;
  }
  async save(record: SessionRecord): Promise<void> {
    if (this.uncertain.has(record.id)) throw new AgentApiError("storage_uncertain", "Retained provider state requires recovery.", 503);
    try { await durableWriteFile(this.file(record.id), JSON.stringify(record)); }
    catch (error) { if (isUncertainWrite(error)) this.uncertain.add(record.id); throw error; }
    try { this.history.publish(record); }
    catch (error) { this.uncertain.add(record.id); throw error; }
    for (const id of Object.keys(record.runs)) { this.runs.set(id, record.id); for (const listener of this.listeners.get(id) ?? []) { try { listener(); } catch { /* A committed observation cannot undo a write. */ } } }
  }
  async create(id: string, actor: Actor, body: string, input: AgentSessionCreate, configuration: ConfigurationRecord, onFresh?: () => void): Promise<AgentSession> {
    return this.exclusive(async () => {
      const old = await this.load(id, actor).catch(error => { if (error instanceof AgentApiError && error.code === "session_not_found") return null; throw error; });
      if (old) { if (old.hash !== bytesHash(body)) throw new AgentApiError("request_conflict", "Session identity has different input.", 409); return old.session; }
      // A different owner must not overwrite the same UUID hidden by ownership filtering.
      await this.load(id).then(() => { throw new AgentApiError("session_not_found", "Session not found.", 404); }, error => { if (!(error instanceof AgentApiError) || error.code !== "session_not_found") throw error; });
      const session: AgentSession = { ref: { provider: this.provider, id }, revision: "1", configurationRevision: "1", configurationDigest: configuration.digest,
        nativeState: "not_created", activeRun: null, resolvedSkills: configuration.resolvedSkills, configuration: input.configuration, correlation: input.correlation };
      await this.save({ version: 1, id, hash: bytesHash(body), owner: actor, session, configurations: { "1": configuration }, configurationRequests: {}, runs: {}, createdAt: new Date().toISOString() });
      onFresh?.();
      return session;
    });
  }
  async run(id: string, actor?: Actor): Promise<{ session: SessionRecord; record: RunRecord }> {
    let sessionId = this.runs.get(id);
    if (!sessionId) {
      // A freshly committed identity may not yet be in a restarted process's index.
      for (const file of await readdir(this.directory)) {
        if (!file.endsWith(".json") || !safe(file.slice(0, -5))) continue;
        const session = await this.load(file.slice(0, -5));
        if (Object.hasOwn(session.runs, id)) { sessionId = session.id; this.runs.set(id, session.id); break; }
      }
    }
    if (!sessionId) throw new AgentApiError("run_not_found", "Run not found.", 404);
    const session = await this.load(sessionId, actor); const record = session.runs[id];
    if (!record) throw new AgentApiError("run_not_found", "Run not found.", 404);
    return { session, record };
  }
  async records(): Promise<SessionRecord[]> {
    const result: SessionRecord[] = [];
    for (const file of await readdir(this.directory)) if (file.endsWith(".json") && safe(file.slice(0, -5))) result.push(await this.load(file.slice(0, -5)));
    return result;
  }
  async list(actor: Actor): Promise<AgentSession[]> {
    const sessions: AgentSession[] = [];
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith(".json") || !safe(file.slice(0, -5))) continue;
      const record = await this.load(file.slice(0, -5));
      if (record.deleted || !sameActor(record.owner, actor) || !sameProvider(record.session.ref.provider, this.provider)) continue;
      const retirement = record.retirement;
      if (retirement && record.runs[retirement.runId]?.controls[retirement.requestId]?.receipt.state === "applied") continue;
      sessions.push(record.session);
    }
    return sessions.sort((a, b) => a.ref.id.localeCompare(b.ref.id));
  }
  private expireReplay(run: RunRecord, now = Date.now()): boolean {
    const completed = Date.parse(run.completedAt ?? ""), observed = Date.parse(run.snapshot.observedAt);
    if (!run.snapshot.stopConfirmed || !Number.isFinite(completed) || now - Math.max(completed, Number.isFinite(observed) ? observed : completed) < this.replayRetentionMs || !run.events.length) return false;
    // Native/session context, pending decisions and mutation tombstones have independent lifetimes.
    run.events = []; run.firstSequence = increment(run.snapshot.lastSequence); return true;
  }
  async pruneReplay(id: string, actor?: Actor): Promise<void> {
    // Active output cannot be TTL-pruned. Do not put observers behind a busy native writer.
    const current = await this.run(id, actor);
    if (!this.expireReplay(current.record)) return;
    await this.exclusive(async () => { const { session, record } = await this.run(id, actor); if (this.expireReplay(record)) await this.save(session); });
  }
  makeRun(session: SessionRecord, id: string, actor: VerifiedOperation, body: string, input?: AgentRunInput): RunRecord {
    if (this.runs.has(id)) throw new AgentApiError("request_conflict", "Run identity is already retained.", 409);
    return { hash: bytesHash(body), admissionRef: actor.admissionRef, input, historyVersion: 1, events: [], firstSequence: "1", controls: {}, nativeSequence: 0, nativeRevision: -1,
      snapshot: { ref: { provider: this.provider, id }, sessionId: session.id, generation: randomUUID(), revision: "1", state: "queued", phase: "preparing", stopConfirmed: false,
        freshness: "current", observedAt: new Date().toISOString(), configurationRevision: session.session.configurationRevision, lastSequence: "0", cursor: "", pending: [],
        effects: { certainty: "known", unresolvedCallIds: [] }, messages: [], tools: [], decisions: [], coverage: { messages: "complete", tools: "complete", decisions: "complete" }, admissionRef: actor.admissionRef } };
  }
  private decisionHistory(record: RunRecord, type: AgentEvent["type"], data: Record<string, unknown>): void {
    if (!type.startsWith("decision.") || typeof data.decisionId !== "string") return;
    const history = record.snapshot.decisions ??= [];
    let entry = history.find(item => item.decision.id === data.decisionId);
    const decision = (data.decision as AgentPendingDecision | undefined) ?? record.snapshot.pending.find(item => item.id === data.decisionId);
    if (!entry && decision) {
      entry = { decision: structuredClone(decision), state: "pending" }; history.push(entry);
    }
    if (!entry) return;
    if (decision) entry.decision = structuredClone(decision);
    if (type === "decision.resolved") {
      entry.state = data.state === "unknown" ? "unknown" : data.state === "superseded" ? "superseded" : "resolved";
      const response = data.response as AgentApprovalResponse | AgentQuestionResponse | undefined;
      if (response?.kind === "approval" || response?.kind === "question") entry.response = structuredClone(response);
      else if (entry.decision.kind === "approval" && (data.state === "allowed" || data.state === "denied")) entry.response = { kind: "approval", decision: data.state === "allowed" ? "allow" : "deny" };
    }
    if (history.length > 256 || Buffer.byteLength(JSON.stringify(history)) > 128 * 1024) {
      const coverage = record.snapshot.coverage ??= { messages: "complete", tools: "complete" };
      if (coverage.decisions !== "truncated") { coverage.decisions = "truncated"; this.emit(record, "warning", { code: "snapshot_truncated", message: "The bounded decision snapshot omits older cards; pending decisions remain authoritative.", coverage: structuredClone(coverage) }); }
      do { history.shift(); } while (history.length > 256 || Buffer.byteLength(JSON.stringify(history)) > 128 * 1024);
    }
  }
  emit(record: RunRecord, type: AgentEvent["type"], data: Record<string, unknown>, source: AgentEvent["source"] = { agentId: "root" }): AgentEvent {
    this.decisionHistory(record, type, data);
    if (type === "control.updated" && typeof data.requestId === "string") {
      const receipt = data.receipt as AgentControlReceipt | undefined;
      if (receipt?.continuation) {
        const entries = record.snapshot.pendingContinuations ??= [], found = entries.find(item => item.requestId === data.requestId);
        const current = { requestId: data.requestId, ...structuredClone(receipt.continuation) };
        if (found) Object.assign(found, current);
        else {
          if (entries.length >= 256) { const closed = entries.findIndex(item => item.state === "admitted" || item.state === "superseded"); if (closed < 0) throw new AgentApiError("continuation_limit", "Resolve pending continuations before accepting another decision.", 413); entries.splice(closed, 1); }
          entries.push(current);
        }
      }
    }
    const previous = { lastSequence: record.snapshot.lastSequence, observedAt: record.snapshot.observedAt, cursor: record.snapshot.cursor };
    record.snapshot.lastSequence = increment(record.snapshot.lastSequence); record.snapshot.observedAt = new Date().toISOString();
    record.snapshot.cursor = this.cursor(record.snapshot.generation, record.snapshot.lastSequence);
    const event: AgentEvent = { schemaVersion: "agent-event.1", runId: record.snapshot.ref.id, generation: record.snapshot.generation, sequence: record.snapshot.lastSequence,
      revision: record.snapshot.revision, occurredAt: record.snapshot.observedAt, type, source,
      data: type === "run.updated" ? { snapshot: structuredClone(record.snapshot) } : data };
    if (Buffer.byteLength(JSON.stringify(event)) > 1024 * 1024) {
      Object.assign(record.snapshot, previous);
      throw new AgentApiError("event_budget", "Persisted output exceeds the event allowance; reconcile execution before continuing.", 413);
    }
    record.events.push(event);
    this.history.stage(record, { kind: "event", event, cursor: record.snapshot.cursor });
    let size = Buffer.byteLength(JSON.stringify(record.events));
    while (size > this.maxReplayBytes && record.events.length) { record.events.shift(); size = Buffer.byteLength(JSON.stringify(record.events)); }
    record.firstSequence = record.events[0]?.sequence ?? increment(record.snapshot.lastSequence);
    return event;
  }
  lifecycle(record: RunRecord): void {
    for (const entry of record.snapshot.decisions ?? []) if (entry.state === "pending" && !record.snapshot.pending.some(item => item.id === entry.decision.id)) {
      const applied = Object.values(record.controls).find(control => control.decisionId === entry.decision.id && control.receipt.state === "applied");
      if (applied) { entry.state = "resolved"; const response = applied.response as AgentApprovalResponse | AgentQuestionResponse | undefined; if (response?.kind === "approval" || response?.kind === "question") entry.response = structuredClone(response); }
      else entry.state = record.snapshot.stopConfirmed ? "superseded" : "unknown";
    }
    const revision = record.snapshot.revision; record.snapshot.revision = increment(revision);
    try { this.emit(record, "run.updated", {}); } catch (error) { record.snapshot.revision = revision; throw error; }
  }
  cursor(generation: string, sequence: string): string { return Buffer.from(JSON.stringify([generation, sequence])).toString("base64url"); }
  decodeCursor(value: string): { generation: string; sequence: string } {
    try { const v: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "string" || typeof v[1] !== "string" || !/^\d+$/.test(v[1])) throw new Error(); return { generation: v[0], sequence: v[1] }; }
    catch { throw new AgentApiError("invalid_cursor", "Invalid event cursor.", 400); }
  }
  subscribe(id: string, listener: () => void): () => void { const set = this.listeners.get(id) ?? new Set(); set.add(listener); this.listeners.set(id, set); return () => { set.delete(listener); if (!set.size) this.listeners.delete(id); }; }
}
