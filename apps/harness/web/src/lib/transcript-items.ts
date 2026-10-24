import type { AssistantEvent } from "./assistant-api";
import { isListedToolUse } from "./tool-display";
import { commandOutcome, commandResultId, isCommandTool, type CommandOutcome } from "./transcript-activity";
import { canShowToolOutput, recordedToolOutput, type ToolOutput } from "./tool-output";
export type TranscriptItem =
  | { kind: "event"; key: string; event: AssistantEvent }
  | { kind: "activity"; key: string; events: AssistantEvent[]; commandResults: Record<number, CommandOutcome>; toolResults: Record<number, ToolOutput> };
const identity = commandResultId;
/** Join only a preceding, uniquely identified command from the same factual user turn. */
function commandResults(events: readonly AssistantEvent[]) {
  const results: Record<number, CommandOutcome> = {}, matched = new Set<number>();
  let calls = new Map<string, AssistantEvent[]>();
  const outcomes = new Map<number, string>();
  const matchedByCall = new Map<number, number[]>();
  for (const event of events) {
    if (["user_message", "session_created", "result", "error"].includes(event.type)
      || event.type === "session_status" && ["idle", "cancelled", "failed", "abandoned"].includes(String(event.status))) calls = new Map();
    const id = identity(event); if (!id) continue;
    if (isCommandTool(event)) {
      const prior = calls.get(id) ?? []; prior.push(event); calls.set(id, prior);
      // Repeated native IDs are ambiguous; do not relabel either call with another call's result.
      if (prior.length > 1) prior.forEach(call => { delete results[call.seq]; for (const seq of matchedByCall.get(call.seq) ?? []) matched.delete(seq); });
    } else if (event.type === "command_result") {
      const candidates = calls.get(id); if (candidates?.length !== 1) continue;
      const call = candidates[0], outcome = commandOutcome(event), fingerprint = JSON.stringify(outcome);
      if (!call) continue;
      const old = outcomes.get(call.seq);
      results[call.seq] = results[call.seq]?.conflict || old && old !== fingerprint ? { status: "unknown", conflict: true } : outcome;
      outcomes.set(call.seq, old ?? fingerprint); matched.add(event.seq);
      matchedByCall.set(call.seq, [...(matchedByCall.get(call.seq) ?? []), event.seq]);
    }
  }
  return { results, matched };
}
/** Output is attached only to a unique preceding call within its recorded user turn. */
function toolResults(events: readonly AssistantEvent[]) {
  const results: Record<number, ToolOutput> = {}, matched = new Set<number>();
  let calls = new Map<string, AssistantEvent[]>();
  const outcomes = new Map<number, string>(), matchedByCall = new Map<number, number[]>();
  for (const event of events) {
    if (["user_message", "session_created", "result", "error"].includes(event.type)
      || event.type === "session_status" && ["idle", "cancelled", "failed", "abandoned"].includes(String(event.status))) calls = new Map();
    const id = identity(event); if (!id) continue;
    if (event.type === "tool_use") {
      const prior = calls.get(id) ?? []; prior.push(event); calls.set(id, prior);
      if (prior.length > 1) prior.forEach(call => { delete results[call.seq]; for (const seq of matchedByCall.get(call.seq) ?? []) matched.delete(seq); });
    } else if (event.type === "tool_result") {
      const candidates = calls.get(id), output = recordedToolOutput(event);
      if (candidates?.length !== 1 || !output) continue;
      const call = candidates[0];
      if (!canShowToolOutput(String(call.toolName ?? "tool"))) { matched.add(event.seq); continue; }
      const fingerprint = JSON.stringify(output), old = outcomes.get(call.seq);
      results[call.seq] = results[call.seq]?.conflict || old && old !== fingerprint ? { status: "unknown", output: "", conflict: true } : output;
      outcomes.set(call.seq, old ?? fingerprint); matched.add(event.seq);
      matchedByCall.set(call.seq, [...(matchedByCall.get(call.seq) ?? []), event.seq]);
    }
  }
  return { results, matched };
}
/** Group adjacent calls; prose, decisions and turn boundaries always end a group. */
export function transcriptItems(events: AssistantEvent[], claimed: ReadonlySet<string>): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const joined = commandResults(events), outputs = toolResults(events);
  let activity: Extract<TranscriptItem, { kind: "activity" }> | undefined;
  for (const event of events) {
    if (event.type === "command_result" && joined.matched.has(event.seq) || event.type === "tool_result" && outputs.matched.has(event.seq)) continue;
    if (event.type === "tool_use") {
      if (!isListedToolUse(String(event.toolName ?? "tool"))) continue;
      if (!activity) { activity = { kind: "activity", key: `activity-${event.seq}`, events: [], commandResults: {}, toolResults: {} }; items.push(activity); }
      activity.events.push(event);
      if (joined.results[event.seq]) activity.commandResults[event.seq] = joined.results[event.seq];
      if (outputs.results[event.seq]) activity.toolResults[event.seq] = outputs.results[event.seq];
      continue;
    }
    activity = undefined;
    const visible = event.type === "attachment_added" ? !claimed.has(String(event.name ?? ""))
      : ["user_message", "assistant_text", "app_context_changed", "approval_request", "question_request", "notice", "error", "command_result", "tool_result"].includes(event.type);
    if (visible) items.push({ kind: "event", key: `event-${event.seq}`, event });
  }
  return items;
}
