"use client";
import { useEffect, type Dispatch, type SetStateAction } from "react";
import { listSessions, type AssistantSession } from "./assistant-api";
import { isWaiting } from "./attention";

/** The selected conversation uses SSE; only background active sessions need reconciliation. */
export function useSessionListRefresh(enabled: boolean, sessions: AssistantSession[], activeId: string | undefined,
  setSessions: Dispatch<SetStateAction<AssistantSession[]>>) {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false, pending = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible" || pending) return;
      pending = true;
      try {
        const observed = await listSessions();
        // Local events, edits and deletions supersede an in-flight snapshot. A later refresh
        // reconciles it without resurrecting a deleted row or overwriting fresher stream state.
        if (!cancelled) setSessions(current => current === sessions ? observed : current);
      } catch {
        // Retain the known list during an outage; focus or the next active-work tick retries.
      } finally { pending = false; }
    };
    const backgroundWork = sessions.some(session => session.id !== activeId && (session.status === "running" || isWaiting(session.status)));
    const timer = backgroundWork ? window.setInterval(() => void refresh(), 5000) : undefined;
    const recover = () => { void refresh(); };
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [enabled, sessions, activeId, setSessions]);
}
