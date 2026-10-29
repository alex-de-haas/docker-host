import { UsageReader, absentUsage, claudeUsage, claudeLimitEvent } from "./provider-usage.js";
import { ContextUsageReader, claudeContextUsage } from "./context-usage.js";
import { toolResult, toolDuration, shouldRetainToolOutput } from "./tool-result.js";
import { randomUUID } from "node:crypto";
import { suggestionText } from "./prompt-suggestion.js";
import { claudeCommandResult, commandToolUseId, CommandCallHistory } from "./command-result.js";
import { ActivityTracker, activeTool, type ActiveTool } from "./activity.js";
import type {
  HarnessAdapter,
  HarnessAvailability,
  HarnessCapabilities,
  HarnessEvent,
  HarnessQuestion,
  HarnessRun,
  HarnessStartOptions,
} from "./adapter.js";

// First harness adapter (spike decision 2026-08-08, recorded in the plan): the Claude Agent SDK,
// pinned in package.json. It won all three criteria over driving `claude -p` by hand — the
// `canUseTool` callback is a native indefinite approval pause, `includePartialMessages` yields
// typed text deltas, and `resume` restores a session by id. The SDK spawns its bundled Claude Code
// binary; auth comes from the gateway environment (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN /
// provider env) — the SDK does not use an interactive `claude login` state.
//
// Normal preserves native approval prompts. Autonomous is an explicit operator choice for this
// conversation, with host-process access; Hosty MCP still passes through the separate policy broker.

const AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
];

// Read-only tools run without pausing; anything else (Write/Edit/Bash/mcp tools/...) asks.
//
// AskUserQuestion is deliberately absent: it is neither auto-allowed nor approval-gated but handled
// as its own branch below. Adding it here would remove the nonsensical "Approve AskUserQuestion?"
// card and leave the dead end intact, which is worse — the operator would lose even the signal that
// the assistant tried to ask something.
const AUTO_ALLOWED_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "Task"]);

const ASK_USER_QUESTION = "AskUserQuestion";

/**
 * The part of the SDK's third `canUseTool` argument the card can use. A structural subset rather
 * than the SDK's own type, because the query options are handed over untyped (see runLoop) and the
 * two fields read here are documented as optional on every version this adapter has run against.
 */
interface ApprovalContext {
  toolUseID?: string;
  title?: string;
  decisionReason?: string;
}

export class ClaudeHarnessAdapter implements HarnessAdapter {
  readonly name = "claude-agent-sdk";
  readonly capabilities: HarnessCapabilities = {
    promptSuggestions: true,
    usage: { snapshots: true, events: true, kinds: ["quota", "credits"] },
    questions: true,
    appMcp: true,
    liveReconfigure: true,
    autoAllow: true,
    denyReason: true,
  };

  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async probe(): Promise<HarnessAvailability> {
    if (!AUTH_ENV_KEYS.some((key) => this.environment[key]?.trim())) {
      return {
        available: false,
        reason:
          "No harness credentials: set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN / a provider CLAUDE_CODE_USE_* configuration) in the gateway environment.",
      };
    }

    try {
      await import("@anthropic-ai/claude-agent-sdk");
    } catch {
      return {
        available: false,
        reason: "The @anthropic-ai/claude-agent-sdk package failed to load; run the app setup (npm install).",
      };
    }

    return { available: true };
  }

  async readUsage() {
    if (!this.environment.CLAUDE_CODE_OAUTH_TOKEN) return absentUsage("unsupported", "unsupported_auth");
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const controller = new AbortController();
    const input = (async function* () { await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true })); })();
    const client = query({ prompt: input, options: { env: this.environment, settingSources: [], persistSession: false,
      abortController: controller, tools: [], mcpServers: {}, strictMcpConfig: true } });
    const reader = new UsageReader(async () => typeof client.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === "function"
      ? claudeUsage(await client.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }))
      : absentUsage("unsupported", "unsupported_sdk"));
    try { return await reader.refresh(); }
    finally { reader.close(); controller.abort(); client.close(); }
  }

  async models(): Promise<import("../worker/contracts.js").ModelCatalog> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { catalog, effortLabel } = await import("../worker/models.js");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const input = (async function* () { await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true })); })();
    const client = query({ prompt: input, options: { env: this.environment, settingSources: [], persistSession: false,
      abortController: controller, tools: [], mcpServers: {}, strictMcpConfig: true } });
    try {
      return catalog((await client.supportedModels()).map(m => ({ id: m.value, label: m.displayName,
        efforts: (m.supportedEffortLevels ?? []).map(id => ({ id, label: effortLabel(id) })) })));
    } finally { clearTimeout(timer); controller.abort(); client.close(); }
  }

  start(options: HarnessStartOptions): HarnessRun {
    return new ClaudeRun(options, this.environment);
  }
}

interface PendingApproval {
  toolName: string;
  toolUseId?: string;
  resolve: (response: unknown) => void;
}

interface PendingQuestion {
  /** The tool input as the model sent it; the answers are merged back into a copy of it. */
  input: Record<string, unknown>;
  resolve: (response: unknown) => void;
}

class ClaudeRun implements HarnessRun {
  private readonly input = new PushableStream<unknown>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private query: {
    interrupt(): Promise<unknown>;
    close(): void;
    setMcpServers?(servers: Record<string, unknown>): Promise<{ errors?: Record<string, string> }>;
    toggleMcpServer?(name: string, enabled: boolean): Promise<void>;
  } | null = null;
  private usageReader: UsageReader | null = null;
  async readUsage() { return this.usageReader?.refresh() ?? absentUsage(); }
  private contextReader: ContextUsageReader | null = null;
  private stopped = false;
  private turnActive = false;
  private suggestionPending = false;
  private nativeSessionId: string | null = null;
  private readonly commandRun = randomUUID();
  private commandTurn = 0;
  private readonly commandCalls = new Map<string, { id: string; rawId: string }>();
  private readonly toolCalls = new Map<string, { id: string; rawId: string; name: string; durationMs?: number; timingConflict?: boolean }>();
  private readonly commandHistory = new CommandCallHistory();
  private readonly deniedToolCalls = new Set<string>();
  private ambiguousCommandDenial = false;
  private ambiguousToolDenial = false;
  private readonly proposedTools = new Map<string, ActiveTool>();
  private readonly completedTools = new Set<string>();
  private readonly activity = new ActivityTracker(activity => {
    if (this.turnActive && !this.stopped) this.options.onEvent({ type: "activity", activity });
  });
  private serverNames: Set<string>;
  private readonly finished: Promise<void>;
  private readonly disabledServers = new Set<string>();

  constructor(private readonly options: HarnessStartOptions, private readonly environment: NodeJS.ProcessEnv) {
    this.serverNames = new Set(Object.keys(options.mcpServers ?? {}));
    this.finished = this.runLoop();
  }

  send(text: string): void {
    this.suggestionPending = false;
    this.turnActive = true;
    this.commandTurn++;
    this.commandCalls.clear();
    this.toolCalls.clear();
    this.deniedToolCalls.clear();
    this.ambiguousCommandDenial = false;
    this.ambiguousToolDenial = false;
    this.proposedTools.clear();
    this.activity.reset();
    this.input.push({ type: "user", message: { role: "user", content: text } });
  }

  resolveApproval(approvalId: string, decision: "allow" | "deny", message?: string): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      return false;
    }

    this.pending.delete(approvalId);
    if (decision === "deny") {
      if (pending.toolUseId && this.deniedToolCalls.size < 2048) this.deniedToolCalls.add(pending.toolUseId);
      else {
        this.ambiguousToolDenial = true;
        if (pending.toolName === "Bash") this.ambiguousCommandDenial = true;
      }
    }
    pending.resolve(
      decision === "allow"
        ? { behavior: "allow", updatedInput: undefined }
        : { behavior: "deny", message: message ?? "Denied by the operator in Hosty." },
    );
    return true;
  }

  // The answers travel back as `updatedInput.answers` on an *allow*, so the tool runs and returns
  // them to the model as an ordinary tool result. This is the SDK's designed path — the input type
  // carries an optional `answers` map documented as "User answers collected by the permission
  // component" — and it is why no workaround is needed: smuggling the answer through a deny message
  // would risk the model reading it as a refusal and looping back to "please clarify", which is
  // exactly the failure this replaces.
  resolveQuestion(questionId: string, answers: Record<string, string>): boolean {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      return false;
    }

    this.pendingQuestions.delete(questionId);
    pending.resolve({ behavior: "allow", updatedInput: { ...pending.input, answers } });
    return true;
  }

  // The SDK reconfigures a live session, which is why this harness reports liveReconfigure: true.
  // Tokens expire every five minutes, so this is the ordinary path rather than an exceptional one.
  async setMcpServers(servers: Record<string, unknown>): Promise<boolean> {
    const query = this.query;
    if (!query?.setMcpServers) {
      return false;
    }
    try {
      // Startup HTTP servers are retained by SDK setMcpServers. Disable omitted Hosty servers
      // explicitly; never touch servers supplied by operator settings or plugins.
      for (const name of this.serverNames) {
        if (!(name in servers)) {
          if (!query.toggleMcpServer) return false;
          await query.toggleMcpServer(name, false);
          this.disabledServers.add(name);
        }
      }
      const result = await query.setMcpServers(servers);
      if (Object.keys(result?.errors ?? {}).length > 0) return false;
      for (const name of Object.keys(servers)) {
        if (this.disabledServers.has(name)) {
          if (!query.toggleMcpServer) return false;
          await query.toggleMcpServer(name, true);
          this.disabledServers.delete(name);
        }
      }
      this.serverNames = new Set(Object.keys(servers));
      return true;
    } catch {
      return false;
    }
  }

  async interrupt(): Promise<void> {
    await this.query?.interrupt().catch(() => undefined);
  }

  async disableSuggestions(): Promise<void> { this.options.promptSuggestions = false; this.suggestionPending = false; }

  async stopAndWait(): Promise<void> {
    await this.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.finished, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Claude execution exit was not confirmed. Source lease remains held.")), 10_000);
    })]); } finally { clearTimeout(timer); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.usageReader?.close();
    this.contextReader?.close();
    // Unblock any approval or question the harness is still paused on, then tear the query down.
    for (const [, pending] of this.pending) {
      pending.resolve({ behavior: "deny", message: "Session stopped." });
    }
    this.pending.clear();
    for (const [, pending] of this.pendingQuestions) {
      pending.resolve({ behavior: "deny", message: "Session stopped." });
    }
    this.pendingQuestions.clear();
    this.input.end();
    await this.query?.interrupt().catch(() => undefined);
    this.query?.close();
  }

  private async runLoop(): Promise<void> {
    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      let releaseInput: () => void = () => {};
      const configured = new Promise<void>(resolve => { releaseInput = resolve; });
      const input = this.input;
      const prompt = (async function* () { await configured; for await (const message of input) yield message; })();
      const query = sdk.query({
        prompt: prompt as AsyncIterable<never>,
        options: {
          cwd: this.options.cwd,
          ...(this.options.model ? { model: this.options.model } : {}),
          ...(this.options.reasoningEffort ? { effort: this.options.reasoningEffort } : {}),
          ...(this.options.processTransport ? {
            pathToClaudeCodeExecutable: "/opt/hosty-worker/claude",
            spawnClaudeCodeProcess: (input: { args: string[]; cwd?: string; env: NodeJS.ProcessEnv }) =>
              this.options.processTransport!.spawn("claude", input.args, { cwd: input.cwd ?? this.options.cwd, env: input.env }),
          } : {}),
          resume: this.options.resumeHarnessSessionId,
          permissionMode: this.options.autonomy === "autonomous" ? "bypassPermissions" : "default",
          allowDangerouslySkipPermissions: this.options.autonomy === "autonomous",
          includePartialMessages: true,
          promptSuggestions: this.options.promptSuggestions === true,
          hooks: {
            PostToolUse: [{ hooks: [async (input: Record<string, unknown>) => this.recordToolDuration(input)] }],
            PostToolUseFailure: [{ hooks: [async (input: Record<string, unknown>) => this.recordToolDuration(input)] }],
          },
          // The preset is named explicitly rather than left to the SDK default, because the operator
          // profile is defined as behaving like the admin running Claude Code by hand — that is the
          // Claude Code prompt, and relying on a default to supply it would make the behavior depend
          // on an SDK decision we do not control. `append` is what keeps the operator's own text
          // additive: it never displaces the preset or the user/project sources below.
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            ...(this.options.systemPrompt ? { append: this.options.systemPrompt } : {}),
          },
          // Host operator context: the harness reads the operator's own user+project settings
          // (CLAUDE.md, skills), exactly like an admin running Claude Code by hand.
          settingSources: ["user", "project"],
          env: { ...this.environment, ...(this.options.nativeHome ? { HOME: this.options.nativeHome, CLAUDE_CONFIG_DIR: this.options.nativeHome } : {}) },
          ...(this.options.mcpServers ? { mcpServers: this.options.mcpServers } : {}),
          canUseTool: (toolName: string, input: Record<string, unknown>, context?: ApprovalContext) =>
            this.requestApproval(toolName, input, context),
        },
      } as never) as AsyncIterable<Record<string, never>> & { interrupt(): Promise<unknown>; close(): void;
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(options: { skipBehaviors: boolean }): Promise<unknown>;
        getContextUsage?(options: { detail: "summary" }): Promise<unknown>;
        applyFlagSettings(settings: { model: string | null; effortLevel: string | null }): Promise<unknown> };
      this.query = query;
      this.usageReader = new UsageReader(async () => this.environment.ANTHROPIC_API_KEY
        ? absentUsage("unsupported", "unsupported_auth")
        : typeof query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === "function"
          ? claudeUsage(await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }))
          : absentUsage("unsupported", "unsupported_sdk"));
      void this.readUsage().then(usage => { if (!this.stopped) this.options.onEvent({ type: "provider_usage", usage }); });
      if (query.getContextUsage) this.contextReader = new ContextUsageReader(
        async () => claudeContextUsage(await query.getContextUsage!({ detail: "summary" })),
        usage => this.options.onEvent({ type: "context_usage", usage }),
      );
      try {
        if (this.options.model !== undefined || this.options.reasoningEffort !== undefined)
          await query.applyFlagSettings({ model: this.options.model ?? null, effortLevel: this.options.reasoningEffort ?? null });
      } catch (error) { this.input.end(); query.close(); throw error; }
      finally { releaseInput(); }

      let lastMessageId: unknown;
      for await (const message of query) {
        const value = message as Record<string, unknown>;
        if (!value.parent_tool_use_id) {
          const id = (value.message as { id?: unknown } | undefined)?.id;
          const compacted = value.type === "system" && value.subtype === "compact_boundary";
          if (compacted) this.options.onEvent({ type: "context_usage", usage: null });
          if (value.type === "result") {
            // Worker teardown follows result immediately. Flush a bounded final measurement first.
            await this.contextReader?.refresh();
          } else if (compacted || value.type === "system" && value.subtype === "init"
            || value.type === "assistant" && (id === undefined || id !== lastMessageId)) {
            if (value.type === "assistant") lastMessageId = id;
            void this.contextReader?.refresh();
          }
        }
        if (value.type === "rate_limit_event") this.options.onEvent({ type: "provider_usage", usage: claudeLimitEvent(value.rate_limit_info) });
        if (value.type === "assistant" && value.usage_report) this.options.onEvent({ type: "provider_usage", usage: claudeUsage(value.usage_report) });
        if (value.type === "result") this.options.onEvent({ type: "provider_usage", usage: await this.readUsage() });
        this.dispatch(value);
      }
    } catch (error) {
      if (!this.stopped) {
        this.options.onEvent({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.usageReader?.close();
      this.contextReader?.close();
    }
  }

  private requestApproval(
    toolName: string,
    input: Record<string, unknown>,
    context?: ApprovalContext,
  ): Promise<unknown> {
    if (toolName === ASK_USER_QUESTION) {
      const questions = readQuestions(input);
      // A malformed question set is answered rather than parked: parking it would hang the run on a
      // card the UI cannot render, and the model can recover from being told the call was wrong.
      return questions.length === 0
        ? Promise.resolve({
            behavior: "deny",
            message: "AskUserQuestion was called with no usable questions; ask in plain text instead.",
          })
        : new Promise((resolve) => {
            const questionId = randomUUID();
            this.pendingQuestions.set(questionId, { input, resolve });
            this.options.onEvent({ type: "question_request", questionId, questions });
          });
    }

    // Two different grounds, kept apart on purpose. The set above is read-only because the gateway
    // KNOWS what those tools are; an app tool reaches the branch below only when the operator has
    // said they trust that app's own `readOnlyHint` declarations. Collapsing the two would quietly
    // turn "we verified this" into "someone told us".
    if (this.options.autonomy === "autonomous" || AUTO_ALLOWED_TOOLS.has(toolName) || this.options.isAutoAllowed?.(toolName) === true) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }

    return new Promise((resolve) => {
      const approvalId = randomUUID();
      this.pending.set(approvalId, { toolName, resolve, ...(context?.toolUseID ? { toolUseId: context.toolUseID } : {}) });
      this.options.onEvent({
        type: "approval_request",
        approvalId,
        toolName,
        input,
        // The SDK's own prompt sentence and its reason for raising the request, when it supplies
        // them — its documentation asks that the sentence be preferred over a reconstruction from
        // name and input. Spread conditionally so an absent value is absent, not a stored undefined.
        ...(context?.title ? { title: context.title } : {}),
        ...(context?.decisionReason ? { reason: context.decisionReason } : {}),
      });
    });
  }

  private recordToolDuration(input: Record<string, unknown>): Record<string, never> {
    const durationMs = toolDuration(input.duration_ms);
    if (!this.turnActive || this.stopped || durationMs === undefined || input.agent_id !== undefined) return {};
    // Subagent hook IDs do not identify the parent tool in the transcript; do not guess that join.
    const matches = [...this.toolCalls.values()].filter(tool => tool.rawId === input.tool_use_id && tool.name === input.tool_name);
    const main = this.toolCalls.get(JSON.stringify(["main", input.tool_use_id]));
    const tool = matches.length === 1 && matches[0] === main ? main : undefined;
    if (tool && !tool.timingConflict) {
      if (tool.durationMs !== undefined && tool.durationMs !== durationMs) {
        delete tool.durationMs;
        tool.timingConflict = true;
      } else tool.durationMs = durationMs;
    }
    return {};
  }

  private dispatch(message: Record<string, unknown>): void {
    if (this.stopped) return;
    const type = message.type;
    if (type === "prompt_suggestion") {
      if (this.suggestionPending && message.session_id === this.nativeSessionId) {
        this.suggestionPending = false;
        this.options.onEvent({ type: "prompt_suggestion", text: suggestionText(message.suggestion) });
      }
      return;
    }
    if (type === "tool_progress" && this.turnActive && typeof message.tool_use_id === "string") {
      if (this.completedTools.has(message.tool_use_id)) return;
      if (message.tool_name !== ASK_USER_QUESTION) {
        this.activity.start(message.tool_use_id, this.proposedTools.get(message.tool_use_id)
          ?? activeTool(String(message.tool_name ?? "Tool")));
      }
      return;
    }
    // User tool-result blocks, unlike assistant tool-use proposals, establish completion.
    if (type === "user") {
      const content = (message.message as { content?: unknown } | undefined)?.content;
      const resultBlocks = Array.isArray(content) ? content.filter(block => block && block.type === "tool_result") : [];
      if (Array.isArray(content)) for (const block of content) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const key = JSON.stringify([message.parent_tool_use_id ?? "main", block.tool_use_id]);
          const command = this.commandCalls.get(key);
          if (this.turnActive && !message.isReplay && command && !this.deniedToolCalls.has(command.rawId)) {
            const result = claudeCommandResult(command.id, block,
              !this.ambiguousCommandDenial && resultBlocks.length === 1 ? message.tool_use_result : undefined);
            if (result) this.options.onEvent(result);
          }
          const tool = this.toolCalls.get(key);
          if (this.turnActive && !message.isReplay && tool && !this.ambiguousToolDenial
              && !this.deniedToolCalls.has(tool.rawId) && shouldRetainToolOutput(tool.name)) {
            // Only the matched block is display content; the SDK's structured envelope can carry
            // private provider metadata and is ambiguous when several results share a message.
            const structured = resultBlocks.length === 1 && message.tool_use_result && typeof message.tool_use_result === "object"
              ? message.tool_use_result as Record<string, unknown> : {};
            const deferred = structured.detachedToolCall === true || structured.backgroundedByUser === true
              || typeof structured.backgroundTaskId === "string";
            const status = command
              ? claudeCommandResult(command.id, block, resultBlocks.length === 1 ? message.tool_use_result : undefined)?.status ?? "unknown"
              : block.is_error === true ? "failed" : deferred ? "unknown"
                : block.is_error === false || block.is_error === undefined ? "completed" : "unknown";
            this.options.onEvent(toolResult(tool.id, status, block.content, deferred ? undefined : tool.durationMs));
          }
          this.commandCalls.delete(key);
          this.toolCalls.delete(key);
          this.activity.finish(block.tool_use_id);
          this.proposedTools.delete(block.tool_use_id);
          this.completedTools.add(block.tool_use_id);
          // A late heartbeat must not revive a just-completed call, including on the next turn.
          if (this.completedTools.size > 2048) this.completedTools.delete(this.completedTools.values().next().value!);
        }
      }
      return;
    }
    if (type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
      this.nativeSessionId = message.session_id;
      if (this.options.resumeHarnessSessionId && message.session_id !== this.options.resumeHarnessSessionId) {
        this.options.onEvent({ type: "error", message: "Claude did not resume the requested native session; existing history is preserved." });
        void this.stop(); return;
      }
      if (typeof message.model === "string") {
        this.options.onEvent({ type: "execution_model", requested: { model: this.options.model ?? null, reasoningEffort: this.options.reasoningEffort ?? null },
          reported: { model: message.model, reasoningEffort: typeof message.effort === "string" ? message.effort : null } });
      }
      if (this.options.reasoningEffort && "effort" in message && message.effort !== this.options.reasoningEffort)
        this.options.onEvent({ type: "notice", message: `Claude applied ${String(message.effort ?? "no effort parameter")} instead of requested ${this.options.reasoningEffort}.` });
      this.options.onEvent({ type: "harness_session", harnessSessionId: message.session_id });
      return;
    }

    if (type === "stream_event") {
      const event = message.event as Record<string, unknown> | undefined;
      const delta = event?.delta as Record<string, unknown> | undefined;
      const block = event?.content_block as Record<string, unknown> | undefined;
      const activityId = `${String(message.parent_tool_use_id ?? "main")}:${String(event?.index ?? 0)}`;
      if (this.turnActive) {
        if ((event?.type === "content_block_start" && ["thinking", "redacted_thinking"].includes(String(block?.type))) || delta?.type === "thinking_delta") {
          this.activity.phase(activityId, "thinking");
        } else if (delta?.type === "text_delta") this.activity.phase(activityId, "responding");
        else if (event?.type === "content_block_stop") this.activity.finish(activityId);
      }
      if (event?.type === "content_block_delta" && delta?.type === "text_delta") {
        this.options.onEvent({ type: "assistant_delta", text: String(delta.text ?? "") });
      }
      return;
    }

    if (type === "assistant") {
      const content = (message.message as Record<string, unknown> | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === "text" && typeof block.text === "string" && block.text) {
            this.options.onEvent({ type: "assistant_text", text: block.text });
          } else if (block.type === "tool_use") {
            if (typeof block.id === "string") this.proposedTools.set(block.id, activeTool(String(block.name ?? "Tool"), block.input));
            // The question card is already the transcript record for an ask, so the raw tool_use
            // block would render a second, redundant entry carrying the same options as JSON.
            if (block.name === ASK_USER_QUESTION) {
              continue;
            }
            let toolUseId: string | undefined;
            if (this.turnActive && !message.isReplay) {
              const parent = typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : "main";
              const key = JSON.stringify([parent, block.id]);
              toolUseId = commandToolUseId(this.commandRun, this.commandTurn, block.id, parent);
              if (toolUseId && !this.commandHistory.seenOrRecord(key) && this.toolCalls.size < 2048) {
                this.toolCalls.set(key, { id: toolUseId, rawId: String(block.id), name: String(block.name ?? "unknown") });
                if (block.name === "Bash") this.commandCalls.set(key, { id: toolUseId, rawId: String(block.id) });
              } else toolUseId = undefined;
            }
            this.options.onEvent({
              type: "tool_use",
              ...(toolUseId ? { toolUseId } : {}),
              toolName: String(block.name ?? "unknown"),
              input: block.input,
              cwd: this.options.cwd,
            });
          }
        }
      }
      return;
    }

    if (type === "result") {
      this.suggestionPending = this.options.promptSuggestions === true && message.subtype === "success" && message.is_error !== true;
      this.activity.reset();
      this.turnActive = false;
      this.commandCalls.clear();
      this.toolCalls.clear();
      this.proposedTools.clear();
      const usage = message.usage as Record<string, unknown> | undefined;
      if (typeof message.session_id === "string") {
        this.options.onEvent({ type: "harness_session", harnessSessionId: message.session_id });
      }
      this.options.onEvent({
        type: "result",
        status: message.is_error === true ? "failed" : String(message.subtype ?? "success"),
        costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : undefined,
        usage: usage
          ? {
              inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
              outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
            }
          : undefined,
      });
    }
  }
}

// Narrows the model-supplied tool input to the question shape the gateway and Shell agree on.
// Validated rather than cast: the input is model output, so a missing options array or a
// non-string label is a live possibility, and a card built from it would break the panel for a
// pause nobody could then resolve.
function readQuestions(input: Record<string, unknown>): HarnessQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const questions: HarnessQuestion[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (typeof entry?.question !== "string" || !entry.question.trim()) {
      continue;
    }

    const options: HarnessQuestion["options"] = [];
    for (const option of (Array.isArray(entry.options) ? entry.options : []) as Array<Record<string, unknown>>) {
      if (typeof option?.label === "string" && option.label.trim()) {
        options.push({
          label: option.label,
          description: typeof option.description === "string" ? option.description : "",
          preview: typeof option.preview === "string" ? option.preview : undefined,
        });
      }
    }

    // An option-less question cannot be rendered as a choice; dropping it is better than showing a
    // card with nothing to click.
    if (options.length === 0) {
      continue;
    }

    questions.push({
      question: entry.question,
      header: typeof entry.header === "string" ? entry.header : "",
      multiSelect: entry.multiSelect === true,
      options,
    });
  }

  return questions;
}

// Minimal pushable async iterable: query() consumes it as the streaming prompt, so the session
// stays open across user turns until end() is called.
class PushableStream<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private ended = false;

  push(value: T): void {
    if (this.ended) {
      return;
    }
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value, done: false });
      return;
    }
    this.buffered.push(value);
  }

  end(): void {
    this.ended = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.buffered.shift();
        if (value !== undefined) {
          return Promise.resolve({ value, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
