import { isWaitingStatus, WaitingNotifier } from "../notifications.js";
import { composeSystemPrompt, partitionSkills, type AppSkill } from "../mcp/skills.js";
import { HOST_SYSTEM_PROMPT } from "./host-prompt.js";
import { randomUUID } from "node:crypto";
import { deriveTitleFromMessage, normalizeTitle } from "./title.js";
import type { HarnessAdapter, HarnessEvent, HarnessRun } from "../harness/adapter.js";
import type { SessionRecord, SessionStatus, SessionStore, StoredEvent } from "./store.js";
import type { AuditReporter } from "../audit.js";
import type { SettingsStore } from "../settings/store.js";
import type { ProviderDirectory } from "../settings/providers.js";
import { TokenExchange, toMcpServerConfig, serverName, TOKEN_REFRESH_MARGIN_MS } from "../mcp/exchange.js";
import { readOnlyToolNames } from "../mcp/readonly.js";
import type { McpProxy, MintedToken } from "../mcp/proxy.js";

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
  /**
   * The apps whose MCP servers this session was actually given, in the order they were offered.
   * Skills follow this rather than the policy: instructions for tools a session does not have read
   * as a capability rather than as an absence.
   */
  mcpAppIds: string[];
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
  /**
   * Harness-facing names of app tools that may run without an approval card: an app the operator
   * marked trusted, crossed with the tools that app declares read-only. Empty until proven otherwise,
   * which is the only safe default — an unknown tool asks.
   */
  autoAllowed: Set<string>;
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
    private readonly proxy: McpProxy | null = null,
    /** Loopback origin the harness reaches this gateway on, for the per-session MCP proxy. */
    private readonly proxyBaseUrl: string | null = null,
    private readonly notifier: WaitingNotifier | null = null,
  ) {}

  /**
   * Mints an app token for a live session. This is what the proxy calls per request, which is the
   * whole point: the token is obtained when the call goes out rather than when the harness connected,
   * so an approval held past the five-minute TTL still releases onto a valid credential.
   *
   * Returns null once the chain has lapsed — the proxy turns that into a readable refusal rather
   * than letting the app answer with an authorization error.
   */
  async mintAppToken(sessionId: string, appId: string): Promise<MintedToken | null> {
    const session = this.live.get(sessionId);
    if (!session?.credential || !this.exchange?.available) {
      return null;
    }

    const issued = await this.exchange.exchange(session.credential, appId);
    return issued ? { token: issued.token, expiresAtMs: new Date(issued.expiresAt).getTime() } : null;
  }

  async createSession(input: {
    title?: string;
    context?: Record<string, string>;
    createdBy: string;
  }): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const title = normalizeTitle(input.title);
    const record: SessionRecord = {
      id: randomUUID(),
      title,
      titleSource: title ? "operator" : "auto",
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
      mcpAppIds: [],
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
      credential: null,
      refreshTimer: null,
      autoAllowed: new Set(),
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
   * Deletes a session: its record, its transcript, and the run still producing one.
   *
   * The run is stopped first and by the same route a cancel takes — proxy routes unregistered,
   * refresh timer cleared — because a harness left running against a deleted session would keep
   * minting app tokens for a conversation nobody can read any more.
   *
   * Subscribers are told before the record goes: another tab with this session open would otherwise
   * sit on a stream that has stopped meaning anything, and reconnect into a 404 it cannot explain.
   */
  async deleteSession(id: string): Promise<boolean> {
    const record = this.live.get(id)?.record ?? (await this.store.readRecord(id));
    if (!record) {
      return false;
    }

    const session = this.live.get(id);
    if (session) {
      if (session.run) {
        await session.run.stop().catch(() => undefined);
        session.run = null;
      }
      session.pendingApprovals.clear();
      session.pendingQuestions.clear();
      this.clearRefresh(session);
      this.fanOut(session, {
        seq: session.record.lastEventSeq,
        ts: new Date().toISOString(),
        type: "session_deleted",
      });
      session.listeners.clear();
      this.live.delete(id);
    }
    this.proxy?.unregister(id);
    await this.store.deleteSession(id);
    // Reported like every other lifecycle transition: the deletion is the operator's action, and the
    // transcript it removed is exactly what an audit trail cannot recover afterwards. The id and the
    // actor go to Core; nothing of what was said does.
    this.audit.report("ai_session_deleted", { sessionId: id });
    return true;
  }

  /**
   * The text of the earliest stored `user_message`, or null when the log holds none.
   *
   * Read once per session: the only caller runs when a session has no title, and it has one
   * immediately afterwards. A session whose log was swept keeps no opening message, and naming it
   * after the current turn is then the best available answer rather than a wrong one.
   */
  private async firstUserMessage(id: string): Promise<string | null> {
    const events = await this.store.readEvents(id).catch(() => []);
    const opening = events.find((event) => event.type === "user_message");
    return typeof opening?.text === "string" ? opening.text : null;
  }

  /**
   * Renames a session. An empty title clears the name and returns it to `auto`, so the next message
   * derives one again — an emptied box is a decision, not a session pinned to the empty string.
   *
   * The title stays in the gateway's own store: it is derived from transcript text, and transcript
   * content does not reach Core (decision 2026-08-08 — Core audits lifecycle and approvals only).
   */
  async renameSession(id: string, title: unknown): Promise<SessionRecord | null> {
    const record = this.live.get(id)?.record ?? (await this.store.readRecord(id));
    if (!record) {
      return null;
    }
    const normalized = normalizeTitle(title);
    record.title = normalized;
    record.titleSource = normalized ? "operator" : "auto";
    record.updatedAt = new Date().toISOString();
    await this.store.saveRecord(record);
    return record;
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
      // A fresh credential is also the documented recovery from a lapsed chain, so an existing run
      // gets its servers rebuilt here rather than waiting for the next timer tick — otherwise
      // "the operator saying anything at all" restores nothing for up to three minutes.
      const recovering = session.credential === null && session.run !== null;
      session.credential = credential;
      if (recovering) {
        await this.refreshMcpServers(session);
      }
    }
    // Named from the first message that says anything, not from every message: the opening ask is
    // what the operator will recognise the session by later, and re-deriving on each turn would
    // rename a session out from under someone mid-conversation.
    if (!session.record.title && session.record.titleSource !== "operator") {
      // Every session that existed before titles did is unnamed *and* already has a conversation.
      // Naming those after the message being typed now would call a session about a failed restart
      // "and now try again" — so the log is asked what this conversation opened with.
      const opening = session.record.lastEventSeq > 0 ? await this.firstUserMessage(id) : null;
      const derived = deriveTitleFromMessage(opening ?? text);
      if (derived) {
        session.record.title = derived;
        session.record.updatedAt = new Date().toISOString();
        await this.store.saveRecord(session.record);
      }
    }
    await this.append(id, { type: "user_message", text });
    await this.setStatus(id, "running");
    if (!session.run) {
      // Read at start, not at every turn: the system prompt is the session's instruction set, so a
      // mid-conversation swap would leave a transcript whose halves ran under different rules. An
      // edit takes effect in the next session, which the settings UI states plainly.
      const operatorPrompt = (await this.settings?.read())?.systemPrompt?.trim() || undefined;
      const mcpServers = await this.buildMcpServers(session);
      // After the servers, deliberately: the set of enabled providers is what decides whose skill is
      // read, and buildMcpServers is where that set is resolved. Asking first would use a stale one.
      // Host preamble first, operator text second — the platform states identity and ground rules,
      // and the operator's own words come after so they can override any of it. App skills follow,
      // fenced, inside composeSystemPrompt. The facade's instructions deliberately do not carry the
      // preamble: an external client has no shell and no approval cards, so it would be false there.
      const systemPrompt = composeSystemPrompt(
        [HOST_SYSTEM_PROMPT, operatorPrompt?.trim()].filter(Boolean).join("\n\n"),
        await this.readDeliverableSkills(session));
      session.run = this.adapter.start({
        sessionId: id,
        cwd: this.workDir,
        systemPrompt,
        ...(mcpServers ? { mcpServers } : {}),
        // Read live rather than captured: a provider toggled off mid-session must stop being
        // auto-allowed at once, not at the next run.
        isAutoAllowed: (toolName) => session.autoAllowed.has(toolName),
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
   * Mints one MCP server entry per enabled, reachable provider, each pointing at this session's
   * proxy route rather than at the app. Returns undefined when there is nothing to offer, so a
   * harness without providers is started exactly as before rather than with an empty map.
   *
   * The per-provider exchange here is an availability probe, not the credential the harness will
   * use: a provider whose exchange is refused stays absent, and the tokens it did produce seed the
   * proxy's cache so the first call does not repeat the round trip.
   */
  private async buildMcpServers(session: LiveSession): Promise<Record<string, unknown> | undefined> {
    if (
      !this.providers ||
      !this.exchange?.available ||
      !this.settings ||
      !session.credential ||
      !this.proxy ||
      !this.proxyBaseUrl
    ) {
      // No providers on offer means no grants, on every early return below as well. A grant left
      // behind here would outlive the policy that justified it, which is the one thing this set must
      // never do — so it is cleared first and only re-earned at the bottom.
      session.autoAllowed.clear();
      session.mcpAppIds = [];
      return undefined;
    }

    const [discovered, policy] = await Promise.all([this.providers.read(), this.settings.read()]);
    if (!discovered) {
      session.autoAllowed.clear();
      session.mcpAppIds = [];
      return undefined;
    }

    const servers = await this.exchange.buildServers(
      session.credential,
      discovered.providers,
      policy.mcpProviders,
    );
    if (servers.length === 0) {
      session.autoAllowed.clear();
      session.mcpAppIds = [];
      this.proxy.unregister(session.record.id);
      return undefined;
    }

    await this.refreshAutoAllowed(session, servers, policy.mcpAutoAllow);

    const key = this.proxy.register(
      session.record.id,
      servers.map((server) => ({ appId: server.appId, url: server.url })),
      new Map(servers.map((server) => [server.appId, { token: server.token, expiresAtMs: server.expiresAtMs }])),
    );
    session.mcpAppIds = servers.map((server) => server.appId);
    return toMcpServerConfig(servers, {
      baseUrl: this.proxyBaseUrl,
      sessionId: session.record.id,
      key,
    });
  }

  /**
   * The skills of the providers this session actually got, in the order they were offered.
   *
   * Keyed off `session.mcpAppIds` rather than the policy, so a provider that is enabled but
   * unreachable contributes no skill: handing a model instructions for tools it does not have would
   * be worse than silence, because it reads as a capability rather than as an absence.
   */
  private async readEnabledSkills(session: LiveSession): Promise<AppSkill[]> {
    if (!this.providers || session.mcpAppIds.length === 0) {
      return [];
    }

    const skills = await Promise.all(session.mcpAppIds.map((appId) => this.providers!.readSkill(appId)));
    return skills.filter((skill): skill is AppSkill => skill !== null);
  }

  /**
   * The skills this session may be given: only those matching a digest the operator approved.
   *
   * This path no longer writes settings. Recording a baseline here was how text that arrived *after*
   * the operator's decision could approve itself, and it also had two concurrent sessions writing the
   * same file. The baseline now belongs to the act of enabling a provider, which is where the
   * decision is actually made.
   */
  private async readDeliverableSkills(session: LiveSession): Promise<AppSkill[]> {
    const skills = await this.readEnabledSkills(session);
    if (skills.length === 0 || !this.settings) {
      return skills;
    }

    const current = await this.settings.read();
    return partitionSkills(skills, current.mcpSkillDigests).deliver;
  }

  /** Re-reads the fleet and the policy, then rebuilds this session's grants from both. */
  private async refreshAutoAllowedFromPolicy(session: LiveSession): Promise<void> {
    if (!this.providers || !this.settings || !this.exchange?.available || !session.credential) {
      session.autoAllowed.clear();
      return;
    }

    // The policy is read first and cheaply, because the common case is that nobody has vouched for
    // anything: doing the rest unconditionally would mint a token per enabled provider on every tick
    // of every live session to discover there was nothing to grant.
    const policy = await this.settings.read();
    if (!Object.values(policy.mcpAutoAllow).some(Boolean)) {
      session.autoAllowed.clear();
      return;
    }

    const discovered = await this.providers.read();
    if (!discovered) {
      // An unreachable Core is not an empty policy. Keeping the previous grants would be the stale
      // case this exists to bound, so they go — the cost is approval cards until Core answers again,
      // which is the right way round.
      session.autoAllowed.clear();
      return;
    }

    const servers = await this.exchange.buildServers(
      session.credential,
      discovered.providers,
      policy.mcpProviders,
    );
    await this.refreshAutoAllowed(session, servers, policy.mcpAutoAllow);
  }

  /**
   * Works out which app tools may run unprompted: the tools an app declares read-only, but only for
   * an app the operator marked trusted.
   *
   * Two ways to end up asking, and both are the point. An app nobody trusted is never even asked for
   * its tool list — the answer could not be used. And an app whose list could not be read (stopped,
   * refused, an answer of the wrong shape) contributes nothing, because "we do not know" and "it
   * offers nothing read-only" must not lead to the same place. The set is rebuilt from scratch each
   * time rather than merged, so revoking trust takes effect immediately.
   */
  private async refreshAutoAllowed(
    session: LiveSession,
    servers: readonly { appId: string; url: string; token: string }[],
    autoAllow: Readonly<Record<string, boolean>>,
  ): Promise<void> {
    const trusted = servers.filter((server) => autoAllow[server.appId] === true);
    const listed = await Promise.all(
      trusted.map(async (server) => ({
        server,
        readOnly: await readOnlyToolNames(server.url, server.token).catch(() => null),
      })),
    );

    session.autoAllowed = new Set(
      listed.flatMap(({ server, readOnly }) =>
        [...(readOnly ?? [])].map((tool) => `mcp__${serverName(server.appId)}__${tool}`),
      ),
    );
  }

  /**
   * Rebuilds the harness's MCP server list — which providers are on offer, never their credential.
   * Called when the set can genuinely have changed: a policy toggle, or an operator message reviving
   * a lapsed chain. Returns false when the chain has run out, in which case the caller leaves the
   * session without app MCP rather than pretending it still has it.
   */
  private async refreshMcpServers(session: LiveSession): Promise<boolean> {
    if (!session.run || !session.credential || !this.exchange?.available) {
      return false;
    }

    const renewed = await this.exchange.refreshSelf(session.credential);
    if (!renewed) {
      return this.dropAppMcp(session);
    }

    session.credential = renewed.token;
    const servers = await this.buildMcpServers(session);
    await session.run.setMcpServers(servers ?? {}).catch(() => false);
    return true;
  }

  /**
   * The chain has run out. Degrade cleanly rather than leaving dead tools on offer: dropping the
   * credential without clearing the servers would keep app tools visible to the model, which would
   * then call them and be told the delegation expired — worse than never having had them. The proxy
   * registration goes with it, and the timer stops, since nothing can revive the chain except a
   * fresh operator message.
   */
  private async dropAppMcp(session: LiveSession): Promise<boolean> {
    session.credential = null;
    session.autoAllowed.clear();
    this.proxy?.unregister(session.record.id);
    await session.run?.setMcpServers({}).catch(() => false);
    this.clearRefresh(session);
    return false;
  }

  /**
   * Keeps the gateway's own credential alive so the proxy can keep branching off it. It does *not*
   * touch the harness's server list: since the proxy landed, that list holds no expiring credential,
   * and pushing an identical config every three minutes would tear down and rebuild every live MCP
   * connection for nothing.
   */
  private scheduleMcpRefresh(id: string): void {
    const session = this.live.get(id);
    // No credential means nothing to refresh, so no timer: an idle interval waking every three
    // minutes to return immediately is pure noise for a session that may never use app MCP.
    if (!session?.credential || !this.exchange?.available || session.refreshTimer) {
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
          await this.dropAppMcp(live);
          return;
        }

        live.credential = renewed.token;

        // Re-earn the auto-allow grants on the same tick. The set is keyed by tool NAME, and a
        // trusted app updated mid-session can keep a name while making it mutating — after which the
        // stale grant would wave the new behaviour through. Rebuilding here bounds that window to one
        // interval instead of to the length of the session. It costs one listing per *trusted* app,
        // which is the small set by construction.
        await this.refreshAutoAllowedFromPolicy(live);
      })().catch((error) => {
        // A background tick must never take the process down. This became load-bearing when the tick
        // started reading the settings file: an unhandled rejection in a timer kills Node, and the
        // gateway is a long-running process whose sessions would go with it. Losing one refresh is a
        // session that keeps its current credential until the next tick.
        console.warn(`[session ${id}] refresh tick failed`, error);
      });
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

    // Nothing to re-mint here any more. Releasing an approved app-MCP call used to be preceded by a
    // token refresh, because a call is prepared when its approval is raised and an operator thinking
    // for longer than the five-minute TTL would release it onto a dead credential. That fix was
    // verified live not to work — a paused call is bound to the connection it was prepared on, so new
    // configuration reaches the next call and never that one. The proxy solves it at the right layer:
    // the released call carries a session key, and its token is minted as the request goes out.
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

  /**
   * Pushes a provider-policy change into every live session. The settings page tells the operator a
   * toggle "applied to running sessions" when the harness supports it, and that has to be true the
   * moment they see it: a provider just switched off must stop being callable, not linger until the
   * refresh timer happens to come round.
   */
  async applyProviderPolicy(): Promise<void> {
    await Promise.all(
      [...this.live.values()]
        .filter((session) => session.run && session.credential)
        .map((session) => this.refreshMcpServers(session).catch(() => false)),
    );
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
    // The proxy routes die with the run that used them: a cancelled session must not leave a live
    // path that still mints app tokens.
    this.proxy?.unregister(id);
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
      this.proxy?.unregister(session.record.id);
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
      mcpAppIds: [],
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
      credential: null,
      refreshTimer: null,
      autoAllowed: new Set(),
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
        // Only the dead harness held this session's proxy key, so the route has no legitimate user
        // left; the next message rebuilds it along with the run.
        this.proxy?.unregister(id);
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

  /**
   * Stops sessions that have waited for a person past the deadline, keeping their transcripts.
   *
   * A harness paused on an approval holds a process, its MCP proxy route and its share of the
   * delegation chain indefinitely. Nothing here reclaims that on its own: "waiting" is a state a
   * session can legitimately sit in for hours, so only a clock can tell it apart from one nobody is
   * ever coming back to.
   *
   * The transcript survives — the point is to release the machinery, not to erase what happened, and
   * an operator returning to find the session gone would have lost the very question it was asking.
   */
  async sweepAbandoned(maxWaitMs: number, now = Date.now()): Promise<string[]> {
    const abandoned: string[] = [];

    // Persisted records, not just live ones. A gateway restart leaves a session that was waiting
    // recorded as waiting while its harness is already gone; sessions are loaded lazily, so one
    // nobody reopened would never be swept and would sit in the list — and in the attention count —
    // as permanently blocked.
    for (const record of await this.store.listRecords()) {
      if (!isWaitingStatus(record.status) || this.live.has(record.id)) {
        continue;
      }

      if (now - Date.parse(record.updatedAt) < maxWaitMs) {
        continue;
      }

      // Written straight to the store: hydrating a live session only to abandon it would start a
      // harness for the sole purpose of stopping it.
      //
      // The duration is knowable here too — `updatedAt` is when it began waiting — so it is recorded
      // rather than reported as unknown, which is what it says everywhere else.
      const waitedMs = now - Date.parse(record.updatedAt);
      record.status = "abandoned";
      record.updatedAt = new Date(now).toISOString();
      await this.store.saveRecord(record);
      this.audit.report("session_abandoned", { sessionId: record.id, waitedMs: String(waitedMs) });
      abandoned.push(record.id);
    }

    for (const [id, session] of this.live) {
      if (!isWaitingStatus(session.record.status)) {
        continue;
      }

      if (now - Date.parse(session.record.updatedAt) < maxWaitMs) {
        continue;
      }

      // Captured before setStatus, which stamps updatedAt with *now*: computing it afterwards audited
      // every abandonment as having waited about zero, which is the one number the record exists for.
      const waitedMs = now - Date.parse(session.record.updatedAt);
      const run = session.run;
      session.run = null;
      session.pendingApprovals.clear();
      session.pendingQuestions.clear();
      session.mcpAppIds = [];
      this.proxy?.unregister(id);
      if (run) {
        // Released before the status flips, so nothing can answer an approval into a run that is
        // already being torn down.
        await run.stop().catch(() => undefined);
      }

      await this.setStatus(id, "abandoned");
      this.audit.report("session_abandoned", { sessionId: id, waitedMs: String(waitedMs) });
      abandoned.push(id);
    }

    return abandoned;
  }

  private async setStatus(id: string, status: SessionStatus): Promise<void> {
    const session = this.live.get(id);
    if (!session || session.record.status === status) {
      return;
    }

    session.record.status = status;
    session.record.updatedAt = new Date().toISOString();
    await this.store.saveRecord(session.record);

    // Announced on *entering* the state, which this method already guarantees: it returns early when
    // the status has not changed, so a session that is asked about repeatedly does not re-announce.
    // Nothing is published on resolution — an inbox row that appears and disappears on its own is
    // one the operator learns to distrust; the state the UI reads is cleared instead.
    if (isWaitingStatus(status)) {
      this.notifier?.waiting(id, status, session.record.createdBy ?? null);
    }
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
