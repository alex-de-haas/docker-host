"use client";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { SdkIcon } from "./sdk-chrome";
import { UiHostContext } from "./ui-context";
import { useHostyChrome, useHostyNavigation } from "./ui-navigation-react";
import { StandaloneNavigationContext } from "./ui-standalone-context";
import { createStandalonePreferenceStore, standalonePreferenceKey } from "./ui-standalone-preferences";
import { panelKey, type UiPanel } from "./ui-types";
const noop = () => () => {};
const PreferencesContext = createContext<ReturnType<typeof createStandalonePreferenceStore> | null>(null);

export function StandaloneChrome({ children, navigation = true }: { children: ReactNode; navigation?: boolean }) {
  const host = useContext(UiHostContext);
  const snapshot = useSyncExternalStore(host?.subscribeSnapshot ?? noop, host?.getSnapshot ?? (() => null), () => null);
  const key = standalonePreferenceKey(snapshot?.bootstrap ?? null);
  const store = useMemo(() => createStandalonePreferenceStore(key), [key]);
  const prefs = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const [narrow, setNarrow] = useState(false), [drawer, setDrawer] = useState({ key, open: false });
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const resize = () => setNarrow(window.innerWidth < 900);
    resize(); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize);
  }, []);
  return <PreferencesContext.Provider value={store}><StandaloneNavigationContext.Provider value={navigation ? {
    collapsed: prefs.collapsed, narrow, open: drawer.key === key && drawer.open,
    setOpen: open => setDrawer({ key, open }), opener,
  } : null}>{children}</StandaloneNavigationContext.Provider></PreferencesContext.Provider>;
}

export function useStandalonePreferences() {
  const store = useContext(PreferencesContext);
  const fallback = useMemo(() => createStandalonePreferenceStore(null), []), current = store ?? fallback;
  const state = useSyncExternalStore(current.subscribe, current.getSnapshot, current.getServerSnapshot);
  return { ...state, setPinned: current.setPinned, setCollapsed: current.setCollapsed };
}

export function StandaloneHeader({ panels, selected, expanded, onSelect, onChoose, canNavigate, chooserOpen, attention }: {
  panels: UiPanel[]; selected: string | null; expanded: boolean; onSelect: (panel: UiPanel) => void;
  onChoose: () => void; canNavigate: boolean; chooserOpen: boolean; attention: (panel: UiPanel) => boolean;
}) {
  const host = useContext(UiHostContext), nav = useContext(StandaloneNavigationContext);
  const snapshot = useSyncExternalStore(host?.subscribeSnapshot ?? noop, host?.getSnapshot ?? (() => null), () => null);
  const chrome = useHostyChrome(), navigation = useHostyNavigation(), prefs = useStandalonePreferences();
  const app = snapshot?.bootstrap?.app, [failedIcon, setFailedIcon] = useState<string | null>(null);
  const name = app?.displayName || app?.appId || "Application";
  const icon = app?.iconUrl && /^https?:\/\//.test(app.iconUrl) ? app.iconUrl : null;
  const showNavigation = canNavigate && chrome.navigation === "show" && (navigation.status !== "ready" || navigation.entries.length > 0);
  const toolsVisible = chrome.tools.enabled && chrome.tools.launcher !== "hide";
  return <header data-hosty-sdk className="hosty-standalone-header">
    <div className="hosty-standalone-identity">
      {showNavigation && nav && <button ref={nav.opener} type="button" className="hosty-standalone-navigation" disabled={!prefs.ready}
        aria-label={nav.narrow ? nav.open ? "Hide navigation" : "Show navigation" : prefs.collapsed ? "Show navigation" : "Hide navigation"}
        title={nav.narrow ? "Page navigation" : prefs.collapsed ? "Show navigation" : "Hide navigation"}
        aria-expanded={nav.narrow ? nav.open : !prefs.collapsed}
        onClick={() => nav.narrow ? nav.setOpen(!nav.open) : prefs.setCollapsed(!prefs.collapsed)}><SdkIcon name="sidebar" /></button>}
      {icon && icon !== failedIcon ? <img src={icon} alt="" draggable={false} onError={() => setFailedIcon(icon)} /> : <SdkIcon name="app" />}
      <strong title={name}>{name}</strong>
    </div>
    {toolsVisible && <div className="hosty-standalone-tools">
      <nav className="hosty-pinned-tools" aria-label="Pinned tools">{prefs.pins.map(key => panels.find(panel => panelKey(panel.panel) === key)).filter((panel): panel is UiPanel => !!panel).map(panel =>
        <button key={panelKey(panel.panel)} type="button" aria-label={`Open ${panel.appName} — ${panel.label}`} title={`${panel.appName}: ${panel.label}`}
          aria-expanded={expanded && selected === panelKey(panel.panel)} onClick={() => onSelect(panel)}>
          <SdkIcon name="tools" /><span>{panel.label}</span>{attention(panel) && <span className="hosty-panel-attention" aria-label="Needs attention"><SdkIcon name="warning" /></span>}
        </button>)}</nav>
      <button type="button" aria-label="Tools" aria-haspopup="dialog" aria-expanded={chooserOpen} onClick={onChoose}><SdkIcon name="tools" /><span>Tools</span><SdkIcon name="chevron" /></button>
    </div>}
  </header>;
}
