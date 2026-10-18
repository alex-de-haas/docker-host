"use client";
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { listSessions, type AssistantSession } from "./assistant-api";
import { activityTime, isWaiting } from "./attention";

/** The selected chat uses SSE; inventory reconciliation also discovers work started elsewhere. */
export function useSessionListRefresh(enabled: boolean, sessions: AssistantSession[], activeId: string | undefined,
  setSessions: Dispatch<SetStateAction<AssistantSession[]>>) {
  const latest = useRef({ sessions, activeId });
  useEffect(() => { latest.current = { sessions, activeId }; }, [sessions, activeId]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false, pending = false, idleTicks = 0;
    const refresh = async () => {
      if (document.visibilityState !== "visible" || pending) return;
      pending = true; idleTicks = 0;
      const snapshot = latest.current.sessions;
      try {
        const observed = await listSessions();
        if (!cancelled) setSessions(current => {
          const before = new Map(snapshot.map(row => [row.id, row]));
          const received = new Map(observed.map(row => [row.id, row]));
          // Preserve rows edited while the request was pending, but still reconcile unrelated
          // background sessions. Removed local rows cannot reappear from this older snapshot.
          const next = current.flatMap(row => {
            if (before.get(row.id) !== row) return [row];
            const value = received.get(row.id);
            if (!value) return [];
            return [activityTime(value) >= activityTime(row) && (value.lastEventSeq ?? 0) >= (row.lastEventSeq ?? 0) ? value : row];
          });
          // A concurrent local create/delete can involve an id absent from both snapshots.
          // Defer new discoveries to the next stable read in that case.
          if (current === snapshot) next.push(...observed.filter(row => !before.has(row.id)));
          return next;
        });
      } catch {
        // Retain the known list during an outage; focus or the next tick retries.
      } finally { pending = false; }
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const { sessions: rows, activeId: selected } = latest.current;
      const backgroundWork = rows.some(row => row.id !== selected && (row.status === "running" || isWaiting(row.status)));
      if (backgroundWork || ++idleTicks >= 6) void refresh();
    }, 5000);
    const recover = () => { void refresh(); };
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [enabled, setSessions]);
}
