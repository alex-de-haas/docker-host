import { UsageReader, absentUsage, codexUsage } from "./provider-usage.js";
import { cleanAgentEnvironment } from "../connections/codex-login.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { toCodexMcpConfig } from "./codex-mcp.js";
import { codexContextUsage } from "./context-usage.js";
import { toolResult, shouldRetainToolOutput } from "./tool-result.js";
import { randomUUID } from "node:crypto";
import { codexPredictionSupport } from "./prediction-support.js";
import { suggestionText } from "./prompt-suggestion.js";
import { codexCommandResult, commandToolUseId } from "./command-result.js";
import { ActivityTracker, activeTool } from "./activity.js";
import path from "node:path";
import type {
  HarnessAdapter,
  HarnessAvailability,
  HarnessCapabilities,
  HarnessEvent,
  HarnessRun,
  HarnessStartOptions,
} from "./adapter.js";
import {
  APPROVAL_METHODS,
  APPROVAL_POLICY,
  approvalDecision,
  CODEX_METHODS,
  describeApproval,
  type JsonRpcMessage,
} from "./codex-protocol.js";
import { isNodeEntry, resolveCodexCommand } from "./codex-binary.js";
import { authMode, ensureCodexAuth, type CodexAuthConfig } from "./codex-auth.js";

// Second harness adapter (spike outcome 2026-08-09, docs/features/ai-gateway/plan.md): OpenAI Codex
// CLI driven over `codex app-server` stdio JSON-RPC. Approvals arrive as server→client *requests*
// with an id and block until answered — the same pause the Claude adapter gets from canUseTool.
//
// Fail-closed by decision: every approval request the server raises becomes a Hosty approval card;
// nothing is auto-allowed on Codex's behalf, and "approved_for_session" is never sent.

// The pinned dependency's JS entry must run under node; a bare binary (PATH install, or the test
// stand-in with its own shebang) is spawned directly.
function spawnTarget(args: string[]): { command: string; args: string[] } {
  const resolved = resolveCodexCommand();
  return isNodeEntry(resolved)
    ? { command: process.execPath, args: [resolved, ...args] }
    : { command: resolved, args };
}

export class CodexHarnessAdapter implements HarnessAdapter {
  readonly name = "codex-app-server";
  // No questions: the mechanism exists but is experimental, off by default, and its shape is only
  // inferable from binary symbols — see REQUEST_USER_INPUT_METHOD in codex-protocol.ts. No live
  // mid-turn reconfiguration either: the wrapper prepares a resumed process between turns.
  // autoAllow is false because nothing here consults the gateway's predicate: Codex raises approvals
  // by its own sandbox rules (below), and an app tool call never passes through this adapter's hands.
  // denyReason is false because the current `item/*` approval reply is a bare "decline" — only the
  // legacy methods carry a rejection text — and a capability that held for some requests and not
  // others would have the card promising delivery it cannot keep.
  readonly capabilities: HarnessCapabilities = {
    // Protocol integration exists; actual availability is learned from a native response.
    promptSuggestions: true,
    usage: { snapshots: true, events: true, kinds: ["quota", "credits"] },
    questions: false,
    appMcp: true,
    liveReconfigure: false,
    autoAllow: false,
    denyReason: false,
  };

  constructor(private readonly auth: CodexAuthConfig) {}

  async probe(): Promise<HarnessAvailability> {
    const probe = await runCodex(["--version"], {}, this.auth.isolated).catch((error: Error) => error);
    if (probe instanceof Error) {
      return {
        available: false,
        reason: `The Codex CLI could not be started (${probe.message}). Install it on the host or set HOSTY_HARNESS_CODEX_COMMAND to its path.`,
      };
    }

    // In API-key mode this also performs (or refreshes) the login, so an operator who pastes a key
    // into app settings is signed in by the next health check without touching the host.
    const resolution = await ensureCodexAuth(this.auth);
    if (resolution.error) {
      return { available: false, reason: resolution.error };
    }

    const status = await runCodex(["login", "status"], resolution.env, this.auth.isolated).catch(() => null);
    if (status === null || /not logged in|no credentials/i.test(status)) {
      // A login run without the configured CODEX_HOME writes credentials into the default home,
      // where the harness never looks — so the suggested command carries the same directory the
      // probe reads from. Only in interactive mode: the key mode owns its home and signs itself in.
      const homePrefix = resolution.env.CODEX_HOME ? `CODEX_HOME=${resolution.env.CODEX_HOME} ` : "";
      return {
        available: false,
        // Codex accepts an API key only through `login --with-api-key` (over stdin), never from the
        // environment. The operator picks the mode, so the reason names both routes.
        reason:
          resolution.mode === "api-key"
            ? "The configured Codex API key did not produce a signed-in session. Check that the key is valid, or clear it to use an interactive `codex login` on the host instead."
            : `Codex is installed but not signed in. Either run \`${homePrefix}codex login\` on the host as the user Core runs as, or set a Codex API key in this app's settings and the gateway will sign in for you.`,
      };
    }

    return { available: true };
  }

  async readUsage() {
    if (this.auth.apiKey) return absentUsage("unsupported", "unsupported_auth");
    const { CodexLogin } = await import("../connections/codex-login.js");
    const client = new CodexLogin(this.auth.managedHome ?? this.auth.codexHome ?? path.join(this.auth.dataDir, "codex-home"));
    const reader = new UsageReader(async () => {
      await client.initialize();
      const account = await client.request("account/read", { refreshToken: false });
      if ((account.account as { type?: string } | null)?.type === "apiKey") return absentUsage("unsupported", "unsupported_auth");
      return codexUsage(await client.request("account/rateLimits/read", {}));
    });
    try { return await reader.refresh(); } finally { reader.close(); await client.closeAndWait(); }
  }

  async models(): Promise<import("../worker/contracts.js").ModelCatalog> {
    const { CodexLogin } = await import("../connections/codex-login.js");
    const { catalog, effortLabel } = await import("../worker/models.js");
    const health = await this.probe();
    if (!health.available) throw new Error(health.reason);
    const client = new CodexLogin(this.auth.managedHome ?? this.auth.codexHome ?? path.join(this.auth.dataDir, "codex-home"));
    try {
      await client.initialize();
      const models: import("../worker/contracts.js").ModelChoice[] = [];
      let cursor: string | undefined, defaultModel: string | undefined;
      do {
        const page = await client.request("model/list", { cursor, limit: 100, includeHidden: false });
        if (!Array.isArray(page.data)) throw new Error("Codex returned an invalid model catalog.");
        for (const m of page.data) {
          if (typeof m.model !== "string" || !Array.isArray(m.supportedReasoningEfforts)) continue;
          models.push({ id: m.model, label: m.displayName ?? m.model, defaultEffort: m.defaultReasoningEffort,
            efforts: m.supportedReasoningEfforts.map((e: { reasoningEffort: string }) => ({ id: e.reasoningEffort, label: effortLabel(e.reasoningEffort) })) });
          if (m.isDefault) defaultModel = m.model;
        }
        cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
        if (models.length > 1000) throw new Error("Model catalog exceeds its limit.");
      } while (cursor);
      return catalog(models, defaultModel);
    } finally { client.close(); }
  }

  start(options: HarnessStartOptions): HarnessRun {
    return new ReconfigurableCodexRun(options, this.auth);
  }
}

/** Prepare a resumed process before replacing the idle one. A failed resume leaves the old run alive. */
class ReconfigurableCodexRun implements HarnessRun {
  private active: CodexRun;
  private stopped = false;
  private replacing = false;
  constructor(private readonly options: HarnessStartOptions, private readonly auth: CodexAuthConfig) {
    this.active = new CodexRun(options, auth);
  }
  readUsage() { return this.active.readUsage(); }
  send(text: string): void { this.active.send(text); }
  resolveApproval(id: string, decision: "allow" | "deny", message?: string): boolean { return this.active.resolveApproval(id, decision, message); }
  resolveQuestion(): boolean { return false; }
  interrupt(): Promise<void> { return this.active.interrupt(); }
  async disableSuggestions(): Promise<void> { this.options.promptSuggestions = false; await this.active.disableSuggestions(); }
  async stop(): Promise<void> { this.stopped = true; await this.active.stop(); }
  async stopAndWait(): Promise<void> { this.stopped = true; await this.active.stopAndWait(); }
  async setMcpServers(servers: Record<string, unknown>): Promise<boolean> {
    if (this.stopped || this.replacing || !this.active.resumableThread) return false;
    this.replacing = true;
    const buffered: HarnessEvent[] = [];
    let committed = false;
    const candidate = new CodexRun({ ...this.options, systemPrompt: undefined,
      resumeHarnessSessionId: this.active.resumableThread, mcpServers: servers,
      onEvent: event => { if (committed) this.options.onEvent(event); else buffered.push(event); },
    }, this.auth, true);
    try {
      await candidate.waitUntilReady();
      if (this.stopped || !this.active.resumableThread || !candidate.resumableThread) return false;
      await this.active.stop();
      this.active = candidate;
      committed = true;
      for (const event of buffered) this.options.onEvent(event);
      return true;
    } catch { return false; }
    finally { if (!committed) await candidate.stop(); this.replacing = false; }
  }
}

interface PendingApproval {
  requestId: number | string;
  /** Protocol item this approval guards, so a refused item is never reported as executed. */
  itemId: string | null;
  /** The method that asked, which decides the decision vocabulary of the reply. */
  method: string;
}

class CodexRun implements HarnessRun {
  private readonly usageReader = new UsageReader(async () => this.auth.apiKey ? absentUsage("unsupported", "unsupported_auth")
    : codexUsage(await this.request("account/rateLimits/read", {})));
  readUsage() { return this.usageReader.refresh(); }
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pendingRequests = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly approvals = new Map<string, PendingApproval>();
  // Items whose approval the operator refused. Codex still emits item/completed for them, so
  // without this the transcript would claim a refused command ran.
  private readonly deniedItems = new Set<string>();
  private readonly mcpStartupFailures = new Map<string, string>();
  private readonly queue: string[] = [];
  private nextId = 1;
  private buffer = "";
  private threadId: string | null = null;
  private ready: Promise<void>;
  private turnActive = false;
  private predictionTurn: string | null = null;
  private predictionRuntime: string | null = null;
  private predictedTurns = new Set<string>();
  private activityTurnId: string | null = null;
  private readonly commandRun = randomUUID();
  private commandTurn = 0;
  private readonly commandCalls = new Map<string, { id: string; turnId: string }>();
  private readonly completedCommandCalls = new Set<string>();
  private readonly completedToolCalls = new Set<string>();
  // File-change approval requests contain IDs, while item/started carries the proposed patch.
  // Keep only bounded proposals for this exact active turn, then consume them before persistence.
  private readonly fileChangeProposals = new Map<string, { threadId: string; turnId: string; changes: unknown[]; bytes: number }>();
  private fileChangeProposalBytes = 0;
  private readonly closedFileChangeItems = new Set<string>();
  private readonly activity = new ActivityTracker(activity => this.emit({ type: "activity", activity }));
  private stopped = false;
  private failed = false;
  /** The operator prompt rides on the first message only; later turns must not repeat it. */
  private systemPromptSent = false;

  constructor(
    private readonly options: HarnessStartOptions,
    private readonly auth: CodexAuthConfig,
    private readonly strictResume = false,
  ) {
    // Resolved synchronously from the mode: the login itself already happened during probe, and a
    // session must not wait on it. In interactive mode this is the operator's own home.
    const env = authMode(auth) === "api-key"
      ? { CODEX_HOME: auth.managedHome ?? path.join(auth.dataDir, "codex-home") }
      : auth.codexHome?.trim()
        ? { CODEX_HOME: auth.codexHome.trim() }
        : {};
    // App MCP is configured at spawn time because that is the only door Codex offers: `-c`
    // overrides layered on top of whatever config it would otherwise load, with the bearer read from
    // the environment. Nothing is written to the operator's ~/.codex — these servers belong to one
    // session of one gateway, not to the machine.
    const mcp = toCodexMcpConfig(options.mcpServers);
    const providerArgs = ["app-server", ...(auth.managedHome ? ["-c", 'cli_auth_credentials_store="file"'] : []), ...mcp.args];
    const target = spawnTarget(providerArgs);
    const spawnOptions = {
      stdio: ["pipe", "pipe", "pipe"] as const,
      cwd: options.cwd,
      env: { ...(auth.isolated ? cleanAgentEnvironment() : process.env), ...env, ...mcp.env, ...(options.nativeHome ? { HOME: options.nativeHome } : {}) },
    };
    this.child = options.processTransport
      ? options.processTransport.spawn("codex", providerArgs, spawnOptions)
      : spawn(target.command, target.args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => {});
    this.child.on("error", () => {
      this.failed = true;
      this.clearFileChangeProposals();
      for (const pending of this.pendingRequests.values()) pending.reject(new Error("Codex process could not start."));
      this.pendingRequests.clear();
      if (!this.stopped) this.emit({ type: "error", message: "Codex process could not start." });
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      // Codex logs routine startup noise (MCP status, OAuth refreshes) to stderr; only surface a
      // hard failure, which arrives as the process exiting.
      if (text && !auth.isolated) {
        console.warn(`[codex] ${text.slice(0, 400)}`);
      }
    });
    this.child.on("exit", (code) => {
      this.failed = true;
      this.clearFileChangeProposals();
      if (!this.stopped) {
        this.emit({ type: "error", message: `The Codex app-server exited unexpectedly (code ${code ?? "unknown"}).` });
      }
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error("codex app-server exited"));
      }
      this.pendingRequests.clear();
    });
    this.ready = this.handshake();
    // Stop can race initialization before send() attaches its own failure handler.
    void this.ready.catch(() => {});
  }

  get resumableThread(): string | null { return !this.turnActive && !this.stopped && !this.failed ? this.threadId : null; }
  async waitUntilReady(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.ready, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Codex resume timed out")), 15_000);
      })]);
    } finally { clearTimeout(timer); }
  }

  send(text: string): void {
    // Codex's app-server protocol exposes no instruction channel the gateway can set per session, so
    // the operator prompt rides in once as a header on the first message — the same shape the panel
    // already uses for page context. Additive by construction: it prepends, and Codex's own
    // instruction sources are untouched.
    const prompt = this.options.systemPrompt?.trim();
    if (prompt && !this.systemPromptSent) {
      this.systemPromptSent = true;
      this.queue.push(`[Hosty operator instructions]\n${prompt}\n\n${text}`);
    } else {
      this.queue.push(text);
    }
    void this.pump();
  }

  resolveApproval(approvalId: string, decision: "allow" | "deny", message?: string): boolean {
    const pending = this.approvals.get(approvalId);
    if (!pending) {
      return false;
    }

    this.approvals.delete(approvalId);
    if (decision === "deny" && pending.itemId) {
      this.deniedItems.add(pending.itemId);
      this.activity.finish(pending.itemId);
    }
    this.respond(pending.requestId, {
      decision: approvalDecision(
        pending.method,
        decision,
        message ??
          "The Hosty operator refused this action. Do not attempt it another way; explain what you would have done instead.",
      ),
    });
    return true;
  }

  // Never any pending question: this adapter reports questions: false, so the manager will not route
  // one here. Present because the contract requires it, and returning false is the correct answer.
  resolveQuestion(): boolean {
    return false;
  }

  // The wrapper replaces idle processes and resumes their threads. A single process still takes
  // providers at spawn time: Codex takes its MCP servers
  // from configuration read at startup and exposes no method to change them afterwards. So this
  // returns false here; the wrapper handles configuration changes by preparing a resumed process.
  async setMcpServers(): Promise<boolean> {
    return false;
  }

  async interrupt(): Promise<void> {
    if (this.threadId) {
      await this.request(CODEX_METHODS.turnInterrupt, { threadId: this.threadId }).catch(() => undefined);
    }
  }

  async disableSuggestions(): Promise<void> { this.options.promptSuggestions = false; this.predictionTurn = null; }

  async stopAndWait(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.child.off("exit", done); resolve(); };
      const timer = setTimeout(() => { this.child.off("exit", done); reject(new Error("Codex process exit was not confirmed. Source lease remains held.")); }, 10_000);
      this.child.once("exit", done);
      void this.stop().catch(error => { clearTimeout(timer); this.child.off("exit", done); reject(error); });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Release anything the harness is blocked on before tearing the process down, or the child
    // can sit forever waiting for an approval reply that will never come.
    for (const [, pending] of this.approvals) {
      this.respond(pending.requestId, {
        decision: approvalDecision(pending.method, "deny", "The session was stopped."),
      });
    }
    this.approvals.clear();
    this.clearFileChangeProposals();
    this.usageReader.close();
    this.child.kill("SIGTERM");
  }

  private selectedModel: string | null = null;
  private selectedEffort: string | null = null;
  private async handshake(): Promise<void> {
    const initialized = await this.request(CODEX_METHODS.initialize, {
      clientInfo: { name: "hosty-harness", version: "1" },
      capabilities: this.options.promptSuggestions ? { experimentalApi: true } : null,
    });
    this.predictionRuntime = codexPredictionSupport.key(resolveCodexCommand(), (initialized as { userAgent?: unknown })?.userAgent);
    this.notify(CODEX_METHODS.initialized, {});
    void this.readUsage().then(usage => { if (!this.stopped) this.emit({ type: "provider_usage", usage }); });
    this.selectedModel = this.options.model ?? null;
    this.selectedEffort = this.options.reasoningEffort ?? null;
    // Null turn overrides keep a resumed thread's old values. Resolve native defaults explicitly
    // before resume so selecting Default really clears the preceding turn's explicit selection.
    if (this.options.model === null || this.options.reasoningEffort === null) {
      const configured = await this.request("config/read", { includeLayers: false }) as { config: { model?: string; model_reasoning_effort?: string } };
      const available: Array<{ model: string; isDefault: boolean; defaultReasoningEffort?: string }> = [];
      let cursor: string | null = null;
      do {
        const page = await this.request("model/list", { cursor, limit: 100, includeHidden: false }) as { data: typeof available; nextCursor?: string };
        if (!Array.isArray(page.data) || available.length + page.data.length > 1000) throw new Error("Invalid native model catalog.");
        available.push(...page.data); cursor = page.nextCursor ?? null;
      } while (cursor);
      this.selectedModel ??= configured.config?.model ?? available.find(model => model.isDefault)?.model ?? null;
      const model = available.find(model => model.model === this.selectedModel);
      this.selectedEffort ??= (this.options.model === null ? configured.config?.model_reasoning_effort : null) ?? model?.defaultReasoningEffort ?? null;
      if (!this.selectedModel) throw new Error("Codex did not report its default model; select a model explicitly.");
    }

    if (this.options.resumeHarnessSessionId) {
      const resumed = (await this.request(CODEX_METHODS.threadResume, {
        threadId: this.options.resumeHarnessSessionId,
        cwd: this.options.cwd,
        model: this.selectedModel,
        ...(this.selectedEffort ? { config: { model_reasoning_effort: this.selectedEffort } } : {}),
        sandbox: this.options.autonomy === "autonomous" ? "danger-full-access" : "read-only",
        approvalPolicy: this.options.autonomy === "autonomous" ? "never" : APPROVAL_POLICY,
      }).catch((error) => { if (this.auth.isolated || this.strictResume) throw new Error("The native session could not be resumed. Start a new chat; existing history is preserved."); return null; })) as { thread?: { id?: string } } | null;
      if (resumed && resumed.thread?.id !== this.options.resumeHarnessSessionId)
        throw new Error("Codex did not resume the requested thread.");
      if (resumed) {
        this.reportSelection(resumed);
        this.threadId = resumed.thread?.id ?? this.options.resumeHarnessSessionId;
      }
    }

    if (!this.threadId) {
      const started = (await this.request(CODEX_METHODS.threadStart, {
        cwd: this.options.cwd,
        model: this.selectedModel,
        ...(this.selectedEffort ? { config: { model_reasoning_effort: this.selectedEffort } } : {}),
        // Apply explicit chat policy on both initial start and every turn, including resumed threads.
        sandbox: this.options.autonomy === "autonomous" ? "danger-full-access" : "read-only",
        approvalPolicy: this.options.autonomy === "autonomous" ? "never" : APPROVAL_POLICY,
      })) as { threadId?: string; thread?: { id?: string } };
      this.reportSelection(started);
      this.threadId = started.threadId ?? started.thread?.id ?? null;
    }

    if (this.threadId) {
      this.emit({ type: "harness_session", harnessSessionId: this.threadId });
    }
  }

  private reportSelection(value: object): void {
    const reported = value as { model?: string; reasoningEffort?: string };
    if (typeof reported.model !== "string") return;
    this.emit({ type: "execution_model", requested: { model: this.options.model ?? null, reasoningEffort: this.options.reasoningEffort ?? null },
      reported: { model: reported.model, reasoningEffort: reported.reasoningEffort ?? null } });
    if (this.options.model && reported.model !== this.options.model)
      this.emit({ type: "notice", message: `Codex selected ${reported.model} instead of requested ${this.options.model}.` });
  }

  /** One turn at a time: Codex rejects a second turn/start while one is running. */
  private async pump(): Promise<void> {
    if (this.turnActive || this.stopped) {
      return;
    }
    const text = this.queue.shift();
    if (text === undefined) {
      return;
    }

    this.turnActive = true;
    this.commandTurn++;
    this.commandCalls.clear(); this.completedCommandCalls.clear(); this.completedToolCalls.clear();
    this.clearFileChangeProposals();
    this.activityTurnId = null;
    this.activity.reset();
    try {
      await this.ready;
      if (!this.threadId) {
        throw new Error("Codex did not return a thread id.");
      }
      const started = await this.request(CODEX_METHODS.turnStart, {
        threadId: this.threadId,
        input: [{ type: "text", text }],
        model: this.selectedModel,
        effort: this.selectedEffort,
        approvalPolicy: this.options.autonomy === "autonomous" ? "never" : APPROVAL_POLICY,
        // The managed transport already isolates the process in Docker. Starting another Linux
        // namespace sandbox there fails under Docker's restricted capabilities. Keep the chat's
        // approval policy, and tell Codex which boundary actually owns filesystem/network access.
        sandboxPolicy: this.options.processTransport
          ? { type: "externalSandbox", networkAccess: "enabled" }
          : { type: this.options.autonomy === "autonomous" ? "dangerFullAccess" : "readOnly" },
      }) as { turn?: { id?: string } };
      if (this.turnActive && !this.activityTurnId) this.activityTurnId = started.turn?.id ?? null;
    } catch (error) {
      this.turnActive = false;
      this.clearFileChangeProposals();
      if (!this.stopped) {
        this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // turnActive is cleared by the turn/completed notification, which also drives the next pump.
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString();
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      try {
        this.dispatch(JSON.parse(line) as JsonRpcMessage);
      } catch {
        // A non-JSON line is log noise on stdout; ignore it rather than killing the session.
      }
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    // Response to one of our requests.
    if (message.id !== undefined && !message.method && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(Object.assign(new Error(message.error.message ?? "Codex returned an error."), { code: message.error.code }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Server→client request. Approvals block until answered; anything else gets a minimal reply so
    // the harness never wedges on an unimplemented capability.
    if (message.id !== undefined && message.method) {
      if (APPROVAL_METHODS.has(message.method)) {
        const approvalId = randomUUID();
        const params = message.params ?? {};
        this.approvals.set(approvalId, {
          requestId: message.id,
          itemId: typeof params.itemId === "string" ? params.itemId : null,
          method: message.method,
        });
        const proposal = message.method === "item/fileChange/requestApproval" ? this.takeFileChangeProposal(params) : undefined;
        const { toolName, input } = describeApproval(message.method, proposal && !Array.isArray(params.changes)
          ? { ...params, changes: proposal } : params);
        this.emit({
          type: "approval_request",
          approvalId,
          toolName,
          input,
          // Codex sends its own reason for needing to escalate; the card shows it where the Claude
          // side shows the SDK's decision reason.
          ...(typeof params.reason === "string" && params.reason ? { reason: params.reason } : {}),
        });
      } else {
        this.respond(message.id, {});
      }
      return;
    }

    if (!message.method) {
      return;
    }

    const params = message.params ?? {};
    if (message.method === "account/rateLimits/updated") {
      this.emit({ type: "provider_usage", usage: codexUsage(params, true) }); return;
    }
    if (message.method === "account/updated") {
      this.emit({ type: "provider_usage", usage: { ...absentUsage(), invalidated: true } }); return;
    }
    if (typeof params.threadId === "string" && this.threadId && params.threadId !== this.threadId) return;
    if (message.method === "model/rerouted") {
      this.emit({ type: "notice", message: `Codex reported a model change: ${String(params.fromModel ?? "unknown")} → ${String(params.toModel ?? "unknown")}.` });
      return;
    }
    if (message.method === "turn/started") {
      const turn = params.turn as { id?: string } | undefined;
      if (this.turnActive && (!this.activityTurnId || this.activityTurnId === turn?.id)) this.activityTurnId = turn?.id ?? null;
      return;
    }
    if (typeof params.turnId === "string" && this.activityTurnId && params.turnId !== this.activityTurnId) return;
    if (message.method === "thread/tokenUsage/updated") {
      this.emit({ type: "context_usage", usage: codexContextUsage(params.tokenUsage) });
      return;
    }
    if (message.method === "thread/compacted" || (message.method === "item/completed"
      && (params.item as { type?: string } | undefined)?.type === "contextCompaction")) {
      this.emit({ type: "context_usage", usage: null });
    }
    // Item lifecycle shapes are verified from the installed app-server's generated v2 types.
    if (message.method === "item/started") {
      const item = (params.item ?? {}) as Record<string, unknown>;
      if (!this.turnActive || typeof item.id !== "string" || this.deniedItems.has(item.id)) return;
      if (item.type === "fileChange") this.rememberFileChangeProposal(params, item);
      if (item.type === "commandExecution" && item.status === "inProgress" && params.threadId === this.threadId &&
          typeof params.turnId === "string" && params.turnId === this.activityTurnId && this.commandCalls.size < 2048 &&
          !this.commandCalls.has(item.id) && !this.completedCommandCalls.has(item.id)) {
        const id = commandToolUseId(this.commandRun, this.commandTurn, item.id, params.turnId);
        if (id) this.commandCalls.set(item.id, { id, turnId: params.turnId });
      }
      if (item.type === "reasoning") this.activity.phase(item.id, "thinking");
      else if (item.type === "mcpToolCall" && item.status === "inProgress") {
        const server = String(item.server ?? "App"), tool = String(item.tool ?? "Tool");
        this.activity.start(item.id, activeTool(`mcp__${server}__${tool}`, undefined, { server, tool }));
      } else if (["commandExecution", "fileChange", "dynamicToolCall"].includes(String(item.type)) && item.status === "inProgress") {
        const name = item.type === "commandExecution" ? "Command" : item.type === "fileChange" ? "FileChange" : String(item.tool ?? "Tool");
        this.activity.start(item.id, activeTool(name));
      } else if (item.type === "webSearch") this.activity.start(item.id, activeTool("WebSearch"));
      return;
    }
    // Codex reports each configured MCP server's startup, which is the only signal that a provider
    // the operator enabled did not actually come up. Verified on 0.147.0 (2026-08-19): `starting`
    // then `ready` for a reachable server.
    //
    // Anything that is neither is treated as a failure rather than matching a specific status name —
    // the failure names are not part of any contract this adapter can see, and guessing at Codex's
    // vocabulary is what has bitten it before. Reporting one status too many is a visible message;
    // missing the real one leaves an app silently toolless.
    if (message.method === "mcpServer/startupStatus/updated") {
      const params = message.params as { name?: unknown; status?: unknown; error?: unknown; failureReason?: unknown } | undefined;
      const status = typeof params?.status === "string" ? params.status : "";
      const name = typeof params?.name === "string" ? params.name : "an app";
      if (status === "ready") this.mcpStartupFailures.delete(name);
      if (status && status !== "starting" && status !== "ready") {
        const reason = typeof params?.failureReason === "string" && params.failureReason
          ? params.failureReason
          : typeof params?.error === "string" && params.error
            ? params.error
            : status;
        // Repeated startup attempts can report the same unavailable provider. Keep one notice
        // until it recovers or the reason changes; a new process has its own startup state.
        if (this.mcpStartupFailures.get(name) === reason) return;
        this.mcpStartupFailures.set(name, reason);
        // A notice, not an error: this provider is optional, and the session keeps whatever else
        // started. Reporting it as an error would drop the run and fail the session over one app.
        this.emit({ type: "notice", message: `MCP server "${name}" did not start (${reason}). Its tools are unavailable for this session.` });
      }
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      if (!this.turnActive) return;
      this.activity.phase(String(params.itemId ?? "response"), "responding");
      this.emit({ type: "assistant_delta", text: String(params.delta ?? "") });
      return;
    }

    if (message.method === "item/completed") {
      const item = (params.item ?? {}) as Record<string, unknown>;
      if (!this.turnActive) return;
      this.activity.finish(String(item.id ?? "response"));
      this.activity.finish("response");
      const type = String(item.type ?? "");
      if (type === "fileChange" && params.threadId === this.threadId && params.turnId === this.activityTurnId && typeof item.id === "string")
        this.closeFileChangeProposal(item.id);
      const scopedTool = (type === "mcpToolCall" || type === "dynamicToolCall")
        && params.threadId === this.threadId && typeof params.turnId === "string"
        && params.turnId === this.activityTurnId && typeof item.id === "string";
      if (type === "mcpToolCall" || type === "dynamicToolCall") {
        const id = typeof item.id === "string" ? item.id : null;
        if (id && this.deniedItems.has(id)) {
          this.deniedItems.delete(id);
          if (this.completedToolCalls.size < 2048) this.completedToolCalls.add(id);
          return;
        }
        if (id && this.completedToolCalls.has(id)) return;
      }
      const toolUseId = scopedTool && this.completedToolCalls.size < 2048
        ? commandToolUseId(this.commandRun, this.commandTurn, item.id, params.turnId as string) : undefined;
      if (toolUseId) this.completedToolCalls.add(item.id as string);
      if (type === "agentMessage") {
        const text = readItemText(item);
        if (text) {
          this.emit({ type: "assistant_text", text });
        }
      } else if (type === "mcpToolCall") {
        // Match Claude's MCP naming so the shared transcript resolves the server's display name.
        // Emit only on completion: item/started describes the same call and would duplicate it.
        const server = String(item.server ?? "unknown");
        const tool = String(item.tool ?? "unknown");
        this.emit({
          type: "tool_use",
          ...(toolUseId ? { toolUseId } : {}),
          toolName: `mcp__${server}__${tool}`,
          input: item.arguments,
          // Either name can contain __, so retain the boundary instead of reparsing the alias.
          mcp: { server, tool },
        });
        if (toolUseId && shouldRetainToolOutput(`mcp__${server}__${tool}`)) {
          const result = item.result && typeof item.result === "object" && !Array.isArray(item.result) ? item.result as Record<string, unknown> : {};
          const error = item.error && typeof item.error === "object" ? item.error as Record<string, unknown> : {};
          const hasResult = Array.isArray(result.content) || result.structuredContent !== undefined && result.structuredContent !== null;
          const status = item.status === "failed" || typeof error.message === "string" ? "failed"
            : item.status === "completed" && hasResult ? "completed" : "unknown";
          // Project public tool content only. Provider _meta, app identity and configuration stay private.
          this.emit(toolResult(toolUseId, status, typeof error.message === "string" ? error.message
            : hasResult ? { content: result.content, structuredContent: result.structuredContent } : undefined, item.durationMs));
        }
      } else if (type === "dynamicToolCall") {
        const toolName = typeof item.namespace === "string" && item.namespace ? `${item.namespace}: ${String(item.tool ?? "Tool")}` : String(item.tool ?? "Tool");
        this.emit({ type: "tool_use", ...(toolUseId ? { toolUseId } : {}), toolName, input: item.arguments });
        if (toolUseId && shouldRetainToolOutput(toolName)) {
          const content = Array.isArray(item.contentItems) ? item.contentItems.map(value => {
            const block = value && typeof value === "object" ? value as Record<string, unknown> : {};
            return block.type === "inputText" ? { type: "text", text: block.text }
              : { type: block.type === "inputAudio" ? "audio" : "image" };
          }) : undefined;
          const status = item.status === "failed" || item.success === false ? "failed"
            : item.status === "completed" && item.success === true && content !== undefined ? "completed" : "unknown";
          this.emit(toolResult(toolUseId, status, content, item.durationMs));
        }
      } else if (type === "commandExecution" || type === "fileChange") {
        // Codex reports a refused item as completed too; reporting it as a tool use would tell the
        // operator their denial ran anyway.
        const itemId = typeof item.id === "string" ? item.id : null;
        if (itemId && this.deniedItems.has(itemId)) {
          this.deniedItems.delete(itemId);
          if (type === "commandExecution") {
            this.commandCalls.delete(itemId);
            if (this.completedCommandCalls.size < 2048) this.completedCommandCalls.add(itemId);
          }
          return;
        }
        if (type === "commandExecution" && itemId && this.completedCommandCalls.has(itemId)) return;
        if (type === "commandExecution" && item.status === "declined") {
          if (itemId) { this.commandCalls.delete(itemId); if (this.completedCommandCalls.size < 2048) this.completedCommandCalls.add(itemId); }
          return;
        }
        const command = type === "commandExecution" && itemId ? this.commandCalls.get(itemId) : undefined;
        const toolUseId = command && params.threadId === this.threadId && params.turnId === command.turnId ? command.id : undefined;
        if (type === "commandExecution" && itemId && this.completedCommandCalls.size < 2048) this.completedCommandCalls.add(itemId);
        if (itemId) this.commandCalls.delete(itemId);
        this.emit({
          type: "tool_use",
          ...(toolUseId ? { toolUseId } : {}),
          toolName: type === "commandExecution" ? "Command" : "FileChange",
          ...(type === "fileChange" ? { cwd: this.options.cwd } : {}),
          input: type === "commandExecution" ? { command: item.command ?? null } : { changes: item.changes ?? null },
        });
        if (toolUseId) {
          const result = codexCommandResult(toolUseId, item);
          if (result) this.emit(result);
          this.emit(toolResult(toolUseId, result?.status ?? "unknown", item.aggregatedOutput));
        }
      }
      return;
    }

    // The one authoritative turn outcome: Codex has no separate failure notification, and reports a
    // failed turn through this same message with `status: "failed"` and the reason on `turn.error`.
    // Read live on 0.150.1 (2026-09-07) by driving a turn with an empty CODEX_HOME, which fails on
    // auth; the turn status vocabulary is `inProgress | completed | failed | declined`, read out of
    // the binary's variant table.
    if (message.method === "thread/prediction/updated") {
      if (this.predictionTurn && params.threadId === this.threadId && params.sourceTurnId === this.predictionTurn) {
        this.predictionTurn = null;
        const result = params.result as { type?: string; text?: unknown } | undefined;
        this.emit({ type: "prompt_suggestion", text: result?.type === "completed" ? suggestionText(result.text) : null,
          ...(result?.type === "failed" ? { reason: "unavailable" as const } : {}) });
      }
      return;
    }
    if (message.method === "turn/completed") {
      const completedTurn = params.turn as { id?: string } | undefined;
      if (this.activityTurnId && completedTurn?.id && completedTurn.id !== this.activityTurnId) return;
      this.turnActive = false;
      this.commandCalls.clear();
      this.clearFileChangeProposals();
      this.activity.reset();
      const turn = params.turn as Record<string, unknown> | undefined;
      const usage = turn?.usage as Record<string, unknown> | undefined;
      const status = typeof turn?.status === "string" ? turn.status : "";
      const error = turn?.error as Record<string, unknown> | undefined;
      // Keyed on the error payload as much as the status name: a turn carrying an error did not
      // succeed whatever it is called, and a build that renames the status must not silently turn a
      // failure back into a success. An unrecognized status with no error stays a success, because
      // the alternative — failing every turn on a vocabulary change — is the worse way to be wrong.
      const failed = status === "failed" || status === "declined" || Boolean(error);
      if (failed) {
        const reason = typeof error?.message === "string" && error.message ? error.message : status || "no reason given";
        // A notice, not an error: the app-server survives a failed turn and accepts the next one
        // (verified 2026-09-07 — a second turn/start after a failure runs to its own turn/completed),
        // so dropping the run would discard a live session the operator can still use. This is also
        // what carries the reason: `result` has no message field, and the status alone would tell
        // the operator that something failed without ever saying what.
        this.emit({ type: "notice", message: `The Codex turn failed (${reason}).` });
      }
      this.emit({
        type: "result",
        status: failed ? "failed" : "success",
        usage: usage
          ? {
              inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : undefined,
              outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : undefined,
            }
          : undefined,
      });
      if (!failed && this.options.promptSuggestions && typeof completedTurn?.id === "string" && params.threadId === this.threadId && !this.predictedTurns.has(completedTurn.id)) {
        const turnId = this.predictionTurn = completedTurn.id;
        this.predictedTurns.add(turnId);
        if (!codexPredictionSupport.shouldRequest(this.predictionRuntime)) {
          this.predictionTurn = null;
          this.emit({ type: "prompt_suggestion", text: null, reason: "unsupported" });
        } else void this.request("thread/prediction/request", { threadId: this.threadId, sourceTurnId: turnId }).catch((error: Error) => {
          const unsupported = codexPredictionSupport.observeFailure(this.predictionRuntime, error);
          if (this.stopped || this.predictionTurn !== turnId) return;
          this.predictionTurn = null;
          this.emit({ type: "prompt_suggestion", text: null, reason: unsupported ? "unsupported" : "unavailable" });
        });
      }
      void this.pump();
      return;
    }

    // Codex's error notification is the bare method `error` — not `thread/error`, which exists in no
    // build (checked against 0.147.0, 0.150.1 and 0.153.2), and there is no `turn/failed` either.
    // Shape: { error: { message }, willRetry, threadId, turnId }.
    if (message.method === "error") {
      const error = params.error as Record<string, unknown> | undefined;
      // Retryable errors arrive in bursts — one per attempt, ten for a single failed turn — and
      // Codex either recovers or ends the turn with the final reason on turn/completed. Reporting
      // them would bury the operator in noise for a turn that may yet succeed.
      if (params.willRetry === true) {
        return;
      }
      // A terminal error inside a turn is left to turn/completed, which carries the same message and
      // is what ends the turn; emitting here too would report one failure twice. Outside a turn
      // nothing else will report it, so it is surfaced here or not at all.
      if (!this.turnActive) {
        const reason = typeof error?.message === "string" && error.message ? error.message : "no reason given";
        this.emit({ type: "notice", message: `Codex reported an error (${reason}).` });
      }
    }
  }

  private rememberFileChangeProposal(params: Record<string, unknown>, item: Record<string, unknown>): void {
    if (item.status !== "inProgress" || typeof item.id !== "string" || item.id.length > 256 || !Array.isArray(item.changes)
      || typeof params.threadId !== "string" || params.threadId !== this.threadId
      || typeof params.turnId !== "string" || params.turnId !== this.activityTurnId
      || this.closedFileChangeItems.has(item.id) || this.closedFileChangeItems.size >= 2048
      || this.fileChangeProposals.has(item.id) || this.fileChangeProposals.size >= 128) return;
    const bytes = Buffer.byteLength(JSON.stringify(item.changes));
    // Refuse excess proposals rather than truncating a patch or evicting an earlier pending item.
    if (bytes > 512 * 1024 - this.fileChangeProposalBytes) return;
    this.fileChangeProposals.set(item.id, { threadId: params.threadId, turnId: params.turnId, changes: item.changes, bytes });
    this.fileChangeProposalBytes += bytes;
  }

  private takeFileChangeProposal(params: Record<string, unknown>): unknown[] | undefined {
    if (!this.turnActive || typeof params.itemId !== "string"
      || typeof params.threadId !== "string" || params.threadId !== this.threadId
      || typeof params.turnId !== "string" || params.turnId !== this.activityTurnId) return undefined;
    const proposal = this.fileChangeProposals.get(params.itemId);
    if (!proposal || proposal.threadId !== params.threadId || proposal.turnId !== params.turnId) return undefined;
    this.closeFileChangeProposal(params.itemId);
    return proposal.changes;
  }

  private closeFileChangeProposal(itemId: string): void {
    // A duplicate item/started must not revive a completed or already-consumed proposal.
    if (itemId.length <= 256 && this.closedFileChangeItems.size < 2048) this.closedFileChangeItems.add(itemId);
    const proposal = this.fileChangeProposals.get(itemId);
    if (!proposal) return;
    this.fileChangeProposalBytes -= proposal.bytes;
    this.fileChangeProposals.delete(itemId);
  }

  private clearFileChangeProposals(): void {
    this.fileChangeProposals.clear();
    this.fileChangeProposalBytes = 0;
    this.closedFileChangeItems.clear();
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => this.pendingRequests.set(id, { resolve, reject }));
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: unknown): void {
    if (!this.child.stdin.destroyed) {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  }

  private emit(event: HarnessEvent): void {
    if (this.stopped) return;
    this.options.onEvent(event);
  }
}

function readItemText(item: Record<string, unknown>): string {
  if (typeof item.text === "string") {
    return item.text;
  }
  const content = item.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

function runCodex(args: string[], env: Record<string, string>, isolated = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const target = spawnTarget(args);
    const child = spawn(target.command, target.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...(isolated ? cleanAgentEnvironment() : process.env), ...env },
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", (error) => reject(error));
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(out.trim().slice(0, 200) || `exit ${code}`))));
    setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out"));
    }, 10_000).unref();
  });
}
