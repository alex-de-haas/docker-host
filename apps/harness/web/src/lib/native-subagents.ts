import { providerIdentityParts } from "../../../shared/provider-reference";
import type { ProviderTranscriptSource } from "../../../src/agent-providers/transcript-source";
import type { AssistantEvent } from "./assistant-api";
import { summarizeToolUse } from "./tool-display";

export type NativeAgent = {
  key: string; source: ProviderTranscriptSource; label: string; parentLabel: string;
  events: AssistantEvent[]; status?: AssistantEvent; lastAction: string; streamed: string;
  launchEvents?: AssistantEvent[]; prompt?: string; promptTruncated?: boolean;
  result?: string; resultTruncated?: boolean; resultMessageSeq?: number;
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
    || typeof source.provider.installationId !== "string" || typeof source.provider.key !== "string"
    || source.provider.implementationId != null && (typeof source.provider.implementationId !== "string"
      || !source.provider.implementationId || source.provider.implementationId.length > 128)) return;
  return source;
}
export function nativeSource(event: AssistantEvent): ProviderTranscriptSource | undefined {
  const source = transcriptSource(event);
  return source && (source.parentAgentId || source.parentToolCallId) ? source : undefined;
}
export const nativeRunKey = (source: ProviderTranscriptSource): string => JSON.stringify([
  ...providerIdentityParts(source.provider), source.transcriptRunId ?? source.runId, source.generation,
]);
export const nativeAgentKey = (source: ProviderTranscriptSource): string => JSON.stringify([nativeRunKey(source), source.agentId]);
export const isNativeDecision = (event: AssistantEvent): boolean => ["approval_request", "approval_decision", "question_request", "question_answered", "question_cancelled"].includes(event.type);

/** A child's final message clears only its own partial text, including interleaved children. */
export function receiveTranscriptText(current: TranscriptStreams, event: AssistantEvent): TranscriptStreams {
  // Late history remains visible in its original turn and cannot end a current stream.
  if (event.providerHistoryEarlier === true || !["assistant_delta", "assistant_text"].includes(event.type)) return current;
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

const launchTools = new Set(["Agent", "Task", "Agent: spawn", "Agent: spawnAgent", "spawn_agent", "fork_agent"]);
function launchInput(event: AssistantEvent | undefined): Record<string, unknown> | undefined {
  if (!event || !launchTools.has(String(event.toolName))) return;
  return event.input && typeof event.input === "object" && !Array.isArray(event.input) ? event.input as Record<string, unknown> : {};
}

function compareSequence(a: AssistantEvent, b: AssistantEvent): number {
  const sequence = (value: unknown) => typeof value === "string" && /^(?:0|[1-9][0-9]{0,31})$/.test(value) ? BigInt(value) : -1n;
  const left = sequence(a.sourceSequence), right = sequence(b.sourceSequence);
  return left === right ? 0 : left < right ? -1 : 1;
}

function applyAgentDetails(agent: NativeAgent, details: AssistantEvent[]) {
  const source = agent.source, messages = agent.events.filter(event => event.type === "assistant_text" && !event.incomplete);
  const messagesById = new Map(messages.map(event => [event.providerEventId, event]));
  let messageId: string | undefined;
  // Apply backfilled records in native order. A later clipped copy of the same text cannot
  // replace an already retained complete copy. A changed response owns its own message ID.
  for (const update of details.sort(compareSequence)) {
    if (typeof update.prompt === "string" && update.prompt && !(update.promptTruncated && !agent.promptTruncated && agent.prompt?.startsWith(update.prompt))) {
      agent.prompt = update.prompt;
      agent.promptTruncated = update.promptTruncated === true;
    }
    const id = typeof update.resultMessageId === "string" ? update.resultMessageId : undefined;
    if (!id && typeof update.result !== "string") continue;
    const message = id ? messagesById.get(`${source.transcriptRunId ?? source.runId}:message:${source.agentId}:${id}`) : undefined;
    const text = typeof update.result === "string" ? update.result : typeof message?.text === "string" ? message.text : undefined;
    const keepFull = !agent.resultTruncated && update.resultTruncated === true && text && agent.result?.startsWith(text)
      && (!id || !messageId || id === messageId);
    if (!keepFull) {
      agent.result = text;
      agent.resultTruncated = update.resultTruncated === true;
    }
    messageId = id;
    if (typeof message?.text === "string" && agent.resultTruncated && agent.result && message.text.startsWith(agent.result)) {
      agent.result = message.text;
      agent.resultTruncated = false;
    }
  }
  if (messageId) {
    const matched = messagesById.get(`${source.transcriptRunId ?? source.runId}:message:${source.agentId}:${messageId}`);
    if (matched && matched.text === agent.result) agent.resultMessageSeq = matched.seq;
    return;
  }
  if (!agent.result) {
    // An older provider can retain the parent's tool return and the child's messages separately.
    // An exact return on this launch distinguishes the reply from earlier progress.
    const receipt = agent.launchEvents?.find(event => event.type === "tool_result" && event.status === "completed" && !event.truncated);
    if (typeof receipt?.output === "string" && receipt.output && messages.some(event => event.text === receipt.output)) agent.result = receipt.output;
  }
  if (agent.result) {
    const copies = messages.filter(event => event.text === agent.result);
    if (copies.length === 1) agent.resultMessageSeq = copies[0].seq;
  }
}

/** Partition the same replayed/live event log; child output never joins the root transcript. */
export function nativeAgentTranscript(events: AssistantEvent[], streams: Record<string, ChildStream> = {}) {
  const groups = new Map<string, NativeAgentGroup>(), agents = new Map<string, NativeAgent>();
  const markers = new Map<number, NativeAgentGroup>(), root: AssistantEvent[] = [];
  const tools = new Map<string, AssistantEvent>(), sources = new Map<string, ProviderTranscriptSource>(), rootAgents = new Set<string>();
  const toolKey = (source: ProviderTranscriptSource, id: string) => JSON.stringify([nativeRunKey(source), id]);
  const remember = (source: ProviderTranscriptSource) => {
    const key = nativeAgentKey(source);
    sources.set(key, { ...sources.get(key), ...source });
  };
  for (const event of events) {
    const source = transcriptSource(event);
    if (!source) continue;
    if (nativeSource(event)) remember(source); else if (source.agentId === "root") rootAgents.add(nativeAgentKey(source));
    if (event.type === "tool_use" && typeof event.toolUseId === "string") tools.set(toolKey(source, event.toolUseId), event);
  }
  for (const { source } of Object.values(streams)) remember(source);

  // Fold only an actual, uniquely linked launch. sendInput/wait and unclaimed calls keep their normal rows.
  const launches = new Map<string, ProviderTranscriptSource | null>();
  for (const source of sources.values()) {
    if (!source.parentTranscriptToolUseId) continue;
    const key = toolKey(source, source.parentTranscriptToolUseId), tool = tools.get(key);
    const owner = tool && transcriptSource(tool);
    if (tool && owner && launchInput(tool) && (source.parentAgentId === owner.agentId
      || owner.agentId === "root" && !owner.parentAgentId && !sources.has(nativeAgentKey({ ...source, agentId: source.parentAgentId ?? "" })))) {
      launches.set(key, launches.has(key) ? null : source);
    }
  }
  const counts = new Map<string, number>();
  const add = (source: ProviderTranscriptSource, event: AssistantEvent) => {
    const key = nativeAgentKey(source);
    let agent = agents.get(key);
    if (agent) return agent;
    const groupKey = JSON.stringify([nativeRunKey(source), source.parentAgentId ?? source.parentToolCallId]);
    let group = groups.get(groupKey);
    if (!group) {
      group = { key: groupKey, agents: [] }; groups.set(groupKey, group);
      const markerSeq = -groups.size; markers.set(markerSeq, group);
      root.push({ seq: markerSeq, ts: event.ts, type: "native_agent_group" });
    }
    const run = nativeRunKey(source), count = (counts.get(run) ?? 0) + 1;
    counts.set(run, count);
    agent = { key, source, label: `Subagent ${count}`, parentLabel: source.parentAgentId === "root" ? "Main agent" : "Parent unconfirmed", events: [], lastAction: "No activity recorded", streamed: "" };
    agents.set(key, agent); group.agents.push(agent);
    return agent;
  };
  const details = new Map<string, AssistantEvent[]>();
  for (const event of events) {
    const source = transcriptSource(event);
    const launch = source && typeof event.toolUseId === "string" && ["tool_use", "tool_result", "command_result"].includes(event.type)
      ? launches.get(toolKey(source, event.toolUseId)) : undefined;
    if (launch) {
      // Preserve the raw parent tool and its receipt inside the disclosure, including launch failures.
      (add(launch, event).launchEvents ??= []).push(event);
      continue;
    }
    const child = source && sources.get(nativeAgentKey(source));
    if (!child) { root.push(event); continue; }
    const agent = add(child, event);
    if (event.type === "native_agent_details") {
      const updates = details.get(agent.key);
      if (updates) updates.push(event); else details.set(agent.key, [event]);
    } else if (event.type === "native_agent_status") {
      if (!agent.status || compareSequence(agent.status, event) <= 0) agent.status = event;
    } else {
      agent.events.push(event);
      agent.lastAction = action(event) ?? agent.lastAction;
    }
    // Decisions retain their normal location and handlers, outside collapsed child output.
    if (isNativeDecision(event)) root.push(event);
  }
  let transientSeq = events.reduce((maximum, event) => Math.max(maximum, event.seq), 0);
  for (const stream of Object.values(streams)) {
    const agent = add(sources.get(nativeAgentKey(stream.source))!, { seq: ++transientSeq, ts: stream.ts, type: "assistant_delta" });
    agent.streamed = stream.text;
    agent.lastAction = "Writing a message";
  }
  for (const agent of agents.values()) {
    const source = agent.source;
    const key = source.parentTranscriptToolUseId && toolKey(source, source.parentTranscriptToolUseId);
    const input = key && launches.get(key) ? launchInput(tools.get(key)) : undefined;
    if (input && typeof input.description === "string" && input.description.trim()) agent.label = input.description.trim();
    if (input) {
      const text = input.prompt ?? input.message;
      if (typeof text === "string" && text.trim()) agent.prompt = text;
    }
    applyAgentDetails(agent, details.get(agent.key) ?? []);
    if (agent.result && agent.lastAction === "No activity recorded") agent.lastAction = "Returned a response";
  }
  for (const agent of agents.values()) {
    if (agent.source.parentAgentId && agent.source.parentAgentId !== "root") {
      const parentKey = nativeAgentKey({ ...agent.source, agentId: agent.source.parentAgentId });
      if (rootAgents.has(parentKey) || agent.launchEvents?.some(event => event.type === "tool_use" && !nativeSource(event))) continue;
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
