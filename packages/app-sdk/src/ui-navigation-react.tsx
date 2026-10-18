"use client";
import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
  return <div className="hosty-child-tools"><button type="button" disabled={chrome.tools.owner !== "host"} onClick={async () => {
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
  return <HostyNavigationBoundary><style>{navigationStyles}</style><div className={`hosty-navigation ${className}`}>
    {narrow ? <><button ref={opener} type="button" aria-label="Page navigation" aria-expanded={expanded} onClick={() => setExpanded(true)}>☰</button>
      <dialog ref={dialog} className="hosty-navigation-dialog" aria-label="Page navigation" onCancel={() => setExpanded(false)}>
        <button type="button" onClick={() => setExpanded(false)}>Close navigation</button><nav aria-label="App pages">{links}</nav>
      </dialog></> : <nav aria-label="App pages">{links}</nav>}
  </div></HostyNavigationBoundary>;
}
const navigationStyles = `
[data-hosty-navigation=hide] [data-hosty-navigation-boundary]{display:none!important}
.hosty-app-layout{display:flex;width:100%;height:100%;min-height:0;min-width:0}
.hosty-app-content{flex:1;min-width:0;min-height:0;overflow:auto;outline:none}
.hosty-navigation{flex:0 0 190px;box-sizing:border-box;padding:12px;border-right:1px solid color-mix(in srgb,currentColor 14%,transparent);font:14px system-ui}
.hosty-navigation nav,.hosty-navigation-dialog nav{display:flex;flex-direction:column;gap:4px}
.hosty-navigation a,.hosty-navigation-dialog a{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:6px;text-decoration:none;color:inherit}
.hosty-navigation a[aria-current=page],.hosty-navigation-dialog a[aria-current=page]{background:color-mix(in srgb,currentColor 10%,transparent);font-weight:600}
.hosty-navigation a[aria-disabled=true]{opacity:.55;cursor:not-allowed}
.hosty-navigation button,.hosty-child-tools button,.hosty-navigation-dialog button{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:6px;padding:7px 10px;cursor:pointer}
.hosty-navigation-dialog{position:fixed;inset:0 auto 0 0;margin:0;height:100dvh;width:min(300px,85vw);box-sizing:border-box;border:0;padding:16px;background:Canvas;color:CanvasText}
.hosty-navigation-dialog::backdrop{background:#0007}.hosty-child-tools{padding:6px 10px}
@media(max-width:899px){.hosty-app-layout{flex-direction:column}.hosty-navigation{flex:0 0 auto;border-right:0;padding:6px 10px}}
`;
