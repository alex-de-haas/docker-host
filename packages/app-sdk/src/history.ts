import type { ConversationRef, NativeSessionRef, ProviderRef, Revision, RunRef } from "./agent-sessions.js";
export type { ConversationRef, NativeSessionRef, ProviderRef, Revision, RunRef } from "./agent-sessions.js";
export type EntryRef = { conversation: ConversationRef; id: string };
export type HistoryCoverage = { state: "complete" | "partial"; reasons: string[] };
export type Conversation = { ref: ConversationRef; revision: Revision; title: string | null; ownerUserId: string;
  createdAt: string; updatedAt: string; nativeSessions?: NativeSessionRef[]; capabilities: string[] };
export type HistoryPart = { type: "text"; text: string; format: "plain" | "markdown" }
  | { type: "attachment"; attachmentId: string; revision: Revision; mediaType: string; name: string; sizeBytes?: number }
  | { type: "resource"; resourceKind: string; owner: string; id: string; revision?: Revision; label?: string };
export type Disclosure = "complete" | "redacted" | "truncated";
export type HistoryData =
  | { kind: "message"; role: "user" | "assistant" | "system"; parts: HistoryPart[]; state: "streaming" | "complete" | "interrupted" }
  | { kind: "tool_call"; callId: string; toolName: string; input: unknown; disclosure: Disclosure }
  | { kind: "tool_result"; callId: string; parts: HistoryPart[]; outcome: "completed" | "failed" | "cancelled" | "unknown"; durationMs?: number; disclosure: Disclosure }
  | { kind: "run_state"; state: string; stopConfirmed: boolean }
  | { kind: "usage"; scope: "turn" | "run"; source: string; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; estimated: boolean; cost?: { amount: string; currency: string } }
  | { kind: "extension"; name: string; version: number; payload: unknown; fallbackText?: string; disclosure: Disclosure };
export type HistoryKind = HistoryData["kind"];
export type HistoryEntry = { ref: EntryRef; revision: Revision; sequence: Revision; createdAt: string; updatedAt: string;
  actor: { kind: "user" | "agent" | "system" | "tool"; id?: string; displayName?: string }; run?: RunRef; parentEntryId?: string; data: HistoryData };
export type HistoryExtension = { name: string; version: number; schema: Record<string, unknown> };
export type HistoryCapabilities = { version: 1; entryKinds: HistoryKind[]; extensions: HistoryExtension[]; maxPageSize: number;
  snapshotLifetimeSeconds: number; changeRetentionSeconds: number };
export type ConversationQuery = { providers: ProviderRef[]; title?: string; cursor?: string; limit?: number };
export type SourceConversationQuery = { provider: ProviderRef; title?: string; cursor?: string; limit?: number };
export type ConversationPage = { conversations: Conversation[]; nextCursor: string | null; coverage: HistoryCoverage; providers: HistoryProviderCoverage[] };
export type SourceConversationPage = { conversations: Conversation[]; nextCursor: string | null; snapshotId: string; highWater: Revision; coverage: HistoryCoverage };
export type HistoryQuery = { conversation: ConversationRef; kinds?: HistoryKind[]; cursor?: string; limit?: number };
export type HistoryPage = { entries: HistoryEntry[]; nextCursor: string | null; snapshotId: string; highWater: Revision; coverage: HistoryCoverage };
export type HistoryEntryGet = { entry: EntryRef; expectedRevision?: Revision };
export type HistorySearch = { providers?: ProviderRef[]; q: string; kinds?: HistoryKind[]; conversations?: ConversationRef[]; cursor?: string; limit?: number };
export type HistorySearchHit = { entry: EntryRef; revision: Revision; conversationTitle: string | null; excerpt: string; updatedAt: string; observedAt: string };
export type HistoryProviderCoverage = { provider: ProviderRef; state: "complete" | "partial" | "unavailable" | "unsupported"; error?: HistoryError };
export type HistorySearchPage = { hits: HistorySearchHit[]; nextCursor: string | null; coverage: HistoryCoverage; providers: HistoryProviderCoverage[] };
export type HistorySelection = { entryIds?: string[]; includeFutureEntries?: true };
export type HistoryShareCreate = { ref: ConversationRef; requestId: string; expectedRevision: Revision; selection: HistorySelection;
  recipientUserIds: string[]; includeAttachments: boolean; extensions?: string[]; label?: string; expiresAt?: string };
export type HistoryShare = { id: string; ref: ConversationRef; revision: Revision; ownerUserId: string; recipientUserIds: string[];
  selection: HistorySelection; includeAttachments: boolean; extensions: string[]; label: string | null; expiresAt: string | null; state: "active" | "revoked" };
export type HistoryShareRevoke = { ref: ConversationRef; grantId: string; requestId: string; expectedRevision: Revision };
export type HistorySharePage = { shares: HistoryShare[]; conversationRevision: Revision };
export type HistoryShareReceipt = { requestId: string; grant: HistoryShare; conversationRevision: Revision };
export type HistoryAttachmentResolve = { entry: EntryRef; attachmentId: string; revision: Revision };
export type HistoryAttachment = { attachmentId: string; revision: Revision; name: string; mediaType: string; sizeBytes: number; handle: string; expiresAt: string };
export type HistoryExportCorpus = { mode: "all-owned"; includeFutureConversations: true; providers: ProviderRef[] }
  | { mode: "conversations"; conversations: ConversationRef[] };
export type HistoryExportConsumer = { kind: "self" } | { kind: "app"; appId: string; installationId: string };
export type HistoryExportCreate = { requestId: string; consumer: HistoryExportConsumer; corpus: HistoryExportCorpus; purpose: string; expiresAt?: string };
export type HistoryExportGrant = { id: string; revision: Revision; ownerUserId: string; consumer: HistoryExportConsumer; principalId: string;
  corpus: HistoryExportCorpus; purpose: string; expiresAt: string | null; state: "proposed" | "active";
  approvalUrl?: string | null; lastAppliedCursor?: string | null }
  | { id: string; revision: Revision; state: "purge_required" | "purged"; ownerUserId?: string | null; consumer?: HistoryExportConsumer | null;
      principalId?: string | null; corpus?: HistoryExportCorpus | null; purpose?: string | null; expiresAt?: string | null; approvalUrl?: null; lastAppliedCursor?: string | null };
export type HistoryExportQuery = { exportGrantId: string; provider: ProviderRef; cursor?: string; limit?: number };
export type HistoryExportSnapshot = { entries: HistoryEntry[]; nextCursor: string | null; snapshotId: string; highWater: Revision; changeCursor: string; coverage: HistoryCoverage };
export type HistoryChange = { id: string; sequence: Revision; type: "upsert"; entry: HistoryEntry }
  | { id: string; sequence: Revision; type: "delete"; ref: EntryRef; revision: Revision }
  | { id: string; sequence: Revision; type: "access_reset"; reason: string };
export type HistoryChangePage = { changes: HistoryChange[]; nextCursor: string; highWater: Revision; coverage: HistoryCoverage };
export type HistoryExportAcknowledge = { exportGrantId: string; requestId: string; expectedRevision: Revision; lastAppliedCursor?: string; purgeComplete?: boolean };
export type HistoryError = { code: string; message: string; retryable: boolean; operationRef?: string };
export type HistoryNotification = { conversation: ConversationRef; revision: Revision; cursor: string;
  changes: Array<{ type: "upsert" | "delete"; entryId: string; revision: Revision }>; rescanRequired: boolean };
export type HistorySubscription = { handle: string; expiresAt: string; initial: HistoryNotification };
export type HistorySubscriptionCreate = { conversation: ConversationRef; cursor?: string };
