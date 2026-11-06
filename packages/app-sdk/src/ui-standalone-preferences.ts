import { panelKey, type UiBootstrap, type UiPanel } from "./ui-types";

type Preferences = { ready: boolean; collapsed: boolean; pins: string[]; error: string | null };
const initial: Preferences = { ready: false, collapsed: false, pins: [], error: null };
export const standalonePreferenceKey = (bootstrap: UiBootstrap | null) => bootstrap
  ? `hosty:standalone:v1:${JSON.stringify([bootstrap.coreOrigin, bootstrap.userId, bootstrap.app.appId, bootstrap.app.installationId])}` : null;
export function parseStandalonePreferences(raw: string | null): Pick<Preferences, "collapsed" | "pins"> {
  try {
    const value = JSON.parse(raw ?? "null");
    if (value?.version !== 1) return { collapsed: false, pins: [] };
    const pins = Array.isArray(value.pins) ? value.pins.slice(0, 100).filter((key: unknown): key is string => {
      if (typeof key !== "string" || key.length > 2048) return false;
      try { const ref = JSON.parse(key); return Array.isArray(ref) && ref.length === 3 && ref.every(part => typeof part === "string" && part.length > 0); }
      catch { return false; }
    }) : [];
    return { collapsed: value.collapsed === true, pins: [...new Set<string>(pins)] };
  } catch { return { collapsed: false, pins: [] }; }
}

export function createStandalonePreferenceStore(key: string | null) {
  let snapshot = initial, raw: string | null | undefined;
  const listeners = new Set<() => void>();
  function read() {
    if (!key || typeof window === "undefined") return snapshot;
    try {
      const next = window.localStorage.getItem(key);
      if (next !== raw) { raw = next; snapshot = { ...parseStandalonePreferences(next), ready: true, error: null }; }
    } catch {
      if (!snapshot.ready) snapshot = { ...initial, ready: true, error: "Preferences cannot be saved in this browser." };
    }
    return snapshot;
  }
  function write(patch: Partial<Pick<Preferences, "collapsed" | "pins">>) {
    if (!key) return;
    snapshot = { ...read(), ...patch, ready: true, error: null };
    try {
      const next = JSON.stringify({ version: 1, collapsed: snapshot.collapsed, pins: snapshot.pins });
      window.localStorage.setItem(key, next); raw = next;
    } catch { snapshot = { ...snapshot, error: "Preferences apply until you reload; this browser could not save them." }; }
    listeners.forEach(listener => listener());
  }
  return {
    getSnapshot: read, getServerSnapshot: () => initial,
    subscribe(listener: () => void) {
      listeners.add(listener);
      const storage = (event: StorageEvent) => { if (event.key === key || event.key === null) { read(); listeners.forEach(fn => fn()); } };
      window.addEventListener("storage", storage);
      return () => { listeners.delete(listener); window.removeEventListener("storage", storage); };
    },
    setCollapsed: (collapsed: boolean) => write({ collapsed }),
    setPinned(panel: UiPanel, pinned: boolean) {
      const key = panelKey(panel.panel), pins = read().pins.filter(item => item !== key);
      write({ pins: pinned ? [...pins, key].slice(-100) : pins });
    },
  };
}
