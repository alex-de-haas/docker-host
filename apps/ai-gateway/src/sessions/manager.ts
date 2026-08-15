import { randomUUID } from "node:crypto";
import type { HarnessAdapter, HarnessEvent, HarnessRun } from "../harness/adapter.js";
import type { SessionRecord, SessionStatus, SessionStore, StoredEvent } from "./store.js";
import type { AuditReporter } from "../audit.js";
import type { SettingsStore } from "../settings/store.js";
import type { ProviderDirectory } from "../settings/providers.js";
import { TokenExchange, toMcpServerConfig, TOKEN_REFRESH_MARGIN_MS } from "../mcp/exchange.js";

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
  /** questionId -> the question texts, which are the keys the answers must come back under. */
  pendingQuestions: Map<string, string[]>;
  /**
   * The gateway's own credential for this session, kept alive by self-refresh so app tokens can be
   * re-minted mid-turn. Null once the chain's absolute lifetime has run out, at which point the
   * session keeps working with its host tools and simply loses app MCP until the operator speaks.
   */
  credential: string | null;
  refreshTimer: NodeJS.Timeout | null;
}

export class SessionManager {
  private readonly live = new Map<string, LiveSession>();

  constructor(
    private readonly store: SessionStore,
    private readonly adapter: HarnessAdapter,
    private readonly audit: AuditReporter,
    private readonly workDir: string,
    private readonly settings: SettingsStore | null = null,
    private readonly providers: ProviderDirectory | null = null,
    private readonly exchange: TokenExchange | null = null,
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
      pendingQuestions: new Map(),
      credential: null,
      refreshTimer: null,
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

  /**
   * `credential` is the delegated token the operator's client presented. It is the session's seed for
   * reaching app MCP endpoints: the gateway self-refreshes it to stay alive through a long turn and
   * branches off it for each enabled provider. Every message replaces it, so an active conversation
   * always holds the freshest chain.
   */
  async postMessage(id: string, text: string, credential?: string): Promise<void> {
    const session = await this.requireLive(id);
    if (credential) {
      session.credential = credential;
    }
    await this.append(id, { type: "user_message", text });
    await this.setStatus(id, "running");
    if (!session.run) {
      // Read at start, not at every turn: the system prompt is the session's instruction set, so a
      // mid-conversation swap would leave a transcript whose halves ran under different rules. An
      // edit takes effect in the next session, which the settings UI states plainly.
      const systemPrompt = (await this.settings?.read())?.systemPrompt?.trim() || undefined;
      const mcpServers = await this.buildMcpServers(session);
      session.run = this.adapter.start({
        sessionId: id,
        cwd: this.workDir,
        systemPrompt,
        ...(mcpServers ? { mcpServers } : {}),
        // A gateway restart loses the process but not the record: resume the harness-native
        // session when one was captured, per the reattach/resume decision in the plan.
        resumeHarnessSessionId: session.record.harnessSessionId ?? undefined,
        onEvent: (event) => void this.onHarnessEvent(id, event),
      });
    }
    this.scheduleMcpRefresh(id);
    session.run.send(text);
  }

  /**
   * Mints one MCP server entry per enabled, reachable provider. Returns undefined when there is
   * nothing to offer, so a harness without providers is started exactly as before rather than with
   * an empty map.
   */
  private async buildMcpServers(session: LiveSession): Promise<Record<string, unknown> | undefined> {
    if (!this.providers || !this.exchange?.available || !this.settings || !session.credential) {
      return undefined;
    }

    const [discovered, policy] = await Promise.all([this.providers.read(), this.settings.read()]);
    if (!discovered) {
      return undefined;
    }

    const servers = await this.exchange.buildServers(
      session.credential,
      discovered.providers,
      policy.mcpProviders,
    );
    return servers.length > 0 ? toMcpServerConfig(servers) : undefined;
  }

  /**
   * App tokens live five minutes, so they are re-minted before they die rather than after a call has
   * already failed. The chain itself is capped an hour past the operator's last interaction: once
   * self-refresh is refused, the credential is dropped and the session continues without app MCP —
   * degraded, not broken, and restored by the operator saying anything at all.
   */
  /**
   * Re-mints the gateway's credential and rebuilds the harness's MCP servers. Returns false when the
   * chain has run out, in which case the caller leaves the session without app MCP rather than
   * pretending it still has it.
   */
  private async refreshMcpServers(session: LiveSession): Promise<boolean> {
    if (!session.run || !session.credential || !this.exchange?.available) {
      return false;
    }

    const renewed = await this.exchange.refreshSelf(session.credential);
    if (!renewed) {
      session.credential = null;
      return false;
    }

    session.credential = renewed.token;
    const servers = await this.buildMcpServers(session);
    await session.run.setMcpServers(servers ?? {}).catch(() => false);
    return true;
  }

  private scheduleMcpRefresh(id: string): void {
    const session = this.live.get(id);
    if (!session || !this.exchange?.available || session.refreshTimer) {
      return;
    }

    session.refreshTimer = setInterval(() => {
      void (async () => {
        const live = this.live.get(id);
        if (!live?.run || !live.credential) {
          return;
        }

        const renewed = await this.exchange!.refreshSelf(live.credential);
        if (!renewed) {
          live.credential = null;
          return;
        }

        live.credential = renewed.token;
        const servers = await this.buildMcpServers(live);
        await live.run.setMcpServers(servers ?? {}).catch(() => false);
      })();
    }, TOKEN_REFRESH_MARGIN_MS * 3);
    session.refreshTimer.unref?.();
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

    // Re-mint before releasing an approved app-MCP call. The timer alone is not enough: the call was
    // prepared when the approval was raised, so an operator who thinks for longer than the five-minute
    // TTL would release a call carrying a dead credential. Observed live on 2026-08-15 — an approval
    // held nine minutes failed with an authorization error even though the refresh timer had been
    // running correctly the whole time, because refreshing helps the NEXT call, not the paused one.
    if (decision === "allow" && toolName.startsWith("mcp__")) {
      await this.refreshMcpServers(session);
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

  /**
   * Answers a pending question. `answers` is keyed by question text — the harness's own keying, kept
   * end to end so nothing has to correlate by index.
   *
   * Returns false when the question is unknown or already answered, which the route turns into a 409
   * exactly as a second approval decision does: two operators on the same session must not both
   * think they steered it.
   */
  async resolveQuestion(
    id: string,
    questionId: string,
    answers: Record<string, string>,
  ): Promise<boolean> {
    const session = await this.requireLive(id);
    const questions = session.pendingQuestions.get(questionId);
    if (!session.run || questions === undefined) {
      return false;
    }

    // Only answers to questions that were actually asked are forwarded. The harness keys its lookup
    // by question text, so an unrecognized key would be silently ignored downstream — dropping it
    // here keeps the transcript honest about what was answered.
    const accepted: Record<string, string> = {};
    for (const question of questions) {
      const answer = answers[question];
      if (typeof answer === "string") {
        accepted[question] = answer;
      }
    }

    if (!session.run.resolveQuestion(questionId, accepted)) {
      return false;
    }

    session.pendingQuestions.delete(questionId);
    await this.append(id, { type: "question_answered", questionId, answers: accepted });
    await this.setStatus(id, "running");
    return true;
  }

  async cancelSession(id: string): Promise<void> {
    const session = await this.requireLive(id);
    if (session.run) {
      await session.run.stop().catch(() => undefined);
      session.run = null;
    }
    session.pendingApprovals.clear();
    session.pendingQuestions.clear();
    this.clearRefresh(session);
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
    // Attach BEFORE reading the replay and buffer until the read finishes: an event persisted
    // mid-read could otherwise miss both the file snapshot and the listener — for an approval
    // request that gap would strand the harness on a pause nobody can see. The buffered tail is
    // deduped against the replay by seq; the flip to passthrough has no await in between, so no
    // event can slip past it.
    const buffered: StoredEvent[] = [];
    let passthrough = false;
    const wrapped: SessionListener = (event) => {
      if (passthrough) {
        listener(event);
      } else {
        buffered.push(event);
      }
    };
    session.listeners.add(wrapped);
    const replay = await this.store.readEvents(id, afterSeq);
    const lastReplayed = replay.length > 0 ? replay[replay.length - 1]!.seq : afterSeq;
    const tail = buffered.filter((event) => event.seq > lastReplayed);
    passthrough = true;
    return { replay: [...replay, ...tail], unsubscribe: () => session.listeners.delete(wrapped) };
  }

  async shutdown(): Promise<void> {
    for (const session of this.live.values()) {
      if (session.run) {
        await session.run.stop().catch(() => undefined);
        session.run = null;
      }
      this.clearRefresh(session);
    }
  }

  private clearRefresh(session: LiveSession): void {
    if (session.refreshTimer) {
      clearInterval(session.refreshTimer);
      session.refreshTimer = null;
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
      pendingQuestions: new Map(),
      credential: null,
      refreshTimer: null,
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
      case "question_request":
        session.pendingQuestions.set(
          event.questionId,
          event.questions.map((question) => question.question),
        );
        // Persisted, not live-only: a reconnecting client rebuilds the card from the event log, the
        // same way a pending approval already does.
        await this.append(id, { ...event });
        await this.setStatus(id, "awaiting_question");
        return;
      case "result":
        await this.append(id, { ...event });
        await this.setStatus(id, "idle");
        return;
      case "error": {
        // The run is dead: drop it so the next message starts a fresh harness (resuming the
        // captured harness session when possible) instead of feeding a terminated input stream.
        const failedRun = session.run;
        session.run = null;
        session.pendingApprovals.clear();
        session.pendingQuestions.clear();
        if (failedRun) {
          void failedRun.stop().catch(() => undefined);
        }
        await this.append(id, { ...event });
        await this.setStatus(id, "failed");
        return;
      }
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
