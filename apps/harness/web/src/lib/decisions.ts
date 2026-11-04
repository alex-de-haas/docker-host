import type { DecisionRecord, DecisionPage, DecisionResolve } from "@hosty-sdk/app/decisions";
import type { AssistantEvent } from "./assistant-api";
import { subscribeWorkspaceEvents } from "./workspace-events";
import { call } from "./api";
export type DecisionWaitView = { id: string; sessionId: string; questionId: string; state: string; core: DecisionRecord | null; error: string | null; reason: string | null };
export type DecisionProjection = { id: string; kind: "permission" | "recovery" | "task_mode"; revision?: number; approved?: boolean; sessionId: string; title: string; createdAt: string; event?: AssistantEvent; available: boolean; error?: string };
export const readDecision = async (id: string): Promise<DecisionRecord> => (await call(`/decisions/${encodeURIComponent(id)}`)).json();
export const readDecisionWait = async (id: string): Promise<DecisionWaitView> => (await call(`/decisions/waits/${encodeURIComponent(id)}`)).json();
export const resolveDecision = async (id: string, input: DecisionResolve): Promise<DecisionRecord> => (await call(`/decisions/${encodeURIComponent(id)}/resolve`, { method: "POST", body: JSON.stringify(input) })).json();
export const retryDecision = async (id: string): Promise<DecisionWaitView> => (await call(`/decisions/waits/${encodeURIComponent(id)}/retry`, { method: "POST", body: "{}" })).json();
export async function listDecisions(history: boolean): Promise<DecisionPage> {
  let cursor: string | null = null; const items: DecisionRecord[] = []; let pendingCount = 0;
  do {
    const page: DecisionPage = await (await call(`/decisions?${history ? "state=history&" : ""}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json();
    items.push(...page.items); pendingCount = page.pendingCount; cursor = page.cursor;
  } while (cursor);
  return { items: history ? items : items.filter(row => row.state === "pending" || row.continuation?.state === "blocked"), pendingCount, cursor: null };
}

/** Entry, stream hints and reconnect all reload authoritative state; subscribing never submits. */
export function subscribeDecisionUpdates(refresh: () => Promise<unknown>, unavailable: () => void): () => void {
  let disposed = false;
  void Promise.resolve().then(() => { if (!disposed) return refresh(); }).catch(unavailable);
  const stop = subscribeWorkspaceEvents("/api/decisions/events", async () => { await refresh(); }, unavailable);
  return () => { disposed = true; stop(); };
}
