import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface RemovalOrigin {
  runId: string;
  sessionId: string;
  admissionRef: string;
  provider: import("@hosty-sdk/app/agent").AgentProviderRef;
}

export interface Removal {
  sessionId: string;
  owner: string;
  requestId: string;
  state: "pending" | "removed";
  reason: string | null;
}

/** The removal receipt is independent of the private session payload that cleanup erases. */
export class SessionRemovals {
  private database?: DatabaseSync;
  constructor(private readonly directory: string) {}

  private open(): DatabaseSync {
    if (this.database) return this.database;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path.join(this.directory, "session-removals.sqlite"));
    db.exec(`PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS removals (
        sessionId TEXT PRIMARY KEY, owner TEXT NOT NULL, requestId TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', reason TEXT, failures INTEGER NOT NULL DEFAULT 0,
        due INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS removal_payloads (
        session TEXT PRIMARY KEY, ready INTEGER NOT NULL DEFAULT 0, erased INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS removal_origins (session TEXT NOT NULL, run TEXT NOT NULL, origin TEXT NOT NULL, PRIMARY KEY(session,run));
      CREATE INDEX IF NOT EXISTS removal_due ON removals(state, due);`);
    this.database = db;
    return db;
  }

  read(id: string): Removal | undefined {
    return this.open().prepare("SELECT sessionId,owner,requestId,state,reason FROM removals WHERE sessionId=?").get(id) as unknown as Removal | undefined;
  }

  accept(id: string, owner: string, requestId: string, origins: RemovalOrigin[] = []): void {
    const db = this.open();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (db.prepare("INSERT OR IGNORE INTO removals(sessionId,owner,requestId) VALUES(?,?,?)").run(id, owner, requestId).changes) {
        db.prepare("INSERT INTO removal_payloads(session) VALUES(?)").run(id);
        const add = db.prepare("INSERT INTO removal_origins(session,run,origin) VALUES(?,?,?)");
        for (const origin of origins) add.run(id, origin.runId, JSON.stringify(origin));
      }
      if (this.read(id)?.owner !== owner) throw new Error("The removal belongs to a different owner.");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  readyToErase(id: string): void { this.open().prepare("UPDATE removal_payloads SET ready=1 WHERE session=?").run(id); }
  canErase(id: string): boolean { return this.open().prepare("SELECT ready FROM removal_payloads WHERE session=?").get(id)?.ready === 1; }
  erased(id: string): void { this.open().prepare("UPDATE removal_payloads SET erased=1 WHERE session=? AND ready=1").run(id); }
  localErased(id: string): boolean { return this.open().prepare("SELECT erased FROM removal_payloads WHERE session=?").get(id)?.erased === 1; }

  origins(id: string): RemovalOrigin[] {
    return this.open().prepare("SELECT origin FROM removal_origins WHERE session=? ORDER BY rowid").all(id)
      .map(row => JSON.parse(String(row.origin)) as RemovalOrigin);
  }
  discarded(id: string, run: string): void { this.open().prepare("DELETE FROM removal_origins WHERE session=? AND run=?").run(id, run); }

  due(now: number): Removal[] {
    this.open().prepare("DELETE FROM removals WHERE state='removed' AND due<?").run(now - 7 * 86400_000);
    return this.open().prepare("SELECT sessionId,owner,requestId,state,reason FROM removals WHERE state='pending' AND due<=? ORDER BY due, sessionId LIMIT 32").all(now) as unknown as Removal[];
  }

  completed(id: string): void {
    const db = this.open();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (this.origins(id).length) throw new Error("Provider delivery cleanup remains pending.");
      db.prepare("DELETE FROM removal_payloads WHERE session=?").run(id);
      db.prepare("UPDATE removals SET state='removed', reason=NULL, due=? WHERE sessionId=?").run(Date.now(), id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  defer(id: string, reason: string, now: number): void {
    this.open().prepare("UPDATE removals SET reason=?, due=? + min(60000, 1000 * (1 << min(failures,6))), failures=min(failures+1,6) WHERE sessionId=? AND state='pending'").run(reason, now, id);
  }

  close(): void { this.database?.close(); this.database = undefined; }
}
