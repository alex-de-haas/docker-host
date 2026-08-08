import { randomUUID } from "node:crypto";
import type { HarnessAdapter, HarnessEvent, HarnessRun } from "../harness/adapter.js";
import type { SessionRecord, SessionStatus, SessionStore, StoredEvent } from "./store.js";
import type { AuditReporter } from "../audit.js";

// Owns session lifecycle: one harness run per live session, an append-only event log with a
// monotonic seq (the SSE reattach cursor), and status transitions driven by harness events.
// Deltas fan out live but are not persisted — the final assistant_text is the transcript record.

export interface SessionListener {
  (event: StoredEvent): void;
}

interface LiveSession {
  record: SessionRecord;
  run: HarnessRun | null;
  listeners: Set<SessionListener>;
  /** approvalId -> toolName, so approval decisions can be audited with what they approved. */
  pendingApprovals: Map<string, string>;
}

export class SessionManager {
  private readonly live = new Map<string, LiveSession>();

  constructor(
    private readonly store: SessionStore,
    private readonly adapter: HarnessAdapter,
    private readonly audit: AuditReporter,
    private readonly workDir: string,
  ) {}

  async createSession(input: {
    title?: string;
    context?: Record<string, string>;
    createdBy: string;
  }): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: randomUUID(),
      title: input.title?.trim() || null,
      context: input.context ?? null,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy,
      harnessSessionId: null,
      lastEventSeq: 0,
    };
    await this.store.createSession(record);
    this.live.set(record.id, {
      record,
      run: null,
      listeners: new Set(),
      pendingApprovals: new Map(),
    });
    await this.append(record.id, { type: "session_created", createdBy: input.createdBy });
    this.audit.report("ai_session_created", { sessionId: record.id, actor: input.createdBy });
    return record;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.store.listRecords();
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return this.live.get(id)?.record ?? this.store.readRecord(id);
  }

  async postMessage(id: string, text: string): Promise<void> {
    const session = await this.requireLive(id);
    await this.append(id, { type: "user_message", text });
    await this.setStatus(id, "running");
    if (!session.run) {
      session.run = this.adapter.start({
        sessionId: id,
        cwd: this.workDir,
        // A gateway restart loses the process but not the record: resume the harness-native
        // session when one was captured, per the reattach/resume decision in the plan.
        resumeHarnessSessionId: session.record.harnessSessionId ?? undefined,
        onEvent: (event) => void this.onHarnessEvent(id, event),
      });
    }
    session.run.send(text);
  }

  async resolveApproval(
    id: string,
    approvalId: string,
    decision: "allow" | "deny",
    message?: string,
  ): Promise<boolean> {
    const session = await this.requireLive(id);
    const toolName = session.pendingApprovals.get(approvalId);
    if (!session.run || toolName === undefined) {
      return false;
    }

    const resolved = session.run.resolveApproval(approvalId, decision, message);
    if (!resolved) {
      return false;
    }

    session.pendingApprovals.delete(approvalId);
    await this.append(id, { type: "approval_decision", approvalId, toolName, decision });
    await this.setStatus(id, "running");
    if (decision === "allow") {
      // Approved actions are the one transcript-adjacent fact Core audit does receive —
      // lifecycle plus approvals, never content (decision 2026-08-08).
      this.audit.report("ai_action_approved", { sessionId: id, toolName });
    }
    return true;
  }

  async cancelSession(id: string): Promise<void> {
    const session = await this.requireLive(id);
    if (session.run) {
      await session.run.stop().catch(() => undefined);
      session.run = null;
    }
    session.pendingApprovals.clear();
    // Persisted with the same type the live status fan-out uses, so a transcript replay and a
    // live subscriber see one status vocabulary.
    await this.append(id, { type: "session_status", status: "cancelled" });
    await this.setStatus(id, "cancelled");
    this.audit.report("ai_session_cancelled", { sessionId: id });
  }

  /** Replays persisted events after `afterSeq`, then attaches for live ones. */
  async subscribe(
    id: string,
    afterSeq: number,
    listener: SessionListener,
  ): Promise<{ replay: StoredEvent[]; unsubscribe: () => void }> {
    const session = await this.requireLive(id);
    const replay = await this.store.readEvents(id, afterSeq);
    session.listeners.add(listener);
    return { replay, unsubscribe: () => session.listeners.delete(listener) };
  }

  async shutdown(): Promise<void> {
    for (const session of this.live.values()) {
      if (session.run) {
        await session.run.stop().catch(() => undefined);
        session.run = null;
      }
    }
  }

  private async requireLive(id: string): Promise<LiveSession> {
    const existing = this.live.get(id);
    if (existing) {
      return existing;
    }

    // A session created before the last gateway restart: rehydrate the record; the harness run
    // itself restarts lazily on the next message (with resume when possible).
    const record = await this.store.readRecord(id);
    if (!record) {
      throw new SessionNotFoundError(id);
    }

    const session: LiveSession = {
      record,
      run: null,
      listeners: new Set(),
      pendingApprovals: new Map(),
    };
    this.live.set(id, session);
    return session;
  }

  private async onHarnessEvent(id: string, event: HarnessEvent): Promise<void> {
    try {
      await this.applyHarnessEvent(id, event);
    } catch (error) {
      // A late event after the session dir was swept/cancelled must not crash the process;
      // the harness run is being torn down anyway.
      console.warn(`[session ${id}] dropping harness event after store failure`, error);
    }
  }

  private async applyHarnessEvent(id: string, event: HarnessEvent): Promise<void> {
    const session = this.live.get(id);
    if (!session) {
      return;
    }

    switch (event.type) {
      case "harness_session":
        session.record.harnessSessionId = event.harnessSessionId;
        await this.store.saveRecord(session.record);
        return;
      case "assistant_delta":
        // Live-only: fanned out for typing UX, never persisted (the final text is the record).
        this.fanOut(session, { seq: session.record.lastEventSeq, ts: new Date().toISOString(), ...event });
        return;
      case "approval_request":
        session.pendingApprovals.set(event.approvalId, event.toolName);
        await this.append(id, { ...event });
        await this.setStatus(id, "awaiting_approval");
        return;
      case "result":
        await this.append(id, { ...event });
        await this.setStatus(id, "idle");
        return;
      case "error":
        await this.append(id, { ...event });
        await this.setStatus(id, "failed");
        return;
      default:
        await this.append(id, { ...event });
    }
  }

  private async append(id: string, payload: Record<string, unknown> & { type: string }): Promise<void> {
    const session = this.live.get(id);
    if (!session) {
      return;
    }

    session.record.lastEventSeq += 1;
    const event: StoredEvent = {
      seq: session.record.lastEventSeq,
      ts: new Date().toISOString(),
      ...payload,
    };
    await this.store.appendEvent(id, event);
    await this.store.saveRecord(session.record);
    this.fanOut(session, event);
  }

  private fanOut(session: LiveSession, event: StoredEvent): void {
    for (const listener of session.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not take down the session loop.
      }
    }
  }

  private async setStatus(id: string, status: SessionStatus): Promise<void> {
    const session = this.live.get(id);
    if (!session || session.record.status === status) {
      return;
    }

    session.record.status = status;
    session.record.updatedAt = new Date().toISOString();
    await this.store.saveRecord(session.record);
    this.fanOut(session, {
      seq: session.record.lastEventSeq,
      ts: session.record.updatedAt,
      type: "session_status",
      status,
    });
  }
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`session not found: ${id}`);
  }
}
