"use client";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { HostyAppFrame, useHostyUiHost } from "@hosty-sdk/app/ui/react";
import type { UiHostSnapshot } from "@hosty-sdk/app/ui/host";
import { panelKey, type UiPanel } from "@hosty-sdk/app/ui";
import { Bot, LoaderCircle, PanelRightClose, Wrench, X } from "lucide-react";
import { assistantFor, createWindowPlacement, prepareWindowDiscussion, windowWorkspace } from "@/lib/window-tools";
import type { App } from "@/lib/model";
import { AppIcon } from "./app-icon";

const empty: UiHostSnapshot = { bootstrap: null, catalog: [], tools: [], selected: null, expanded: false, width: 360, error: null };
const noop = () => () => {};
const Placement = createContext<ReturnType<typeof createWindowPlacement> | null>(null);
export function DesktopTools({ children, revision = "" }: { children: ReactNode; revision?: string }) {
  const host = useHostyUiHost();
  const [placement] = useState(createWindowPlacement);
  useEffect(() => { host?.setPlacementResolver(placement.resolve); return () => host?.setPlacementResolver(); }, [host, placement]);
  useEffect(() => { void host?.refresh(); }, [host, revision]);
  return <Placement.Provider value={placement}>{children}</Placement.Provider>;
}

export function WindowTools({ app, apps, userId, children }: {
  app?: App; apps: App[]; userId: string;
  children: (toolbar: ReactNode, wrap: (content: ReactNode) => ReactNode) => ReactNode;
}) {
  const host = useHostyUiHost(), placement = useContext(Placement);
  const state = useSyncExternalStore(host?.subscribeSnapshot ?? noop, host?.getSnapshot ?? (() => empty), () => empty);
  const appId = app?.id;
  const workspaceId = windowWorkspace(appId ?? "");
  const root = useRef<HTMLDivElement>(null), mounted = useRef(false), busy = useRef(false);
  const [assistantViews, setAssistantViews] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const workspace = state.workspaces?.find(item => item.workspaceId === workspaceId);
  const tools = state.tools.filter(item => item.workspaceId === workspaceId);
  const selected = tools.find(item => item.presentationId === workspace?.selectedId);
  const expanded = Boolean(workspace?.expanded && selected);
  const catalog = state.bootstrap?.canHost ? state.catalog.filter(item => item.available || item.canStart) : [];
  useEffect(() => {
    mounted.current = true;
    if (!host || !appId) return () => { mounted.current = false; };
    // Render frames in the actual window tree: dragging, clipping, stacking and minimizing
    // then share the window's geometry without a second fixed-position overlay.
    const release = host.registerWorkspace({ workspaceId, renderer: {
      async present() { return root.current?.isConnected ? "accepted" : "unavailable"; },
      focus(id) { root.current?.querySelector<HTMLElement>(`[data-window-presentation="${id}"] iframe`)?.focus(); },
      collapse() {}, release() {}, async showToolPicker() { return "unavailable"; },
    } });
    return () => {
      mounted.current = false;
      for (const tool of host.getSnapshot().tools.filter(item => item.workspaceId === workspaceId)) host.closePresentation(tool.presentationId);
      release();
    };
  }, [host, appId, app?.installationId, workspaceId]);

  async function toggle(panel: UiPanel) {
    if (!host || !app || !placement || busy.current) return;
    const key = panelKey(panel.panel);
    if (workspace?.expanded && (selected?.key === key || assistantViews[key] === selected?.presentationId)) { host.collapseWorkspace(workspaceId); return; }
    busy.current = true; setPending(key); setError(null);
    try {
      await host.refresh();
      if (!mounted.current) return;
      if (host.getEnvironment().connection !== "connected") throw new Error("Reconnect Desktop to Hosty before opening a tool.");
      if (assistantFor(panel, apps)) {
        const retained = assistantViews[key];
        const view = host.getSnapshot().tools.find(item => item.presentationId === retained && item.workspaceId === workspaceId);
        if (view?.resolved.available) { host.focusPresentation(view.presentationId); return; }
        const discussion = await prepareWindowDiscussion(userId, app, panel, apps);
        if (!mounted.current) return;
        const result = await placement.open(host, workspaceId, discussion.target);
        if (result.status !== "opened") throw new Error(`Could not open the assistant (${result.code}). Retry to recover this discussion.`);
        if (result.presentationId) setAssistantViews(current => ({ ...current, [key]: result.presentationId! }));
        discussion.complete();
      } else {
        const result = await host.selectPanel(panel.panel, workspaceId);
        if (result.status !== "opened") throw new Error(`Could not open ${panel.label} (${result.code}).`);
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not open this tool."); }
    finally { busy.current = false; if (mounted.current) setPending(null); }
  }
  const toolbar = app && catalog.length > 0 ? <div className="window-tools" role="group" aria-label={`${app.displayName} tools`}>
    {catalog.map(panel => {
      const key = panelKey(panel.panel), assistant = assistantFor(panel, apps);
      const provider = apps.find(item => item.id === panel.panel.appId);
      const isSelected = expanded && (selected?.key === key || assistantViews[key] === selected?.presentationId);
      const label = `${panel.appName}: ${panel.label}${assistant ? ` — discuss ${app.displayName}` : ""}${panel.available ? "" : " — start the application from the dock"}`;
      return <button key={key} className={`window-tool ${isSelected ? "selected" : ""}`}
        title={label} aria-label={label} aria-expanded={isSelected} aria-controls={`tools-${workspaceId}`}
        disabled={!!pending || !panel.available} onClick={() => void toggle(panel)}>
        {pending === key ? <LoaderCircle size={17} className="spin" /> : <AppIcon app={provider ? { ...provider, icon: panel.icon || provider.icon, iconUrl: panel.icon ? undefined : provider.iconUrl } : undefined} icon={assistant ? Bot : Wrench} className="tool-icon" />}
        {tools.some(item => item.key === key && item.attention > 0) && <span className="tool-attention" aria-label="Needs attention" />}
      </button>;
    })}
  </div> : null;
  return children(toolbar, content => <div ref={root} className={`window-workspace ${expanded ? "with-tool" : ""}`}>
    <div className="window-document">{!host || workspace || !app ? content : null}</div>
    {app && <aside className="window-tool-panel" id={`tools-${workspaceId}`} aria-label={`${app.displayName} tool panel`} hidden={!expanded} inert={!expanded}>
      <header><div><strong>{state.catalog.find(item => item.panel.appId === selected?.target.panel.appId && item.panel.panelId === selected?.target.panel.panelId)?.label || "Tool"}</strong>
        <span>{app.displayName}</span></div><button className="window-tool" aria-label={`Hide ${app.displayName} tool panel`} title="Hide panel" onClick={() => host?.collapseWorkspace(workspaceId)}><PanelRightClose size={17} /></button></header>
      {selected?.readiness === "unreported" && <p className="tool-unavailable" role="status">The tool has not confirmed that it loaded. Check its connection and try opening it again.</p>}
      {selected?.readiness === "auth-required" && <p className="tool-unavailable" role="status">Sign in to the tool below to continue.</p>}
      <div className="window-tool-frames">{tools.map(tool => <div key={tool.presentationId} data-window-presentation={tool.presentationId}
        className="window-tool-frame" hidden={tool.presentationId !== workspace?.selectedId} inert={tool.presentationId !== workspace?.selectedId}>
        {tool.resolved.surface && tool.resolved.available ? <HostyAppFrame surface={{ ...tool.resolved.surface, panelId: tool.target.panel.panelId }}
          title={state.catalog.find(item => panelKey(item.panel) === tool.key)?.label || "Tool"}
          view={{ viewId: `tool-${tool.presentationId}`, workspaceId, presentationId: tool.presentationId, chrome: { navigation: "hide", tools: { enabled: true, launcher: "hide" } } }}
          onAttention={count => host?.setAttention(tool.presentationId, count)} /> : <p className="tool-unavailable" role="status">This tool is no longer available. Check its access and running state.</p>}
      </div>)}</div>
    </aside>}
    {error && <div className="window-tool-error" role="alert"><span>{error}</span><button className="window-tool" aria-label="Dismiss tool error" onClick={() => setError(null)}><X size={15} /></button></div>}
  </div>);
}
