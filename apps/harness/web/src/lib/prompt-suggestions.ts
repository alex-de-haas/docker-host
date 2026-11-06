"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSuggestionPreference, setSuggestionPreference, type AssistantEvent, type AssistantSession } from "./assistant-api";

export type PromptSuggestion = { epoch: string; revision: number; sessionId: string; userId: string; attemptId?: string;
  state: "empty" | "collecting" | "available" | "unavailable"; text?: string; expiresAt?: number; reason?: string };
const prefix = "hosty.prompt-suggestion.v1.";
export const suggestionKey = (value: PromptSuggestion) => `${prefix}${encodeURIComponent(value.userId)}.${encodeURIComponent(value.sessionId)}`;
const identity = (value: PromptSuggestion) => `${value.epoch}:${value.attemptId}`;
export function parseSuggestion(event: AssistantEvent): PromptSuggestion | null {
  if (event.type !== "session_suggestion" || typeof event.epoch !== "string" || !Number.isSafeInteger(event.revision)
    || typeof event.sessionId !== "string" || typeof event.userId !== "string"
    || !["empty", "collecting", "available", "unavailable"].includes(String(event.state))) return null;
  if (event.state === "available" && (typeof event.text !== "string" || !event.text.trim() || [...event.text].length > 2000
    || typeof event.expiresAt !== "number" || !Number.isFinite(event.expiresAt) || typeof event.attemptId !== "string")) return null;
  return event as unknown as PromptSuggestion;
}
function dismissed(value: PromptSuggestion) {
  try { return localStorage.getItem(suggestionKey(value)) === identity(value); } catch { return true; }
}

export function usePromptSuggestions(session: AssistantSession | null, ready: boolean, occupied: boolean) {
  const [preference, setPreference] = useState<{ enabled: boolean; revision: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState<PromptSuggestion | null>(null);
  const current = useRef<PromptSuggestion | null>(null);
  const blocked = useRef(false);
  const context = JSON.stringify([session?.id, session?.connectionId, session?.connectionRevision, session?.selectionRevision,
    session?.appContextRevision, session?.workspaceAssociation]);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    void getSuggestionPreference().then(next => { if (active) setPreference(next); }).catch(() => { if (active) setPreference(null); });
    return () => { active = false; };
  }, [ready, session?.createdBy]);
  const interact = useCallback(() => {
    blocked.current = true;
    const suggestion = current.current;
    if (suggestion?.attemptId) try { localStorage.setItem(suggestionKey(suggestion), identity(suggestion)); } catch { /* Keep hidden in this view. */ }
    setValue(null);
  }, []);
  const receive = useCallback((event: AssistantEvent) => {
    if (event.type === "user_message") { blocked.current = false; current.current = null; setValue(null); return; }
    const next = parseSuggestion(event);
    if (!next) return;
    const previous = current.current;
    if (previous?.sessionId === next.sessionId && previous.epoch === next.epoch && previous.revision >= next.revision) return;
    current.current = next;
    if (next.state === "unavailable") { setValue(next); return; }
    if (blocked.current && next.attemptId) try { localStorage.setItem(suggestionKey(next), identity(next)); } catch { /* Keep hidden. */ }
    if (blocked.current || dismissed(next) || next.expiresAt !== undefined && next.expiresAt <= Date.now()) { setValue(null); return; }
    setValue(next);
  }, []);
  const [previousContext, setPreviousContext] = useState(context);
  if (previousContext !== context) { setPreviousContext(context); setValue(null); }
  if (occupied && value?.state === "available") setValue(null);
  useEffect(() => { current.current = null; blocked.current = false; }, [session?.id]);
  const contextRef = useRef({ id: session?.id, context });
  useEffect(() => {
    if (contextRef.current.id === session?.id && contextRef.current.context !== context) blocked.current = true;
    contextRef.current = { id: session?.id, context };
  }, [session?.id, context]);
  useEffect(() => {
    if (!occupied) return;
    blocked.current = true;
    if (current.current?.attemptId) try { localStorage.setItem(suggestionKey(current.current), identity(current.current)); } catch { /* Keep hidden. */ }
  }, [occupied]);
  useEffect(() => {
    if (!value?.expiresAt) return;
    const timer = setTimeout(interact, Math.max(0, value.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [value, interact]);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (current.current && event.key === suggestionKey(current.current) && dismissed(current.current)) interact(); };
    window.addEventListener("storage", changed); return () => window.removeEventListener("storage", changed);
  }, [interact]);
  const toggle = async () => {
    if (!preference || saving) return;
    setSaving(true); setError(null); interact();
    try { setPreference(await setSuggestionPreference(!preference.enabled, preference.revision)); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your preference.");
      void getSuggestionPreference().then(setPreference).catch(() => {});
    } finally { setSaving(false); }
  };
  const suggestion = preference?.enabled && !occupied && value?.sessionId === session?.id && value?.userId === session?.createdBy
    && value?.state === "available" ? value : null;
  return { suggestion, receive, interact, toggle, preference, saving, error,
    availability: value?.state === "unavailable" && value.sessionId === session?.id ? value.reason : null };
}
