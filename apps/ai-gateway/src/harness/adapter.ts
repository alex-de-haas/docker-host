// The harness adapter contract (docs/features/ai-gateway/plan.md): a small internal surface —
// start / send / approve / interrupt / stop — so the concrete harness stays replaceable. The
// adapter reports what happened through a single event callback; the session manager owns
// persistence, status transitions, and SSE fan-out.

export interface HarnessAvailability {
  available: boolean;
  /** Operator-facing reason when unavailable ("assistant unavailable" state in Shell). */
  reason?: string;
}

export type HarnessEvent =
  /** The harness-native session id became known; persisted for resume-after-restart. */
  | { type: "harness_session"; harnessSessionId: string }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_use"; toolName: string; input: unknown }
  /** A proposed write is paused inside the harness until resolveApproval is called. */
  | { type: "approval_request"; approvalId: string; toolName: string; input: unknown }
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
  /** Harness-native session id to resume after a gateway restart, when the harness supports it. */
  resumeHarnessSessionId?: string;
  onEvent: (event: HarnessEvent) => void;
}

export interface HarnessRun {
  send(text: string): void;
  /** Returns false when the approval id is unknown (already resolved or never issued). */
  resolveApproval(approvalId: string, decision: "allow" | "deny", message?: string): boolean;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
}

export interface HarnessAdapter {
  readonly name: string;
  probe(): Promise<HarnessAvailability>;
  start(options: HarnessStartOptions): HarnessRun;
}
