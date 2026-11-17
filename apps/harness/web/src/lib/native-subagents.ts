import type { ProviderTranscriptSource } from "../../../src/agent-providers/transcript-source";
import type { AssistantEvent } from "./assistant-api";
import { summarizeToolUse } from "./tool-display";

export type NativeAgent = {
  key: string; source: ProviderTranscriptSource; label: string; parentLabel: string;
  events: AssistantEvent[]; status?: AssistantEvent; lastAction: string; streamed: string;
};
export type NativeAgentGroup = { key: string; agents: NativeAgent[] };
export type ChildStream = { source: ProviderTranscriptSource; text: string; ts: string };
export type TranscriptStreams = { root: string; children: Record<string, ChildStream> };
export const emptyTranscriptStreams = (): TranscriptStreams => ({ root: "", children: {} });

/** Missing attribution is historical root content, never a guessed child identity. */
export function transcriptSource(event: AssistantEvent): ProviderTranscriptSource | undefined {
  const value = event.providerSource;
  if (!value || typeof value !== "object") return;
  const source = value as ProviderTranscriptSource;
  if (typeof source.agentId !== "string" || !source.agentId
    || typeof source.runId !== "string" || typeof source.generation !== "string"
    || !source.provider || typeof source.provider.appId !== "string"
    || typeof source.provider.installationId !== "string" || typeof source.provider.key !== "string") return;
  return source;
}
export function nativeSource(event: AssistantEvent): ProviderTranscriptSource | undefined {
  const source = transcriptSource(event);
  return source && (source.parentAgentId || source.parentToolCallId) ? source : undefined;
}
export const nativeRunKey = (source: ProviderTranscriptSource): string => JSON.stringify([
  source.provider.appId, source.provider.installationId, source.provider.key, source.runId, source.generation,
]);
export const nativeAgentKey = (source: ProviderTranscriptSource): string => JSON.stringify([nativeRunKey(source), source.agentId]);
export const isNativeDecision = (event: AssistantEvent): boolean => ["approval_request", "approval_decision", "question_request", "question_answered"].includes(event.type);

/** A child's final message clears only its own partial text, including interleaved children. */
export function receiveTranscriptText(current: TranscriptStreams, event: AssistantEvent): TranscriptStreams {
  if (!["assistant_delta", "assistant_text"].includes(event.type)) return current;
  const source = nativeSource(event);
  if (!source) return { ...current, root: event.type === "assistant_text" ? "" : current.root + String(event.text ?? "") };
  const key = nativeAgentKey(source), children = { ...current.children };
  if (event.type === "assistant_text") delete children[key];
  else children[key] = { source, text: (children[key]?.text ?? "") + String(event.text ?? ""), ts: event.ts };
  return { ...current, children };
}

function action(event: AssistantEvent): string | undefined {
  if (event.type === "tool_use") {
    const summary = summarizeToolUse(String(event.toolName ?? "tool"), event.input);
    return [summary.label, summary.detail].filter(Boolean).join(" · ");
  }
  if (event.type === "assistant_text") return event.incomplete === true ? "Message interrupted" : "Sent a message";
  if (event.type === "approval_request") return "Requested approval";
  if (event.type === "question_request") return "Asked a question";
  if (event.type === "error") return "Reported an error";
}

/** Partition the same replayed/live event log; child output never joins the root transcript. */
export function nativeAgentTranscript(events: AssistantEvent[], streams: Record<string, ChildStream> = {}) {
  const groups = new Map<string, NativeAgentGroup>(), agents = new Map<string, NativeAgent>();
  const markers = new Map<number, NativeAgentGroup>(), root: AssistantEvent[] = [];
  const tools = new Map<string, AssistantEvent>(), rootAgents = new Set<string>();
  for (const event of events) {
    const source = transcriptSource(event);
    if (source && !nativeSource(event)) rootAgents.add(nativeAgentKey(source));
    if (source && event.type === "tool_use" && typeof event.toolUseId === "string")
      tools.set(JSON.stringify([nativeRunKey(source), event.toolUseId]), event);
  }
  const add = (source: ProviderTranscriptSource, event: AssistantEvent) => {
    const runKey = nativeRunKey(source), key = nativeAgentKey(source);
    let group = groups.get(runKey);
    if (!group) {
      group = { key: runKey, agents: [] }; groups.set(runKey, group);
      const markerSeq = -groups.size; markers.set(markerSeq, group);
      root.push({ seq: markerSeq, ts: event.ts, type: "native_agent_group" });
    }
    let agent = agents.get(key);
    if (!agent) {
      agent = { key, source, label: `Subagent ${group.agents.length + 1}`, parentLabel: "Main agent", events: [], lastAction: "No activity recorded", streamed: "" };
      agents.set(key, agent); group.agents.push(agent);
    }
    // Later events may supply parent linkage that the first observation did not have.
    agent.source = { ...agent.source, ...source };
    return agent;
  };
  for (const event of events) {
    const source = nativeSource(event);
    if (!source) { root.push(event); continue; }
    const agent = add(source, event);
    agent.events.push(event);
    if (event.type === "native_agent_status") agent.status = event;
    agent.lastAction = action(event) ?? agent.lastAction;
    // Decisions retain their normal location and handlers, outside collapsed child output.
    if (isNativeDecision(event)) root.push(event);
  }
  let transientSeq = events.reduce((maximum, event) => Math.max(maximum, event.seq), 0);
  for (const stream of Object.values(streams)) {
    const agent = add(stream.source, { seq: ++transientSeq, ts: stream.ts, type: "assistant_delta" });
    agent.streamed = stream.text;
    agent.lastAction = "Writing a message";
  }
  for (const agent of agents.values()) {
    const parentTool = tools.get(JSON.stringify([nativeRunKey(agent.source), agent.source.parentTranscriptToolUseId]));
    const input = parentTool?.input;
    if (input && typeof input === "object" && "description" in input && typeof input.description === "string" && input.description.trim())
      agent.label = input.description.trim();
  }
  for (const agent of agents.values()) {
    if (agent.source.parentAgentId && agent.source.parentAgentId !== "root") {
      const parentKey = nativeAgentKey({ ...agent.source, agentId: agent.source.parentAgentId });
      if (rootAgents.has(parentKey)) continue;
      const parent = agents.get(parentKey);
      agent.parentLabel = parent?.label ?? `Agent ${agent.source.parentAgentId}`;
    }
  }
  return { events: root, groups: markers, agents };
}

const states: Record<string, string> = {
  queued: "Queued", running: "Running", waiting_for_input: "Waiting for input", succeeded: "Completed",
  failed: "Failed", cancelled: "Cancelled", unknown: "Unknown",
};
export function nativeAgentStatus(agent: NativeAgent, connected: boolean): { label: string; detail?: string; failed: boolean } {
  const event = agent.status;
  if (!event) return { label: "Unknown", detail: "No status reported", failed: false };
  const state = String(event.state), lastKnown = typeof event.lastKnownState === "string" ? states[event.lastKnownState] : undefined;
  const stopped = event.stopConfirmed === true;
  const confirmedTerminal = stopped && ["succeeded", "failed", "cancelled"].includes(state);
  const stale = !confirmedTerminal && (event.freshness !== "current" || !connected);
  if (stale || state === "unknown") return { label: "Unknown", detail: lastKnown ? `Last known: ${lastKnown.toLowerCase()}`
    : states[state] && state !== "unknown" ? `Last known: ${states[state].toLowerCase()}` : "Observation unavailable", failed: false };
  return { label: states[state] ?? "Unknown", detail: !stopped && ["succeeded", "failed", "cancelled"].includes(state) ? "Stop unconfirmed" : undefined, failed: state === "failed" };
}
