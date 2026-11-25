import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AgentApiError, type AgentProviderRef, type AgentRunSnapshot, type AgentHistorySessionState, type AgentWatchItem } from "@hosty-sdk/app/agent";
import { shouldRetainToolOutput } from "./internal/harness/tool-result.js";
import type { Actor, RunRecord, SessionRecord } from "./store.js";

export type HistoryOwner = Pick<Actor, "callerAppId" | "callerInstallation">;
export type HistoryAuthority = HistoryOwner & { provider: AgentProviderRef; expiresAt: string; acknowledge?: boolean };
export type HistoryObservation = { sessionId: string; runId: string; generation: string; userId: string; principalId: string; item: AgentWatchItem };
export type HistoryFrame = HistoryObservation & { cursor: string; epoch?: string; sessionPosition?: number; sourceHistoryIncomplete?: true };

const ownerKey = (owner: HistoryOwner) => JSON.stringify([owner.callerAppId, owner.callerInstallation]);
const sequenceOf = (item: AgentWatchItem) => item.kind === "snapshot" ? item.snapshot.lastSequence : item.event.sequence;

const sourceIncomplete = `EXISTS(SELECT 1 FROM history_run_gaps AS g WHERE g.scope=f.scope AND g.session=f.session AND g.run=f.run AND g.generation=f.generation)`;

/** Retained public facts, scoped to both installations. Each installation gets its own ordering and opaque cursor. */
export class InstallationHistory {
  private readonly db: DatabaseSync;
  private readonly listeners = new Map<string, Set<() => void>>();
  private dataChanges?: NodeJS.Timeout;
  private closed = false;
  constructor(file: string, private readonly provider: AgentProviderRef) {
    closeSync(openSync(file, "a", 0o600));
    this.db = new DatabaseSync(file, { open: false });
    this.withDatabase(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_scopes (scope TEXT PRIMARY KEY, epoch TEXT NOT NULL, position INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS discarded_deliveries (
        scope TEXT NOT NULL, session TEXT NOT NULL, run TEXT NOT NULL, admission TEXT NOT NULL, request TEXT NOT NULL,
        ordinal INTEGER NOT NULL, PRIMARY KEY(scope,session,run)
      );
      CREATE TABLE IF NOT EXISTS history_delivery (
        scope TEXT NOT NULL, session TEXT NOT NULL, through INTEGER NOT NULL, PRIMARY KEY(scope,session)
      );
      CREATE TABLE IF NOT EXISTS history_commits (
        scope TEXT NOT NULL, position INTEGER NOT NULL, marker TEXT NOT NULL, PRIMARY KEY(scope,position)
      );
      CREATE TABLE IF NOT EXISTS history_run_gaps (
        scope TEXT NOT NULL, session TEXT NOT NULL, run TEXT NOT NULL, generation TEXT NOT NULL,
        PRIMARY KEY(scope,session,run,generation)
      );
      CREATE TABLE IF NOT EXISTS history_facts (
        scope TEXT NOT NULL, position INTEGER NOT NULL, session TEXT NOT NULL, run TEXT NOT NULL,
        generation TEXT NOT NULL, sequence TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, ordinal INTEGER NOT NULL, state_run_start INTEGER,
        PRIMARY KEY(scope,position), UNIQUE(scope,session,run,generation,sequence,kind)
      );
      CREATE TABLE IF NOT EXISTS history_backlog (
        scope TEXT NOT NULL, session TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,session)
      );
      CREATE TRIGGER IF NOT EXISTS backlog_insert AFTER INSERT ON history_facts BEGIN
        INSERT INTO history_backlog(scope,session,bytes) VALUES(NEW.scope,NEW.session,length(CAST(NEW.body AS BLOB)))
          ON CONFLICT(scope,session) DO UPDATE SET bytes=bytes+excluded.bytes;
      END;
      CREATE TRIGGER IF NOT EXISTS backlog_delete AFTER DELETE ON history_facts
        WHEN OLD.ordinal>COALESCE((SELECT through FROM history_delivery WHERE scope=OLD.scope AND session=OLD.session),0)
        BEGIN UPDATE history_backlog SET bytes=bytes-length(CAST(OLD.body AS BLOB)) WHERE scope=OLD.scope AND session=OLD.session; END;
      CREATE INDEX IF NOT EXISTS history_tool_start ON history_facts(scope,session,run,generation,
        json_extract(body,'$.item.event.source.agentId'),json_extract(body,'$.item.event.data.toolCallId'),position DESC)
        WHERE json_extract(body,'$.item.event.type')='tool.started';
    `));
    this.withDatabase(() => this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS history_session_ordinal ON history_facts(scope,session,ordinal);
      CREATE INDEX IF NOT EXISTS history_session_position ON history_facts(scope,session,position);
      CREATE INDEX IF NOT EXISTS history_session_state ON history_facts(scope,session,state_run_start DESC,position DESC)
        WHERE state_run_start IS NOT NULL;
    `));
  }
  database<T>(action: (db: DatabaseSync) => T): T { return this.withDatabase(() => action(this.db)); }
  /** An open subscription keeps its live buffer. Idle stores release their SQLite file handles. */
  private withDatabase<T>(action: () => T): T {
    if (this.closed) throw new AgentApiError("history_closed", "Provider history is closed.", 503);
    if (!this.db.isOpen) {
      this.db.open();
      this.db.exec("PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=4000;");
    }
    try { return action(); }
    finally { if (!this.listeners.size && this.db.isOpen) this.db.close(); }
  }
  private scope(owner: HistoryOwner) {
    const key = [this.provider.appId, this.provider.installationId, this.provider.key, ownerKey(owner)];
    if (this.provider.implementationId != null) key.push(this.provider.implementationId);
    return JSON.stringify(key);
  }
  stage(run: RunRecord, item: AgentWatchItem): void {
    const snapshot = item.kind === "snapshot" ? item.snapshot : item.event.type === "run.updated" ? item.event.data.snapshot : undefined;
    if (snapshot && typeof snapshot === "object" && "admissionRef" in snapshot) {
      // Keep the provider's internal admission reference out of delivery credentials' public history.
      const { admissionRef: _, ...publicSnapshot } = snapshot as AgentRunSnapshot;
      item = item.kind === "snapshot" ? { ...item, snapshot: publicSnapshot as typeof item.snapshot }
        : { ...item, event: { ...item.event, data: { ...item.event.data, snapshot: publicSnapshot } } };
    }
    (run.historyOutbox ??= []).push(item);
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
  discardedDelivery(owner: HistoryOwner, session: string, run: string) {
    return this.database(db => db.prepare("SELECT admission,request FROM discarded_deliveries WHERE scope=? AND session=? AND run=?")
      .get(this.scope(owner), session, run));
  }

  /** Called inside the execution write transaction after the original scope has stopped. */
  discardDelivery(db: DatabaseSync, owner: HistoryOwner, session: string, run: string, admission: string, request: string): void {
    const scope = this.scope(owner);
    const last = db.prepare("SELECT COALESCE(MAX(ordinal),0) AS n FROM history_facts WHERE scope=? AND session=? AND run=?").get(scope, session, run)!;
    db.prepare("INSERT INTO discarded_deliveries(scope,session,run,admission,request,ordinal) VALUES(?,?,?,?,?,?)")
      .run(scope, session, run, admission, request, last.n!);
    db.prepare("DELETE FROM history_facts WHERE scope=? AND session=? AND run=?").run(scope, session, run);
    db.prepare("DELETE FROM history_run_gaps WHERE scope=? AND session=? AND run=?").run(scope, session, run);
  }
  /** One commit publishes a transition, its operation receipt and every promised delivery fact. */
  commitSession(session: SessionRecord, write: (db: DatabaseSync) => void): void {
    const scope = this.scope(session.owner);
    this.database(db => {
      db.exec("BEGIN IMMEDIATE");
      try {
        write(db);
        if (session.deleted) {
          db.prepare("DELETE FROM history_facts WHERE scope=? AND session=?").run(scope, session.id);
          db.prepare("DELETE FROM history_delivery WHERE scope=? AND session=?").run(scope, session.id);
          db.prepare("DELETE FROM history_backlog WHERE scope=? AND session=?").run(scope, session.id);
        } else {
          this.append(scope, session);
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
    for (const run of Object.values(session.runs)) delete run.historyOutbox;
    for (const notify of this.listeners.get(scope) ?? []) { try { notify(); } catch { /* Delivery can resume after the stored cursor. */ } }
  }

  requireDeliveryCapacity(owner: HistoryOwner, session: string, limit = 64 * 1024 * 1024): void {
    const bytes = this.database(db => Number(db.prepare("SELECT bytes FROM history_backlog WHERE scope=? AND session=?")
      .get(this.scope(owner), session)?.bytes ?? 0));
    if (bytes >= limit) throw new AgentApiError("history_backpressure", "Previous output is waiting for durable delivery.", 503, true);
  }

  acknowledgeThrough(owner: HistoryOwner, session: string, epoch: string, through: number): void {
    this.database(db => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const scope = this.scope(owner);
        const boundary = this.boundary(scope);
        if (epoch !== boundary.epoch) throw new AgentApiError("history_cursor_invalid", "The delivery generation changed.", 410);
        const head = db.prepare("SELECT MAX(ordinal) AS n FROM history_facts WHERE scope=? AND session=?").get(scope, session);
        if (!head?.n || through > Number(head.n)) throw new AgentApiError("invalid_input", "The receipt exceeds the session's delivery head.", 400);
        const previous = Number(db.prepare("SELECT through FROM history_delivery WHERE scope=? AND session=?").get(scope, session)?.through ?? 0);
        if (through > previous) {
          const claim = db.prepare("SELECT SUM(length(CAST(body AS BLOB))) AS bytes FROM history_facts WHERE scope=? AND session=? AND ordinal>? AND ordinal<=?")
            .get(scope, session, previous, through);
          db.prepare("UPDATE history_backlog SET bytes=bytes-? WHERE scope=? AND session=?").run(Number(claim?.bytes ?? 0), scope, session);
        }
        db.prepare(`INSERT INTO history_delivery(scope,session,through) VALUES(?,?,?)
          ON CONFLICT(scope,session) DO UPDATE SET through=MAX(through,excluded.through)`).run(scope, session, through);
        // Keep a recent window for reconnect and preserve each run's latest state and durable sequence anchor.
        db.prepare(`DELETE FROM history_facts WHERE scope=? AND session=? AND ordinal<=? AND state_run_start IS NULL
          AND position NOT IN (SELECT MAX(position) FROM history_facts WHERE scope=? AND session=? GROUP BY run)`)
          .run(scope, session, through - 256, scope, session);
        db.prepare(`DELETE FROM history_facts WHERE scope=? AND session=? AND ordinal<=? AND state_run_start IS NOT NULL
          AND position NOT IN (SELECT MAX(position) FROM history_facts WHERE scope=? AND session=? AND state_run_start IS NOT NULL GROUP BY run)`)
          .run(scope, session, through - 256, scope, session);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
  }
  private append(scope: string, session: SessionRecord): void {
    let { position } = this.boundary(scope);
    let firstDurable: number | undefined;
    const append = this.db.prepare(`INSERT INTO history_facts(scope,position,session,run,generation,sequence,kind,body,ordinal,state_run_start)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,session,run,generation,sequence,kind) DO NOTHING`);
    const head = this.db.prepare("SELECT MAX(ordinal) AS n FROM history_facts WHERE scope=? AND session=?");
    const retired = this.db.prepare("SELECT MAX(ordinal) AS n FROM discarded_deliveries WHERE scope=? AND session=?");
    let ordinal = Math.max(Number(head.get(scope, session.id)?.n ?? 0), Number(retired.get(scope, session.id)?.n ?? 0));
    const firstRecord = this.db.prepare("SELECT MIN(state_run_start) AS n FROM history_facts WHERE scope=? AND session=? AND run=?");
    for (const run of Object.values(session.runs)) {
      const items = run.historyOutbox ?? [];
      if (!items.length || this.db.prepare("SELECT 1 FROM discarded_deliveries WHERE scope=? AND session=? AND run=?")
        .get(scope, session.id, run.snapshot.ref.id)) continue;
      let runStart = Number(firstRecord.get(scope, session.id, run.snapshot.ref.id)?.n ?? 0);
      for (const item of items) {
        const observation: HistoryObservation = { sessionId: session.id, runId: run.snapshot.ref.id,
          generation: run.snapshot.generation, userId: session.owner.userId, principalId: session.owner.principalId, item };
        const body = JSON.stringify(observation);
        runStart ||= position + 1;
        const state = item.kind === "snapshot" || item.event.type === "run.updated";
        if (!append.run(scope, position + 1, session.id, observation.runId, observation.generation,
          sequenceOf(item), item.kind, body, ordinal + 1, state ? runStart : null).changes) continue;
        ordinal++;
        position++;
        firstDurable ??= position;
      }
    }
    if (firstDurable !== undefined) {
      // An old backup can fork the stream and reuse a position. Every batch gets a fresh marker.
      this.db.prepare("INSERT INTO history_commits(scope,position,marker) VALUES(?,?,?)").run(scope, firstDurable, randomUUID());
      this.db.prepare("UPDATE history_scopes SET position=? WHERE scope=?").run(position, scope);
    }
  }
  /** Read the public name from the earlier start even when neither the page nor the run snapshot contains it. */
  private readObservation(scope: string, position: number, body: string): HistoryObservation {
    const observation = JSON.parse(body) as HistoryObservation;
    const { item } = observation;
    if (item.kind !== "event" || item.event.type !== "tool.completed") return observation;
    const { event } = item, { toolCallId, state } = event.data;
    let name = event.data.name;
    if ((!name || name === "unknown") && typeof toolCallId === "string") {
      const start = this.db.prepare(`
        SELECT json_extract(body,'$.item.event.data.name') AS name FROM history_facts
        WHERE scope=? AND session=? AND run=? AND generation=? AND json_extract(body,'$.item.event.type')='tool.started'
          AND json_extract(body,'$.item.event.source.agentId')=? AND json_extract(body,'$.item.event.data.toolCallId')=?
          AND position<? ORDER BY position DESC LIMIT 1`)
        .get(scope, observation.sessionId, observation.runId, observation.generation, event.source.agentId, toolCallId, position);
      if (typeof start?.name === "string" && start.name) event.data.name = name = start.name;
    }
    if (typeof name !== "string" || !name || name === "unknown" || !shouldRetainToolOutput(name)) {
      // Keep the outcome while withholding output and command summaries for unclassified or private tools.
      event.data = { toolCallId, state, ...(typeof name === "string" && name ? { name } : {}) };
    }
    return observation;
  }
  page(owner: HistoryOwner, after?: string, through?: string, limit = 32, live = false, positioned = false): { observations: HistoryFrame[]; through: string; nextCursor: string | null } {
    return this.withDatabase(() => this.readPage(owner, after, through, limit, live, positioned));
  }
  private readPage(owner: HistoryOwner, after: string | undefined, through: string | undefined, limit: number, live: boolean, positioned: boolean) {
    const scope = this.scope(owner);
    const { boundary, cursor, position } = this.coordinates(scope);
    const start = position(after, 0), end = position(through, boundary.position);
    if (start > end || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AgentApiError("invalid_input", "Invalid history page bounds.", 400);
    const select = "SELECT position,ordinal,body," + (positioned ? sourceIncomplete : "0")
      + " AS partial FROM history_facts AS f WHERE scope=? AND position>? AND position<=?";
    const rows = this.db.prepare(select + " ORDER BY position LIMIT ?");
    const observations: HistoryFrame[] = [];
    let pageBytes = 0, more = false;
    const range = [scope, start, end];
    for (const row of rows.iterate(...range, limit + 1)) {
      const body = String(row.body), size = Buffer.byteLength(body);
      if (observations.length >= limit || observations.length > 0 && pageBytes + size > 2 * 1024 * 1024) { more = true; break; }
      observations.push({ cursor: cursor(Number(row.position)), ...this.readObservation(scope, Number(row.position), body),
        ...(positioned ? { epoch: boundary.epoch } : {}), ...(row.partial ? { sourceHistoryIncomplete: true as const } : {}),
        ...(positioned && row.ordinal !== null ? { sessionPosition: Number(row.ordinal) } : {}) });
      pageBytes += size;
    }
    return { observations, through: cursor(end), nextCursor: more ? observations.at(-1)!.cursor : null };
  }
  private coordinates(scope: string) {
    const boundary = this.boundary(scope);
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
    return { boundary, cursor, position };
  }

  currentBoundary(owner: HistoryOwner, previous?: string): string {
    return this.withDatabase(() => {
      const { boundary, cursor, position } = this.coordinates(this.scope(owner));
      if (previous) position(previous, 0);
      return cursor(boundary.position);
    });
  }

  states(owner: HistoryOwner, through?: string, afterSession = "", limit = 32) {
    return this.withDatabase(() => {
      const scope = this.scope(owner), { boundary, cursor, position } = this.coordinates(scope);
      const end = position(through, boundary.position);
      const names = this.db.prepare(`
        SELECT DISTINCT session FROM history_facts WHERE scope=? AND session>? AND position<=?
        ORDER BY session LIMIT ?`).all(scope, afterSession, end, limit + 1);
      const latest = this.db.prepare(`
        SELECT body, ${sourceIncomplete} AS partial FROM history_facts AS f WHERE scope=? AND session=? AND position<=? AND state_run_start IS NOT NULL
        ORDER BY state_run_start DESC,position DESC LIMIT 1`);
      const head = this.db.prepare("SELECT ordinal FROM history_facts WHERE scope=? AND session=? AND position<=? ORDER BY position DESC LIMIT 1");
      const sessions: AgentHistorySessionState[] = [];
      let bytes = 0, more = false;
      for (const name of names) {
        if (sessions.length === limit) { more = true; break; }
        const sessionId = String(name.session), row = latest.get(scope, sessionId, end);
        if (!row) throw new AgentApiError("history_state_missing", "Retained history lacks an initial run state.", 503, true);
        const { item, userId, principalId }: HistoryObservation = JSON.parse(String(row.body));
        const snapshot = item.kind === "snapshot" ? item.snapshot : item.event.data.snapshot as AgentRunSnapshot;
        const { ref, generation, revision, state, phase, stopConfirmed, freshness, observedAt,
          configurationRevision, lastSequence, cursor: runCursor, pending, effects } = snapshot;
        const summary: AgentHistorySessionState = { sessionId, userId, principalId, epoch: boundary.epoch,
          head: Number(head.get(scope, sessionId, end)!.ordinal), ...(row.partial ? { sourceHistoryIncomplete: true as const } : {}),
          snapshot: { ref, sessionId, generation, revision, state, phase, stopConfirmed, freshness, observedAt,
            configurationRevision, lastSequence, cursor: runCursor, pending, effects } };
        const size = Buffer.byteLength(JSON.stringify(summary));
        if (sessions.length && bytes + size > 2 * 1024 * 1024) { more = true; break; }
        sessions.push(summary); bytes += size;
      }
      return { through: cursor(end), sessions, nextSession: more ? sessions.at(-1)!.sessionId : null };
    });
  }

  range(owner: HistoryOwner, through: string, sessionId: string, epoch: string, from: number, to: number, limit: number) {
    return this.withDatabase(() => {
      const scope = this.scope(owner), { boundary, cursor, position } = this.coordinates(scope);
      const end = position(through, boundary.position);
      if (epoch !== boundary.epoch) throw new AgentApiError("history_cursor_invalid", "The session history epoch changed.", 410);
      const head = this.db.prepare("SELECT ordinal FROM history_facts WHERE scope=? AND session=? AND position<=? ORDER BY position DESC LIMIT 1")
        .get(scope, sessionId, end);
      if (!head) throw new AgentApiError("history_range_unavailable", "This session range is unavailable at this boundary.", 410);
      if (to > Number(head.ordinal)) throw new AgentApiError("invalid_input", "Requested range exceeds the session head.", 400);
      const receipt = this.db.prepare("SELECT through FROM history_delivery WHERE scope=? AND session=?").get(scope, sessionId);
      if (receipt && from <= Number(receipt.through) - 256)
        throw new AgentApiError("history_range_unavailable", "This range was acknowledged by its transcript owner.", 410);
      const missing = () => this.db.prepare("SELECT 1 FROM discarded_deliveries WHERE scope=? AND session=? AND ordinal>=?").get(scope, sessionId, from)
        ? new AgentApiError("history_range_unavailable", "The transcript owner discarded delivery in this range.", 410)
        : new AgentApiError("history_range_invalid", "Session history is incomplete.", 503);
      const rows = this.db.prepare(`
        SELECT position,ordinal,body,${sourceIncomplete} AS partial FROM history_facts AS f WHERE scope=? AND session=?
          AND ordinal BETWEEN ? AND ? AND position<=? ORDER BY ordinal LIMIT ?`).iterate(scope, sessionId, from, to, end, limit);
      const observations: HistoryFrame[] = [];
      let bytes = 0;
      for (const row of rows) {
        const body = String(row.body), size = Buffer.byteLength(body);
        if (observations.length && bytes + size > 2 * 1024 * 1024) break;
        if (Number(row.ordinal) !== from + observations.length) throw missing();
        observations.push({ ...this.readObservation(scope, Number(row.position), body), cursor: cursor(Number(row.position)), epoch, sessionPosition: Number(row.ordinal),
          ...(row.partial ? { sourceHistoryIncomplete: true as const } : {}) });
        bytes += size;
      }
      if (!observations.length) throw missing();
      const next = from + observations.length;
      return { observations, nextPosition: next <= to ? next : null };
    });
  }
  subscribe(owner: HistoryOwner, listener: () => void): () => void {
    const scope = this.scope(owner), set = this.listeners.get(scope) ?? new Set();
    this.listeners.set(scope, set); set.add(listener);
    if (!this.dataChanges) {
      let previous = this.database(db => db.prepare("PRAGMA data_version").get()?.data_version);
      this.dataChanges = setInterval(() => {
        try {
          const current = this.database(db => db.prepare("PRAGMA data_version").get()?.data_version);
          if (current === previous) return;
          previous = current;
          for (const group of this.listeners.values()) for (const notify of group) notify();
        } catch { /* A later tick retries a temporary read failure. */ }
      }, 250);
      this.dataChanges.unref();
    }
    return () => {
      set.delete(listener);
      if (set.size) return;
      this.listeners.delete(scope);
      if (!this.listeners.size) this.releaseReader();
    };
  }
  private releaseReader(): void {
    clearInterval(this.dataChanges); this.dataChanges = undefined;
    if (this.db.isOpen) this.db.close();
  }
  close(): void { this.closed = true; this.releaseReader(); }
}
