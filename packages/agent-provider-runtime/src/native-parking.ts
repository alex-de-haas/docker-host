import { createHash } from "node:crypto";
import type { RunRecord } from "./store.js";
import type { WorkerEvent, WorkerReceipt } from "./internal/worker/contracts.js";
import { nativeEventIdentity } from "./internal/harness/adapter.js";

export const NATIVE_QUESTION_PARK_MS = 5 * 60_000;
type NativeRecord = { receipt: WorkerReceipt; events: WorkerEvent[]; controls: Record<string, { applied: boolean }> };
/** Fixed production deadline; only a durably observed, exclusively blocked execution is eligible. */
export function overdueBlockingQuestion(record: RunRecord, native: NativeRecord, now: number): WorkerEvent | null {
  const snapshot = record.snapshot, pending = native.receipt.pending ?? [];
  const waitingSources = new Set(snapshot.pending.filter(decision => decision.kind === "question" && decision.delivery === "continue_run")
    .map(decision => decision.source?.agentId ?? "root"));
  if (record.decisionsFenced || snapshot.stopConfirmed || snapshot.phase !== "waiting" || snapshot.state !== "waiting_for_input" || snapshot.freshness !== "current"
    || snapshot.effects.certainty !== "known" || snapshot.effects.unresolvedCallIds.length || native.receipt.state !== "awaiting_input"
    || !native.receipt.snapshot?.nativeSessionId || Object.keys(native.receipt.effects ?? {}).length
    || !pending.length || pending.some(frame => frame.event.type !== "question_request" || frame.event.blocking === false || frame.event.delivery === "message")
    || snapshot.pending.some(decision => decision.kind === "approval")
    || snapshot.agents?.some(agent => agent.agentId !== "root" && (["queued", "running", "unknown"].includes(agent.state)
      || agent.state === "waiting_for_input" && !waitingSources.has(agent.agentId)))
    || Object.values(native.controls).some(control => !control.applied)) return null;
  const ids = new Set(pending.map(frame => frame.event.type === "question_request" ? frame.event.questionId : ""));
  if (Object.values(record.controls).some(control => ["accepted", "unknown"].includes(control.receipt.state))
    || Object.values(record.decisionDeliveries ?? {}).some(delivery => ids.has(delivery.input.decisionId) && !delivery.done && !delivery.rejected)) return null;
  // Include command/tool events as well as explicit effect receipts. A partial/unknown tool result
  // cannot be treated as settled merely because the native SDK is awaiting another callback.
  const calls = new Set<string>(); let unknown = false;
  for (const { event } of native.events) {
    if (event.type === "native_effect" && event.state === "settled") calls.delete(nativeEventIdentity(event.source, event.id));
    if (event.type === "tool_use") { if (event.toolUseId) calls.add(nativeEventIdentity(event.source, event.toolUseId)); else if (event.toolName !== "FileChange") unknown = true; }
    if (event.type === "tool_result" || event.type === "command_result") {
      if (event.status === "unknown") unknown = true; else calls.delete(nativeEventIdentity(event.source, event.toolUseId));
    }
  }
  if (unknown || calls.size) return null;
  return pending.find(frame => {
    const since = Date.parse(record.blockingQuestionSince?.[String(frame.sequence)] ?? "");
    return Number.isFinite(since) && now >= since && now - since >= NATIVE_QUESTION_PARK_MS;
  }) ?? null;
}
export function automaticParkId(runId: string, generation: string, sequence: number): string {
  const hash = createHash("sha256").update(`${runId}:${generation}:${sequence}:automatic-question-park`).digest("hex");
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
