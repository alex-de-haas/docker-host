"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPresentationRequestId } from "@hosty-sdk/app/ui";
import type { UiHost } from "@hosty-sdk/app/ui/host";
import type { PresentedHandoff } from "./assistant-client";

/** Keep completed domain results actionable even when side placement is unavailable. */
export function useAssistantPresentation(host: UiHost | null, userId: string | null) {
  const presentations = useRef(new Map<string, string>());
  const actor = useRef(userId), sequence = useRef(0);
  const [recovery, setRecovery] = useState<{ userId: string | null; session: PresentedHandoff } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [previousUser, setPreviousUser] = useState(userId);
  if (previousUser !== userId) {
    setPreviousUser(userId);
    setRecovery(null);
    setRetrying(false);
  }
  useEffect(() => { actor.current = userId; sequence.current++; presentations.current.clear(); }, [userId]);
  const reveal = useCallback(async (session: PresentedHandoff) => {
    if (actor.current !== userId) return;
    const intent = ++sequence.current;
    if (!session.target || !host) { setRecovery({ userId, session }); return; }
    const key = JSON.stringify([userId, session.target, session.id]);
    const requestId = presentations.current.get(key) ?? createPresentationRequestId();
    presentations.current.set(key, requestId);
    let opened = false;
    try {
      const result = await host.openSurface(session.target, { placement: "side", requestId });
      opened = result.status === "opened";
    } finally {
      if (actor.current === userId && sequence.current === intent) {
        setRecovery(opened ? null : { userId, session });
      }
    }
  }, [host, userId]);
  const notice = recovery?.userId === userId && recovery ? <div role="status" className="flex flex-wrap items-center gap-3 border-b bg-background px-4 py-2 text-sm">
    <span>Discussion created. Its panel could not be opened here.</span>
    {recovery.session.target && host && <button type="button" className="underline" disabled={retrying} onClick={() => {
      setRetrying(true); void reveal(recovery.session).catch(() => {}).finally(() => setRetrying(false));
    }}>Retry opening</button>}
    <a href={recovery.session.url} target="_blank" rel="noopener noreferrer" className="underline">Open separately</a>
    <button type="button" className="ml-auto underline" onClick={() => setRecovery(null)}>Dismiss</button>
  </div> : null;
  return { reveal, notice };
}
