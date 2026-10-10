"use client";

import { useEffect, useEffectEvent } from "react";
import type { UiHost } from "@hosty-sdk/app/ui/host";

/** Keep a notification link pending until its panel is actually placed. */
export function useAssistantSessionLink({ host, appId, sessionId, userId, onOpened }: {
  host: UiHost | null; appId: string | null; sessionId: string | null; userId: string | null;
  onOpened: () => void;
}) {
  const opened = useEffectEvent(onOpened);
  useEffect(() => {
    if (!host || !appId || !sessionId || !userId) return;
    let cancelled = false, pending = false, completed = false;
    let attemptedCatalog: ReturnType<UiHost["getSnapshot"]>["catalog"] | null = null;
    const tryOpen = () => {
      const state = host.getSnapshot();
      if (cancelled || pending || completed || state.bootstrap?.userId !== userId || state.catalog === attemptedCatalog) return;
      const panel = state.catalog.find(item => item.panel.appId === appId && item.available);
      if (!panel) return;
      pending = true;
      attemptedCatalog = state.catalog;
      void host.selectPanel(panel.panel).then(result => {
        if (!cancelled && result.status === "opened") {
          completed = true;
          opened();
        }
      }).finally(() => { pending = false; tryOpen(); });
    };
    const stop = host.subscribeSnapshot(tryOpen);
    tryOpen();
    return () => { cancelled = true; stop(); };
  }, [host, appId, sessionId, userId]);
}
