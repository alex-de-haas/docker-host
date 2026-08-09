import { randomUUID } from "node:crypto";
import type {
  HarnessAdapter,
  HarnessAvailability,
  HarnessEvent,
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
const AUTO_ALLOWED_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "Task"]);

export class ClaudeHarnessAdapter implements HarnessAdapter {
  readonly name = "claude-agent-sdk";

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

class ClaudeRun implements HarnessRun {
  private readonly input = new PushableStream<unknown>();
  private readonly pending = new Map<string, PendingApproval>();
  private query: { interrupt(): Promise<unknown>; close(): void } | null = null;
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

  async interrupt(): Promise<void> {
    await this.query?.interrupt().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Unblock any approval the harness is still paused on, then tear the query down.
    for (const [, pending] of this.pending) {
      pending.resolve({ behavior: "deny", message: "Session stopped." });
    }
    this.pending.clear();
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
          // Host operator context: the harness reads the operator's own user+project settings
          // (CLAUDE.md, skills), exactly like an admin running Claude Code by hand.
          settingSources: ["user", "project"],
          canUseTool: (toolName: string, input: Record<string, unknown>) =>
            this.requestApproval(toolName, input),
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

  private requestApproval(toolName: string, input: Record<string, unknown>): Promise<unknown> {
    if (AUTO_ALLOWED_TOOLS.has(toolName)) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }

    return new Promise((resolve) => {
      const approvalId = randomUUID();
      this.pending.set(approvalId, { toolName, resolve });
      this.options.onEvent({ type: "approval_request", approvalId, toolName, input });
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
