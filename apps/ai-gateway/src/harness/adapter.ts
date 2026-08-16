// The harness adapter contract (docs/features/ai-gateway/plan.md): a small internal surface —
// start / send / approve / answer / interrupt / stop — so the concrete harness stays replaceable.
// The adapter reports what happened through a single event callback; the session manager owns
// persistence, status transitions, and SSE fan-out.

export interface HarnessAvailability {
  available: boolean;
  /** Operator-facing reason when unavailable ("assistant unavailable" state in Shell). */
  reason?: string;
}

// What a given harness can actually do, so the gateway degrades loudly instead of silently.
// Both flags exist because the harnesses genuinely differ, and a UI that claims one behavior for
// both would be lying about one of them.
export interface HarnessCapabilities {
  /** The harness can ask the operator a question and receive the answer back as a tool result. */
  questions: boolean;
  /**
   * The harness can be given app MCP servers at all. False means enabled providers reach it in no
   * form — not that updates are deferred — so a UI must say the toggle has no effect there rather
   * than implying a delay.
   */
  appMcp: boolean;
  /**
   * Configuration changes can be applied to a running session. The Claude SDK exposes
   * setMcpServers/toggleMcpServer/reconnectMcpServer; Codex shows no equivalent, so there a toggle
   * takes effect at the next session and the settings UI must say so rather than imply immediacy.
   */
  liveReconfigure: boolean;
}

// One question the harness wants answered. Mirrors the Claude SDK's AskUserQuestionInput shape
// (verified against the shipped types, not assumed) so nothing is lost in translation: 1-4
// questions, each with 2-4 options carrying a label and a description.
export interface HarnessQuestion {
  question: string;
  /** Very short chip label, max ~12 chars. */
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string; preview?: string }>;
}

export type HarnessEvent =
  /** The harness-native session id became known; persisted for resume-after-restart. */
  | { type: "harness_session"; harnessSessionId: string }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_use"; toolName: string; input: unknown }
  /** A proposed write is paused inside the harness until resolveApproval is called. */
  | { type: "approval_request"; approvalId: string; toolName: string; input: unknown }
  /**
   * The harness is asking the operator, paused until resolveQuestion is called. Deliberately not an
   * approval: approving the act of being asked a question is nonsense, and the resolution carries
   * answers rather than a verdict.
   */
  | { type: "question_request"; questionId: string; questions: HarnessQuestion[] }
  | {
      type: "result";
      status: string;
      costUsd?: number;
      usage?: { inputTokens?: number; outputTokens?: number };
    }
  | { type: "error"; message: string };

export interface HarnessStartOptions {
  sessionId: string;
  cwd: string;
  /** Operator-authored instructions, appended to the harness's own sources — never replacing them. */
  systemPrompt?: string;
  /** Enabled app MCP providers, already carrying a token scoped to each app. */
  mcpServers?: Record<string, unknown>;
  /**
   * Whether an app MCP tool may run without an approval card.
   *
   * A predicate rather than a set, so a provider toggle changing mid-session needs no new harness
   * method: the session manager owns the state and this reads it live.
   */
  isAutoAllowed?: (toolName: string) => boolean;
  /** Harness-native session id to resume after a gateway restart, when the harness supports it. */
  resumeHarnessSessionId?: string;
  onEvent: (event: HarnessEvent) => void;
}

export interface HarnessRun {
  send(text: string): void;
  /** Returns false when the approval id is unknown (already resolved or never issued). */
  resolveApproval(approvalId: string, decision: "allow" | "deny", message?: string): boolean;
  /**
   * Answers a pending question, keyed by question text (the SDK's own keying). Returns false when
   * the id is unknown — already answered, or never asked.
   */
  resolveQuestion(questionId: string, answers: Record<string, string>): boolean;
  /**
   * Replaces the MCP servers of a running session. Returns false when the harness cannot be
   * reconfigured live (`capabilities.liveReconfigure`), in which case the change waits for the next
   * session rather than silently doing nothing.
   */
  setMcpServers(servers: Record<string, unknown>): Promise<boolean>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
}

export interface HarnessAdapter {
  readonly name: string;
  readonly capabilities: HarnessCapabilities;
  probe(): Promise<HarnessAvailability>;
  start(options: HarnessStartOptions): HarnessRun;
}
