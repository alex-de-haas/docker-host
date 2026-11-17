import { createHash } from "node:crypto";
import type { AgentPendingDecision, AgentToolBlock, AgentSource, AgentRunState } from "@hosty-sdk/app/agent";
import type { HarnessEventSource } from "./internal/harness/adapter.js";
import type { WorkerEvent, WorkerReceipt } from "./internal/worker/contracts.js";
import { ProviderStore, increment, valueHash, type RunRecord, type SessionRecord } from "./store.js";

export const publicToolId = (id: string, agentId = "root") => "tool_" + createHash("sha256").update(agentId === "root" ? id : agentId + "\0" + id).digest("base64url");
const publicAgentId = (id: string) => id === "root" ? "root" : "agent_" + createHash("sha256").update(id).digest("base64url");
function publicEffectId(identity: string): string {
  try {
    const value: unknown = JSON.parse(identity);
    if (Array.isArray(value) && value.length === 3 && value[0] === "agent" && typeof value[1] === "string" && typeof value[2] === "string")
      return publicToolId(value[2], publicAgentId(value[1]));
  } catch { /* Root native effect IDs remain ordinary private strings. */ }
  return publicToolId(identity);
}
export function publicSource(native?: HarnessEventSource): AgentSource {
  if (!native) return { agentId: "root" };
  return { agentId: publicAgentId(native.agentId), ...(native.parentAgentId ? { parentAgentId: publicAgentId(native.parentAgentId) } : {}), ...(native.parentToolCallId ? { parentToolCallId: publicToolId(native.parentToolCallId, publicAgentId(native.parentAgentId ?? "root")) } : {}) };
}
const clipped = (text: string, size = 128 * 1024) => Buffer.byteLength(text) <= size ? text : new TextDecoder().decode(Buffer.from(text).subarray(0, size), { stream: true });
const bounded = (value: unknown) => { const text = JSON.stringify(value); return text && Buffer.byteLength(text) <= 8 * 1024 ? value : { truncated: true }; };
export function nativeDecision(frame: WorkerEvent): AgentPendingDecision | null {
  const event = frame.event;
  if (event.type === "approval_request") return { id: event.approvalId, revision: String(frame.sequence), kind: "approval", delivery: "continue_run", title: event.title,
    source: publicSource(event.source), toolCallId: event.toolUseId ? publicToolId(event.toolUseId, publicSource(event.source).agentId) : undefined, toolName: event.toolName, input: bounded(event.input) };
  if (event.type === "question_request") return { id: event.questionId, revision: String(frame.sequence), kind: "question", delivery: event.delivery === "message" ? "next_turn" : "continue_run", source: publicSource(event.source),
    questions: event.questions.map((q, at) => ({ id: q.id ?? String(at), text: q.question, header: q.header, multiple: q.multiSelect, allowText: q.allowText,
      options: q.options.map((option, index) => ({ id: option.id ?? String(index), label: option.label, description: option.description, preview: option.preview })) })) };
  return null;
}
function tool(record: RunRecord, id: string): AgentToolBlock | undefined { return record.snapshot.tools?.find(value => value.id === id); }
/** A disappeared native callback is not delivery proof; an applied retained control is. */
export function projectAppliedDecisionControls(store: ProviderStore, record: RunRecord): boolean {
  let changed = false;
  for (const control of Object.values(record.controls)) {
    const decision = control.decision;
    const response = control.response as { kind?: string } | undefined;
    if (control.receipt.state !== "applied" || !decision || decision.delivery !== "continue_run" || response?.kind !== decision.kind) continue;
    const history = record.snapshot.decisions?.find(entry => entry.decision.id === decision.id);
    const pending = record.snapshot.pending.some(entry => entry.id === decision.id && entry.revision === decision.revision);
    // Do not recreate pruned history or replace a newer request reusing the native ID.
    if (!history && !pending || history && history.decision.revision !== decision.revision) continue;
    if (pending) { record.snapshot.pending = record.snapshot.pending.filter(entry => entry.id !== decision.id || entry.revision !== decision.revision); changed = true; }
    if (history?.state === "resolved" && valueHash([history.response]) === valueHash([control.response])) continue;
    store.emit(record, "decision.resolved", { decisionId: decision.id, decision: structuredClone(decision), state: "resolved", response: structuredClone(control.response) }, decision.source);
    changed = true;
  }
  return changed;
}
export function projectEvent(store: ProviderStore, session: SessionRecord, record: RunRecord, frame: WorkerEvent): void {
  if (frame.sequence <= record.nativeSequence) return;
  record.nativeSequence = frame.sequence;
  const event = frame.event, snapshot = record.snapshot, source = publicSource(event.source), child = source.agentId !== "root";
  const emit = (type: Parameters<ProviderStore["emit"]>[1], data: Record<string, unknown>) => store.emit(record, type, data, source);
  const truncated = (kind: "messages" | "tools") => {
    const coverage = snapshot.coverage ??= { messages: "complete", tools: "complete" };
    if (coverage[kind] === "truncated") return;
    coverage[kind] = "truncated";
    emit("warning", { code: "snapshot_truncated", message: `The bounded public ${kind} snapshot is incomplete; it is not the full native context.`, coverage: structuredClone(coverage) });
  };
  const text = (value: string) => { if (Buffer.byteLength(value) > 128 * 1024) truncated("messages"); return clipped(value); };
  const currentIds = record.nativeMessageIds ??= {};
  let messageId = currentIds[source.agentId] ?? (!child ? record.nativeMessageId : undefined);
  const messages = snapshot.messages ??= [];
  const message = () => {
    let found = messages.find(value => value.id === messageId);
    if (!found || found.state === "complete") {
      messageId = `${snapshot.ref.id}-message-${frame.sequence}`; currentIds[source.agentId] = messageId;
      found = { id: messageId, role: "assistant", text: "", state: "streaming", source }; messages.push(found); emit("message.started", { messageId });
    }
    return found;
  };
  const fitMessages = () => {
    while (messages.length > 32) { truncated("messages"); messages.shift(); }
    let size = messages.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
    for (const item of messages) if (size > 128 * 1024) { truncated("messages"); const before = Buffer.byteLength(item.text), keep = Math.max(0, before - (size - 128 * 1024)); item.text = clipped(item.text, keep); size -= before - Buffer.byteLength(item.text); }
  };
  const agent = (state: AgentRunState, confirmed = false) => {
    const agents = snapshot.agents ??= []; let entry = agents.find(item => item.agentId === source.agentId);
    if (!entry) { entry = { ...source, state, stopConfirmed: confirmed }; agents.push(entry); } else { entry.state = state; entry.stopConfirmed = confirmed; }
    emit("agent.updated", { agent: structuredClone(entry) });
  };
  switch (event.type) {
    case "agent_status": {
      const statusSource = publicSource({ agentId: event.agentId, parentAgentId: event.parentAgentId, parentToolCallId: event.parentToolCallId });
      const agents = snapshot.agents ??= [], existing = agents.find(item => item.agentId === statusSource.agentId);
      const entry = { ...statusSource, state: event.state, stopConfirmed: event.stopConfirmed === true };
      if (existing) Object.assign(existing, entry); else agents.push(entry);
      store.emit(record, "agent.updated", { agent: entry }, statusSource); break;
    }
    case "harness_session":
      if (child) break;
      if (session.nativeId && session.nativeId !== event.harnessSessionId) throw new Error("Native continuation changed its session identity.");
      session.nativeId = event.harnessSessionId; session.session.nativeState = "available";
      emit("session.bound", { sessionId: session.id, nativeState: "available" }); break;
    case "assistant_delta": { const block = message(); block.text = text(block.text + event.text); fitMessages(); emit("message.delta", { messageId, text: text(event.text) }); break; }
    case "assistant_text": { const block = message(); block.text = text(event.text); block.state = "complete"; fitMessages(); emit("message.completed", { messageId, text: block.text, truncated: snapshot.coverage?.messages === "truncated" }); break; }
    case "tool_use": {
      const id = publicToolId(event.toolUseId ?? `unidentified-${frame.sequence}`, source.agentId);
      const block: AgentToolBlock = { id, source, name: event.toolName, input: bounded(event.input), state: "running" };
      (snapshot.tools ??= []).push(block); if (snapshot.tools.length > 16) { truncated("tools"); snapshot.tools.shift(); }
      if (JSON.stringify(block.input) === '{"truncated":true}') truncated("tools");
      emit("tool.started", { toolCallId: id, name: block.name, input: block.input, state: block.state }); break;
    }
    case "tool_result": { const block = tool(record, publicToolId(event.toolUseId, source.agentId)); if (block) { block.state = event.status; block.output = clipped(event.output, 8 * 1024); block.truncated = event.truncated || Buffer.byteLength(event.output) > 8 * 1024; if (block.truncated) truncated("tools"); }
      emit("tool.completed", { toolCallId: publicToolId(event.toolUseId, source.agentId), name: block?.name ?? "unknown", output: event.output, state: event.status, truncated: event.truncated }); break; }
    case "command_result": { const block = tool(record, publicToolId(event.toolUseId, source.agentId)); if (block) { block.state = event.status; block.command = { status: event.status, exitCode: event.exitCode, durationMs: event.durationMs, summary: event.summary ? clipped(event.summary, 8192) : undefined }; }
      emit("tool.completed", { toolCallId: publicToolId(event.toolUseId, source.agentId), name: block?.name ?? "unknown", state: event.status, exitCode: event.exitCode, durationMs: event.durationMs, summary: event.summary }); break; }
    case "approval_request": case "question_request": { const decision = nativeDecision(frame)!;
      if (record.decisionsFenced) { emit("decision.resolved", { decisionId: decision.id, decision, state: "superseded" }); break; }
      if (!snapshot.pending.some(value => value.id === decision.id)) snapshot.pending.push(decision);
      if (event.type === "question_request" && event.blocking !== false && event.delivery !== "message")
        (record.blockingQuestionSince ??= {})[String(frame.sequence)] ??= new Date().toISOString();
      store.lifecycle(record); emit("decision.requested", { decisionId: decision.id, decision }); break; }
    case "execution_model": { const selected = { requested: event.requested, effective: event.reported }; if (!child) snapshot.selection = selected; emit("selection.updated", selected); break; }
    case "provider_usage": emit("usage.updated", { usage: event.usage }); break;
    case "context_usage": {
      const observation = store.emit(record, "context.updated", { usage: event.usage }, source);
      if (!child) snapshot.latestContext = { sequence: observation.sequence, usage: event.usage === null ? null : { ...structuredClone(event.usage) } };
      break;
    }
    case "result": {
      if (child) { agent(["success", "completed", "succeeded"].includes(event.status) ? "succeeded" : "failed"); break; }
      const rootMessages = messages.filter(item => !item.source || item.source.agentId === "root");
      snapshot.result = { status: ["success", "completed", "succeeded"].includes(event.status) ? "succeeded" : "failed", messageId: rootMessages.at(-1)?.id, text: text(rootMessages.map(item => item.text).filter(Boolean).join("\n\n")) };
      emit("result.available", { result: snapshot.result }); break;
    }
    case "error": if (child) { agent("failed"); emit("warning", { code: "child_execution_failed", message: clipped(event.message, 4096) }); }
      else { snapshot.result = { status: "failed", error: { code: "native_execution_failed", message: clipped(event.message, 4096), retryable: false } }; emit("result.available", { result: snapshot.result }); } break;
    case "notice": for (const kind of event.incomplete ?? []) truncated(kind); emit("warning", { code: "native_notice", message: clipped(event.message, 4096) }); break;
    case "prompt_suggestion": emit("extension", { namespace: "hosty.agent.predictions", name: "predictions", text: event.text, reason: event.reason }); break;
    case "activity": emit("extension", { namespace: "hosty.agent.activity", name: "activity", activity: bounded(event.activity) }); break;
    case "answer_complete": emit("extension", { namespace: "hosty.agent.answer", name: "answer.complete" }); break;
    case "native_effect": case "execution_parked": break;
  }
}
export function projectReceipt(store: ProviderStore, session: SessionRecord, record: RunRecord, receipt: WorkerReceipt): void {
  const snapshot = record.snapshot;
  const before = valueHash([snapshot.state, snapshot.phase, snapshot.stopConfirmed, snapshot.pending, snapshot.effects, snapshot.selection, snapshot.agents]);
  record.nativeRevision = receipt.revision; record.nativeGeneration = receipt.generation;
  if (receipt.usage && Number.isSafeInteger(receipt.usage.sequence) && receipt.usage.sequence >= 0 && (!snapshot.executionUsage || BigInt(receipt.usage.sequence) > BigInt(snapshot.executionUsage.sequence))) {
    snapshot.executionUsage = { sequence: String(receipt.usage.sequence), activeMs: receipt.usage.activeMs, unknown: receipt.usage.unknown };
    store.emit(record, "usage.updated", { execution: structuredClone(snapshot.executionUsage) });
  }
  snapshot.stopConfirmed = receipt.exitConfirmed === true;
  snapshot.state = ({ accepted: "queued", running: "running", awaiting_input: "waiting_for_input", suggesting: "running", parking: "waiting_for_input", parked: "waiting_for_input", cancelling: "running", completed: snapshot.result?.status === "failed" ? "failed" : "succeeded", failed: "failed", cancelled: "cancelled", interrupted: "unknown" } as const)[receipt.state];
  snapshot.phase = ({ accepted: "preparing", running: "executing", awaiting_input: "waiting", suggesting: "finalizing", parking: "waiting", parked: "parked", cancelling: "cancelling", completed: "terminal", failed: "terminal", cancelled: "terminal", interrupted: "interrupted" } as const)[receipt.state];
  snapshot.freshness = receipt.state === "interrupted" ? "last_known" : "current";
  const pendingIds = new Set((receipt.pending ?? []).map(frame => nativeDecision(frame)?.id));
  snapshot.pending = snapshot.pending.filter(value => value.delivery === "next_turn" || record.proxyDecisions?.includes(value.id) || pendingIds.has(value.id));
  if (snapshot.pending.some(value => record.proxyDecisions?.includes(value.id)) && receipt.state === "running") { snapshot.state = "waiting_for_input"; snapshot.phase = "waiting"; }
  snapshot.effects = { certainty: receipt.state === "interrupted" || Object.values(receipt.effects ?? {}).includes("unknown") ? "unknown" : "known", unresolvedCallIds: Object.keys(receipt.effects ?? {}).map(publicEffectId) };
  if (snapshot.effects.unresolvedCallIds.length && snapshot.stopConfirmed) { snapshot.stopConfirmed = false; snapshot.state = "unknown"; snapshot.phase = "interrupted"; snapshot.freshness = "last_known"; }
  if (snapshot.stopConfirmed) {
    for (const agent of snapshot.agents ?? []) {
      const state = ["queued", "running", "waiting_for_input"].includes(agent.state) && receipt.state !== "parked"
        ? "unknown" : agent.state;
      if (agent.stopConfirmed === true && agent.state === state) continue;
      agent.stopConfirmed = true; agent.state = state;
      const source = { agentId: agent.agentId, ...(agent.parentAgentId ? { parentAgentId: agent.parentAgentId } : {}),
        ...(agent.parentToolCallId ? { parentToolCallId: agent.parentToolCallId } : {}) };
      store.emit(record, "agent.updated", { agent: structuredClone(agent) }, source);
    }
  }
  if (receipt.state === "parked" && snapshot.stopConfirmed) {
    for (const decision of snapshot.pending) {
      const frame = receipt.pending?.find(frame => frame.event.type === "question_request" && frame.event.questionId === decision.id
        && frame.event.blocking !== false && String(frame.sequence) === decision.revision);
      if (decision.kind !== "question" || decision.delivery !== "continue_run" || !frame) continue;
      decision.delivery = "next_turn"; decision.revision = increment(decision.revision);
      store.emit(record, "decision.requested", { decisionId: decision.id, decision: structuredClone(decision) }, decision.source);
    }
  }
  const waiting = new Set((receipt.pending ?? []).filter(frame => {
    const event = frame.event;
    return event.type === "question_request" && event.blocking !== false
      && snapshot.pending.some(decision => decision.id === event.questionId && decision.delivery === "continue_run" && decision.revision === String(frame.sequence));
  }).map(frame => String(frame.sequence)));
  if (record.blockingQuestionSince) record.blockingQuestionSince = Object.fromEntries(Object.entries(record.blockingQuestionSince).filter(([sequence]) => waiting.has(sequence)));
  if (receipt.snapshot?.nativeSessionId) { session.nativeId = receipt.snapshot.nativeSessionId; session.session.nativeState = "available"; }
  if (snapshot.stopConfirmed && session.session.activeRun?.id === snapshot.ref.id) {
    session.session.activeRun = null; session.session.revision = increment(session.session.revision);
    record.completedAt ??= new Date().toISOString();
  }
  projectAppliedDecisionControls(store, record);
  if (before !== valueHash([snapshot.state, snapshot.phase, snapshot.stopConfirmed, snapshot.pending, snapshot.effects, snapshot.selection, snapshot.agents])) {
    if (receipt.exitConfirmed === true && snapshot.effects.unresolvedCallIds.length)
      store.emit(record, "warning", { code: "native_effect_outcomes_unresolved",
        message: `The native process has stopped, but outcomes of ${snapshot.effects.unresolvedCallIds.length} native tool call(s) remain unresolved. This execution stays fenced until supported provider reconciliation.` });
    store.lifecycle(record);
  }
}
