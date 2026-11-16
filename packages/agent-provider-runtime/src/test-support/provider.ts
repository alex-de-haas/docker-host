import type { AgentCapabilities } from "@hosty-sdk/app/agent";

/** A synthetic engine's declared contract, independent of any distributed native adapter. */
export const fixtureCapabilities: AgentCapabilities = {
  version: 1, eventVersions: ["agent-event.1"],
  capabilities: ["session.resume", "configuration.resume-compatible", "configuration.approval-mode", "skills.catalog", "skills.exclusive-selection", "mcp.core", "mcp.apps", "mcp.policy-update", "workflow.consumer", "model.change-on-resume", "decisions.questions", "decisions.auto-allow", "connections.usage", "runs.park", "runs.barrier", "runs.reconcile", "native-tools.none", "decisions.deny-reason", "runs.live-configure", "decisions.next-turn", "predictions", "subagents.native"],
  limits: { maxCommandBytes: 1024 * 1024, maxEventBytes: 1024 * 1024, maxSnapshotBytes: 1024 * 1024, maxReplayBytes: 64 * 1024 * 1024, replayRetentionMs: 7 * 24 * 60 * 60 * 1000, maxControls: 10000, maxPageSize: 100, maxDurationMs: 24 * 60 * 60 * 1000 },
  configuration: { resumeCompatible: ["instructions", "systemPrompt", "skills", "nativeTools", "approvalMode", "predictions"] },
  nativeTools: { default: "provider_default", none: true },
  subagents: { defaultEnabled: true, policy: "enforceable", observation: "partial" },
};
