/** Addressed input. A decision answer never grants tool, installation, or task-review permission. */
export interface DecisionOption { id: string; label: string; description?: string | null }
export interface DecisionQuestion { id: string; question: string; options?: DecisionOption[] | null; allowText?: boolean; multiple?: boolean; header?: string | null }
export interface DecisionReference { kind: string; id: string; revision?: string | null }
export interface DecisionInput {
  correlationKey: string; title: string; questions: DecisionQuestion[]; reason?: string | null;
  subject?: DecisionReference | null; task?: DecisionReference | null; materials?: DecisionReference[] | null;
  originPath?: string | null; waitReference?: string | null; expiresAt?: string | null; predecessorId?: string | null;
}
export interface DecisionCreate { requestId: string; input: DecisionInput }
export interface DecisionAnswer { optionIds?: string[] | null; text?: string | null }
export type DecisionAnswers = Record<string, DecisionAnswer>;
export interface DecisionResolve { requestId: string; expectedRevision: number; answers: DecisionAnswers }
export interface DecisionWithdraw { requestId: string; expectedRevision: number; reason: string; currentSubjectRevision?: string | null; removeContent?: boolean }
export interface DecisionAck { requestId: string; resolutionRevision: number }
export type DecisionContinuationState = "pending" | "received" | "blocked" | "admitted" | "running" | "completed" | "failed" | "cancelled";
export type DecisionContinuationReason = "missing_authority" | "missing_provider" | "unknown_stop" | "unknown_admission" | "stale_input" | "unsupported_resume" | "paused" | "cancelled" | "provider_failed";
export interface DecisionContinue { requestId: string; commandId: string; expectedRevision: number; state: DecisionContinuationState; reason?: DecisionContinuationReason | null; outcome?: string | null }
export type DecisionState = "pending" | "answered" | "withdrawn" | "expired" | "stale";
export interface DecisionQuery { cursor?: string; limit?: number; state?: DecisionState | "history"; subject?: string; task?: string }
export interface DecisionResolution { revision: number; userId: string; principalId: string; answers: DecisionAnswers; answeredAt: string }
export interface DecisionContinuation { revision: number; commandId: string | null; state: DecisionContinuationState; updatedAt: string; reason?: DecisionContinuationReason | null; outcome?: string | null }
export interface DecisionRecord {
  id: string; sequence: number; revision: number; userId: string; correlationHash: string;
  sourceAppId: string | null; sourceInstallation: string | null; sourcePrincipal: string;
  input: DecisionInput | null; state: DecisionState; createdAt: string; updatedAt: string;
  resolution: DecisionResolution | null; delivery: { resolutionRevision: number; receivedAt: string | null } | null;
  notificationPending?: boolean | null;
  continuation: DecisionContinuation | null; reason?: string | null; contentRemovedAt?: string | null;
}
export interface DecisionPage { items: DecisionRecord[]; pendingCount: number; cursor: string | null }
export class DecisionError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); this.name = "DecisionError"; }
}
/** The transport supplies current authority on each call. Mutations are never implicitly retried. */
export type DecisionTransport = (route: string, method: "GET" | "POST", body?: unknown, signal?: AbortSignal) => Promise<Response>;
export class DecisionClient {
  constructor(private readonly transport: DecisionTransport) {}
  private async send<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.transport(route, body === undefined ? "GET" : "POST", body, signal);
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const envelope = value as { error?: { code?: string; message?: string }; code?: string; message?: string } | null;
      const error = envelope?.error ?? envelope;
      throw new DecisionError(error?.code ?? "decision_unavailable", error?.message ?? "Decisions are unavailable. Your answer has not been discarded.", response.status);
    }
    if (value === null) throw new DecisionError("decision_response_invalid", "Core returned no decision result.", 502);
    return value as T;
  }
  /** Private change hints. Reload authorized state on stream.ready and decisions.changed. */
  async events(signal: AbortSignal): Promise<Response> {
    const response = await this.transport("/events", "GET", undefined, signal);
    if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
      await response.body?.cancel();
      throw new DecisionError("decision_stream_unavailable", "Decision updates are unavailable.", response.ok ? 502 : response.status);
    }
    return response;
  }
  create(input: DecisionCreate, signal?: AbortSignal) { return this.send<DecisionRecord>("/requests", input, signal); }
  get(id: string, signal?: AbortSignal) { return this.send<DecisionRecord>("/requests/" + encodeURIComponent(id), undefined, signal); }
  list(query: DecisionQuery = {}, signal?: AbortSignal) { return this.send<DecisionPage>("/requests" + queryString(query), undefined, signal); }
  resolve(id: string, input: DecisionResolve, signal?: AbortSignal) { return this.send<DecisionRecord>("/requests/" + encodeURIComponent(id) + "/resolve", input, signal); }
  withdraw(id: string, input: DecisionWithdraw, signal?: AbortSignal) { return this.send<DecisionRecord>("/requests/" + encodeURIComponent(id) + "/withdraw", input, signal); }
  invalidate(id: string, input: DecisionWithdraw, signal?: AbortSignal) { return this.send<DecisionRecord>("/requests/" + encodeURIComponent(id) + "/invalidate", input, signal); }
  responses(query: DecisionQuery = {}, signal?: AbortSignal) { return this.send<DecisionPage>("/responses" + queryString(query), undefined, signal); }
  acknowledge(id: string, input: DecisionAck, signal?: AbortSignal) { return this.send<DecisionRecord>("/responses/" + encodeURIComponent(id) + "/ack", input, signal); }
  continuation(id: string, input: DecisionContinue, signal?: AbortSignal) { return this.send<DecisionRecord>("/requests/" + encodeURIComponent(id) + "/continuation", input, signal); }
}
function queryString(query: DecisionQuery): string {
  const params = new URLSearchParams();
  for (const key of ["cursor", "limit", "state", "subject", "task"] as const) if (query[key] !== undefined) params.set(key, String(query[key]));
  return params.size ? "?" + params.toString() : "";
}
