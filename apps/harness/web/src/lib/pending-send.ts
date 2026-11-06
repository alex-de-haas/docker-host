"use client";
import { draftStorageText } from "./draft-store";
import { AssistantApiError, getMessageReceipt, postMessage, type MessageReceipt, type StoredAttachment } from "./assistant-api";

export const PENDING_SEND_PREFIX = "hosty.assistant.pending-send.";
export const PENDING_SEND_CHANGED = "hosty:pending-send-changed";
const PREFIX = PENDING_SEND_PREFIX;
const MAX_JOURNAL_CHARS = 1024 * 1024;
export type PendingSend = {
  version: 1; clientRequestId: string; sessionId: string; text: string; draftText: string; attachments: StoredAttachment[];
  promptSuggestions?: boolean;
  appContextRevision: number; withoutAppDetails: boolean; selectionRevision: number;
};
function valid(value: unknown, sessionId: string): value is PendingSend {
  const request = value as PendingSend | null;
  return !!request && request.version === 1 && request.sessionId === sessionId
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.clientRequestId)
    && typeof request.text === "string" && typeof request.draftText === "string" && typeof request.withoutAppDetails === "boolean"
    && (request.promptSuggestions === undefined || typeof request.promptSuggestions === "boolean")
    && Number.isSafeInteger(request.appContextRevision) && request.appContextRevision >= 0
    && Number.isSafeInteger(request.selectionRevision) && request.selectionRevision >= 0
    && Array.isArray(request.attachments) && request.attachments.every(file => typeof file?.name === "string" && !!file.name && Number.isFinite(file.size) && file.size >= 0);
}
export function readPendingSend(sessionId: string): PendingSend | null {
  const raw = window.localStorage.getItem(PREFIX + sessionId);
  if (raw === null) return null;
  let value: unknown;
  try { if (raw.length <= MAX_JOURNAL_CHARS) value = JSON.parse(raw); } catch { /* Keep corrupt recovery data instead of silently dispatching a new send. */ }
  if (!valid(value, sessionId)) throw new Error("The previous send's recovery details are unavailable. Keep this draft and inspect the conversation before sending again.");
  return value;
}
export function rememberPendingSend(request: PendingSend): void {
  const value = JSON.stringify(request);
  if (!valid(request, request.sessionId) || value.length > MAX_JOURNAL_CHARS) throw new Error("This message's recovery details are too large to save.");
  const previous = readPendingSend(request.sessionId);
  if (previous && JSON.stringify(previous) !== value) throw new Error("A message is already awaiting confirmation in another view. Retry that original send first.");
  try {
    window.localStorage.setItem(PREFIX + request.sessionId, value);
    if (window.localStorage.getItem(PREFIX + request.sessionId) === value) { window.dispatchEvent(new Event(PENDING_SEND_CHANGED)); return; }
  } catch { /* A private/quota-limited browser cannot safely recover an uncertain send after reload. */ }
  throw new Error("Cannot save this message's recovery details. Allow browser storage and try again; the message was not sent.");
}
export async function withPendingSendLock<T>(sessionId: string, action: () => T | Promise<T>): Promise<T> {
  return navigator.locks?.request ? navigator.locks.request(PREFIX + sessionId, action) : action();
}
/** Serialize claims across browser views where Web Locks is available; retain the durable guard everywhere. */
export async function claimPendingSend(request: PendingSend): Promise<void> {
  const claim = () => {
    const draft = window.localStorage.getItem("hosty.assistant.draft." + request.sessionId);
    if (draft !== null && draft !== draftStorageText(request.draftText)) throw new Error("This draft changed in another view. Review it before sending.");
    rememberPendingSend(request);
  };
  await withPendingSendLock(request.sessionId, claim);
}
export function forgetPendingSend(request: PendingSend): void {
  // A late result must not remove a newer request stored by another view.
  if (readPendingSend(request.sessionId)?.clientRequestId === request.clientRequestId) {
    window.localStorage.removeItem(PREFIX + request.sessionId);
    window.dispatchEvent(new Event(PENDING_SEND_CHANGED));
  }
}
export function isMessageAdmissionRejection(error: unknown): error is AssistantApiError {
  return error instanceof AssistantApiError && ["app_context_unavailable", "app_context_conflict", "selection_conflict", "provider_required", "workspace_closed", "session_busy", "cleanup_pending", "handoff_pending", "handoff_queued", "worker_recovery_required"].includes(error.code ?? "");
}
export function dispatchPendingSend(request: PendingSend): Promise<MessageReceipt | void> {
  return postMessage(request.sessionId, request.text, request.attachments.map(file => file.name), request.appContextRevision,
    request.withoutAppDetails, request.selectionRevision, request.clientRequestId, ...(request.promptSuggestions === true ? [true] : []));
}
/** Explicit user retry only: settle the original receipt before considering the exact original write. */
export async function retryPendingSend(request: PendingSend): Promise<MessageReceipt | void> {
  try { return await getMessageReceipt(request.sessionId, request.clientRequestId); }
  catch (error) {
    if (!(error instanceof AssistantApiError) || error.status !== 404 || error.code !== "message_request_not_found") throw error;
    try { return await dispatchPendingSend(request); }
    catch (refusal) {
      // Only a POST issued after a serialized not-admitted read can establish this refusal.
      if (!isMessageAdmissionRejection(refusal)) throw refusal;
      return { clientRequestId: request.clientRequestId, state: "rejected", error: { code: refusal.code!, message: refusal.message } };
    }
  }
}
