"use client";

import { useEffect, useEffectEvent } from "react";
import type { UiHost } from "@hosty-sdk/app/ui/host";
import { createPresentationRequestId, type PanelTarget } from "@hosty-sdk/app/ui";

/** Keep a notification link pending until its panel is actually placed. */
export function useAssistantSessionLink({ host, appId, assistantIds, panelId = null, sessionId, userId, onOpened }: {
  host: UiHost | null; appId: string | null; sessionId: string | null; userId: string | null;
  assistantIds: readonly string[];
  panelId?: string | null;
  onOpened: (target: PanelTarget) => void;
}) {
  const opened = useEffectEvent(onOpened);
  const eligibleAppId = appId && assistantIds.includes(appId) ? appId : null;
  useEffect(() => {
    if (!host || !eligibleAppId || !sessionId || !userId) return;
    let cancelled = false, pending = false, completed = false;
    let attemptedCatalog: ReturnType<UiHost["getSnapshot"]>["catalog"] | null = null;
    const tryOpen = () => {
      const state = host.getSnapshot();
      if (cancelled || pending || completed || state.bootstrap?.userId !== userId || state.catalog === attemptedCatalog) return;
      const matches = state.catalog.filter(item => item.panel.appId === eligibleAppId
        && (panelId === null || item.panel.panelId === panelId));
      const panel = matches.length === 1 ? matches[0] : null;
      if (!panel?.available) return;
      pending = true;
      attemptedCatalog = state.catalog;
      void host.openSurface({ panel: panel.panel, route: panel.route }, { placement: "side", requestId: createPresentationRequestId() }).then(result => {
        if (!cancelled && result.status === "opened") {
          completed = true;
          opened(result.target);
        }
      }).finally(() => { pending = false; tryOpen(); });
    };
    const stop = host.subscribeSnapshot(tryOpen);
    tryOpen();
    return () => { cancelled = true; stop(); };
  }, [host, eligibleAppId, panelId, sessionId, userId]);
}
