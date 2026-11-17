import type { AssistantEvent } from "./assistant-api";
import { transcriptDecisionId } from "../../../src/agent-providers/decision-identity";
import { isListedToolUse } from "./tool-display";
import { commandOutcome, commandResultId, isCommandTool, type CommandOutcome } from "./transcript-activity";
import { canShowToolOutput, recordedToolOutput, type ToolOutput } from "./tool-output";
/** How an approval was resolved: the verdict, and the operator's reason when a deny carried one. */
export type ApprovalDecision = { decision: string; message: string | null };
export type TranscriptItem =
  | { kind: "event"; key: string; event: AssistantEvent }
  | { kind: "activity"; key: string; events: AssistantEvent[]; commandResults: Record<number, CommandOutcome>; toolResults: Record<number, ToolOutput>; approvals: Record<number, ApprovalDecision> };
const identity = commandResultId;
const turnBoundary = (event: AssistantEvent) => ["user_message", "session_created", "result", "error"].includes(event.type)
  || event.type === "session_status" && ["idle", "cancelled", "failed", "abandoned"].includes(String(event.status));
type FailedObservation = { runId: string; generation: string; seq: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function failedObservation(event: AssistantEvent): FailedObservation | undefined {
  const value = event.providerObservation;
  if (event.type !== "session_status" || event.status !== "failed" || !value || typeof value !== "object" || Array.isArray(value)) return;
  const observation = value as Record<string, unknown>;
  if (observation.stopConfirmed === false && typeof observation.runId === "string" && uuid.test(observation.runId)
    && typeof observation.generation === "string" && uuid.test(observation.generation))
    return { runId: observation.runId, generation: observation.generation, seq: event.seq };
}
function observedCalls(calls: Map<string, AssistantEvent[]>, observation?: FailedObservation): Map<string, AssistantEvent[]> {
  return observation ? new Map([...calls].filter(([, candidates]) => candidates.every(call => call.providerGeneration === observation.generation
    && typeof call.providerEventId === "string" && call.providerEventId.startsWith(`${observation.runId}:tool:`)))) : new Map();
}
function sameObservedCall(call: AssistantEvent, result: AssistantEvent, observation: FailedObservation, kind: "command" | "output"): boolean {
  const scope = String(call.providerEventId).slice(`${observation.runId}:tool:`.length);
  return result.providerGeneration === observation.generation && typeof result.providerEventId === "string"
    && result.providerEventId.startsWith(`${observation.runId}:${kind}:${scope}:`);
}
/** Pair an approval with the one listed call of its recorded turn that carries the same identity. */
function approvalCalls(events: readonly AssistantEvent[]) {
  const pairs = new Map<string, number>();
  let calls = new Map<string, AssistantEvent[]>(), requests = new Map<string, AssistantEvent[]>();
  const settle = () => {
    for (const [id, [request, ...others]] of requests) {
      const [call, ...more] = calls.get(id) ?? [];
      // Either side repeating its identity is ambiguous; such a card stays on its own.
      if (request && call && !others.length && !more.length && isListedToolUse(String(call.toolName ?? "tool"))) pairs.set(transcriptDecisionId(request), call.seq);
    }
    calls = new Map(); requests = new Map();
  };
  for (const event of events) {
    if (turnBoundary(event)) settle();
    const id = identity(event); if (!id) continue;
    const bucket = event.type === "tool_use" ? calls : event.type === "approval_request" ? requests : undefined;
    bucket?.set(id, [...(bucket.get(id) ?? []), event]);
  }
  settle();
  return pairs;
}
/** Join only a preceding, uniquely identified command from the same factual user turn. */
function commandResults(events: readonly AssistantEvent[]) {
  const results: Record<number, CommandOutcome> = {}, matched = new Set<number>();
  let calls = new Map<string, AssistantEvent[]>();
  let observation: FailedObservation | undefined;
  const outcomes = new Map<number, string>();
  const matchedByCall = new Map<number, number[]>();
  for (const event of events) {
    if (turnBoundary(event)) { observation = failedObservation(event); calls = observedCalls(calls, observation); }
    const id = identity(event); if (!id) continue;
    if (isCommandTool(event)) {
      const prior = calls.get(id) ?? []; prior.push(event); calls.set(id, prior);
      // Repeated native IDs are ambiguous; do not relabel either call with another call's result.
      if (prior.length > 1) prior.forEach(call => { delete results[call.seq]; for (const seq of matchedByCall.get(call.seq) ?? []) matched.delete(seq); });
    } else if (event.type === "command_result") {
      const candidates = calls.get(id); if (candidates?.length !== 1) continue;
      const call = candidates[0], outcome = commandOutcome(event), fingerprint = JSON.stringify(outcome);
      if (!call) continue;
      if (observation && call.seq < observation.seq && !sameObservedCall(call, event, observation, "command")) continue;
      const old = outcomes.get(call.seq);
      results[call.seq] = results[call.seq]?.conflict || old && old !== fingerprint ? { status: "unknown", conflict: true } : outcome;
      outcomes.set(call.seq, old ?? fingerprint); matched.add(event.seq);
      matchedByCall.set(call.seq, [...(matchedByCall.get(call.seq) ?? []), event.seq]);
    }
  }
  return { results, matched };
}
/** Output is attached only to a unique preceding call within its recorded user turn. */
export function toolResults(events: readonly AssistantEvent[]) {
  const results: Record<number, ToolOutput> = {}, matched = new Set<number>();
  let calls = new Map<string, AssistantEvent[]>();
  let observation: FailedObservation | undefined;
  const outcomes = new Map<number, string>(), matchedByCall = new Map<number, number[]>();
  for (const event of events) {
    if (turnBoundary(event)) { observation = failedObservation(event); calls = observedCalls(calls, observation); }
    const id = identity(event); if (!id) continue;
    if (event.type === "tool_use") {
      const prior = calls.get(id) ?? []; prior.push(event); calls.set(id, prior);
      if (prior.length > 1) prior.forEach(call => { delete results[call.seq]; for (const seq of matchedByCall.get(call.seq) ?? []) matched.delete(seq); });
    } else if (event.type === "tool_result") {
      const candidates = calls.get(id), output = recordedToolOutput(event);
      if (candidates?.length !== 1 || !output) continue;
      const call = candidates[0];
      if (observation && call.seq < observation.seq && !sameObservedCall(call, event, observation, "output")) continue;
      if (!canShowToolOutput(String(call.toolName ?? "tool"))) { matched.add(event.seq); continue; }
      const fingerprint = JSON.stringify(output), old = outcomes.get(call.seq);
      results[call.seq] = results[call.seq]?.conflict || old && old !== fingerprint ? { status: "unknown", output: "", conflict: true } : output;
      outcomes.set(call.seq, old ?? fingerprint); matched.add(event.seq);
      matchedByCall.set(call.seq, [...(matchedByCall.get(call.seq) ?? []), event.seq]);
    }
  }
  return { results, matched };
}
/**
 * Group adjacent calls; prose, open decisions and turn boundaries always end a group. A decided
 * approval paired with its call folds into that call's row, so its card, decision and the status
 * changes around it no longer split the group.
 */
export function transcriptItems(events: AssistantEvent[], claimed: ReadonlySet<string>, decided: ReadonlyMap<string, ApprovalDecision> = new Map()): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const joined = commandResults(events), outputs = toolResults(events), paired = approvalCalls(events);
  const folded = new Map<number, ApprovalDecision>(), foldedIds = new Set<string>();
  for (const [approvalId, seq] of paired) {
    const decision = decided.get(approvalId);
    if (decision) { folded.set(seq, decision); foldedIds.add(approvalId); }
  }
  let activity: Extract<TranscriptItem, { kind: "activity" }> | undefined;
  for (const event of events) {
    if (event.type === "command_result" && joined.matched.has(event.seq) || event.type === "tool_result" && outputs.matched.has(event.seq)) continue;
    if (["approval_request", "approval_decision"].includes(event.type) && foldedIds.has(transcriptDecisionId(event))
      || event.type === "session_status" && ["running", "awaiting_approval"].includes(String(event.status))) continue;
    if (event.type === "tool_use") {
      if (!isListedToolUse(String(event.toolName ?? "tool"))) continue;
      if (!activity) { activity = { kind: "activity", key: `activity-${event.seq}`, events: [], commandResults: {}, toolResults: {}, approvals: {} }; items.push(activity); }
      activity.events.push(event);
      if (joined.results[event.seq]) activity.commandResults[event.seq] = joined.results[event.seq];
      if (outputs.results[event.seq]) activity.toolResults[event.seq] = outputs.results[event.seq];
      const approval = folded.get(event.seq);
      if (approval) activity.approvals[event.seq] = approval;
      continue;
    }
    activity = undefined;
    const visible = event.type === "attachment_added" ? !claimed.has(String(event.name ?? ""))
      : ["native_agent_group", "user_message", "assistant_text", "prompt_suggestion_created", "app_context_changed", "approval_request", "question_request", "notice", "error", "command_result", "tool_result"].includes(event.type);
    if (visible) items.push({ kind: "event", key: `event-${event.seq}`, event });
  }
  return items;
}
