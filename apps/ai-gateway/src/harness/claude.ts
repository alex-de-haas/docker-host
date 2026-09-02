import { randomUUID } from "node:crypto";
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
// permissionMode stays "default" with every write routed through canUseTool: v1 approval policy is
// "every write asks", with no exceptions (plan decision) — never widen this to bypassPermissions.

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
  title?: string;
  decisionReason?: string;
}

export class ClaudeHarnessAdapter implements HarnessAdapter {
  readonly name = "claude-agent-sdk";
  readonly capabilities: HarnessCapabilities = {
    questions: true,
    appMcp: true,
    liveReconfigure: true,
    autoAllow: true,
    denyReason: true,
  };

  async probe(): Promise<HarnessAvailability> {
    if (!AUTH_ENV_KEYS.some((key) => process.env[key]?.trim())) {
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

  start(options: HarnessStartOptions): HarnessRun {
    return new ClaudeRun(options);
  }
}

interface PendingApproval {
  toolName: string;
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
    setMcpServers?(servers: Record<string, unknown>): Promise<unknown>;
  } | null = null;
  private stopped = false;

  constructor(private readonly options: HarnessStartOptions) {
    void this.runLoop();
  }

  send(text: string): void {
    this.input.push({ type: "user", message: { role: "user", content: text } });
  }

  resolveApproval(approvalId: string, decision: "allow" | "deny", message?: string): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      return false;
    }

    this.pending.delete(approvalId);
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
      await query.setMcpServers(servers);
      return true;
    } catch {
      return false;
    }
  }

  async interrupt(): Promise<void> {
    await this.query?.interrupt().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
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
      const query = sdk.query({
        prompt: this.input as AsyncIterable<never>,
        options: {
          cwd: this.options.cwd,
          resume: this.options.resumeHarnessSessionId,
          permissionMode: "default",
          includePartialMessages: true,
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
          ...(this.options.mcpServers ? { mcpServers: this.options.mcpServers } : {}),
          canUseTool: (toolName: string, input: Record<string, unknown>, context?: ApprovalContext) =>
            this.requestApproval(toolName, input, context),
        },
      } as never) as AsyncIterable<Record<string, never>> & { interrupt(): Promise<unknown>; close(): void };
      this.query = query;

      for await (const message of query) {
        this.dispatch(message as Record<string, unknown>);
      }
    } catch (error) {
      if (!this.stopped) {
        this.options.onEvent({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
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
    if (AUTO_ALLOWED_TOOLS.has(toolName) || this.options.isAutoAllowed?.(toolName) === true) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }

    return new Promise((resolve) => {
      const approvalId = randomUUID();
      this.pending.set(approvalId, { toolName, resolve });
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

  private dispatch(message: Record<string, unknown>): void {
    const type = message.type;
    if (type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
      this.options.onEvent({ type: "harness_session", harnessSessionId: message.session_id });
      return;
    }

    if (type === "stream_event") {
      const event = message.event as Record<string, unknown> | undefined;
      const delta = event?.delta as Record<string, unknown> | undefined;
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
            // The question card is already the transcript record for an ask, so the raw tool_use
            // block would render a second, redundant entry carrying the same options as JSON.
            if (block.name === ASK_USER_QUESTION) {
              continue;
            }
            this.options.onEvent({
              type: "tool_use",
              toolName: String(block.name ?? "unknown"),
              input: block.input,
            });
          }
        }
      }
      return;
    }

    if (type === "result") {
      const usage = message.usage as Record<string, unknown> | undefined;
      if (typeof message.session_id === "string") {
        this.options.onEvent({ type: "harness_session", harnessSessionId: message.session_id });
      }
      this.options.onEvent({
        type: "result",
        status: String(message.subtype ?? "success"),
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
