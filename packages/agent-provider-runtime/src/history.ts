import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AgentApiError, type AgentProviderRef, type AgentRunSnapshot, type AgentWatchItem } from "@hosty-sdk/app/agent";
import type { Actor, RunRecord, SessionRecord } from "./store.js";

export type HistoryOwner = Pick<Actor, "callerAppId" | "callerInstallation">;
export type HistoryAuthority = HistoryOwner & { provider: AgentProviderRef; expiresAt: string };
export type HistoryObservation = { sessionId: string; runId: string; generation: string; userId: string; principalId: string; item: AgentWatchItem };
export type HistoryFrame = HistoryObservation & { cursor: string };

const ownerKey = (owner: HistoryOwner) => JSON.stringify([owner.callerAppId, owner.callerInstallation]);
const sequenceOf = (item: AgentWatchItem) => item.kind === "snapshot" ? item.snapshot.lastSequence : item.event.sequence;
const isTransient = (item: AgentWatchItem) => item.kind === "event" && (item.event.type === "message.delta" || item.event.type === "tool.output");

/** Retained public facts, scoped to both installations. Each installation gets its own ordering and opaque cursor. */
export class InstallationHistory {
  private readonly db: DatabaseSync;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly transients = new WeakMap<RunRecord, AgentWatchItem[]>();
  private closed = false;
  constructor(file: string, private readonly provider: AgentProviderRef) {
    closeSync(openSync(file, "a", 0o600));
    this.db = new DatabaseSync(file, { open: false });
    this.withDatabase(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_scopes (scope TEXT PRIMARY KEY, epoch TEXT NOT NULL, position INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS history_commits (
        scope TEXT NOT NULL, position INTEGER NOT NULL, marker TEXT NOT NULL, PRIMARY KEY(scope,position)
      );
      CREATE TABLE IF NOT EXISTS history_facts (
        scope TEXT NOT NULL, position INTEGER NOT NULL, session TEXT NOT NULL, run TEXT NOT NULL,
        generation TEXT NOT NULL, sequence TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(scope,position), UNIQUE(scope,session,run,generation,sequence,kind)
      );
    `));
  }
  /** An open subscription keeps its live buffer. Idle stores release their SQLite file handles. */
  private withDatabase<T>(action: () => T): T {
    if (this.closed) throw new AgentApiError("history_closed", "Provider history is closed.", 503);
    if (!this.db.isOpen) {
      this.db.open();
      this.db.exec(`PRAGMA synchronous = FULL; PRAGMA temp_store = MEMORY;
        CREATE TEMP TABLE live_facts (scope TEXT NOT NULL, position INTEGER NOT NULL, session TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope,position));`);
    }
    try { return action(); }
    finally { if (!this.listeners.size && this.db.isOpen) this.db.close(); }
  }
  private scope(owner: HistoryOwner) {
    return JSON.stringify([this.provider.appId, this.provider.installationId, this.provider.key, ownerKey(owner)]);
  }
  /** A previously published receipt distinguishes missing archive data from a normal unpublished outbox. */
  needsRecovery(session: SessionRecord, run: RunRecord): boolean {
    if (session.deleted) return false;
    const ref = session.session.ref.provider;
    if (ref.appId !== this.provider.appId || ref.installationId !== this.provider.installationId || ref.key !== this.provider.key) return false;
    const scope = this.scope(session.owner), receipt = run.historyReceipt;
    return this.withDatabase(() => {
      const query = "SELECT 1 FROM history_facts WHERE scope=? AND session=? AND run=? AND generation=?";
      const identity = [scope, session.id, run.snapshot.ref.id, run.snapshot.generation];
      if (receipt ? this.db.prepare(query + " AND sequence=? AND kind=?").get(...identity, receipt.sequence, receipt.kind)
        : this.db.prepare(query + " LIMIT 1").get(...identity)) return false;
      // Existing v1 aggregates may predate receipts. A newly admitted, unpublished run starts at sequence one.
      if (!receipt && (run.snapshot.lastSequence === "0" || run.historyOutbox?.some(item => item.kind === "event" &&
          item.event.type === "run.updated" && item.event.sequence === "1"))) return false;
      this.db.prepare("UPDATE history_scopes SET epoch=? WHERE scope=?").run(randomUUID(), scope);
      return true;
    });
  }
  acknowledge(run: RunRecord): void {
    const last = run.historyOutbox?.at(-1);
    if (last) run.historyReceipt = { sequence: sequenceOf(last), kind: last.kind };
    delete run.historyOutbox;
  }
  stage(run: RunRecord, item: AgentWatchItem): void {
    if (isTransient(item)) {
      if (this.listeners.size) {
        const pending = this.transients.get(run) ?? [];
        pending.push(item);
        this.transients.set(run, pending);
      }
    } else {
      const snapshot = item.kind === "snapshot" ? item.snapshot : item.event.type === "run.updated" ? item.event.data.snapshot : undefined;
      if (snapshot && typeof snapshot === "object" && ("admissionRef" in snapshot || run.historyPartial)) {
        // Keep the provider's internal admission reference out of delivery credentials' public history.
        const { admissionRef: _, ...publicSnapshot } = snapshot as AgentRunSnapshot;
        if (run.historyPartial) publicSnapshot.coverage = { messages: "truncated", tools: "truncated", decisions: "truncated" };
        item = item.kind === "snapshot" ? { ...item, snapshot: publicSnapshot as typeof item.snapshot }
          : { ...item, event: { ...item.event, data: { ...item.event.data, snapshot: publicSnapshot } } };
      }
      (run.historyOutbox ??= []).push(item);
    }
  }
  private boundary(scope: string): { epoch: string; position: number } {
    let row = this.db.prepare("SELECT epoch,position FROM history_scopes WHERE scope=?").get(scope);
    if (!row) {
      const epoch = randomUUID();
      this.db.prepare("INSERT INTO history_scopes(scope,epoch,position) VALUES(?,?,0)").run(scope, epoch);
      row = { epoch, position: 0 };
    }
    return { epoch: String(row.epoch), position: Number(row.position) };
  }
  /** The session's on-disk outbox makes the database transaction replayable across a crash between stores. */
  publish(session: SessionRecord): void {
    const ref = session.session.ref.provider;
    if (ref.appId !== this.provider.appId || ref.installationId !== this.provider.installationId || ref.key !== this.provider.key) return;
    const scope = this.scope(session.owner);
    if (session.deleted) {
      this.withDatabase(() => {
        this.db.prepare("DELETE FROM history_facts WHERE scope=? AND session=?").run(scope, session.id);
        this.db.prepare("DELETE FROM live_facts WHERE scope=? AND session=?").run(scope, session.id);
      });
      return;
    }
    if (!Object.values(session.runs).some(run => run.historyOutbox?.length || this.listeners.has(scope) && this.transients.has(run))) return;
    const changed = this.withDatabase(() => this.append(scope, session));
    for (const run of Object.values(session.runs)) { this.acknowledge(run); this.transients.delete(run); }
    if (changed) for (const notify of this.listeners.get(scope) ?? []) { try { notify(); } catch { /* A subscriber cannot undo a committed batch. */ } }
  }
  private append(scope: string, session: SessionRecord): boolean {
    let changed = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let { position } = this.boundary(scope);
      let firstDurable: number | undefined;
      const append = this.db.prepare(`INSERT INTO history_facts(scope,position,session,run,generation,sequence,kind,body)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope,session,run,generation,sequence,kind) DO NOTHING`);
      const live = this.db.prepare("INSERT INTO live_facts(scope,position,session,body) VALUES(?,?,?,?)");
      for (const run of Object.values(session.runs)) {
        const transients = this.listeners.has(scope) ? this.transients.get(run) ?? [] : [];
        const durable = run.historyOutbox ?? [];
        const items = transients.length
          ? [...durable, ...transients].sort((a, b) => Number(BigInt(sequenceOf(a)) - BigInt(sequenceOf(b))))
          : durable;
        for (const item of items) {
          const observation: HistoryObservation = { sessionId: session.id, runId: run.snapshot.ref.id,
            generation: run.snapshot.generation, userId: session.owner.userId, principalId: session.owner.principalId, item };
          const body = JSON.stringify(observation);
          if (isTransient(item)) {
            live.run(scope, ++position, session.id, body);
            changed = true;
          } else if (append.run(scope, position + 1, session.id, observation.runId, observation.generation, sequenceOf(item), item.kind, body).changes) {
            position++;
            firstDurable ??= position;
            changed = true;
          }
        }
      }
      if (changed) {
        // An old backup can fork the stream and reuse a position. A new durable batch gets a fresh
        // marker even if it recreated identical content. Ephemeral-only batches need no durable marker.
        if (firstDurable !== undefined)
          this.db.prepare("INSERT INTO history_commits(scope,position,marker) VALUES(?,?,?)").run(scope, firstDurable, randomUUID());
        this.db.prepare("UPDATE history_scopes SET position=? WHERE scope=?").run(position, scope);
        this.db.prepare("DELETE FROM live_facts WHERE scope=? AND position<=?").run(scope, position - 128);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return changed;
  }
  page(owner: HistoryOwner, after?: string, through?: string, limit = 32, live = false): { observations: HistoryFrame[]; through: string; nextCursor: string | null } {
    return this.withDatabase(() => this.readPage(owner, after, through, limit, live));
  }
  private readPage(owner: HistoryOwner, after: string | undefined, through: string | undefined, limit: number, live: boolean) {
    const scope = this.scope(owner), boundary = this.boundary(scope);
    const marker = this.db.prepare("SELECT marker FROM history_commits WHERE scope=? AND position<=? ORDER BY position DESC LIMIT 1");
    const cursor = (n: number) => boundary.epoch + "." + n + "." + (marker.get(scope, n)?.marker ?? "0");
    const position = (value: string | undefined, fallback: number) => {
      if (!value) return fallback;
      const parts = value.split(".");
      if (parts.length !== 3 || parts[0] !== boundary.epoch || !/^(0|[1-9]\d{0,15})$/.test(parts[1]!))
        throw new AgentApiError("history_cursor_invalid", "The history cursor belongs to another stream or generation.", 410);
      const n = Number(parts[1]);
      if (!Number.isSafeInteger(n) || n > boundary.position) throw new AgentApiError("history_cursor_invalid", "The history cursor is ahead of retained history.", 410);
      if (cursor(n) !== value) throw new AgentApiError("history_cursor_invalid", "The retained history at this cursor has changed.", 410);
      return n;
    };
    const start = position(after, 0), end = position(through, boundary.position);
    if (start > end || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AgentApiError("invalid_input", "Invalid history page bounds.", 400);
    const select = "SELECT position,body FROM history_facts WHERE scope=? AND position>? AND position<=?";
    const query = live ? select + " UNION ALL SELECT position,body FROM live_facts WHERE scope=? AND position>? AND position<=?" : select;
    const rows = this.db.prepare(query + " ORDER BY position LIMIT ?");
    const observations: HistoryFrame[] = [];
    let pageBytes = 0, more = false;
    const range = [scope, start, end];
    for (const row of rows.iterate(...range, ...(live ? range : []), limit + 1)) {
      const body = String(row.body), size = Buffer.byteLength(body);
      if (observations.length >= limit || observations.length > 0 && pageBytes + size > 2 * 1024 * 1024) { more = true; break; }
      observations.push({ cursor: cursor(Number(row.position)), ...JSON.parse(body) as HistoryObservation });
      pageBytes += size;
    }
    return { observations, through: cursor(end), nextCursor: more ? observations.at(-1)!.cursor : null };
  }
  subscribe(owner: HistoryOwner, listener: () => void): () => void {
    const scope = this.scope(owner), set = this.listeners.get(scope) ?? new Set();
    this.listeners.set(scope, set); set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size) return;
      this.listeners.delete(scope);
      if (this.db.isOpen) {
        this.db.prepare("DELETE FROM live_facts WHERE scope=?").run(scope);
        if (!this.listeners.size) this.db.close();
      }
    };
  }
  close(): void { this.closed = true; if (this.db.isOpen) this.db.close(); }
}
