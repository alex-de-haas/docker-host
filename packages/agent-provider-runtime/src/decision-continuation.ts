import { createHash } from "node:crypto";
import { AgentApiError, type AgentResponseInput } from "@hosty-sdk/app/agent";
import type { DecisionContinue, DecisionContinuationState, DecisionContinuationReason } from "@hosty-sdk/app/decisions";
import type { ProviderAuthority } from "./core.js";
import type { ProviderController } from "./controller.js";
import type { ProviderStore, RunRecord, SessionRecord } from "./store.js";

export type DecisionDelivery = { decisionId: string; resolutionRevision: number; input: AgentResponseInput; commandId: string;
  submitted?: boolean; rejected?: string; done?: boolean; previousInputs?: AgentResponseInput[]; report?: DecisionContinue };
const uuid = (value: string) => { const h = createHash("sha256").update(value).digest("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };
type Progress = { state: DecisionContinuationState; reason?: DecisionContinuationReason };
function progress(session: SessionRecord, record: RunRecord, delivery: DecisionDelivery): Progress {
  if (delivery.rejected) return { state: record.decisionsFenced ? "cancelled" : "failed", reason: record.decisionsFenced ? "cancelled" : "stale_input" };
  const control = record.controls[delivery.input.requestId]?.receipt;
  if (session.retirement?.runId === (control?.continuation?.run.id ?? record.snapshot.ref.id)) return { state: "cancelled", reason: "cancelled" };
  if (!control || control.state === "accepted") return { state: "blocked", reason: "unknown_admission" };
  if (control.state === "unknown") return { state: "blocked", reason: "unknown_admission" };
  if (control.state === "rejected") return { state: "failed", reason: "provider_failed" };
  if (control.state === "superseded" || control.continuation?.state === "superseded") return { state: "cancelled", reason: "cancelled" };
  if (control.continuation?.state === "awaiting_authorization") return { state: "blocked", reason: "missing_authority" };
  const target = control.continuation ? session.runs[control.continuation.run.id] : record;
  if (!target) return { state: "blocked", reason: "unknown_admission" };
  if (target.snapshot.state === "queued" || target.snapshot.phase === "preparing") return { state: "admitted" };
  if (target.snapshot.state === "unknown") return { state: "blocked", reason: "unknown_stop" };
  if (target.snapshot.stopConfirmed) {
    if (target.snapshot.state === "succeeded") return { state: "completed" };
    if (target.snapshot.state === "cancelled") return { state: "cancelled", reason: "cancelled" };
    if (target.snapshot.state === "failed") return { state: "failed", reason: "provider_failed" };
  }
  return { state: "running" };
}
function transition(current: DecisionContinuationState, desired: Progress): Progress | null {
  if (["completed", "failed", "cancelled"].includes(current)) return null;
  if (current === desired.state && desired.state !== "blocked" || current === "running" && desired.state === "admitted") return null;
  if (desired.state === "completed" || desired.state === "running") {
    if (current === "received" || current === "blocked") return { state: "admitted" };
    if (current === "admitted") return { state: "running" };
  }
  return desired;
}
/** Reports durable local outcomes; retries repeat exact metadata bytes and never repeat SDK delivery. */
export async function syncDecisionDeliveries(store: ProviderStore, controller: ProviderController, authority: ProviderAuthority, runId: string): Promise<void> {
  // Retire provider-owned questions whose native continuation no longer exists. A
  // stopped next-turn question remains valid until its explicit cancellation fence.
  const retirement = await store.run(runId);
  for (const [publicId, coreId] of Object.entries(retirement.record.decisionLinks ?? {})) {
    if (retirement.record.retiredDecisionIds?.includes(coreId)) continue;
    const pending = retirement.record.snapshot.pending.find(value => value.id === publicId);
    if (!retirement.record.snapshot.stopConfirmed && pending || !retirement.record.decisionsFenced && pending?.delivery === "next_turn") continue;
    const client = authority.decisions(retirement.record.admissionRef), current = await client.get(coreId);
    if (current.state === "pending") await client.withdraw(coreId, { requestId: uuid(`${coreId}:${current.revision}:retire`), expectedRevision: current.revision,
      reason: "The original provider question no longer accepts a response." });
    else if (current.state === "answered" && current.resolution && !retirement.record.decisionDeliveries?.[coreId]) {
      await store.exclusive(async () => {
        const fresh = await store.run(runId), deliveries = fresh.record.decisionDeliveries ??= {};
        deliveries[coreId] ??= { decisionId: coreId, resolutionRevision: current.resolution!.revision, commandId: uuid(`${coreId}:${current.resolution!.revision}:continuation`),
          submitted: true, rejected: "stale_input", input: { requestId: uuid(`${coreId}:fenced-response`), expectedGeneration: fresh.record.snapshot.generation,
            expectedRevision: fresh.record.snapshot.revision, decisionId: publicId, decisionRevision: pending?.revision ?? "1", response: { kind: "question", answers: {} } } };
        await store.save(fresh.session);
      });
    }
    await store.exclusive(async () => { const fresh = await store.run(runId); (fresh.record.retiredDecisionIds ??= []).push(coreId); await store.save(fresh.session); });
  }
  const initial = await store.run(runId);
  for (const id of Object.keys(initial.record.decisionDeliveries ?? {})) {
    let { session, record } = await store.run(runId), delivery = record.decisionDeliveries![id]!;
    if (delivery.done) continue;
    const client = authority.decisions(record.admissionRef);
    if (!delivery.submitted && !delivery.rejected) {
      try {
        await controller.respond(runId, delivery.input, JSON.stringify(delivery.input), { ...session.owner, admissionRef: record.admissionRef, operation: "runs.respond", provider: store.provider });
        await store.exclusive(async () => { const fresh = await store.run(runId); fresh.record.decisionDeliveries![id]!.submitted = true; await store.save(fresh.session); });
      } catch (error) {
        if (!(error instanceof AgentApiError) || error.status >= 500) throw error;
        if (error.code === "stale_revision") {
          const fresh = await store.run(runId), pending = fresh.record.snapshot.pending.find(value => value.id === delivery.input.decisionId && value.revision === delivery.input.decisionRevision);
          // Only this definitive pre-admission CAS rejection permits a fresh request. An
          // accepted/uncertain delivery keeps its original UUID and bytes forever.
          if (!fresh.record.controls[delivery.input.requestId] && fresh.record.snapshot.generation === delivery.input.expectedGeneration && pending && (delivery.previousInputs?.length ?? 0) < 16) {
            await store.exclusive(async () => {
              const latest = await store.run(runId), current = latest.record.decisionDeliveries![id]!;
              (current.previousInputs ??= []).push(current.input);
              current.input = { ...current.input, requestId: uuid(`${current.commandId}:${latest.record.snapshot.revision}:cas`), expectedRevision: latest.record.snapshot.revision };
              await store.save(latest.session);
            });
            continue;
          }
        }
        await store.exclusive(async () => { const fresh = await store.run(runId); fresh.record.decisionDeliveries![id]!.rejected = error.code; await store.save(fresh.session); });
      }
    }
    await client.acknowledge(id, { requestId: uuid(`${id}:${delivery.resolutionRevision}:ack`), resolutionRevision: delivery.resolutionRevision });
    for (let step = 0; step < 4; step++) {
      ({ session, record } = await store.run(runId)); delivery = record.decisionDeliveries![id]!;
      if (delivery.done) break;
      let input = delivery.report;
      if (!input) {
        const current = await client.get(id), desired = progress(session, record, delivery), next = transition(current.continuation?.state ?? "received", desired);
        if (!next || current.continuation?.state === "blocked" && next.state === "blocked" && current.continuation.reason === next.reason) break;
        if (!current.continuation) break;
        input = { requestId: uuid(`${delivery.commandId}:${current.continuation.revision}:${next.state}:${next.reason ?? ""}`), commandId: delivery.commandId,
          expectedRevision: current.continuation.revision, state: next.state, ...(next.reason ? { reason: next.reason } : {}) };
        await store.exclusive(async () => { const fresh = await store.run(runId); fresh.record.decisionDeliveries![id]!.report = input; await store.save(fresh.session); });
      }
      const result = await client.continuation(id, input);
      await store.exclusive(async () => {
        const fresh = await store.run(runId), current = fresh.record.decisionDeliveries![id]!;
        delete current.report; current.done = ["completed", "failed", "cancelled"].includes(result.continuation?.state ?? ""); await store.save(fresh.session);
      });
    }
  }
}
