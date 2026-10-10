"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { UiHost } from "@hosty-sdk/app/ui/host";
import { RIGHT_PANEL_OPEN_PREF_KEY } from "../shell-routes";

const noop = () => () => {};

/** The host owns live expansion; cookies and legacy storage only seed a new host. */
export function usePanelExpanded(host: UiHost | null, initialOpen: boolean | null, deferInitialOpen: boolean) {
  const initialized = useRef<UiHost | null>(null);
  const expanded = useSyncExternalStore(host?.subscribeSnapshot ?? noop,
    () => host?.getSnapshot().expanded ?? false, () => false);
  useEffect(() => {
    if (!host || initialized.current === host) return;
    initialized.current = host;
    const preferred = initialOpen ?? (window.localStorage.getItem(RIGHT_PANEL_OPEN_PREF_KEY) === "true");
    host.setExpanded(!deferInitialOpen && preferred);
    if (initialOpen === null) {
      document.cookie = `${RIGHT_PANEL_OPEN_PREF_KEY}=${preferred}; path=/; max-age=31536000; samesite=lax`;
    }
  }, [host, initialOpen, deferInitialOpen]);
  return expanded;
}
