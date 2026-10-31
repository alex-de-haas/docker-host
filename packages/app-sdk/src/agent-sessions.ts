/** Local-to-Core identities. Never infer an app, conversation, native session or run from another ID. */
export type ProviderRef = { appId: string; installationId: string; key: string };
export type ConversationRef = { provider: ProviderRef; id: string };
export type NativeSessionRef = { provider: ProviderRef; id: string };
export type RunRef = { provider: ProviderRef; id: string };
/** Decimal strings avoid integer truncation across language boundaries. */
export type Revision = string;
export type AgentSession = { ref: NativeSessionRef; revision: Revision; activeRuns: RunRef[]; capabilities: string[]; conversation?: ConversationRef | null };
export type AgentRun = {
  ref: RunRef; revision: Revision; state: "queued" | "running" | "waiting_for_input" | "succeeded" | "failed" | "cancelled" | "unknown";
  observedAt: string; freshness: "current" | "last_known" | "unavailable"; stopConfirmed: boolean;
  nativeSession?: NativeSessionRef | null; conversation?: ConversationRef | null;
};
export type AgentSessionPage = { sessions: AgentSession[]; nextCursor: string | null; availability: "available" | "partial" | "unavailable"; observedAt: string };
export type AgentSessionQuery = { provider: ProviderRef; conversation?: ConversationRef; cursor?: string; limit?: number };
export type RunCancel = { run: RunRef; requestId: string; expectedRevision: Revision };
export type RunCancelReceipt = { requestId: string; state: "accepted" | "completed"; run: AgentRun };

export type AgentRunNotification = { run: AgentRun; cursor: string; rescanRequired: boolean };
export type AgentRunSubscription = { handle: string; expiresAt: string; initial: AgentRunNotification };
export type AgentRunSubscriptionCreate = { run: RunRef; cursor?: string };
