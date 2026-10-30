import type { ProviderServerOptions } from "@hosty-sdk/app/providers/server";
import { FeedbackError, type FeedbackCapabilities, type FeedbackSubmit, type FeedbackReport,
  type FeedbackCollection, type FeedbackDispatch, type FeedbackDispatchInput, type FeedbackDelivery, type FeedbackOutcome } from "@hosty-sdk/app/feedback";

export class FeedbackServerClient {
  private readonly appId: string; private readonly core: URL; private readonly service: string;
  constructor(options: ProviderServerOptions = {}) {
    this.appId = options.appId ?? process.env.HOSTY_APP_ID ?? "";
    this.core = new URL(options.coreOrigin ?? process.env.HOSTY_CORE_ORIGIN ?? "http://127.0.0.1:7070");
    this.service = options.serviceToken ?? process.env.HOSTY_APP_SERVICE_TOKEN ?? "";
    if (!this.appId || !this.service) throw new FeedbackError("hosty_misconfigured", "Hosty app credentials are unavailable.", 503);
  }
  private async response(path: string, token: string, body?: unknown, signal?: AbortSignal) {
    if (!token) throw new FeedbackError("identity_required", "Sign in to use feedback.", 401);
    const response = await fetch(new URL("/api/internal/apps/" + encodeURIComponent(this.appId) + "/" + path, this.core), {
      method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      headers: { authorization: "Bearer " + this.service, "X-Hosty-User-Token": token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { code?: string; message?: string } | null;
      throw new FeedbackError(error?.code ?? "feedback_unavailable", error?.message ?? "Feedback is unavailable. Your draft is retained.", response.status);
    }
    return response;
  }
  private async request<T>(path: string, token: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return (await this.response(path, token, body, signal)).json() as Promise<T>;
  }
  capabilities(token: string, signal?: AbortSignal): Promise<FeedbackCapabilities> { return this.request("ui/feedback", token, undefined, signal); }
  submit(input: FeedbackSubmit, token: string, signal?: AbortSignal): Promise<{ id: string; status: string }> { return this.request("ui/feedback", token, input, signal); }
  reviewTargets(id: string, token: string, signal?: AbortSignal) { return this.request<{ targets: { label: string; href: string }[] }>("ui/feedback/" + encodeURIComponent(id) + "/review-targets", token, undefined, signal); }
  list(token: string, signal?: AbortSignal): Promise<FeedbackCollection> { return this.request("feedback", token, undefined, signal); }
  change(id: string, input: { expectedRevision: number; workspaceId: string | null; disposition?: string | null }, token: string) {
    return this.request<FeedbackReport>("feedback/" + encodeURIComponent(id), token, input);
  }
  reserve(input: FeedbackDispatchInput, token: string) { return this.request<FeedbackDispatch>("feedback/dispatches", token, input); }
  delivery(id: string, input: FeedbackDelivery, token: string) {
    return this.request<FeedbackDispatch>("feedback/dispatches/" + encodeURIComponent(id) + "/delivery", token, input);
  }
  outcomes(id: string, outcomes: FeedbackOutcome[], token: string) {
    return this.request<FeedbackDispatch>("feedback/dispatches/" + encodeURIComponent(id) + "/outcomes", token, { outcomes });
  }
  image(id: string, noteId: string, token: string, signal?: AbortSignal) {
    return this.response("feedback/" + encodeURIComponent(id) + "/images/" + encodeURIComponent(noteId), token, undefined, signal);
  }
}

