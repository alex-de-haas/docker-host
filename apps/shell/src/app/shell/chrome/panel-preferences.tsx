"use client";

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useHostyUiHost } from "@hosty-sdk/app/ui/react";
import { panelKey, type UiPanel } from "@hosty-sdk/app/ui/types";

export const panelPreferenceKey = (coreOrigin: string, userId: string) =>
  `hosty:shell:panel-pins:v1:${JSON.stringify([coreOrigin, userId])}`;

type Snapshot = { overrides: Record<string, boolean>; ready: boolean; error: string | null; changed: boolean };
const initial: Snapshot = { overrides: {}, ready: false, error: null, changed: false };
export function parsePanelPreferences(raw: string | null): Record<string, boolean> {
  try {
    const value = JSON.parse(raw ?? "null");
    if (value?.version !== 1 || !value.pins || Array.isArray(value.pins) || typeof value.pins !== "object") return {};
    return Object.fromEntries(Object.entries(value.pins).filter((entry): entry is [string, boolean] => {
      const [key, pin] = entry;
      try { const ref = JSON.parse(key); return typeof pin === "boolean" && Array.isArray(ref) && ref.length === 3 && ref.every(part => typeof part === "string" && part.length > 0); }
      catch { return false; }
    }));
  } catch { return {}; }
}

export function createPanelPreferenceStore(key: string | null) {
  let snapshot = initial, raw: string | null | undefined;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  function read() {
    if (!key || typeof window === "undefined") return snapshot;
    try {
      const next = window.localStorage.getItem(key);
      if (next !== raw) {
        raw = next;
        snapshot = { overrides: parsePanelPreferences(next), ready: true, error: null, changed: snapshot.ready };
      }
    } catch {
      if (!snapshot.ready) snapshot = { overrides: {}, ready: true, error: "Tool choices cannot be saved in this browser.", changed: false };
    }
    return snapshot;
  }
  return {
    getSnapshot: read,
    getServerSnapshot: () => initial,
    subscribe(listener: () => void) {
      listeners.add(listener);
      const changed = (event: StorageEvent) => { if (event.key === key || event.key === null) { read(); emit(); } };
      window.addEventListener("storage", changed);
      return () => { listeners.delete(listener); window.removeEventListener("storage", changed); };
    },
    setPinned(panel: UiPanel, pinned: boolean) {
      if (!key) return;
      const overrides = { ...read().overrides, [panelKey(panel.panel)]: pinned };
      snapshot = { overrides, ready: true, error: null, changed: true };
      try {
        const next = JSON.stringify({ version: 1, pins: overrides });
        window.localStorage.setItem(key, next); raw = next;
      } catch { snapshot = { ...snapshot, error: "Tool choices cannot be saved in this browser. They apply until you reload." }; }
      emit();
    },
  };
}

type Preferences = { ready: boolean; restoreAllowed: boolean; error: string | null; isPinned: (panel: UiPanel) => boolean; setPinned: (panel: UiPanel, pinned: boolean) => void };
const PanelPreferences = createContext<Preferences>({ ready: true, restoreAllowed: true, error: null, isPinned: () => true, setPinned: () => {} });
const noop = () => () => {};
export function PanelPreferencesProvider({ coreOrigin, userId, assistantAppId, children }: {
  coreOrigin: string; userId: string | null; assistantAppId?: string | null; children: ReactNode;
}) {
  const host = useHostyUiHost();
  const hostState = useSyncExternalStore(host?.subscribeSnapshot ?? noop, host?.getSnapshot ?? (() => null), () => null);
  const defaultPanel = hostState?.catalog.find(item => item.panel.appId === assistantAppId);
  const defaultKey = defaultPanel ? panelKey(defaultPanel.panel) : null;
  const store = useMemo(() => createPanelPreferenceStore(userId ? panelPreferenceKey(coreOrigin, userId) : null), [coreOrigin, userId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const value = useMemo<Preferences>(() => ({ ready: state.ready, error: state.error,
    // A user choice cancels a pending layout restore; pinning never opens a tool.
    restoreAllowed: state.ready && !state.changed,
    isPinned: item => state.overrides[panelKey(item.panel)] ?? panelKey(item.panel) === defaultKey,
    setPinned: store.setPinned,
  }), [state, defaultKey, store]);
  return <PanelPreferences.Provider value={value}>{children}</PanelPreferences.Provider>;
}
export const usePanelPreferences = () => useContext(PanelPreferences);
