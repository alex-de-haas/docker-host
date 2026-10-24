"use client";
import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { SdkChromeStyles, SdkIcon } from "./sdk-chrome";
import { ui, createPresentationRequestId } from "./ui";
import { INITIAL_CHROME, INITIAL_NAVIGATION } from "./ui-composition";
import { UiCompositionContext } from "./ui-context";
import { UI_COMPOSITION_CAPABILITY } from "./ui-types";
export function useHostyChrome() { return useSyncExternalStore(ui.subscribeChrome, ui.getChrome, () => INITIAL_CHROME); }
export function useHostyNavigation() { return useSyncExternalStore(ui.subscribeNavigation, ui.getNavigation, () => INITIAL_NAVIGATION); }
export function HostyNavigationBoundary({ children, className }: { children: ReactNode; className?: string }) {
  const chrome = useHostyChrome(), ref = useRef<HTMLDivElement>(null), hidden = chrome.navigation === "hide";
  const focused = useRef(false);
  useLayoutEffect(() => { if (hidden && focused.current) { document.querySelector<HTMLElement>('[data-hosty-content][tabindex="-1"]')?.focus(); focused.current = false; } }, [hidden]);
  return <div ref={ref} onFocusCapture={() => { focused.current = true; }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) focused.current = false; }} className={className} data-hosty-navigation-boundary hidden={hidden} inert={hidden} style={hidden ? { display: "none" } : { display: "contents" }}>{children}</div>;
}
export function HostyToolLauncher() {
  const chrome = useHostyChrome(), [error, setError] = useState<string | null>(null);
  if (chrome.tools.owner === "local" || !chrome.tools.enabled || chrome.tools.launcher === "hide"
    || !chrome.capabilities.includes(UI_COMPOSITION_CAPABILITY)) return null;
  return <div data-hosty-sdk className="hosty-child-tools"><SdkChromeStyles /><style>{navigationStyles}</style><button type="button" disabled={chrome.tools.owner !== "host"} onClick={async () => {
    const result = await ui.openToolPicker({ requestId: createPresentationRequestId() });
    setError(result.status === "accepted" ? null : "Tools are unavailable. Reconnect to your host or open the app separately.");
  }}>Tools</button>{error && <span role="status">{error}</span>}</div>;
}
export function HostyNavigation({ className = "" }: { className?: string }) {
  const composition = useContext(UiCompositionContext);
  const model = useHostyNavigation(), chrome = useHostyChrome();
  const [expanded, setExpanded] = useState(false), [error, setError] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false), dialog = useRef<HTMLDialogElement>(null), opener = useRef<HTMLButtonElement>(null);
  useEffect(() => { const resize = () => setNarrow(window.innerWidth < 900); resize(); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  useEffect(() => {
    const modal = (event: Event) => { if ((event as CustomEvent).detail !== "navigation") setExpanded(false); };
    window.addEventListener("hosty:ui:modal", modal); return () => window.removeEventListener("hosty:ui:modal", modal);
  }, []);
  useEffect(() => {
    if (expanded && narrow && chrome.navigation === "show") { window.dispatchEvent(new CustomEvent("hosty:ui:modal", { detail: "navigation" })); dialog.current?.showModal(); }
    else { if (dialog.current?.open) { dialog.current.close();
      if (chrome.navigation === "show") opener.current?.focus();
      else document.querySelector<HTMLElement>('[data-hosty-content][tabindex="-1"]')?.focus();
    } }
  }, [expanded, narrow, chrome.navigation]);
  const empty = model.status === "ready" && !model.entries.length;
  const links = <>
    {model.status === "loading" && <p role="status">Loading navigation…</p>}
    {model.status === "unavailable" && <p role="status">Navigation is unavailable. <button type="button" onClick={() => void composition?.refreshNavigation()}>Retry navigation</button></p>}
    {model.entries.map(entry => <a key={entry.key} href={entry.standaloneHref ?? undefined} aria-current={model.activeKey === entry.key ? "page" : undefined}
      aria-disabled={!entry.route || !entry.available} title={!entry.available ? entry.state : undefined}
      onClick={async event => {
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        if (!entry.route || !entry.available) return;
        const result = await ui.navigate(entry.key, { requestId: createPresentationRequestId() });
        if (result.status === "accepted") { setExpanded(false); setError(null); }
        else setError(`Cannot open this page (${result.code}). Try again or open it separately.`);
      }}>{entry.icon && <img src={entry.icon} alt="" width={18} height={18} />}<span>{entry.label}</span></a>)}
    {error && <p role="status">{error}</p>}
  </>;
  if (empty) return null;
  return <HostyNavigationBoundary><SdkChromeStyles /><style>{navigationStyles}</style><div data-hosty-sdk className={`hosty-navigation ${className}`}>
    {narrow ? <><button ref={opener} type="button" aria-label="Page navigation" aria-expanded={expanded} onClick={() => setExpanded(true)}><SdkIcon name="menu" /></button>
      <dialog data-hosty-sdk ref={dialog} className="hosty-navigation-dialog" aria-label="Page navigation" onCancel={() => setExpanded(false)}>
        <button type="button" onClick={() => setExpanded(false)}>Close navigation</button><nav aria-label="App pages">{links}</nav>
      </dialog></> : <nav aria-label="App pages">{links}</nav>}
  </div></HostyNavigationBoundary>;
}
const navigationStyles = `
[data-hosty-navigation=hide] [data-hosty-navigation-boundary]{display:none!important}
.hosty-app-layout{display:flex;width:100%;height:100%;min-height:0;min-width:0}.hosty-app-content{flex:1;min-width:0;min-height:0;overflow:auto;outline:none}
.hosty-navigation{flex:0 0 190px;box-sizing:border-box;padding:12px;border-right:1px solid var(--hs-border);background:var(--hs-bg)}
.hosty-navigation nav,.hosty-navigation-dialog nav{display:flex;flex-direction:column;gap:4px}
.hosty-navigation a,.hosty-navigation-dialog a{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;text-decoration:none;color:inherit;font:500 14px/20px var(--hs-font);min-width:0;transition:background-color 120ms ease-out}.hosty-navigation a>span,.hosty-navigation-dialog a>span{min-width:0;overflow-wrap:anywhere}.hosty-navigation a>img,.hosty-navigation-dialog a>img{flex:none}
.hosty-navigation a:hover,.hosty-navigation-dialog a:hover{background:var(--hs-brand-soft)}.hosty-navigation a[aria-current=page],.hosty-navigation-dialog a[aria-current=page]{background:var(--hs-brand-soft);font-weight:500}
.hosty-navigation a[aria-disabled=true],.hosty-navigation-dialog a[aria-disabled=true]{opacity:.5;cursor:not-allowed}
.hosty-navigation button,.hosty-child-tools button,.hosty-navigation-dialog button{display:inline-flex;align-items:center;justify-content:center;gap:8px;font:500 14px/20px var(--hs-font);color:inherit;background:var(--hs-card);border:1px solid var(--hs-input);border-radius:8px;padding:7px 10px;cursor:pointer}.hosty-navigation button:hover,.hosty-child-tools button:hover,.hosty-navigation-dialog button:hover{background:var(--hs-brand-soft)}.hosty-child-tools button:disabled{opacity:.5;cursor:not-allowed}
.hosty-navigation-dialog{position:fixed;inset:0 auto 0 0;margin:0;height:100dvh;max-height:none;width:min(300px,85vw);box-sizing:border-box;border:0;border-right:1px solid var(--hs-border);padding:16px;background:var(--hs-card);color:var(--hs-fg)}.hosty-navigation-dialog>button{margin-bottom:16px}
.hosty-navigation-dialog::backdrop{background:#0F1B2D57}.hosty-child-tools{padding:6px 10px}.hosty-child-tools>[role=status]{display:inline-block;margin:0 8px;color:var(--hs-muted);font-size:13px}
@media(max-width:899px){.hosty-app-layout{flex-direction:column}.hosty-navigation{flex:0 0 auto;border-right:0;padding:6px 10px}}
`;
