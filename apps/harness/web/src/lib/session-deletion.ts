import { AssistantApiError, deleteSession, getSession } from "./assistant-api";

// Stop can wait up to 30 seconds for the provider to confirm native exit.
const DELETE_TIMEOUT_MS = 45_000;
const RECONCILE_TIMEOUT_MS = 8_000;

async function deletionRequest<T>(confirmed: AbortSignal, timeoutMs: number, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([confirmed, deadline.signal]);
  signal.throwIfAborted();
  const timer = setTimeout(() => {
    deadline.abort(new Error("Deletion could not be confirmed in time. Refresh the session list and retry if the session is still present."));
  }, timeoutMs);
  let onAbort!: () => void;
  // Hosty sign-in or a stalled transport can outlive the HTTP signal. Bound the UI wait too.
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([request(signal), interrupted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** A terminal stream event confirms deletion even if the HTTP response or its reconciliation is lost. */
export async function deleteAndReconcileSession(id: string, confirmed: AbortSignal): Promise<void> {
  try {
    await deletionRequest(confirmed, DELETE_TIMEOUT_MS, signal => deleteSession(id, signal));
  } catch (error) {
    if (confirmed.aborted) return;
    if (error instanceof AssistantApiError) {
      const status = error.status ?? 0;
      const refused = status >= 400 && status < 500 && status !== 404 && status !== 408;
      const providerBlocked = ["exit_unconfirmed", "stop_unconfirmed", "provider_unavailable", "retirement_pending"].includes(error.code ?? "");
      if (refused || providerBlocked) throw error;
    }

    // Read this session directly. A filtered inventory or a missing route cannot prove deletion.
    try {
      await deletionRequest(confirmed, RECONCILE_TIMEOUT_MS, signal => getSession(id, signal));
    } catch (readError) {
      if (confirmed.aborted || readError instanceof AssistantApiError && readError.status === 404 && readError.code === "session_not_found") return;
    }
    if (!confirmed.aborted) throw error;
  }
}
