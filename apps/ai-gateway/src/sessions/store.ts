import { mkdir, readdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

// Session records and transcripts live in the gateway's app data directory (decision 2026-08-08):
// standard app backup/removal semantics apply, Core audit never receives transcript content.
// Layout: {dataDir}/sessions/{id}/record.json + events.ndjson (append-only transcript).

// "awaiting_question" is deliberately its own status rather than a flavor of awaiting_approval: the
// two pauses look identical from the outside but resolve through different routes with different
// payloads, and a client that cannot tell them apart cannot render the right card.
export type SessionStatus =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "awaiting_question"
  | "cancelled"
  /**
   * Waited for a person long enough that nobody is coming.
   *
   * Distinct from `cancelled`, which the operator chose, and from `failed`, which the harness caused.
   * Collapsing it into either would misreport who decided — and the transcript is kept precisely so
   * the operator can still read what it was waiting to ask.
   */
  | "abandoned"
  | "failed";

export interface SessionRecord {
  id: string;
  title: string | null;
  /**
   * Who chose the title. An operator's own name is never overwritten by a derived one — a session
   * renamed to "disk pressure" must not become the first line of the next message. Absent on records
   * written before titles existed, which read as `auto`: nobody had typed one.
   */
  titleSource?: "auto" | "operator";
  /** Structured page context from the client (app id, route) — seeds the first prompt, never parsed. */
  context: Record<string, string> | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  harnessSessionId: string | null;
  lastEventSeq: number;
}

export interface StoredEvent {
  seq: number;
  ts: string;
  type: string;
  [key: string]: unknown;
}

export class SessionStore {
  constructor(private readonly dataDir: string) {}

  private sessionsRoot(): string {
    return path.join(this.dataDir, "sessions");
  }

  private sessionDir(id: string): string {
    // Ids are gateway-generated UUIDs, but never trust a path segment from a request.
    if (!/^[a-zA-Z0-9-]+$/.test(id)) {
      throw new Error(`invalid session id: ${id}`);
    }
    return path.join(this.sessionsRoot(), id);
  }

  async createSession(record: SessionRecord): Promise<void> {
    const dir = this.sessionDir(record.id);
    await mkdir(dir, { recursive: true });
    await this.saveRecord(record);
  }

  async saveRecord(record: SessionRecord): Promise<void> {
    await writeFile(
      path.join(this.sessionDir(record.id), "record.json"),
      JSON.stringify(record, null, 2),
      "utf8",
    );
  }

  async readRecord(id: string): Promise<SessionRecord | null> {
    try {
      return JSON.parse(
        await readFile(path.join(this.sessionDir(id), "record.json"), "utf8"),
      ) as SessionRecord;
    } catch {
      return null;
    }
  }

  async listRecords(): Promise<SessionRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.sessionsRoot());
    } catch {
      return [];
    }

    const records: SessionRecord[] = [];
    for (const entry of entries) {
      const record = await this.readRecord(entry).catch(() => null);
      if (record) {
        records.push(record);
      }
    }

    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async appendEvent(id: string, event: StoredEvent): Promise<void> {
    await appendFile(
      path.join(this.sessionDir(id), "events.ndjson"),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
  }

  async readEvents(id: string, afterSeq = 0): Promise<StoredEvent[]> {
    let raw: string;
    try {
      raw = await readFile(path.join(this.sessionDir(id), "events.ndjson"), "utf8");
    } catch {
      return [];
    }

    const events: StoredEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as StoredEvent;
        if (event.seq > afterSeq) {
          events.push(event);
        }
      } catch {
        // A torn tail line from a crash mid-append is expected; skip it rather than fail the read.
      }
    }

    return events;
  }

  /** Deletes sessions whose last activity is older than the retention window. Returns deleted ids. */
  async sweepRetention(retentionDays: number, now = new Date()): Promise<string[]> {
    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    const deleted: string[] = [];
    for (const record of await this.listRecords()) {
      if (new Date(record.updatedAt).getTime() < cutoff) {
        await rm(this.sessionDir(record.id), { recursive: true, force: true });
        deleted.push(record.id);
      }
    }

    return deleted;
  }
}
