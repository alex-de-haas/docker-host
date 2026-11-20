import type { AgentEvent, AgentPendingDecision, AgentRunSnapshot, AgentSource, AgentWatchItem } from "@hosty-sdk/app/agent";
import { createAgentRunProjection, reduceAgentRunProjection } from "./projection.js";

/** The latest fact, lifecycle snapshot and detailed snapshot can arrive on different connections. */
export interface HistoryProjectionClock {
  runId: string;
  generation: string;
  lifecycle: string;
  details: string;
  /** Individual changes after the last detailed snapshot, including resolved/removed entries. */
  changes: Record<string, string>;
}

const slot = (kind: string, id: string, source?: AgentSource) => JSON.stringify([kind, source?.agentId ?? "root", id]);
const decisionSlot = (entry: AgentPendingDecision) => slot("decision", entry.id, entry.source);

function eventSlot(event: AgentEvent): string | undefined {
  if (event.type.startsWith("message.")) return slot("message", String(event.data.messageId), event.source);
  if (event.type.startsWith("tool.")) return slot("tool", String(event.data.toolCallId), event.source);
  if (event.type.startsWith("decision.")) return slot("decision", String(event.data.decisionId), event.source);
  if (event.type === "agent.updated") return slot("agent", event.source.agentId);
  if (event.type === "control.updated") return slot("control", String(event.data.requestId));
  if (event.type === "selection.updated" || event.type === "result.available")
    return event.source.parentAgentId === undefined ? event.type : undefined;
}

function mergeRows<T>(snapshot: T[] | undefined, current: T[] | undefined, key: (entry: T) => string, later: (key: string) => boolean): T[] | undefined {
  const kept = current?.filter(entry => later(key(entry)));
  if (!kept?.length && !snapshot) return undefined;
  return [...(snapshot ?? []).filter(entry => !later(key(entry))), ...(kept ?? [])];
}

function mergeCounters(target: AgentRunSnapshot, other: Pick<AgentRunSnapshot, "latestContext" | "executionUsage">): boolean {
  let changed = false;
  if (other.executionUsage && (!target.executionUsage || BigInt(other.executionUsage.sequence) > BigInt(target.executionUsage.sequence))) {
    target.executionUsage = other.executionUsage;
    changed = true;
  }
  if (other.latestContext && (!target.latestContext || BigInt(other.latestContext.sequence) > BigInt(target.latestContext.sequence))) {
    target.latestContext = other.latestContext;
    changed = true;
  }
  return changed;
}

export function reconcileHistoryProjection(current: AgentRunSnapshot, prior: HistoryProjectionClock | undefined, item: AgentWatchItem, compact: boolean) {
  const clock: HistoryProjectionClock = prior?.runId === current.ref.id && prior.generation === current.generation ? structuredClone(prior)
    : { runId: current.ref.id, generation: current.generation, lifecycle: current.lastSequence, details: current.lastSequence, changes: {} };
  const incoming = item.kind === "snapshot" ? item.snapshot : item.event.type === "run.updated" ? item.event.data.snapshot as AgentRunSnapshot : undefined;
  const sequence = item.kind === "event" ? item.event.sequence : item.snapshot.lastSequence;
  const at = BigInt(sequence), ahead = at > BigInt(current.lastSequence);
  let next: AgentRunSnapshot;
  if (incoming) {
    next = { ...current };
    const later = (key: string) => BigInt(clock.changes[key] ?? "0") > at;
    const lifecycle = at >= BigInt(clock.lifecycle);
    const details = !compact && at >= BigInt(clock.details);
    const accounting = mergeCounters(next, incoming);
    if (!lifecycle && !details && !accounting) return;
    if (lifecycle) {
      next.state = incoming.state; next.phase = incoming.phase; next.stopConfirmed = incoming.stopConfirmed;
      next.effects = incoming.effects; next.configurationRevision = incoming.configurationRevision; next.freshness = incoming.freshness;
      next.pending = mergeRows(incoming.pending, current.pending, decisionSlot, later) ?? [];
      clock.lifecycle = sequence;
    }
    if (details) {
      next.messages = mergeRows(incoming.messages, current.messages, m => slot("message", m.id, m.source), later);
      next.tools = mergeRows(incoming.tools, current.tools, t => slot("tool", t.id, t.source), later);
      next.agents = mergeRows(incoming.agents, current.agents, a => slot("agent", a.agentId), later);
      next.decisions = mergeRows(incoming.decisions, current.decisions, d => decisionSlot(d.decision), later);
      next.pendingContinuations = mergeRows(incoming.pendingContinuations, current.pendingContinuations, c => slot("control", c.requestId), later);
      if (!later("result.available")) next.result = incoming.result;
      if (!later("selection.updated")) next.selection = incoming.selection;
      next.coverage = incoming.coverage;
      clock.details = sequence;
      for (const [key, position] of Object.entries(clock.changes)) if (BigInt(position) <= at) delete clock.changes[key];
    }
    if (ahead || at === BigInt(current.lastSequence)) {
      next.cursor = incoming.cursor; next.observedAt = incoming.observedAt;
      next.lastSequence = sequence; next.revision = incoming.revision;
    }
  } else if (item.kind === "event") {
    const { event } = item, key = eventSlot(event);
    const usable = key && at > BigInt(clock.changes[key] ?? clock.details);
    const counter = event.type === "usage.updated" || event.type === "context.updated";
    if (!ahead && !usable && !counter) return;
    // The reducer needs an earlier frontier to read an independently positioned fact.
    const base = ahead ? current : { ...current, lastSequence: String(at - 1n), revision: event.revision };
    next = reduceAgentRunProjection(createAgentRunProjection(base), item, true).snapshot;
    if (event.type.startsWith("decision.") && at <= BigInt(clock.lifecycle)) next.pending = current.pending;
    if (key && usable) clock.changes[key] = sequence;
    if (!ahead) {
      next.lastSequence = current.lastSequence; next.cursor = current.cursor;
      next.revision = current.revision; next.observedAt = current.observedAt;
    }
    mergeCounters(next, current);
    if (!ahead && counter && next.executionUsage?.sequence === current.executionUsage?.sequence
      && next.latestContext?.sequence === current.latestContext?.sequence) return;
  } else return;
  return { clock, projection: createAgentRunProjection(next) };
}
