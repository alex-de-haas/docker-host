import { sameProvider } from "./provider-ref.js";
import { needsSupervisor } from "./attempt-supervisor.js";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import type { AgentConfiguration, AgentSession, AgentSessionCreate, AgentRunInput, AgentRunSnapshot, AgentEvent, AgentControlReceipt, AgentProviderRef, AgentPendingDecision, AgentWatchItem } from "@hosty-sdk/app/agent";
import { AgentApiError } from "@hosty-sdk/app/agent";
import type { AgentApprovalResponse, AgentQuestionResponse } from "@hosty-sdk/app/agent";
import { durableMkdir } from "./internal/persistence.js";
import { InstallationHistory } from "./history.js";

export type Actor = { userId: string; principalId: string; callerAppId: string; callerInstallation: string };
export type VerifiedOperation = Actor & { admissionRef: string; operation: string; originalStartDigest?: string; cleanupOnly?: boolean; provider: AgentProviderRef; sessionId?: string; runId?: string; configurationDigest?: string; ceiling?: unknown; expiresAt?: string };
export type ConfigurationRecord = { configuration: AgentConfiguration; digest: string; skillPath?: string; snapshotId?: string; snapshotDigest?: string; pinRequestId?: string; binding?: import("./internal/connections/registry.js").ConnectionBinding; resolvedSkills: Array<{ skillId: string; digest: string }> };
export type ControlRecord = { hash: string; receipt: AgentControlReceipt; stop?: true; command?: import("@hosty-sdk/app/agent").AgentRunControlInput; decisionId?: string; decision?: AgentPendingDecision; response?: unknown };
export type RunRecord = {
  historyOutbox?: AgentWatchItem[]; authorityExpiresAt?: string;
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
  priorRunIds?: string[]; runs: Record<string, RunRecord>; nativeId?: string; deleted?: boolean; createdAt: string;
  retirement?: { runId: string; requestId: string; nativeGeneration: string; nativeRevision: number };
};
export const bytesHash = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
export const valueHash = (value: unknown) => bytesHash(JSON.stringify(value));
export const increment = (value: string) => (BigInt(value) + 1n).toString();
export const sameActor = (a: Actor, b: Actor) => a.userId === b.userId && a.principalId === b.principalId && a.callerAppId === b.callerAppId && a.callerInstallation === b.callerInstallation;
const safe = (value: string) => /^[A-Za-z0-9-]{1,100}$/.test(value);
const occupied = (record: SessionRecord) => !!record.session.activeRun || Object.values(record.runs).some(run => !!run.reservedFor);
const notAdmitted = { status: "cancelled", error: {
  code: "run_not_admitted", message: "The original request was fenced before native admission.", retryable: false,
} } as const;
type StoredVersion = { version: number; runs: Map<string, string> };

function maintenanceDue(record: SessionRecord): boolean {
  return !!record.retirement || Object.values(record.runs).some(needsSupervisor);
}

/** Each installation commits its session, immutable run identities and public delivery together. */
export class ProviderStore {
  history!: InstallationHistory;
  readonly databasePath: string;
  private readonly lockPath: string;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly versions = new WeakMap<SessionRecord, StoredVersion>();
  constructor(readonly directory: string, readonly provider: AgentProviderRef, readonly maxReplayBytes = 64 * 1024 * 1024, readonly replayRetentionMs = 7 * 24 * 60 * 60 * 1000) {
    this.databasePath = path.join(directory, "execution-v2.sqlite");
    this.lockPath = path.join(directory, "writer-v2.sqlite");
  }
  async initialize(): Promise<void> {
    await durableMkdir(this.directory);
    this.history = new InstallationHistory(this.databasePath, this.provider);
    closeSync(openSync(this.lockPath, "a", 0o600));
    this.history.database(db => db.exec(`
      CREATE TABLE IF NOT EXISTS execution_sessions (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, installation TEXT NOT NULL, occupied INTEGER NOT NULL,
        due INTEGER NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS occupied_sessions ON execution_sessions(installation,occupied);
      CREATE INDEX IF NOT EXISTS due_sessions ON execution_sessions(installation,due);
      CREATE INDEX IF NOT EXISTS owner_sessions ON execution_sessions(installation,owner);
      CREATE TABLE IF NOT EXISTS execution_runs (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, due INTEGER NOT NULL, reserved_source TEXT, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_by_session ON execution_runs(session);
      CREATE INDEX IF NOT EXISTS due_runs ON execution_runs(session,due);
      CREATE INDEX IF NOT EXISTS reservations ON execution_runs(session,reserved_source) WHERE reserved_source IS NOT NULL;
      CREATE TABLE IF NOT EXISTS archived_sessions (
        installation TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(installation,id)
      );
      CREATE TABLE IF NOT EXISTS stop_intents (
        installation TEXT NOT NULL, owner TEXT NOT NULL, run TEXT NOT NULL, request TEXT NOT NULL,
        generation TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(installation,owner,run,request)
      );
      CREATE TABLE IF NOT EXISTS replay_expiry (run TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS expired_replays ON replay_expiry(expires);
      CREATE TABLE IF NOT EXISTS archived_runs (id TEXT PRIMARY KEY);
    `));
    await this.reclaimExpiredReplay();
  }
  private expiredIds(): string[] {
    return this.history.database(db => db.prepare("SELECT run FROM replay_expiry WHERE expires<=? ORDER BY expires LIMIT 64")
      .all(Date.now()).map(row => String(row.run)));
  }
  private async reclaimExpiredReplay(): Promise<void> {
    for (const id of this.expiredIds()) await this.pruneReplay(id);
  }
  private providerKey(provider = this.provider): string {
    return JSON.stringify([provider.appId, provider.installationId, provider.key, provider.implementationId ?? null]);
  }
  private ownerKey(actor: Actor): string {
    return JSON.stringify([actor.userId, actor.principalId, actor.callerAppId, actor.callerInstallation]);
  }
  /** An OS-released SQLite reservation serializes admission with independent supervisor processes. */
  exclusive<T>(action: () => Promise<T>): Promise<T> {
    const perform = async () => {
      const db = new DatabaseSync(this.lockPath);
      try {
        const deadline = Date.now() + 30_000;
        for (;;) {
          try { db.exec("BEGIN IMMEDIATE"); break; }
          catch (error) {
            if ((error as { errcode?: number }).errcode !== 5) throw error;
            if (Date.now() >= deadline) throw new AgentApiError("provider_busy", "The execution writer is busy.", 503, true);
            await delay(20);
          }
        }
        return await action();
      } finally { db.close(); }
    };
    const next = this.tail.then(perform, perform);
    this.tail = next.catch(() => {});
    return next;
  }
  get historicalRunIds(): Pick<ReadonlySet<string>, "has"> {
    return { has: id => this.history.database(db => !!db.prepare(
      "SELECT 1 FROM archived_runs WHERE id=? UNION ALL SELECT 1 FROM execution_runs r JOIN execution_sessions s ON s.id=r.session WHERE r.id=? AND s.installation<>? LIMIT 1"
    ).get(id, id, this.providerKey())) };
  }
  async load(id: string, actor?: Actor, attempt?: string): Promise<SessionRecord> {
    if (!safe(id)) throw new AgentApiError("invalid_id", "Invalid session identity.", 400);
    return this.history.database(db => {
      db.exec("BEGIN");
      try {
        const row = db.prepare("SELECT revision,body,owner,installation FROM execution_sessions WHERE id=?").get(id);
        if (!row || actor && (row.owner !== this.ownerKey(actor) || row.installation !== this.providerKey()))
          throw new AgentApiError("session_not_found", "Session not found.", 404);
        const record = JSON.parse(String(row.body)) as SessionRecord;
        record.runs = {};
        const runs = new Map<string, string>();
        // An operation needs its addressed run, active writers, gates and their source receipts.
        // The latest row is retained for exact session retirement even when no work is due.
        const items = attempt === undefined
          ? db.prepare("SELECT id,body FROM execution_runs WHERE session=? ORDER BY rowid").iterate(id)
          : db.prepare(`SELECT id,body FROM execution_runs WHERE session=? AND id IN (
              SELECT ? UNION SELECT id FROM execution_runs WHERE session=? AND due=1
              UNION SELECT id FROM execution_runs WHERE session=? AND reserved_source IS NOT NULL
              UNION SELECT reserved_source FROM execution_runs WHERE session=? AND reserved_source IS NOT NULL
              UNION SELECT id FROM (SELECT id FROM execution_runs WHERE session=? ORDER BY rowid DESC LIMIT 1)
            ) ORDER BY rowid`).iterate(id, attempt, id, id, id, id);
        for (const item of items) {
          const runId = String(item.id), bytes = String(item.body);
          const run: RunRecord = JSON.parse(bytes);
          record.runs[runId] = run;
          runs.set(runId, bytesHash(bytes));
        }
        db.exec("COMMIT");
        this.versions.set(record, { version: Number(row.revision), runs });
        return record;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
  }

  async archiveInstallation(record: SessionRecord): Promise<void> {
    this.history.database(db => {
      db.prepare("INSERT OR IGNORE INTO archived_sessions(installation,id,body) VALUES(?,?,?)")
        .run(this.providerKey(record.session.ref.provider), record.id, JSON.stringify(record));
    });
  }
  async save(record: SessionRecord, discarded?: { run: string; admission: string; request: string }): Promise<void> {
    const baseline = this.versions.get(record);
    const revision = baseline?.version ?? 0;
    const digests = new Map<string, string>();
    const { runs, ...session } = record;
    try {
      this.history.commitSession(record, db => {
        if (discarded) this.history.discardDelivery(db, record.owner, record.id, discarded.run, discarded.admission, discarded.request);
        const existing = db.prepare("SELECT revision FROM execution_sessions WHERE id=?").get(record.id);
        if (Number(existing?.revision ?? 0) !== revision)
          throw new AgentApiError("state_changed", "The retained execution changed. Read its current revision.", 409, true);
        db.prepare(`INSERT INTO execution_sessions(id,owner,installation,occupied,due,revision,body) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,installation=excluded.installation,occupied=excluded.occupied,
            due=excluded.due,revision=excluded.revision,body=excluded.body`)
          .run(record.id, this.ownerKey(record.owner), this.providerKey(record.session.ref.provider),
            Number(occupied(record)), Number(maintenanceDue(record)), revision + 1, JSON.stringify(session));
        const update = db.prepare(`INSERT INTO execution_runs(id,session,due,reserved_source,body) VALUES(?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET body=excluded.body,due=excluded.due,reserved_source=excluded.reserved_source WHERE execution_runs.session=excluded.session`);
        for (const [id, run] of Object.entries(runs)) {
          const { historyOutbox: _pending, ...data } = run;
          const bytes = JSON.stringify(data), digest = bytesHash(bytes);
          digests.set(id, digest);
          if (baseline?.runs.get(id) === digest) continue;
          const completed = Date.parse(run.completedAt ?? "");
          if (run.events.length && run.snapshot.stopConfirmed && Number.isFinite(completed)) {
            const expires = Math.max(completed, Date.parse(run.snapshot.observedAt) || completed) + this.replayRetentionMs;
            db.prepare("INSERT OR REPLACE INTO replay_expiry(run,expires) VALUES(?,?)").run(id, expires);
          } else db.prepare("DELETE FROM replay_expiry WHERE run=?").run(id);
          if (!update.run(id, record.id, Number(needsSupervisor(run)), run.reservedFor?.runId ?? null, bytes).changes)
            throw new AgentApiError("request_conflict", "Run identity is already retained.", 409);
        }
        // Suppression now lives in the committed attempt, including its original command receipts.
        for (const [id, run] of Object.entries(runs)) if (run.cancelFence)
          db.prepare("DELETE FROM stop_intents WHERE installation=? AND owner=? AND run=?")
            .run(this.providerKey(record.session.ref.provider), this.ownerKey(record.owner), id);
        for (const id of baseline?.runs.keys() ?? []) {
          if (digests.has(id)) continue;
          db.prepare("INSERT OR IGNORE INTO archived_runs(id) VALUES(?)").run(id);
          db.prepare("DELETE FROM replay_expiry WHERE run=?").run(id);
          db.prepare("DELETE FROM execution_runs WHERE id=? AND session=?").run(id, record.id);
        }
      });
    } catch (error) {
      if (error instanceof AgentApiError) throw error;
      console.warn("[agent-provider] execution commit failed", { sessionId: record.id, stage: "transaction",
        code: (error as {errcode?: number}).errcode });
      throw new AgentApiError("storage_unavailable", "The execution transaction could not be confirmed.", 503, true);
    }
    this.versions.set(record, { version: revision + 1, runs: digests });

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
    const row = this.history.database(db => db.prepare("SELECT session FROM execution_runs WHERE id=?").get(id));
    if (!row) throw new AgentApiError("run_not_found", "Run not found.", 404);
    const session = await this.load(String(row.session), actor, id);
    const record = session.runs[id];
    if (!record) throw new AgentApiError("run_not_found", "Run not found.", 404);
    return { session, record };
  }
  private async inventory(where: string, args: string[], skipUnavailable = false, onlyDue = false): Promise<SessionRecord[]> {
    const ids = this.history.database(db => db.prepare("SELECT id FROM execution_sessions " + where).all(...args));
    const records: SessionRecord[] = [];
    for (const row of ids) {
      try { records.push(await this.load(String(row.id), undefined, onlyDue ? "" : undefined)); }
      catch (error) {
        if (!skipUnavailable) throw error;
        console.warn("[agent-provider] retained session unavailable", { sessionId: row.id });
      }
    }
    return records;
  }
  records(currentInstallationOnly = false, skipUnavailable = false): Promise<SessionRecord[]> {
    return currentInstallationOnly ? this.inventory("WHERE installation=?", [this.providerKey()], skipUnavailable)
      : this.inventory("", [], skipUnavailable);
  }
  async recordsDue(): Promise<SessionRecord[]> {
    await this.reclaimExpiredReplay();
    return this.inventory("WHERE installation=? AND due=1", [this.providerKey()], true, true);
  }
  occupiedSlots(): number {
    return this.history.database(db => Number(db.prepare("SELECT COUNT(*) AS n FROM execution_sessions WHERE installation=? AND occupied=1")
      .get(this.providerKey())!.n));
  }
  async list(actor: Actor): Promise<AgentSession[]> {
    const records = await this.inventory("WHERE installation=? AND owner=? ORDER BY id", [this.providerKey(), this.ownerKey(actor)]);
    return records.filter(record => !record.deleted && (!record.retirement ||
      record.runs[record.retirement.runId]?.controls[record.retirement.requestId]?.receipt.state !== "applied")).map(record => record.session);
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
  pendingStops(id: string, actor: Actor): Array<{ request: string; generation: string; hash: string }> {
    return this.history.database(db => db.prepare("SELECT request,generation,hash FROM stop_intents WHERE installation=? AND owner=? AND run=?")
      .all(this.providerKey(), this.ownerKey(actor), id).map(row => ({ request: String(row.request), generation: String(row.generation), hash: String(row.hash) })));
  }

  async controlReceipt(id: string, actor: Actor, request: string): Promise<AgentControlReceipt> {
    const pending = this.pendingStops(id, actor).find(stop => stop.request === request);
    if (pending) return { requestId: request, run: { provider: this.provider, id }, generation: pending.generation, revision: "1", state: "applied" };
    const { record } = await this.run(id, actor);
    const control = record.controls[request];
    if (!control) throw new AgentApiError("control_not_found", "Control not found.", 404);
    return control.receipt;
  }

  stopBeforeAdmission(id: string, actor: Actor, request: string, hash: string): AgentControlReceipt {
    const prior = this.pendingStops(id, actor);
    const exact = prior.find(item => item.request === request);
    if (exact && exact.hash !== hash) throw new AgentApiError("request_conflict", "Stop identity has different command bytes.", 409);
    const generation = prior[0]?.generation ?? randomUUID();
    if (!exact) this.history.database(db => db.prepare("INSERT INTO stop_intents(installation,owner,run,request,generation,hash) VALUES(?,?,?,?,?,?)")
      .run(this.providerKey(), this.ownerKey(actor), id, request, generation, hash));
    return { requestId: request, run: { provider: this.provider, id }, generation, revision: "1", state: "applied" };
  }

  markNotAdmitted(run: RunRecord): void { run.snapshot.result = notAdmitted; }

  makeRun(session: SessionRecord, id: string, actor: VerifiedOperation, body: string, input?: AgentRunInput): RunRecord {
    if (this.history.database(db => !!db.prepare("SELECT id FROM execution_runs WHERE id=? UNION ALL SELECT id FROM archived_runs WHERE id=? LIMIT 1").get(id, id))) throw new AgentApiError("request_conflict", "Run identity is already retained.", 409);
    return { hash: bytesHash(body), admissionRef: actor.admissionRef, input, events: [], firstSequence: "1", controls: {}, nativeSequence: 0, nativeRevision: -1,
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
}
