import { providerIdentityParts } from "../../shared/provider-reference.js";
import { createHash } from "node:crypto";
import type { AgentRunSnapshot, AgentRunState, AgentSource } from "@hosty-sdk/app/agent";

/** Public execution attribution retained with transcript content; native IDs stay provider-owned. */
export type ProviderTranscriptSource = AgentSource & {
  provider: AgentRunSnapshot["ref"]["provider"];
  runId: string;
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
};

export function transcriptToolId(runId: string, source: AgentSource | undefined, toolId: string): string {
  // Preserve the identity used by already stored provider tool events, including omitted root source.
  return `provider-${createHash("sha256").update(JSON.stringify([runId, source?.agentId, toolId])).digest("hex")}`;
}
export function providerTranscriptSource(snapshot: AgentRunSnapshot, source: AgentSource = { agentId: "root" }): ProviderTranscriptSource {
  let parentToolUseId: string | undefined;
  if (source.parentToolCallId) {
    const parentId = source.parentAgentId ?? "root";
    const knownRoot = parentId === "root" || [...(snapshot.agents ?? []), ...(snapshot.messages ?? []).flatMap(message => message.source ? [message.source] : []),
      ...(snapshot.tools ?? []).flatMap(tool => tool.source ? [tool.source] : [])].some(agent => agent.agentId === parentId && agent.parentAgentId === undefined);
    const candidates = (snapshot.tools ?? []).filter(tool => tool.id === source.parentToolCallId);
    const parentTool = candidates.find(tool => tool.source?.agentId === parentId)
      ?? (knownRoot ? candidates.find(tool => !tool.source) : undefined);
    // Old snapshots omitted root source, and their already stored tool IDs include that omission.
    // Join the retained tool's actual identity instead of assigning it a different root hash.
    parentToolUseId = transcriptToolId(snapshot.ref.id, parentTool ? parentTool.source : { agentId: parentId }, source.parentToolCallId);
  }
  return { agentId: source.agentId, ...(source.parentAgentId ? { parentAgentId: source.parentAgentId } : {}),
    ...(source.parentToolCallId ? { parentToolCallId: source.parentToolCallId } : {}), provider: { ...snapshot.ref.provider }, runId: snapshot.ref.id, generation: snapshot.generation,
    ...(parentToolUseId ? { parentTranscriptToolUseId: parentToolUseId } : {}) };
}
export function providerAgentKey(source: ProviderTranscriptSource): string {
  return JSON.stringify([...providerIdentityParts(source.provider), source.runId, source.generation, source.agentId]);
}
export function nativeAgentStatus(snapshot: AgentRunSnapshot, agent: NonNullable<AgentRunSnapshot["agents"]>[number]): NativeAgentStatusEvent {
  const active = ["queued", "running", "waiting_for_input"].includes(agent.state);
  const uncertain = active && (snapshot.freshness !== "current" || snapshot.state === "unknown" || snapshot.phase === "interrupted" || snapshot.stopConfirmed);
  return { type: "native_agent_status", providerSource: providerTranscriptSource(snapshot, agent),
    state: uncertain ? "unknown" : agent.state, stopConfirmed: agent.stopConfirmed === true,
    freshness: uncertain && snapshot.freshness === "current" ? "last_known" : snapshot.freshness,
    observedAt: snapshot.observedAt, ...(uncertain ? { lastKnownState: agent.state } : {}) };
}
export function nativeAgentStatusIdentity(event: NativeAgentStatusEvent): string {
  return JSON.stringify([event.providerSource, event.state, event.stopConfirmed, event.freshness, event.lastKnownState]);
}
