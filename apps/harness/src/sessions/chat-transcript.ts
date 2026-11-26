import { closeSync, lstatSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { applyProviderHistoryContent } from "../agent-providers/history-content.js";
import type { StoredEvent } from "./store.js";
import type { HistoryReceipt } from "../agent-providers/history-coverage.js";
import { providerIdentityParts } from "../../shared/provider-reference.js";
import type { AgentAuthorizationRequest, AgentProviderRef } from "@hosty-sdk/app/agent";

export type DeliveryAck = { sessionId: string; epoch: string; through: number };
type Staged = { key: string; ordinal: number; provider: AgentProviderRef; fact: HistoryReceipt };

/** The conversation owns this file. Only the browser projection can be rebuilt from its pending inputs. */
export class ChatTranscript {
  constructor(private readonly file: string) {}

  private database<T>(action: (db: DatabaseSync) => T) {
    if (!lstatSync(this.file).isFile())
      throw Object.assign(new Error("The retained conversation database is not a regular file."), { code: "session_storage_corrupt" });
    const db = new DatabaseSync(this.file);
    try {
      db.exec("PRAGMA synchronous=FULL; PRAGMA secure_delete=ON");
      return action(db);
    } finally { db.close(); }
  }

  create() {
    closeSync(openSync(this.file, "wx", 0o600));
    this.database(db => db.exec(`
      CREATE TABLE authorizations (key TEXT PRIMARY KEY, reference TEXT NOT NULL, request TEXT NOT NULL);
      CREATE TABLE admissions (run TEXT PRIMARY KEY, reference TEXT NOT NULL);
      CREATE TABLE delivery_origins (run TEXT PRIMARY KEY, provider TEXT NOT NULL, session TEXT NOT NULL, reference TEXT NOT NULL);
      CREATE TABLE transcript (seq INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE INDEX transcript_content ON transcript(json_extract(body,'$.target'),seq)
        WHERE json_extract(body,'$.type') IN ('provider_fragment','provider_history_order');
      CREATE TABLE streams (id TEXT PRIMARY KEY, provider TEXT NOT NULL, session TEXT NOT NULL, epoch TEXT NOT NULL,
        received INTEGER NOT NULL DEFAULT 0, acknowledged INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE incoming (stream TEXT NOT NULL, ordinal INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(stream,ordinal));
      CREATE INDEX pending_acks ON streams(received,acknowledged) WHERE received>acknowledged;
    `));
  }

  authorize(request: AgentAuthorizationRequest, reference: string, provider: AgentProviderRef) {
    const key = JSON.stringify([request.method, request.path, request.bodyHash]);
    this.database(db => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const { operation, method, path, bodyHash, sessionId, runId } = request;
        db.prepare("INSERT INTO authorizations(key,reference,request) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET reference=excluded.reference")
          .run(key, reference, JSON.stringify({ operation, method, path, bodyHash, sessionId, runId }));
        if (request.operation === "runs.start" && request.runId && request.sessionId) {
          db.prepare("INSERT OR IGNORE INTO admissions(run,reference) VALUES (?,?)").run(request.runId, reference);
          db.prepare("INSERT OR IGNORE INTO delivery_origins(run,provider,session,reference) VALUES(?,?,?,?)")
            .run(request.runId, JSON.stringify(provider), request.sessionId, reference);
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
    return true;
  }

  authorization(request: AgentAuthorizationRequest) {
    const key = JSON.stringify([request.method, request.path, request.bodyHash]);
    return this.database(db => {
      const row = db.prepare("SELECT reference,request FROM authorizations WHERE key=?").get(key);
      return row && { reference: String(row.reference), request: JSON.parse(String(row.request)) as AgentAuthorizationRequest };
    });
  }

  admission(runId: string) {
    return this.database(db => db.prepare("SELECT reference FROM admissions WHERE run=?").get(runId)?.reference as string | undefined);
  }

  deliveryOrigins() {
    return this.database(db => db.prepare("SELECT run,provider,session,reference FROM delivery_origins ORDER BY rowid").all()
      .map(row => ({ runId: String(row.run), provider: JSON.parse(String(row.provider)) as AgentProviderRef,
        sessionId: String(row.session), admissionRef: String(row.reference) })));
  }

  highWater() {
    return this.database(db => Number(db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM transcript").get()!.seq));
  }

  append(event: StoredEvent) {
    this.database(db => db.prepare("INSERT INTO transcript(seq,body) VALUES (?,?)").run(event.seq, JSON.stringify(event)));
  }

  read(after: number) {
    return this.database(db => {
      const decode = (row: { body?: unknown }) => JSON.parse(String(row.body)) as StoredEvent;
      const events = db.prepare("SELECT body FROM transcript WHERE seq>? ORDER BY seq").all(after).map(decode);
      const targets = after > 0 ? events.filter(event => event.type === "assistant_text" || event.type === "tool_result")
        .map(event => event.providerEventId).filter(id => typeof id === "string") : [];
      if (!targets.length) return applyProviderHistoryContent(events);
      // A reconnect cursor can fall within an already stored answer. Read its earlier content by target.
      const prior = db.prepare(`SELECT body FROM transcript WHERE json_extract(body,'$.type') IN ('provider_fragment','provider_history_order')
        AND json_extract(body,'$.target') IN (SELECT value FROM json_each(?)) AND seq<=? ORDER BY seq`).all(JSON.stringify(targets), after).map(decode);
      return applyProviderHistoryContent([...prior, ...events]).slice(prior.length);
    });
  }

  /** Commit the complete incoming transcript item and its contiguous delivery cursor together.
   * Acknowledgement can release the provider's copy even when local display projection is delayed. */
  receive(provider: AgentProviderRef, fact: HistoryReceipt) {
    const { sessionPosition: ordinal, epoch, sessionId } = fact;
    if (!ordinal || !epoch) throw new Error("Durable provider delivery requires an ordinal and epoch.");
    const key = JSON.stringify([providerIdentityParts(provider), sessionId, epoch]);
    return this.database(db => {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT OR IGNORE INTO streams(id,provider,session,epoch) VALUES (?,?,?,?)")
          .run(key, JSON.stringify(provider), sessionId, epoch);
        const current = Number(db.prepare("SELECT received FROM streams WHERE id=?").get(key)!.received);
        if (ordinal > current) db.prepare("INSERT OR IGNORE INTO incoming(stream,ordinal,body) VALUES (?,?,?)")
          .run(key, ordinal, JSON.stringify(fact));
        if (ordinal === current + 1) {
          // Sparse tail inputs remain owned until both the hole and projection have settled.
          let contiguous = current;
          for (const row of db.prepare("SELECT ordinal FROM incoming WHERE stream=? AND ordinal>? ORDER BY ordinal").iterate(key, current)) {
            if (Number(row.ordinal) !== contiguous + 1) break;
            contiguous++;
          }
          db.prepare("UPDATE streams SET received=? WHERE id=?").run(contiguous, key);
          db.prepare("DELETE FROM incoming WHERE stream=? AND ordinal<=? AND body=''").run(key, contiguous);
        }
        const staged = db.prepare("SELECT body FROM incoming WHERE stream=? AND ordinal=? AND body<>''").get(key, ordinal);
        db.exec("COMMIT");
        return staged ? { key, ordinal, provider, fact: JSON.parse(String(staged.body)) as HistoryReceipt } : undefined;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
  }

  pending(limit = 32): Staged[] {
    return this.database(db => db.prepare(`SELECT incoming.stream,ordinal,body,provider FROM incoming
      JOIN streams ON streams.id=incoming.stream WHERE body<>'' ORDER BY ordinal LIMIT ?`).all(limit)
      .map(row => ({ key: String(row.stream), ordinal: Number(row.ordinal), provider: JSON.parse(String(row.provider)), fact: JSON.parse(String(row.body)) })));
  }

  projected(item: Staged) {
    this.database(db => {
      // A zero-content marker above the contiguous frontier preserves sparse deduplication.
      db.prepare("UPDATE incoming SET body='' WHERE stream=? AND ordinal=?").run(item.key, item.ordinal);
      db.prepare("DELETE FROM incoming WHERE stream=? AND ordinal=? AND ordinal<=(SELECT received FROM streams WHERE id=?)")
        .run(item.key, item.ordinal, item.key);
    });
  }

  acknowledgements(provider: AgentProviderRef): DeliveryAck[] {
    return this.database(db => db.prepare("SELECT id,session,epoch,received FROM streams WHERE received>acknowledged").all()
      .filter(row => JSON.stringify(JSON.parse(String(row.id))[0]) === JSON.stringify(providerIdentityParts(provider)))
      .map(row => ({ sessionId: String(row.session), epoch: String(row.epoch), through: Number(row.received) })));
  }
  acknowledged(provider: AgentProviderRef, receipt: DeliveryAck) {
    const key = JSON.stringify([providerIdentityParts(provider), receipt.sessionId, receipt.epoch]);
    this.database(db => db.prepare("UPDATE streams SET acknowledged=MAX(acknowledged,?) WHERE id=? AND received>=?")
      .run(receipt.through, key, receipt.through));
  }
}
