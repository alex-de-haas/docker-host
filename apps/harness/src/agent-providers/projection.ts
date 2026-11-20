import type {
  AgentEvent, AgentHistoryObservation, AgentProviderRef, AgentMessageBlock, AgentPendingDecision, AgentResult, AgentRunSnapshot,
  AgentSource, AgentToolBlock, AgentWatchItem,
} from "@hosty-sdk/app/agent";
import { validateAgentEvent, validateAgentRunSnapshot } from "@hosty-sdk/app/agent/server";

export type AgentRunProjection = {
  snapshot: AgentRunSnapshot;
  cursor: string;
  messages: AgentMessageBlock[];
  tools: AgentToolBlock[];
  pending: AgentPendingDecision[];
  result?: AgentResult;
  childResults: Array<{ source: AgentSource; result: AgentResult }>;
};

/** Retained results can contain the final reply after its source message falls outside a bounded snapshot. */
export function historyMessages(projection: AgentRunProjection): AgentMessageBlock[] {
  const final = projection.result;
  if (!final?.text || projection.messages.some(message => message.role === "assistant" && !message.source?.parentAgentId
    && message.state === "complete" && (final.messageId ? message.id === final.messageId : message.text === final.text))) return projection.messages;
  return [...projection.messages, { id: final.messageId ?? "retained-result", role: "assistant", state: "complete", text: final.text }];
}

/** The caller must obtain an authoritative snapshot; this reducer never repairs missing events. */
export class AgentProjectionResyncError extends Error {
  readonly code = "resync_required";
  constructor(readonly reason: string) { super(`Resynchronize the provider run: ${reason}.`); this.name = "AgentProjectionResyncError"; }
}
function invalid(reason: string): never { throw new AgentProjectionResyncError(reason); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, field: string): string { if (typeof value !== "string") invalid(`invalid ${field}`); return value; }
function identity(value: unknown, field: string): string { const result = text(value, field); if (!result) invalid(`missing ${field}`); return result; }
function cursor(value: string): void { if (!value || value.length > 8192 || /[\r\n]/.test(value)) invalid("invalid replay cursor"); }
function scope(source?: AgentSource): string { return JSON.stringify([source?.agentId ?? null, source?.parentAgentId ?? null, source?.parentToolCallId ?? null]); }
function sameSource(left: AgentSource | undefined, right: AgentSource | undefined): boolean { return scope(left) === scope(right); }
function matches(item: { id: string; source?: AgentSource }, id: string, source: AgentSource): boolean {
  // Older snapshots may omit the root source. A child can never claim that root's item.
  return item.id === id && (item.source ? sameSource(item.source, source) : source.parentAgentId === undefined);
}
function assertDistinct(items: Array<{ id: string; source?: AgentSource }>): void {
  const keys = new Set<string>();
  for (const item of items) {
    const key = JSON.stringify([scope(item.source), item.id]);
    if (keys.has(key)) invalid("duplicate snapshot item identity");
    keys.add(key);
  }
}
function validateSnapshot(snapshot: AgentRunSnapshot): void {
  try { validateAgentRunSnapshot(snapshot); } catch { invalid("invalid snapshot"); }
  cursor(snapshot.cursor);
  assertDistinct(snapshot.messages ?? []); assertDistinct(snapshot.tools ?? []); assertDistinct(snapshot.pending);
  const agents = snapshot.agents ?? [];
  if (new Set(agents.map(agent => agent.agentId)).size !== agents.length) invalid("duplicate snapshot agent identity");
}
function sameRun(left: AgentRunSnapshot, right: AgentRunSnapshot): void {
  const a = left.ref.provider, b = right.ref.provider;
  if (left.ref.id !== right.ref.id || left.sessionId !== right.sessionId || a.appId !== b.appId
    || a.installationId !== b.installationId || a.key !== b.key) invalid("run or installation identity changed");
  if (left.generation !== right.generation) invalid("execution generation changed");
}

/** Snapshot contents and their replay watermark are replaced as one value. */
export function createAgentRunProjection(value: AgentRunSnapshot): AgentRunProjection {
  validateSnapshot(value);
  const snapshot = structuredClone(value);
  return { snapshot, cursor: snapshot.cursor, messages: snapshot.messages ?? [], tools: snapshot.tools ?? [],
    pending: snapshot.pending, ...(snapshot.result ? { result: snapshot.result } : {}), childResults: [] };
}
/** Reduce one archived fact for display without borrowing the current run's state or watermark. */
export function projectHistoryFact(provider: AgentProviderRef, fact: AgentHistoryObservation): AgentRunProjection {
  const { item } = fact;
  if (item.kind === "snapshot") return createAgentRunProjection(item.snapshot);
  if (item.event.type === "run.updated") return createAgentRunProjection(item.event.data.snapshot as AgentRunSnapshot);
  const base = createAgentRunProjection({
    ref: { provider, id: fact.runId }, sessionId: fact.sessionId, generation: fact.generation,
    state: "unknown", phase: "interrupted", stopConfirmed: false, freshness: "unavailable",
    revision: "0", lastSequence: "0", configurationRevision: "1", observedAt: item.event.occurredAt,
    cursor: item.cursor, pending: [], effects: { certainty: "unknown", unresolvedCallIds: [] },
  });
  return reduceAgentRunProjection(base, item, true);
}

function replace(current: AgentRunProjection, snapshot: AgentRunSnapshot): AgentRunProjection {
  validateSnapshot(snapshot); sameRun(current.snapshot, snapshot);
  if (BigInt(snapshot.lastSequence) < BigInt(current.snapshot.lastSequence)
    || BigInt(snapshot.revision) < BigInt(current.snapshot.revision)) invalid("snapshot watermark regressed");
  if (current.snapshot.latestContext && snapshot.latestContext
    && BigInt(snapshot.latestContext.sequence) < BigInt(current.snapshot.latestContext.sequence)) invalid("latest context regressed");
  return createAgentRunProjection(snapshot);
}

function message(current: AgentMessageBlock[], event: AgentEvent): AgentMessageBlock[] {
  const id = identity(event.data.messageId, "message ID"), index = current.findIndex(item => matches(item, id, event.source));
  const previous = current[index];
  const supplied = event.data.text === undefined ? undefined : text(event.data.text, "message text");
  const role = event.data.role ?? previous?.role ?? "assistant";
  if (role !== "assistant" && role !== "user" && role !== "system") invalid("invalid message role");
  const next: AgentMessageBlock = { id, source: structuredClone(event.source), role,
    text: event.type === "message.delta" ? (previous?.text ?? "") + (supplied ?? "") : supplied ?? previous?.text ?? "",
    state: event.type === "message.completed" ? "complete" : "streaming" };
  return index < 0 ? [...current, next] : current.map((item, position) => position === index ? next : item);
}
function tool(current: AgentToolBlock[], event: AgentEvent): AgentToolBlock[] {
  const id = identity(event.data.toolCallId, "tool-call ID"), index = current.findIndex(item => matches(item, id, event.source));
  const previous = current[index], name = event.data.name === undefined ? previous?.name : identity(event.data.name, "tool name");
  if (!name) invalid("tool output has no named tool");
  const output = event.data.output === undefined ? undefined : text(event.data.output, "tool output");
  const state = event.data.state ?? (event.type === "tool.completed" ? "completed" : "running");
  if (!["running", "completed", "failed", "cancelled", "unknown"].includes(String(state))) invalid("invalid tool state");
  if (event.data.truncated !== undefined && typeof event.data.truncated !== "boolean") invalid("invalid tool truncation flag");
  const next: AgentToolBlock = { ...(previous ?? {}), id, name, source: structuredClone(event.source), state: state as AgentToolBlock["state"],
    ...(event.data.input !== undefined ? { input: structuredClone(event.data.input) } : {}),
    ...(output !== undefined ? { output: event.type === "tool.output" ? (previous?.output ?? "") + output : output } : {}),
    ...(event.data.truncated !== undefined ? { truncated: event.data.truncated } : {}),
    ...(event.data.command !== undefined ? { command: structuredClone(event.data.command) as AgentToolBlock["command"] }
      : event.data.exitCode !== undefined || event.data.durationMs !== undefined || event.data.summary !== undefined ? { command: {
        status: state as NonNullable<AgentToolBlock["command"]>["status"],
        ...(event.data.exitCode !== undefined ? { exitCode: event.data.exitCode as number } : {}),
        ...(event.data.durationMs !== undefined ? { durationMs: event.data.durationMs as number } : {}),
        ...(event.data.summary !== undefined ? { summary: event.data.summary as string } : {}),
      } } : {}) };
  return index < 0 ? [...current, next] : current.map((item, position) => position === index ? next : item);
}
function decision(current: AgentPendingDecision[], event: AgentEvent): AgentPendingDecision[] {
  const id = identity(event.data.decisionId, "decision ID"), index = current.findIndex(item => matches(item, id, event.source));
  if (event.type === "decision.resolved" || ["resolved", "cancelled", "superseded"].includes(String(event.data.state)))
    return current.filter((_, position) => position !== index);
  if (event.data.decision === undefined) {
    if (event.type === "decision.requested") invalid("decision request has no pending decision");
    return current;
  }
  // The public event validator checked the decision's shape and decimal revision.
  const supplied = event.data.decision as AgentPendingDecision;
  if (supplied.source && !sameSource(supplied.source, event.source)) invalid("decision source changed");
  if (current[index] && BigInt(supplied.revision) < BigInt(current[index]!.revision)) invalid("decision revision regressed");
  const next = { ...structuredClone(supplied), source: structuredClone(event.source) };
  return index < 0 ? [...current, next] : current.map((item, position) => position === index ? next : item);
}
function result(value: unknown): AgentResult {
  if (!object(value) || !["succeeded", "failed", "cancelled"].includes(String(value.status))
    || value.text !== undefined && typeof value.text !== "string"
    || value.messageId !== undefined && (typeof value.messageId !== "string" || !value.messageId)
    || value.schemaValid !== undefined && typeof value.schemaValid !== "boolean") invalid("invalid run result");
  return structuredClone(value) as AgentResult;
}
function selection(value: Record<string, unknown>): NonNullable<AgentRunSnapshot["selection"]> {
  for (const field of ["requested", "effective"]) {
    const item = value[field];
    if (!object(item) || ![item.model, item.reasoningEffort].every(part => part === null || typeof part === "string")) invalid("invalid execution selection");
  }
  return structuredClone({ requested: value.requested, effective: value.effective }) as NonNullable<AgentRunSnapshot["selection"]>;
}

/** Pure reduction: callers persist this whole value, including its cursor, in one transaction. */
export function reduceAgentRunProjection(current: AgentRunProjection, item: AgentWatchItem, sparseHistory = false): AgentRunProjection {
  if (item.kind === "snapshot") return replace(current, item.snapshot);
  const { event } = item;
  try { validateAgentEvent(event); } catch { invalid(event.type === "agent.updated" ? "invalid agent status" : "invalid event"); }
  cursor(item.cursor);
  if (event.runId !== current.snapshot.ref.id) invalid("event belongs to another run");
  if (event.generation !== current.snapshot.generation) invalid("execution generation changed");
  const sequence = BigInt(event.sequence), previous = BigInt(current.snapshot.lastSequence);
  if (sequence <= previous) return current;
  if (!sparseHistory && sequence !== previous + 1n) invalid("event sequence gap");
  if (BigInt(event.revision) < BigInt(current.snapshot.revision)) invalid("event revision regressed");
  if (event.type === "run.updated") {
    const snapshot = event.data.snapshot as AgentRunSnapshot;
    if (snapshot.cursor !== item.cursor) invalid("snapshot cursor differs from event watermark");
    return replace(current, snapshot);
  }

  let messages = current.messages, tools = current.tools, pending = current.pending, finalResult = current.result;
  let childResults = current.childResults;
  const snapshot = { ...current.snapshot };
  if (event.type.startsWith("message.")) messages = message(messages, event);
  else if (event.type.startsWith("tool.")) tools = tool(tools, event);
  else if (event.type.startsWith("decision.")) {
    const before = pending.find(entry => matches(entry, String(event.data.decisionId), event.source));
    pending = decision(pending, event);
    const history = structuredClone(snapshot.decisions ?? []), index = history.findIndex(entry => matches(entry.decision, String(event.data.decisionId), event.source));
    const supplied = (event.data.decision as AgentPendingDecision | undefined) ?? before ?? history[index]?.decision;
    if (supplied) {
      const state = event.type === "decision.resolved" ? event.data.state === "superseded" ? "superseded" : event.data.state === "unknown" ? "unknown" : "resolved" : "pending";
      const entry: NonNullable<AgentRunSnapshot["decisions"]>[number] = { decision: { ...supplied, source: event.source }, state,
        ...(event.data.response ? { response: structuredClone(event.data.response) as NonNullable<AgentRunSnapshot["decisions"]>[number]["response"] } : {}) };
      if (index < 0) history.push(entry); else history[index] = { ...history[index], ...entry };
      snapshot.decisions = history;
    }
  }
  else if (event.type === "agent.updated") {
    const supplied = event.data.agent as NonNullable<AgentRunSnapshot["agents"]>[number];
    if (!object(supplied) || !["queued", "running", "waiting_for_input", "succeeded", "failed", "cancelled", "unknown"].includes(String(supplied.state))
      || supplied.stopConfirmed !== undefined && typeof supplied.stopConfirmed !== "boolean") invalid("invalid agent status");
    if (!sameSource(supplied, event.source)) invalid("agent status source changed");
    const agents = structuredClone(snapshot.agents ?? []), index = agents.findIndex(agent => agent.agentId === supplied.agentId);
    if (index >= 0 && !sameSource(agents[index], supplied)) invalid("agent parent changed");
    // The transcript retains each prompt and response at its original native position. Accumulating
    // those event payloads again in the lifecycle snapshot can exceed its one-MiB wire allowance.
    const status = { ...structuredClone(event.source), state: supplied.state,
      ...(supplied.stopConfirmed !== undefined ? { stopConfirmed: supplied.stopConfirmed } : {}) };
    if (index < 0) agents.push(status); else agents[index] = status;
    snapshot.agents = agents;
  }
  else if (event.type === "selection.updated" && event.source.parentAgentId === undefined) snapshot.selection = selection(event.data);
  else if (event.type === "usage.updated" && event.data.execution !== undefined)
    snapshot.executionUsage = structuredClone(event.data.execution) as AgentRunSnapshot["executionUsage"];
  else if (event.type === "context.updated" && event.source.parentAgentId === undefined)
    snapshot.latestContext = { sequence: event.sequence, usage: structuredClone(event.data.usage) as Record<string, unknown> | null };
  else if (event.type === "control.updated") {
    const receipt = event.data.receipt as import("@hosty-sdk/app/agent").AgentControlReceipt | undefined;
    if (receipt?.continuation) {
      const entries = structuredClone(snapshot.pendingContinuations ?? []), index = entries.findIndex(entry => entry.requestId === event.data.requestId);
      const next = { requestId: String(event.data.requestId), ...receipt.continuation };
      if (index < 0) entries.push(next); else entries[index] = next;
      snapshot.pendingContinuations = entries;
    }
  }
  else if (event.type === "session.bound" && event.data.sessionId !== snapshot.sessionId) invalid("event belongs to another session");
  else if (event.type === "result.available") {
    const value = result(event.data.result);
    if (event.source.parentAgentId === undefined) finalResult = value;
    else {
      const index = childResults.findIndex(child => sameSource(child.source, event.source));
      const next = { source: structuredClone(event.source), result: value };
      childResults = index < 0 ? [...childResults, next] : childResults.map((child, position) => position === index ? next : child);
    }
  }
  Object.assign(snapshot, { revision: event.revision, lastSequence: event.sequence, cursor: item.cursor, observedAt: event.occurredAt, messages, tools, pending });
  if (finalResult) snapshot.result = finalResult; else delete snapshot.result;
  return { snapshot, cursor: item.cursor, messages, tools, pending, ...(finalResult ? { result: finalResult } : {}), childResults };
}
