"use client";
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { bindUiClient, ui, type UiClient } from "./ui";
import { createUiHost, type UiHost, type UiHostSnapshot } from "./ui-host";
import { EmbeddedUiClient } from "./ui-embedded";
import { UiHostContext } from "./ui-context";
import { HostyAppFrame, type HostyAppFrameProps } from "./ui-frame";
import { panelKey, type UiEnvironment, type UiPanel } from "./ui-types";
import { uiPath as normalizeUiPath } from "./ui-transport";
export { HostyAppFrame, type HostyAppFrameProps } from "./ui-frame";

export function useHostyUi(): UiClient { return ui; }
export function useHostyUiHost(): UiHost | null { return useContext(UiHostContext); }

/** Internal composition root, owned by HostyOverlay rather than mounted again by domain apps. */
export function HostyUiRoot({ children, uiPath, panelLayout = "auto", active = true }: {
  children: ReactNode; uiPath?: string; panelLayout?: "auto" | "slot" | "none"; active?: boolean;
}) {
  const [host, setHost] = useState<UiHost | null>(null);
  const [environment, setEnvironment] = useState<UiEnvironment | null>(null);
  const mounted = useRef(false);
  const clientRef = useRef<UiHost | EmbeddedUiClient | null>(null);
  const activeRef = useRef(active);
  useLayoutEffect(() => {
    activeRef.current = active;
    clientRef.current?.setActive(active);
  }, [active]);
  useEffect(() => {
    const path = normalizeUiPath(uiPath);
    const client = window.parent === window ? createUiHost({ uiPath: path, active: activeRef.current }) : new EmbeddedUiClient(path);
    client.setActive(activeRef.current);
    clientRef.current = client;
    const release = bindUiClient(client), stop = client.subscribe(event => { if (event.type === "environment") setEnvironment(event.value); });
    if (client instanceof EmbeddedUiClient) setHost(null); else setHost(client);
    return () => { stop(); release(); client.dispose(); clientRef.current = null; };
  }, [uiPath]);
  const allowed = environment?.mode === "standalone" || environment?.connection === "connected" || environment?.connection === "unsupported";
  if (allowed) mounted.current = true;
  return <UiHostContext.Provider value={host}>
    <div hidden={!allowed} inert={!allowed} style={{ display: allowed ? "contents" : "none" }}>
      {mounted.current && (panelLayout === "auto" && host ? <HostyPanelWorkspace>{children}</HostyPanelWorkspace> : children)}
    </div>
    {!allowed && <div role="status" className="hosty-panel-notice" style={{ padding: 24, font: "14px system-ui" }}>
      {environment?.connection === "blocked" ? <>
        <strong>{environment.code === "actor_mismatch" ? "Use the same Hosty account in this app and its host" : "Cannot verify this app’s host"}</strong>
        <p>Check your account and access in Hosty Core, then reconnect. Your existing discussion is unchanged.</p>
        <button type="button" onClick={() => window.location.reload()}>Reconnect</button>
      </> : "Connecting to the workspace…"}
    </div>}
  </UiHostContext.Provider>;
}

const empty: UiHostSnapshot = { bootstrap: null, catalog: [], tools: [], selected: null, expanded: false, width: 360, error: null };
const noop = () => () => {};

export type HostyPanelWorkspaceProps = {
  children: ReactNode; railMode?: "opened" | "catalog"; className?: string;
  initialWidth?: number; initialExpanded?: boolean; onWidthChange?: (width: number) => void; onExpandedChange?: (expanded: boolean) => void;
  onStartApp?: (appId: string) => void | Promise<void>;
  onAskAssistant?: HostyAppFrameProps["onAskAssistant"]; onAuthRequired?: HostyAppFrameProps["onAuthRequired"];
  outbound?: { appId: string; message: unknown; nonce: number } | null;
  renderIcon?: (panel: UiPanel) => ReactNode;
};

/** A single retained frame tree for dock and drawer; only CSS placement changes at the breakpoint. */
export function HostyPanelWorkspace({ children, railMode = "opened", className = "", initialWidth, initialExpanded,
  onWidthChange, onExpandedChange, onStartApp, onAskAssistant, onAuthRequired, outbound, renderIcon }: HostyPanelWorkspaceProps) {
  const host = useHostyUiHost();
  const state = useSyncExternalStore(host?.subscribeSnapshot ?? noop, host?.getSnapshot ?? (() => empty), () => empty);
  const unsupported = state.error?.code.startsWith("unsupported") === true;
  const root = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), body = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null), panelOpener = useRef<HTMLElement | null>(null);
  const [size, setSize] = useState(1200), [chooser, setChooser] = useState(false), [error, setError] = useState<string | null>(null);
  const chooserRef = useRef<HTMLDialogElement>(null);
  const bodyId = useId();
  const workspaceOwner = useRef({});
  useEffect(() => host?.claimWorkspace(workspaceOwner.current), [host]);
  const drawer = size < 900, expanded = state.expanded && !!state.selected;
  const selectedKey = state.selected ? panelKey(state.selected) : null;
  const tabs = railMode === "catalog" ? state.catalog : state.tools.map(tool => state.catalog.find(p => panelKey(p.panel) === tool.key)).filter((p): p is UiPanel => !!p);
  const selected = state.catalog.find(p => panelKey(p.panel) === selectedKey);
  const tool = state.tools.find(t => t.key === selectedKey);
  const width = Math.min(state.width, Math.max(280, size - 480 - 60));
  const optionsRef = useRef({ onWidthChange, onExpandedChange }); optionsRef.current = { onWidthChange, onExpandedChange };
  useEffect(() => {
    if (!host) return;
    if (initialWidth !== undefined) host.setWidth(initialWidth);
    if (initialExpanded !== undefined) host.setExpanded(initialExpanded);
  }, [host]);
  useEffect(() => {
    if (!host || railMode !== "catalog") return;
    let live = true, pending = false, completed = false;
    let attemptedCatalog: UiPanel[] | null = null;
    const restore = () => {
      const current = host.getSnapshot();
      if (!current.expanded) { attemptedCatalog = null; return; }
      if (!live || pending || completed || current.selected || current.catalog === attemptedCatalog) return;
      const first = current.catalog.find(panel => panel.available);
      if (!first) return;
      pending = true; attemptedCatalog = current.catalog;
      void host.selectPanel(first.panel).then(result => { completed = result.status === "opened"; })
        .finally(() => { pending = false; restore(); });
    };
    // A refusal consumes only this catalog generation. A refresh can retry, including one
    // received while resolution was pending, but a user collapse always prevents restoration.
    const stop = host.subscribeSnapshot(restore);
    restore();
    return () => { live = false; stop(); };
  }, [host, railMode]);
  const lastPrefs = useRef({ width: initialWidth ?? 360, expanded: initialExpanded ?? false });
  useEffect(() => {
    if (!host || state !== host.getSnapshot()) return;
    if (state.width !== lastPrefs.current.width) optionsRef.current.onWidthChange?.(state.width);
    if (state.expanded !== lastPrefs.current.expanded) optionsRef.current.onExpandedChange?.(state.expanded);
    lastPrefs.current = { width: state.width, expanded: state.expanded };
  }, [host, state.width, state.expanded]);
  useLayoutEffect(() => {
    if (!root.current) return;
    const read = () => setSize(root.current!.getBoundingClientRect().width || window.innerWidth);
    read(); const observer = new ResizeObserver(read); observer.observe(root.current); return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!expanded) return;
    panelOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { const previous = panelOpener.current; if (previous?.isConnected) previous.focus(); };
  }, [expanded]);
  useLayoutEffect(() => {
    if (!expanded || !drawer) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    const dismiss = () => host?.setExpanded(false);
    window.addEventListener("hosty:ui:drawer-dismiss", dismiss);
    return () => { window.removeEventListener("hosty:ui:drawer-dismiss", dismiss); if (opener.current?.isConnected) opener.current.focus(); };
  }, [expanded, drawer, host]);
  useEffect(() => {
    if (expanded && tool?.readiness === "ready") body.current?.querySelector<HTMLIFrameElement>(".hosty-panel-frame:not([hidden]) iframe")?.focus();
  }, [expanded, selectedKey, tool?.readiness]);
  useEffect(() => {
    const dialog = chooserRef.current; if (!chooser || !dialog) return;
    dialog.showModal(); return () => { if (dialog.open) dialog.close(); };
  }, [chooser]);
  async function select(panel: UiPanel) {
    if (!host) return;
    if (expanded && selectedKey === panelKey(panel.panel)) { host.setExpanded(false); return; }
    const result = await host.selectPanel(panel.panel);
    if (result.status !== "opened") setError(panel.available ? "Could not open this tool. Try again." : `${panel.appName} is ${panel.state}.`);
    else { setError(null); setChooser(false); }
  }
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = event.clientX, old = width, handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => host?.setWidth(Math.min(size - 540, old + start - next.clientX));
    const end = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", end); handle.removeEventListener("lostpointercapture", end); };
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", end); handle.addEventListener("lostpointercapture", end);
  };
  return <div ref={root} className={`hosty-panel-workspace ${className}`} data-hosty-panel-layout={drawer ? "drawer" : "dock"}
    style={{ "--hosty-panel-width": `${width}px`, ...(unsupported ? { display: "contents" } : {}) } as CSSProperties}>
    <style>{styles}</style>
    <div ref={content} className="hosty-panel-document" style={unsupported ? { display: "contents" } : undefined} inert={expanded && drawer}>{children}</div>
    <nav className="hosty-panel-rail" aria-label="Tools" style={unsupported ? { display: "none" } : undefined} inert={unsupported || expanded && drawer}>
      {tabs.map((panel, index) => <button key={panelKey(panel.panel)} type="button" title={`${panel.appName}: ${panel.label}`} aria-label={panel.label}
        aria-controls={bodyId} aria-expanded={expanded && selectedKey === panelKey(panel.panel)} onClick={() => void select(panel)}
        onKeyDown={event => { const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : delta ? (index + delta + tabs.length) % tabs.length : null;
          if (next !== null) { event.preventDefault(); (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus(); }
        }}>{renderIcon?.(panel) ?? panel.label.slice(0, 2)}
        {state.tools.find(t => t.key === panelKey(panel.panel))?.attention ? <span className="hosty-panel-attention" aria-label="Needs attention">•</span> : null}
      </button>)}
      <button type="button" aria-label="Add tool" title="Add tool" onClick={() => { setError(null); setChooser(true); void host?.refresh(); }}>+</button>
    </nav>
    {expanded && drawer && <button type="button" className="hosty-panel-backdrop" aria-label="Return to document" onClick={() => host?.setExpanded(false)} />}
    <aside ref={body} id={bodyId} className="hosty-panel-body" hidden={!expanded} inert={!expanded}
      role={drawer ? "dialog" : "complementary"} aria-modal={drawer && expanded ? true : undefined} aria-label={selected?.label ?? "Tool"}
      onKeyDown={event => {
        if (!drawer) return;
        if (event.key === "Escape") { event.preventDefault(); host?.setExpanded(false); }
        if (event.key === "Tab") {
          const focusable = Array.from(body.current?.querySelectorAll<HTMLElement>('button,a[href],iframe,[tabindex="0"]') ?? []).filter(e => !e.closest("[hidden]") && !(e as HTMLButtonElement).disabled);
          const first = focusable[0], last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      {drawer && expanded && <span tabIndex={0} aria-hidden="true" className="hosty-panel-focus-guard"
        onFocus={() => body.current?.querySelector<HTMLIFrameElement>(".hosty-panel-frame:not([hidden]) iframe")?.focus()} />}
      <div className="hosty-panel-resize" role="separator" aria-label="Tool panel width" aria-orientation="vertical" tabIndex={drawer ? -1 : 0}
        aria-valuemin={280} aria-valuemax={Math.max(280, Math.min(800, size - 540))} aria-valuenow={width} onPointerDown={resize}
        onDoubleClick={() => host?.setWidth(360)}
        onKeyDown={event => {
          if (event.key === "Home") { event.preventDefault(); host?.setWidth(360); }
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); host?.setWidth(width + (event.key === "ArrowLeft" ? 16 : -16)); }
        }} />
      <header><strong>{selected?.label ?? "Tool"}</strong>
        {tool?.resolved.standaloneHref && <a href={tool.resolved.standaloneHref} target="_blank" rel="noopener noreferrer" title="Open separately" aria-label="Open separately">↗</a>}
        <button ref={close} type="button" onClick={() => host?.setExpanded(false)} aria-label="Return to document" title="Return to document">×</button>
      </header>
      {tool?.resolved.state === "degraded" && <div className="hosty-panel-state" role="status">This app’s health check is failing. Its page may still work.</div>}
      {tool?.readiness === "unreported" && <div className="hosty-panel-state" role="status">This tool has not confirmed that it loaded. If the page is blank or refuses to connect, use <a href={tool.resolved.standaloneHref ?? undefined} target="_blank" rel="noopener noreferrer">Open separately</a>.</div>}
      {tool?.readiness === "auth-required" && <div className="hosty-panel-state" role="status">Check access in the tool below, then retry opening the discussion.</div>}
      {state.tools.map(item => <div key={item.key} className="hosty-panel-frame" hidden={item.key !== selectedKey} inert={item.key !== selectedKey}>
        {item.resolved.surface ? <HostyAppFrame key={JSON.stringify(item.resolved.surface)} surface={{ ...item.resolved.surface, panelId: item.target.panel.panelId }}
          title={state.catalog.find(p => panelKey(p.panel) === item.key)?.label ?? "Tool"} standaloneHref={item.resolved.standaloneHref}
          onAskAssistant={onAskAssistant} onAuthRequired={onAuthRequired} onAttention={count => host?.setAttention(item.target.panel, count)}
          outbound={outbound?.appId === item.target.panel.appId ? outbound : null} />
          : <div className="hosty-panel-notice"><p>This tool is unavailable ({item.resolved.state}).</p><button type="button" onClick={() => void host?.selectPanel(item.target.panel)}>Retry opening</button></div>}
      </div>)}
      {drawer && expanded && <span tabIndex={0} aria-hidden="true" className="hosty-panel-focus-guard" onFocus={() => close.current?.focus()} />}
    </aside>
    {chooser && <dialog ref={chooserRef} className="hosty-tool-chooser" onCancel={() => setChooser(false)} aria-label="Add tool">
      <header><strong>Add tool</strong><button type="button" onClick={() => setChooser(false)} aria-label="Close tool chooser">×</button></header>
      <p>Open a tool beside your document.</p>
      {error && <p role="status">{error}</p>}
      {state.error && <p role="status">{state.error.message}</p>}
      {!state.bootstrap?.canHost && <p>This app needs optional panel access in Hosty Core to show tools here. You can still use the app.</p>}
      {state.bootstrap?.canHost && !state.catalog.length && <p>No tools are available for your account.</p>}
      <ul>{state.catalog.map(panel => <li key={panelKey(panel.panel)}>
        <button type="button" onClick={() => void select(panel)}><strong>{panel.label}</strong><span>{panel.appName}{panel.available ? "" : ` · ${panel.state}`}</span></button>
        {!panel.available && panel.canStart && onStartApp && <button type="button" onClick={() => void Promise.resolve(onStartApp(panel.panel.appId)).then(() => host?.refresh())}>Start app</button>}
      </li>)}</ul>
      <button type="button" onClick={() => void host?.refresh()}>Refresh tools</button>
    </dialog>}
    {error && !chooser && <div className="hosty-panel-error" role="status">{error} <button type="button" onClick={() => { setChooser(true); setError(null); }}>Choose tool</button></div>}
  </div>;
}

const styles = `
.hosty-panel-workspace{--hp-bg:#f8f9fb;--hp-fg:#20242c;--hp-muted:#606875;--hp-border:#e0e4eb;display:flex;position:relative;min-width:0;min-height:0;width:100%;height:100dvh;overflow:hidden;background:var(--hp-bg);color:var(--hp-fg)}
html.dark .hosty-panel-workspace,html[data-hosty-theme=dark] .hosty-panel-workspace{--hp-bg:#14171c;--hp-fg:#f0f2f5;--hp-muted:#a2aab7;--hp-border:#323843}
.hosty-panel-document{flex:1;min-width:0;min-height:0;overflow:auto}.hosty-panel-rail{order:3;flex:0 0 48px;display:flex;flex-direction:column;align-items:center;gap:8px;padding:10px 0;border-left:1px solid var(--hp-border);overflow:auto}
.hosty-panel-workspace button,.hosty-panel-workspace a{font:inherit}.hosty-panel-rail button,.hosty-panel-body header button,.hosty-panel-body header a,.hosty-tool-chooser header button{position:relative;display:grid;place-items:center;flex-shrink:0;border:1px solid transparent;border-radius:8px;width:32px;height:32px;padding:0;background:transparent;color:inherit;font:500 13px system-ui;cursor:pointer;text-decoration:none}
.hosty-panel-rail button:hover,.hosty-panel-rail button[aria-expanded=true]{border-color:var(--hp-border);background:color-mix(in srgb,var(--hp-fg) 8%,transparent)}
.hosty-panel-workspace :focus-visible{outline:2px solid #5286ee;outline-offset:2px}.hosty-panel-attention{position:absolute;top:0;right:1px;color:#e9a52b;font-size:20px}
.hosty-panel-body{order:2;display:flex;flex:0 0 var(--hosty-panel-width);flex-direction:column;position:relative;min-width:0;min-height:0;margin-left:12px;border-left:1px solid var(--hp-border);background:var(--hp-bg)}
.hosty-panel-body[hidden],.hosty-panel-frame[hidden]{display:none}.hosty-panel-body header,.hosty-tool-chooser header{display:flex;align-items:center;gap:6px;min-height:44px;padding:0 10px;border-bottom:1px solid var(--hp-border);font:500 13px system-ui}.hosty-panel-body header strong,.hosty-tool-chooser header strong{flex:1}
.hosty-panel-focus-guard{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.hosty-panel-frame{position:relative;flex:1;min-height:0;overflow:hidden}.hosty-panel-frame iframe{display:block}.hosty-panel-resize{position:absolute;left:-12px;top:0;bottom:0;width:12px;cursor:col-resize;touch-action:none}.hosty-panel-resize:hover{background:color-mix(in srgb,var(--hp-fg) 8%,transparent)}
.hosty-panel-state{padding:8px 12px;font:12px/1.4 system-ui;border-bottom:1px solid var(--hp-border);color:var(--hp-muted)}.hosty-panel-state a{text-decoration:underline}
.hosty-panel-workspace[data-hosty-panel-layout=drawer] .hosty-panel-body{position:absolute;inset:0 0 0 auto;width:min(440px,100%);z-index:3;margin:0;box-shadow:-8px 0 30px #0002}.hosty-panel-workspace[data-hosty-panel-layout=drawer] .hosty-panel-resize{display:none}
.hosty-panel-backdrop{position:absolute;inset:0;border:0;background:#0005;z-index:2;cursor:pointer}.hosty-panel-notice{padding:24px;font:14px/1.5 system-ui}.hosty-panel-review{position:absolute;top:8px;right:8px;z-index:2;padding:10px;background:var(--hp-bg);border:1px solid var(--hp-border);border-radius:8px}
.hosty-tool-chooser{width:min(440px,calc(100vw - 32px));max-height:80dvh;border:1px solid var(--hp-border);border-radius:12px;padding:16px;background:var(--hp-bg);color:var(--hp-fg);font:14px/1.5 system-ui}.hosty-tool-chooser::backdrop{background:#0005}.hosty-tool-chooser ul{list-style:none;padding:0;display:grid;gap:8px}.hosty-tool-chooser li{display:flex;gap:8px}.hosty-tool-chooser li>button{flex:1;border:1px solid var(--hp-border);background:transparent;color:inherit;border-radius:8px;padding:12px;text-align:left;cursor:pointer}.hosty-tool-chooser li span{display:block;color:var(--hp-muted);font-size:12px}.hosty-panel-error{position:absolute;bottom:16px;right:60px;z-index:4;background:var(--hp-bg);border:1px solid var(--hp-border);border-radius:8px;padding:12px;font:13px system-ui}
`;
