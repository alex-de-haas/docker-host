import type { ConversationRef, NativeSessionRef, ProviderRef, Revision, RunRef } from "./agent-sessions.js";

/** Public execution identities never reveal a native SDK thread, filesystem path or process ID. */
export type AgentProviderRef = ProviderRef;
export type AgentSessionRef = NativeSessionRef;
export type AgentRunRef = RunRef;
export const AGENT_API_VERSION = 1 as const;
export const AGENT_EVENT_VERSION = "agent-event.1" as const;
export const AGENT_CAPABILITIES = {
  installationHistory: "installation-history",
  liveInstallationHistory: "installation-history.live",
  resume: "session.resume", configuration: "configuration.resume-compatible", images: "input.images",
  noNativeTools: "native-tools.none", skills: "skills.catalog", exclusiveSkills: "skills.exclusive-selection",
  coreMcp: "mcp.core", externalMcp: "mcp.external", modelChange: "model.change-on-resume",
  nextTurnDecisions: "decisions.next-turn", nativeSubagents: "subagents.native", park: "runs.park",
  barrier: "runs.barrier", reconcile: "runs.reconcile", retire: "runs.retire", liveConfigure: "runs.live-configure",
  predictions: "predictions", connectionUsage: "connections.usage",
  approvalMode: "configuration.approval-mode",
  mcpPolicy: "mcp.policy-update", consumerWorkflow: "workflow.consumer", sessionSubagents: "workflow.subagents",
  profileManagement: "workflow.profile-management",
} as const;
export type AgentCapability = typeof AGENT_CAPABILITIES[keyof typeof AGENT_CAPABILITIES] | (string & {});
export type AgentLimits = {
  maxCommandBytes: number; maxEventBytes: number; maxSnapshotBytes: number; maxReplayBytes: number;
  replayRetentionMs: number; maxControls: number; maxPageSize: number; maxDurationMs?: number;
  maxSkillSnapshotBytes?: number; maxSkillSnapshotFiles?: number;
};
export type AgentCapabilities = {
  version: 2; eventVersions: string[]; capabilities: AgentCapability[]; limits: AgentLimits;
  configuration: { resumeCompatible: string[] };
  nativeTools?: { default: "none" | "provider_default"; none: boolean };
  subagents?: { defaultEnabled: boolean; policy: "enforceable" | "observed" | "unavailable"; observation: "full" | "partial" | "summary" | "unavailable" };
};
export type AgentConnection = { id: string; revision: Revision; name: string; ready: boolean; reason?: string; capabilities?: AgentCapability[] };
export type AgentConnectionPage = { connections: AgentConnection[]; nextCursor: string | null };
export type AgentModel = { id: string; name?: string; reasoningEfforts: Array<string | null>; defaultReasoningEffort?: string | null; capabilities?: AgentCapability[]; unavailableReason?: string };
/** Catalog revisions are opaque content identities, independent of session/control counters. */
export type AgentModelCatalog = { revision: string; models: AgentModel[]; defaultModel: string | null; nextCursor?: string | null };
export type AgentConnectionUsage = { observedAt: string; available: boolean; data?: Record<string, unknown> };
export type AgentInstruction = { id: string; text: string };
export type AgentSkillSelection = { skillId: string; expectedDigest?: string };
export type AgentMcpTarget = { kind: "core" } | { kind: "app"; appId: string; installationId: string; key: string };
export type AgentMcpPolicy = { default: "ask" | "run"; autoAllowReadOnly?: boolean; tools?: Record<string, { mode: "ask" | "run" | "disabled"; definition?: string }> };
export type AgentMcpSelection = {
  targets?: Array<{ target: AgentMcpTarget; tools?: string[]; policy?: AgentMcpPolicy }>;
  connections?: Array<{ id: string; revision: Revision }>;
};
export type AgentConfiguration = {
  connection: { id: string; revision: Revision };
  instructions?: AgentInstruction[]; systemPrompt?: { mode: "append"; text: string };
  skills?: AgentSkillSelection[]; nativeTools?: "provider_default" | "none";
  approvalMode?: "normal" | "autonomous";
  predictions?: { enabled: boolean };
  subagents?: { enabled: boolean; maxConcurrency?: number };
};
export type AgentSessionCreate = {
  configuration: AgentConfiguration; requiredCapabilities?: AgentCapability[];
  correlation?: { conversation?: ConversationRef; task?: { provider: ProviderRef; id: string } };
};
export type AgentConfigurationCreate = { requestId: string; expectedSessionRevision: Revision; configuration: AgentConfiguration; requiredCapabilities?: AgentCapability[] };
export type AgentSession = {
  ref: AgentSessionRef; revision: Revision; configurationRevision: Revision; configurationDigest: string;
  nativeState: "not_created" | "available" | "missing" | "unavailable" | "unknown";
  activeRun: AgentRunRef | null; resolvedSkills: Array<{ skillId: string; digest: string }>;
  configuration?: AgentConfiguration; correlation?: AgentSessionCreate["correlation"];
};
export type AgentSessionPage = { sessions: AgentSession[]; nextCursor: string | null };
export type AgentAttachment = { owner: ProviderRef; id: string; digest: string; sizeBytes: number; mediaType: string; name?: string };
export type AgentAttachmentChunk = { digest: string; sizeBytes: number; mediaType: string; name?: string; count: number; data: string };
export type AgentAttachmentChunkReceipt = { attachment: AgentAttachment | null; received: number[] };
export type AgentResource = { kind: string; id: string; revision: string; provider?: ProviderRef };
export type AgentRunInput = {
  expectedSessionRevision: Revision; configurationRevision: Revision; continuation: "start" | "resume";
  input: { text: string; attachments?: AgentAttachment[] } | { decisionResponseRef: { runId: string; requestId: string } };
  context?: AgentInstruction[]; selection?: { model: string | null; reasoningEffort: string | null };
  resources?: AgentResource[]; mcp?: AgentMcpSelection; requiredCapabilities?: AgentCapability[];
  limits?: { maxDurationMs?: number; maxOutputTokens?: number; maxToolCalls?: number };
};
export type AgentRunState = "queued" | "running" | "waiting_for_input" | "succeeded" | "failed" | "cancelled" | "unknown";
export type AgentRunPhase = "preparing" | "executing" | "waiting" | "finalizing" | "cancelling" | "parked" | "interrupted" | "terminal";
export type AgentSource = { agentId: string; parentAgentId?: string; parentToolCallId?: string };
export type AgentPendingDecision = {
  id: string; revision: Revision; kind: "approval" | "question"; delivery: "continue_run" | "next_turn";
  source?: AgentSource; title?: string; toolCallId?: string; toolName?: string; input?: unknown;
  questions?: Array<{ id: string; text: string; header?: string; allowText?: boolean; options?: Array<{ id: string; label: string; description?: string; preview?: string }>; multiple?: boolean; required?: boolean }>;
};
export type AgentMessageBlock = { id: string; source?: AgentSource; role: "assistant" | "user" | "system"; text: string; state: "streaming" | "complete" | "interrupted" };
export type AgentToolBlock = { id: string; source?: AgentSource; name: string; input?: unknown; output?: string; state: "running" | "completed" | "failed" | "cancelled" | "unknown"; truncated?: boolean;
  command?: { status: "completed" | "failed" | "cancelled" | "unknown"; exitCode?: number; durationMs?: number; summary?: string } };
export type AgentResult = { status: "succeeded" | "failed" | "cancelled"; messageId?: string; text?: string; value?: unknown; schemaValid?: boolean; error?: AgentErrorDetail };
export type AgentRunSnapshot = {
  ref: AgentRunRef; sessionId: string; generation: string; revision: Revision; state: AgentRunState; phase: AgentRunPhase;
  stopConfirmed: boolean; freshness: "current" | "last_known" | "unavailable"; observedAt: string;
  configurationRevision: Revision; lastSequence: Revision; cursor: string; pending: AgentPendingDecision[];
  effects: { certainty: "known" | "unknown"; unresolvedCallIds: string[] };
  result?: AgentResult; messages?: AgentMessageBlock[]; tools?: AgentToolBlock[];
  agents?: Array<AgentSource & {
    state: AgentRunState;
    stopConfirmed?: boolean;
    /** Native assignment and final answer, when the provider can attribute them to this child. */
    prompt?: string;
    response?: string;
    promptTruncated?: boolean;
    responseTruncated?: boolean;
  }>;
  selection?: { requested: { model: string | null; reasoningEffort: string | null }; effective: { model: string | null; reasoningEffort: string | null } };
  admissionRef?: string;
  coverage?: { messages: "complete" | "truncated"; tools: "complete" | "truncated"; decisions?: "complete" | "truncated" };
  executionUsage?: { sequence: Revision; activeMs: number; unknown: boolean };
  /** Latest root context.updated observation; null usage explicitly clears it. */
  latestContext?: { sequence: Revision; usage: Record<string, unknown> | null };
  decisions?: Array<{ decision: AgentPendingDecision; state: "pending" | "resolved" | "superseded" | "unknown"; response?: AgentApprovalResponse | AgentQuestionResponse }>;
  pendingContinuations?: Array<{ requestId: string; run: AgentRunRef; state: "pending" | "awaiting_authorization" | "admitted" | "superseded" }>;
};
export type AgentDiscardReceipt = { requestId: string; runId: string; state: "discarded" };
export type AgentRunClosure = Pick<AgentRunSnapshot, "ref" | "sessionId" | "generation" | "revision" | "state" | "phase" | "stopConfirmed" | "pendingContinuations">;
export type AgentApprovalResponse = { kind: "approval"; decision: "allow" | "deny"; message?: string };
export type AgentQuestionResponse = { kind: "question"; answers: Record<string, string | string[]> };
export type AgentResponseInput = { requestId: string; expectedGeneration: string; expectedRevision: Revision; decisionId: string; decisionRevision: Revision; response: AgentApprovalResponse | AgentQuestionResponse };
export type AgentCancelInput = { requestId: string } & (
  { expectedGeneration?: never; expectedRevision?: never; fenceIfNotAdmitted?: never }
  | { expectedGeneration: string; expectedRevision: Revision; fenceIfNotAdmitted?: never }
  | { fenceIfNotAdmitted: { sessionId: string; startDigest: string }; expectedGeneration?: never; expectedRevision?: never }
);
/** Optional execution controls share the same durable public control journal. */
export type AgentRunControlInput = { requestId: string; expectedGeneration: string; expectedRevision: Revision } & (
  | { command: "park"; decisionId: string; decisionRevision: Revision; reason?: string }
  | { command: "barrier"; barrierId: string; kind: "task_adoption" | "child_wait" | "source_rebind" | "limits" | "human_input"; generation: Revision; acknowledgedSequence: Revision; snapshot?: string }
  | { command: "reconcile"; stopped: true; evidence?: string }
  /** Requires provider-owned exit evidence. Applied retirement preserves uncertain tool outcomes. */
  | { command: "retire" }
  | { command: "liveConfigure"; mcp: AgentMcpSelection }
  | { command: "mcpPolicy"; mcp: AgentMcpSelection }
  | { command: "predictions"; enabled: boolean }
);
export type AgentControlReceipt = {
  requestId: string; state: "accepted" | "applied" | "rejected" | "superseded" | "unknown";
  run: AgentRunRef; revision: Revision; generation?: string; error?: AgentErrorDetail;
  continuation?: { run: AgentRunRef; state: "pending" | "awaiting_authorization" | "admitted" | "superseded" };
};
export type AgentEventType = "run.updated" | "session.bound" | "selection.updated" | "message.started" | "message.delta" | "message.completed"
  | "tool.started" | "tool.output" | "tool.completed" | "decision.requested" | "decision.updated" | "decision.resolved" | "control.updated"
  | "result.available" | "usage.updated" | "context.updated" | "agent.updated" | "warning" | "extension";
export type AgentEvent = {
  schemaVersion: typeof AGENT_EVENT_VERSION; runId: string; generation: string; sequence: Revision; revision: Revision;
  occurredAt: string; type: AgentEventType; source: AgentSource; data: Record<string, unknown>;
};
export type AgentWatchItem = { kind: "snapshot"; snapshot: AgentRunSnapshot } | { kind: "event"; event: AgentEvent; cursor: string };
/** One installation feed receipt. Its cursor is independent of the per-run replay position. */
export type AgentHistoryObservation = {
  sessionId: string; runId: string; generation: string; userId: string; principalId: string;
  item: AgentWatchItem; cursor: string; epoch?: string; sessionPosition?: number; sourceHistoryIncomplete?: true;
};
export type AgentHistorySessionState = {
  sessionId: string; userId: string; principalId: string; epoch: string; head: number; snapshot: AgentRunSnapshot; sourceHistoryIncomplete?: true;
};
export type AgentErrorDetail = { code: string; message: string; retryable: boolean; requestId?: string; details?: Record<string, unknown> };
export class AgentApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number,
    public readonly retryable = false, public readonly details?: Record<string, unknown>, public readonly requestId?: string) {
    super(message); this.name = "AgentApiError";
  }
}
export type AgentOperation = "capabilities" | "connections.list" | "connections.models" | "connections.usage" | "attachments.write"
  | "sessions.create" | "sessions.configure" | "sessions.read" | "sessions.list"
  | "runs.start" | "runs.read" | "runs.closure" | "runs.discard" | "runs.events" | "runs.respond" | "runs.cancel" | "runs.control" | "runs.controls.read";
/** Core transport names for the optional consumer-bound task workflow, without general Core tools. */
export const AGENT_SESSION_WORKFLOW_TOOLS = [
  "task_executor_options", "task_options", "task_list", "task_get", "task_create", "task_edit", "task_action",
  "task_result", "task_fail", "task_request_input", "task_adopt", "task_prepare_executor", "task_delegate",
  "task_wait", "task_plan", "task_bind_workspace", "task_execution_get",
] as const;
/** Optional business workflow owned by the invoking consumer, separate from native execution. */
export const AGENT_SUBAGENT_WORKFLOW_TOOLS = ["subagent_profiles", "subagent_spawn", "subagent_status", "subagent_wait"] as const;
/** Profile and skill management is separately selected for an operator's conversation. */
export const AGENT_PROFILE_MANAGEMENT_WORKFLOW_TOOLS = [
  "profile_list", "profile_options", "profile_create", "profile_edit", "skill_list", "skill_discover", "skill_install",
] as const;
export type AgentSessionWorkflowTool = typeof AGENT_SESSION_WORKFLOW_TOOLS[number] | typeof AGENT_SUBAGENT_WORKFLOW_TOOLS[number]
  | typeof AGENT_PROFILE_MANAGEMENT_WORKFLOW_TOOLS[number];
export type AgentSessionWorkflowBinding = {
  executor: ProviderRef; sessionId: string; tools?: AgentSessionWorkflowTool[]; policy?: AgentMcpPolicy;
};
/** Public provider identities carried by exact Core mediation; never native engine IDs. */
export type AgentExecutionReference = { provider: AgentProviderRef; sessionId: string; runId: string };
export type AgentSessionWorkflowRequest = { action: string; input: Record<string, unknown>; agent: AgentExecutionReference; source?: ProviderRef };
export type AgentAuthorizationRequest = {
  operation: AgentOperation; method: "GET" | "PUT" | "POST"; path: string; bodyHash: string;
  resources?: AgentResource[]; sessionId?: string; runId?: string; configurationDigest?: string;
  /** Originating chat on runs.start. The consumer supplies its own app-relative viewer route. */
  conversation?: { sessionId: string; viewerPath: string; title: string };
  ceiling?: { mcp?: AgentMcpSelection; resources?: AgentResource[]; deadline?: string; configurationRevision?: Revision; workflow?: AgentSessionWorkflowBinding };
};
export type AgentOperationAuthorization = { provider: AgentProviderRef; baseUrl: string; token: string; expiresAt: string; admissionRef?: string; supportedWorkflowCapabilities?: string[] };
export type AgentAuthorizer = (request: AgentAuthorizationRequest, signal?: AbortSignal) => Promise<AgentOperationAuthorization>;
/** Persist this value before a mutation; body is the exact UTF-8 JSON string used on every retry. */
export type AgentPreparedRequest<T = unknown> = AgentAuthorizationRequest & { body: string; readonly __result?: T };
