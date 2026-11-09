"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AssistantApiError, getPromptSuggestions, getSuggestionPreference, resolvePromptSuggestion, setSuggestionPreference, type AssistantEvent, type AssistantSession } from "./assistant-api";
import { SuggestionInsertion, insertionScope, type SuggestionInsertionIntent } from "./suggestion-insertion";

export type PromptSuggestion = {
  suggestionId: string; revision: number; sessionId: string; userId: string; attemptId: string;
  answerSeq: number; text: string; expiresAt: number; createdAt: string;
  state: "available" | "selected-for-draft" | "dismissed" | "expired" | "superseded";
  resolvedAt?: string;
};
export const suggestionKey = (value: { userId: string; sessionId: string }) => `hosty.prompt-suggestion.v1.${encodeURIComponent(value.userId)}.${encodeURIComponent(value.sessionId)}`;
export function parseSuggestion(event: AssistantEvent): PromptSuggestion | null {
  if (event.type !== "prompt_suggestion_created" || typeof event.suggestionId !== "string"
    || typeof event.sessionId !== "string" || typeof event.userId !== "string" || typeof event.attemptId !== "string"
    || typeof event.text !== "string" || !event.text.trim() || [...event.text].length > 2000
    || typeof event.expiresAt !== "number" || !Number.isFinite(event.expiresAt)) return null;
  return { suggestionId: event.suggestionId, sessionId: event.sessionId, userId: event.userId, attemptId: event.attemptId,
    answerSeq: Number(event.answerSeq), text: event.text, expiresAt: event.expiresAt, createdAt: event.ts, revision: 1, state: "available" };
}
export function reduceSuggestion(cards: ReadonlyMap<string, PromptSuggestion>, event: AssistantEvent): Map<string, PromptSuggestion> {
  const created = parseSuggestion(event), next = new Map(cards);
  if (created && !next.has(created.suggestionId)) next.set(created.suggestionId, created);
  if (event.type === "prompt_suggestion_resolved" && typeof event.suggestionId === "string") {
    const value = next.get(event.suggestionId);
    if (value?.revision === 1 && ["selected-for-draft", "dismissed", "expired", "superseded"].includes(String(event.state)))
      next.set(value.suggestionId, { ...value, revision: 2, state: event.state as PromptSuggestion["state"], resolvedAt: event.ts });
  }
  return next;
}

export type SuggestionDraftAdapter = { insert: (text: string) => boolean; scope?: string };
export function usePromptSuggestions(session: AssistantSession | null, ready: boolean, occupied: boolean, adapter?: SuggestionDraftAdapter) {
  const [preference, setPreference] = useState<{ enabled: boolean; revision: number } | null>(null);
  const [saving, setSaving] = useState(false), [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [insertionError, setInsertionError] = useState<string | null>(null);
  const [cards, setCards] = useState<Map<string, PromptSuggestion>>(new Map());
  const [availability, setAvailability] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const current = useRef({ session, occupied, adapter, cards });
  useLayoutEffect(() => { current.current = { session, occupied, adapter, cards }; });
  const insertion = useRef<SuggestionInsertion | null>(null);
  const actionBusy = useRef(false);
  const context = JSON.stringify([session?.id, session?.createdBy]);
  const [previousContext, setPreviousContext] = useState(context);
  if (context !== previousContext) {
    setPreviousContext(context);
    setCards(new Map()); setAvailability(null); setInsertionError(null); setError(null);
  }
  useEffect(() => {
    insertion.current = session?.createdBy ? new SuggestionInsertion(insertionScope(`${location.origin}/${adapter?.scope ?? "default"}`, session.createdBy, session.id), session.id) : null;
  }, [session?.id, session?.createdBy, adapter?.scope]);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    void getSuggestionPreference().then(next => { if (active) setPreference(next); }).catch(() => { if (active) setPreference(null); });
    return () => { active = false; };
  }, [ready, session?.createdBy]);
  const interact = useCallback(() => {
    try { insertion.current?.changed(); }
    catch { setInsertionError("Browser storage is unavailable. Your current draft is preserved."); }
  }, []);
  const receive = useCallback((event: AssistantEvent) => {
    const owner = current.current.session;
    if (!owner) return;
    if (event.type === "session_suggestion") {
      if (event.sessionId === owner.id && event.userId === owner.createdBy)
        setAvailability(event.state === "unavailable" ? String(event.reason ?? "unavailable") : null);
      return;
    }
    const value = parseSuggestion(event);
    if (value && (value.sessionId !== owner.id || value.userId !== owner.createdBy)) return;
    if (value || event.type === "prompt_suggestion_resolved") setCards(previous => reduceSuggestion(previous, event));
  }, []);
  const apply = useCallback((controller: SuggestionInsertion, intent: SuggestionInsertionIntent) => {
    const latest = current.current;
    // An already persisted insertion is restored by normal draft loading, even if occupied now.
    if (intent.state === "applied") { controller.forget(intent); setInsertionError(null); return; }
    if (controller.restoreIfPersisted(intent)) { setInsertionError(null); return; }
    if (latest.occupied || !latest.adapter) { setInsertionError("Selected for draft. Clear the current draft or finish editing, then retry insertion."); return; }
    const outcome = controller.apply(intent, latest.adapter.insert);
    setInsertionError(outcome === "draft-changed" ? "Selected for draft. The draft changed, so it was preserved. Retry insertion when ready."
      : outcome === "refused" ? "Selected for draft. The editor could not insert it. Retry insertion when ready." : null);
  }, []);
  const resolveIntent = useCallback(async (controller: SuggestionInsertion, intent: SuggestionInsertionIntent, sessionId: string) => {
    const result = await resolvePromptSuggestion(sessionId, intent.suggestionId, { requestId: intent.requestId,
      expectedRevision: intent.expectedRevision, action: intent.action });
    // The response can arrive after selecting another conversation. Keep its intent for recovery.
    if (intent.action === "dismissed") controller.forget(intent);
    const selected = intent.action === "selected-for-draft" ? controller.selected(intent) : null;
    if (current.current.session?.id !== sessionId || insertion.current !== controller) return;
    setCards(previous => new Map(previous).set(result.suggestionId, result));
    if (selected) apply(controller, selected);
  }, [apply]);
  const refresh = useCallback(async (sessionId: string) => {
    const values = await getPromptSuggestions(sessionId);
    if (current.current.session?.id === sessionId) setCards(new Map(values.map(value => [value.suggestionId, value])));
  }, []);
  const select = useCallback(async (suggestionId: string) => {
    const latest = current.current, value = latest.cards.get(suggestionId), controller = insertion.current;
    if (!latest.session || !controller || latest.occupied || !latest.adapter || actionBusy.current || value?.state !== "available" || value.expiresAt <= Date.now()) return;
    actionBusy.current = true; setActing(true); setError(null); setInsertionError(null);
    let intent: SuggestionInsertionIntent | undefined;
    try { intent = controller.stage(value); await resolveIntent(controller, intent, latest.session.id); }
    catch (cause) {
      if (cause instanceof AssistantApiError && [403, 404, 409].includes(cause.status ?? 0) && intent) {
        controller.forget(intent); await refresh(latest.session.id).catch(() => {});
      } else if (intent) setInsertionError("Suggestion choice not confirmed. Retry checks the original request and preserves your draft.");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { actionBusy.current = false; setActing(false); }
  }, [resolveIntent, refresh]);
  const dismiss = useCallback(async (suggestionId: string) => {
    const latest = current.current, value = latest.cards.get(suggestionId), controller = insertion.current;
    if (!latest.session || !controller || value?.state !== "available" || actionBusy.current) return;
    actionBusy.current = true; setActing(true); setError(null);
    let intent: SuggestionInsertionIntent | undefined;
    try { intent = controller.stage(value, "dismissed"); await resolveIntent(controller, intent, latest.session.id); }
    catch (cause) {
      if (cause instanceof AssistantApiError && [403, 404, 409].includes(cause.status ?? 0) && intent) {
        controller.forget(intent); await refresh(latest.session.id).catch(() => {});
      } else if (intent) setInsertionError("Suggestion choice not confirmed. Retry checks the original request and preserves your draft.");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    finally { actionBusy.current = false; setActing(false); }
  }, [resolveIntent, refresh]);
  const recover = useCallback(async (retry = false) => {
    const controller = insertion.current, latest = current.current;
    if (!controller || !latest.session || actionBusy.current) return;
    actionBusy.current = true; setActing(true);
    let intent: SuggestionInsertionIntent | null = null;
    try {
      intent = controller.read(); if (!intent) return;
      if (retry && intent.state !== "pending" && !latest.occupied) intent = controller.retry(intent);
      if (intent.state === "pending") await resolveIntent(controller, intent, latest.session.id);
      else apply(controller, intent);
    } catch (cause) {
      if (cause instanceof AssistantApiError && [403, 404, 409].includes(cause.status ?? 0) && intent) {
        controller.forget(intent); await refresh(latest.session.id).catch(() => {});
      }
      setInsertionError(cause instanceof Error ? cause.message : String(cause));
    }
    finally { actionBusy.current = false; setActing(false); }
  }, [apply, resolveIntent, refresh]);
  const hasAdapter = !!adapter;
  useEffect(() => {
    let active = true;
    if (ready && session?.id && hasAdapter) void Promise.resolve().then(() => { if (active) return recover(); });
    return () => { active = false; };
  }, [ready, session?.id, adapter?.scope, hasAdapter, recover]);
  useEffect(() => {
    const deadlines = [...cards.values()].filter(value => value.state === "available").map(value => value.expiresAt);
    if (!deadlines.length) return;
    const timer = setTimeout(() => {
      const time = Date.now(); setNow(time);
      setCards(previous => new Map([...previous].map(([key, value]) => [key,
        value.state === "available" && value.expiresAt <= time ? { ...value, state: "expired" as const } : value])));
    }, Math.max(0, Math.min(...deadlines) - Date.now()));
    return () => clearTimeout(timer);
  }, [cards]);
  const toggle = async () => {
    if (!preference || saving) return;
    setSaving(true); setError(null);
    try { setPreference(await setSuggestionPreference(!preference.enabled, preference.revision)); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your preference.");
      void getSuggestionPreference().then(setPreference).catch(() => {});
    } finally { setSaving(false); }
  };
  const suggestion = !occupied ? [...cards.values()].findLast(value => value.state === "available" && value.expiresAt > now) ?? null : null;
  return { suggestion, cards, receive, interact, select, dismiss, toggle, preference, saving, acting, error, availability,
    insertionError, retryInsertion: () => recover(true) };
}
