import { providerIdentityParts } from "../../shared/provider-reference.js";
import { createHash } from "node:crypto";
import type { AgentRunSnapshot, AgentRunState, AgentSource, AgentWatchItem, AgentResult } from "@hosty-sdk/app/agent";

/** Public execution attribution retained with transcript content; native IDs stay provider-owned. */
export type ProviderTranscriptSource = AgentSource & {
  provider: AgentRunSnapshot["ref"]["provider"];
  runId: string;
  transcriptRunId?: string;
  generation: string;
  parentTranscriptToolUseId?: string;
};
export type NativeAgentStatusEvent = {
  type: "native_agent_status";
  providerSource: ProviderTranscriptSource;
  state: AgentRunState;
  stopConfirmed: boolean;
  freshness: AgentRunSnapshot["freshness"];
  observedAt: string;
  lastKnownState?: AgentRunState;
  sourceSequence?: string;
};

export function transcriptToolId(runId: string, source: AgentSource | undefined, toolId: string): string {
  // Preserve the identity used by already stored provider tool events, including omitted root source.
  return `provider-${createHash("sha256").update(JSON.stringify([runId, source?.agentId, toolId])).digest("hex")}`;
}
export function providerTranscriptSource(snapshot: AgentRunSnapshot, source: AgentSource = { agentId: "root" }, transcriptRun = snapshot.ref.id): ProviderTranscriptSource {
  let parentToolUseId: string | undefined;
  if (source.parentToolCallId && source.parentAgentId) {
    const parentId = source.parentAgentId;
    const knownRoot = parentId === "root" || [...(snapshot.agents ?? []), ...(snapshot.messages ?? []).flatMap(message => message.source ? [message.source] : []),
      ...(snapshot.tools ?? []).flatMap(tool => tool.source ? [tool.source] : [])].some(agent => agent.agentId === parentId && agent.parentAgentId === undefined);
    const candidates = (snapshot.tools ?? []).filter(tool => tool.id === source.parentToolCallId);
    const parentTool = candidates.find(tool => tool.source?.agentId === parentId)
      ?? (knownRoot ? candidates.find(tool => !tool.source) : undefined);
    // Old snapshots omitted root source, and their already stored tool IDs include that omission.
    // Join the retained tool's actual identity instead of assigning it a different root hash.
    parentToolUseId = transcriptToolId(transcriptRun, parentTool ? parentTool.source : { agentId: parentId }, source.parentToolCallId);
  }
  return { agentId: source.agentId, ...(source.parentAgentId ? { parentAgentId: source.parentAgentId } : {}),
    ...(source.parentToolCallId ? { parentToolCallId: source.parentToolCallId } : {}), provider: { ...snapshot.ref.provider }, runId: snapshot.ref.id, ...(transcriptRun !== snapshot.ref.id ? { transcriptRunId: transcriptRun } : {}), generation: snapshot.generation,
    ...(parentToolUseId ? { parentTranscriptToolUseId: parentToolUseId } : {}) };
}
export function providerAgentKey(source: ProviderTranscriptSource): string {
  return JSON.stringify([...providerIdentityParts(source.provider), source.transcriptRunId ?? source.runId, source.generation, source.agentId]);
}
export function nativeAgentStatus(snapshot: AgentRunSnapshot, agent: NonNullable<AgentRunSnapshot["agents"]>[number], transcriptRun = snapshot.ref.id): NativeAgentStatusEvent {
  const active = ["queued", "running", "waiting_for_input"].includes(agent.state);
  const uncertain = active && (snapshot.freshness !== "current" || snapshot.state === "unknown" || snapshot.phase === "interrupted" || snapshot.stopConfirmed);
  return { type: "native_agent_status", providerSource: providerTranscriptSource(snapshot, agent, transcriptRun),
    state: uncertain ? "unknown" : agent.state, stopConfirmed: agent.stopConfirmed === true,
    freshness: uncertain && snapshot.freshness === "current" ? "last_known" : snapshot.freshness,
    observedAt: snapshot.observedAt, sourceSequence: snapshot.lastSequence, ...(uncertain ? { lastKnownState: agent.state } : {}) };
}
export function nativeAgentStatusIdentity(event: NativeAgentStatusEvent): string {
  return JSON.stringify([event.providerSource, event.state, event.stopConfirmed, event.freshness, event.lastKnownState]);
}

/** These are public, child-attributed facts. A completed message alone may be a progress report. */
export type NativeAgentDetailsEvent = {
  type: "native_agent_details"; sourceSequence: string;
  prompt?: string; promptTruncated?: boolean;
  result?: string; resultTruncated?: boolean; resultMessageId?: string;
};

export function nativeAgentDetails(item: AgentWatchItem): Array<{ source: AgentSource; event: NativeAgentDetailsEvent; key: string }> {
  const sequence = item.kind === "snapshot" ? item.snapshot.lastSequence : item.event.sequence;
  const entries: Array<{ source: AgentSource; event: NativeAgentDetailsEvent; key: string }> = [];
  const add = (source: AgentSource, details: Omit<NativeAgentDetailsEvent, "type" | "sourceSequence">) => {
    if (source.parentAgentId === undefined || !Object.keys(details).length) return;
    const fingerprint = createHash("sha256").update(JSON.stringify([source.agentId, details])).digest("hex");
    entries.push({ source, event: { type: "native_agent_details", sourceSequence: sequence, ...details }, key: `child-details:${sequence}:${fingerprint}` });
  };
  if (item.kind === "event" && item.event.type === "result.available") {
    const result = item.event.data.result as AgentResult;
    add(item.event.source, { ...(result.text ? { result: result.text } : {}), ...(result.messageId ? { resultMessageId: result.messageId } : {}) });
  } else {
    const agents = item.kind === "snapshot" ? item.snapshot.agents : item.event.type === "run.updated"
      ? (item.event.data.snapshot as AgentRunSnapshot).agents : item.event.type === "agent.updated"
        ? [item.event.data.agent as NonNullable<AgentRunSnapshot["agents"]>[number]] : [];
    for (const agent of agents ?? []) {
      add(agent, { ...(agent.prompt ? { prompt: agent.prompt, ...(agent.promptTruncated ? { promptTruncated: true } : {}) } : {}),
        ...(agent.response ? { result: agent.response, ...(agent.responseTruncated ? { resultTruncated: true } : {}) } : {}) });
    }
  }
  return entries;
}
