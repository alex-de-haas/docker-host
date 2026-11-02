"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { PanelsTopLeft, Pin } from "lucide-react";
import { HostyAppFrame, useHostyUiHost, useHostyChrome, useHostyFeedback, type HostyAppFrameProps } from "@hosty-sdk/app/ui/react";
import type { UiHostSnapshot, UiWorkspaceRenderer } from "@hosty-sdk/app/ui/host";
import { panelKey, type PanelTarget, type UiPanel } from "@hosty-sdk/app/ui/types";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { HostyEmptySlots, HostyLoader } from "../../../../../../shared/web/hosty-states";
import { AppIcon } from "../app-icon";
import { usePanelPreferences } from "./panel-preferences";
import { useToolActivity, ToolActivityMark } from "./tool-activity";
import { ShellConcurrentPanels, type ShellPanelColumn } from "./shell-concurrent-panels";
import { RIGHT_PANEL_WIDTH_PREF_KEY } from "./panel-width";
import { ShellToolPanel } from "./shell-tool-panel";

const empty: UiHostSnapshot = { bootstrap: null, catalog: [], tools: [], selected: null, expanded: false, width: 360, error: null };
const noop = () => () => {};
function rememberLegacyWidth(width: number) { document.cookie = `${RIGHT_PANEL_WIDTH_PREF_KEY}=${Math.round(width)}; path=/; max-age=31536000; samesite=lax`; }
// HostyAppFrame supplies transport and recovery content; Shell supplies its presentation styles.
const frameStyles = `
[data-shell-panel-frame]{position:relative}
[data-shell-panel-frame]>iframe{display:block}
[data-shell-panel-frame]>.hosty-panel-review{position:absolute;top:8px;right:8px;z-index:2;padding:10px;background:var(--background);color:var(--foreground);border:1px solid var(--border);border-radius:8px;font-size:14px}
[data-shell-panel-frame]>.hosty-panel-notice{padding:24px;font-size:14px;line-height:1.5}
[data-shell-panel-frame]>.hosty-panel-notice a{text-decoration:underline}
`;
type Props = Pick<HostyAppFrameProps, "onAskAssistant" | "onAuthRequired"> & {
  children: ReactNode;
  initialWidth?: number;
  pageMinimum?: number;
  onExpandedChange?: (expanded: boolean) => void;
  onStartApp?: (appId: string) => void | Promise<void>;
  outbound?: { target: PanelTarget; presentationId?: string; message: unknown; nonce: number } | null;
};

/** Shell owns all chrome; the SDK owns authority, presentation identity and frame transport. */
export function ShellPanelWorkspace({ children, initialWidth = 360, pageMinimum = 560, onExpandedChange, onStartApp, onAskAssistant, onAuthRequired, outbound }: Props) {
  const host = useHostyUiHost();
  const chrome = useHostyChrome();
  const { state: feedbackState } = useHostyFeedback();
  const state = useSyncExternalStore(host?.subscribeSnapshot ?? noop, host?.getSnapshot ?? (() => empty), () => empty);
  const toolsEnabled = chrome.tools.enabled && !state.error?.code.startsWith("unsupported");
  const workspace = state.workspaces?.find(w => w.workspaceId === "default");
  const tools = state.tools.filter(t => t.workspaceId === "default");
  const tool = tools.find(t => t.presentationId === workspace?.selectedId);
  const expanded = !!workspace?.expanded && !!tool;
  const [picker, setPicker] = useState(false), [error, setError] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [savedWidths, setSavedWidths] = useState<Record<string, number>>({});
  const widthKey = state.bootstrap ? `hosty.shell.tool-widths.v1:${state.bootstrap.coreOrigin}:${state.bootstrap.userId}` : null;
  useEffect(() => {
    let values: Record<string, number> = {};
    try {
      const stored: unknown = widthKey ? JSON.parse(localStorage.getItem(widthKey) ?? "{}") : {};
      if (stored && typeof stored === "object" && !Array.isArray(stored)) values = Object.fromEntries(Object.entries(stored).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 280 && value <= 800));
    } catch { /* Browser storage is optional. */ }
    // Restore external browser preferences when the authenticated owner changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSavedWidths(values); setWidths({});
  }, [widthKey]);
  const [query, setQuery] = useState("");
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const frames = useRef(new Map<string, HTMLDivElement>());

  const panelPreferences = usePanelPreferences();
  const latestPins = useRef(panelPreferences);
  const restorePinned = useRef<(() => void) | null>(null);
  const pendingRestore = useRef<AbortController | null>(null);
  useEffect(() => {
    latestPins.current = panelPreferences;
    if (!panelPreferences.restoreAllowed) pendingRestore.current?.abort();
    restorePinned.current?.();
  }, [panelPreferences]);
  const preferences = useRef(onExpandedChange);
  useEffect(() => { preferences.current = onExpandedChange; }, [onExpandedChange]);

  useEffect(() => {
    if (!host) return;
    const renderer: UiWorkspaceRenderer = {
      async present(_instance, signal) {
        // The mounted Shell slot owns the retained frame tree populated by the host snapshot.
        return !signal.aborted && root.current?.isConnected ? "accepted" : "unavailable";
      },
      focus(id) { setFocusRequest({ id }); setFocusedId(id); },
      collapse() { setPicker(false); },
      release() { /* React removes frames when the host removes their presentation. */ },
      async showToolPicker(signal) {
        if (signal.aborted || !root.current?.isConnected) return "unavailable";
        setPicker(true); return "accepted";
      },
    };
    const unregister = host.registerWorkspace({ workspaceId: "default", renderer, multiple: true });
    host.setWidth(initialWidth);
    // Restore an expanded preference only once a catalog with an available tool arrives.
    let live = true, opening = false;
    let attempted: UiPanel[] | null = null;
    const restore = () => {
      const current = host.getSnapshot(), slot = current.workspaces?.find(w => w.workspaceId === "default");
      if (!slot?.expanded) { attempted = null; return; }
      if (!live || opening || slot.selectedId || attempted === current.catalog) return;
      if (!latestPins.current.restoreAllowed) return;
      const first = current.catalog.find(p => p.available && latestPins.current.isPinned(p)); if (!first) return;
      attempted = current.catalog; opening = true;
      const controller = new AbortController(); pendingRestore.current = controller;
      void host.selectPanel(first.panel, "default", controller.signal).finally(() => {
        if (pendingRestore.current === controller) pendingRestore.current = null;
        opening = false; restore();
      });
    };
    restorePinned.current = restore;
    const stop = host.subscribeSnapshot(restore); restore();
    return () => {
      live = false; pendingRestore.current?.abort(); pendingRestore.current = null;
      restorePinned.current = null; stop();
      for (const item of host.getSnapshot().tools.filter(t => t.workspaceId === "default")) host.closePresentation(item.presentationId);
      unregister();
    };
  }, [host, initialWidth]);
  const workspaceExpanded = workspace?.expanded;
  const lastExpanded = useRef(false);
  useEffect(() => {
    // Registration starts collapsed even when an explicit assistant link defers an open preference.
    // Only persist transitions, never this initial value.
    if (workspaceExpanded !== undefined && workspaceExpanded !== lastExpanded.current) {
      lastExpanded.current = workspaceExpanded;
      preferences.current?.(workspaceExpanded);
    }
  }, [workspaceExpanded]);
  useEffect(() => { if (picker) window.dispatchEvent(new CustomEvent("hosty:ui:modal", { detail: "picker:default" })); }, [picker]);
  const anyOpen = expanded;
  useLayoutEffect(() => {
    if (!anyOpen) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (opener.current?.isConnected) opener.current.focus(); };
  }, [anyOpen]);
  const selectedPresentationId = tool?.presentationId;
  useEffect(() => {
    // Host acceptance can precede React's frame commit. Retry after mounting and readiness,
    // after the layout effect has recorded the document element to restore on collapse.
    if (expanded && selectedPresentationId && focusRequest?.id === selectedPresentationId) {
      frames.current.get(selectedPresentationId)?.querySelector<HTMLIFrameElement>("iframe")?.focus();
    }
  }, [expanded, selectedPresentationId, tool?.readiness, focusRequest]);

  async function select(panel: UiPanel) {
    if (!host) return;
    const result = await host.selectPanel(panel.panel);
    if (result.status === "opened") { setError(null); setPicker(false); }
    else setError(panel.available ? "Could not open this tool. Try again." : `${panel.appName} is ${panel.state}.`);
  }
  const search = query.trim().toLowerCase();
  const activity = useToolActivity();
  const matchingTools = state.catalog.filter(item => `${item.label} ${item.appName}`.toLowerCase().includes(search));
  const toolGroups = new Map<string, { appName: string; items: UiPanel[] }>();
  for (const item of matchingTools) {
    const group = toolGroups.get(item.panel.appId) ?? { appName: item.appName, items: [] };
    group.items.push(item); toolGroups.set(item.panel.appId, group);
  }

  const allTools = () => { setQuery(""); setPicker(true); };
  const visibleIds = workspace?.expanded ? workspace.visibleIds ?? (tool ? [tool.presentationId] : []) : [];
  const columns: ShellPanelColumn[] = tools.map(item => {
    const label = state.catalog.find(p => panelKey(p.panel) === item.key)?.label ?? "Tool";
    const unavailable = !item.resolved.surface;
    const notice = unavailable ? "This tool is no longer available in this view. Choose a tool to reopen it with current settings."
      : item.readiness === "auth-required" ? "Check access in the tool below, then retry opening the discussion."
      : item.readiness === "unreported" ? "This tool has not confirmed that it loaded. If it stays blank, open it separately."
      : item.resolved.state === "degraded" ? "This app’s health check is failing. Its page may still work." : null;
    const siblings = tools.filter(candidate => candidate.key === item.key);
    const tabLabel = siblings.length > 1 ? `${label} ${siblings.indexOf(item) + 1}` : label;
    return { id: item.presentationId, label: tabLabel, open: visibleIds.includes(item.presentationId), width: widths[item.presentationId] ?? savedWidths[item.key] ?? initialWidth,
      content: <ShellToolPanel title={label} onHide={() => host?.hidePresentation(item.presentationId)} onEnd={() => host?.closePresentation(item.presentationId)}
        onAllTools={allTools} standaloneHref={item.resolved.standaloneHref}>
        {notice && <Alert className="m-2 w-auto" role="status"><AlertDescription>{notice}
          {unavailable && <Button variant="outline" size="sm" aria-label="Choose another tool" onClick={() => {allTools(); void host?.refresh();}}>Choose tool</Button>}
        </AlertDescription></Alert>}
        <div data-shell-panel-frame ref={element => {
          if (element) frames.current.set(item.presentationId, element); else frames.current.delete(item.presentationId);
        }} className="min-h-0 flex-1 overflow-hidden">
          {item.resolved.surface && <HostyAppFrame surface={{ ...item.resolved.surface, panelId: item.target.panel.panelId }}
            view={{ viewId: `tool-${item.presentationId}`, workspaceId: "default", presentationId: item.presentationId, chrome: { navigation: "hide", tools: { launcher: "hide" } } }}
            title={label} standaloneHref={item.resolved.standaloneHref} onAskAssistant={onAskAssistant} onAuthRequired={onAuthRequired}
            onAttention={count => host?.setAttention(item.presentationId, count)}
            outbound={outbound && panelKey(outbound.target.panel) === item.key && (outbound.presentationId ? outbound.presentationId === item.presentationId : item === tool && outbound.target.route === item.currentRoute) ? outbound : null} />}
        </div>
      </ShellToolPanel> };
  });
  function rememberWidth(id: string, width: number) {
    setWidths(current => ({ ...current, [id]: width }));
    const key = tools.find(item => item.presentationId === id)?.key;
    if (key) {
      const next = { ...savedWidths, [key]: width }; setSavedWidths(next);
      try { if (widthKey) localStorage.setItem(widthKey, JSON.stringify(next)); } catch { /* Resizing works without storage. */ }
    }
    host?.setWidth(width);
    rememberLegacyWidth(width);
  }
  return <div ref={root} className="h-full min-h-0 min-w-0">
    <style>{frameStyles}</style>
    <ShellConcurrentPanels panels={columns} focusedId={focusedId} pageMinimum={pageMinimum} captureActive={feedbackState.picking}
      onFocus={id => { host?.focusPresentation(id); setFocusRequest(null); setFocusedId(id); }}
      onResize={rememberWidth}>
      {children}
    </ShellConcurrentPanels>
    <Dialog open={picker && toolsEnabled} onOpenChange={open => { setPicker(open); if (open) window.dispatchEvent(new CustomEvent("hosty:ui:modal", { detail: "picker:default" })); }}>
      <DialogContent><DialogHeader><DialogTitle>All tools</DialogTitle><DialogDescription>Open a tool and keep its current conversation or draft.</DialogDescription></DialogHeader>
        {(error || state.error) && <Alert role="status"><AlertDescription>{error ?? state.error?.message}</AlertDescription></Alert>}
        {panelPreferences.error && <p role="status" className="text-sm text-warning-foreground">{panelPreferences.error}</p>}
        <Input className="shrink-0" aria-label="Search tools" placeholder="Search tools and apps" value={query} onChange={event => setQuery(event.target.value)} />
        {!state.bootstrap && !state.error && !state.catalog.length ? <p role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><HostyLoader label={null} className="size-6" />Loading tools…</p>
          : !matchingTools.length && (!state.error || state.catalog.length > 0) && <div role="status" className="flex flex-col items-center gap-2 rounded-lg border bg-card px-4 py-5 text-center"><HostyEmptySlots className="size-12" /><p className="text-sm font-medium">{state.catalog.length ? "No tools match your search" : "No tools are available for your account."}</p>{state.catalog.length > 0 && <Button variant="outline" size="sm" onClick={() => setQuery("")}>Clear search</Button>}</div>}
        <div className="min-h-0 space-y-4 overflow-y-auto">
          {(["needs-you", "working", "no-connection"] as const).map(status => {
            const items = matchingTools.filter(item => status === "needs-you"
              ? ["failed", "needs-you"].includes(activity.read(item).state) : activity.read(item).state === status)
              .sort((a, b) => Number(activity.read(b).state === "failed") - Number(activity.read(a).state === "failed"));
            return items.length > 0 && <section key={status} aria-label={status === "needs-you" ? "Needs you" : status === "working" ? "Working" : "No connection"} className="space-y-1">
              <h3 className="text-xs font-medium">{status === "needs-you" ? "Needs you" : status === "working" ? "Working" : "No connection"}</h3>
              {items.map(item => <Button key={panelKey(item.panel)} variant="ghost" className="flex h-auto w-full justify-between gap-2 py-2" onClick={() => void select(item)}>
                <span className="min-w-0 truncate">{item.appName} — {item.label}</span><ToolActivityMark activity={activity.read(item)} />
              </Button>)}
            </section>;
          })}
          {[...toolGroups].map(([appId, group]) => <section key={appId} className="space-y-2" aria-label={`${group.appName} tools`}>
          <h3 className="text-xs font-medium text-muted-foreground">{group.appName}</h3>
          <div className="grid grid-cols-2 gap-2 min-[400px]:grid-cols-4">{group.items.map(item => <div key={panelKey(item.panel)} className="flex min-w-0 flex-col gap-2">
            <Button variant="outline" aria-pressed={tools.some(open => open.key === panelKey(item.panel) && visibleIds.includes(open.presentationId))} className={cn("h-auto w-full min-w-0 flex-1 flex-col justify-start px-2 py-3", tool?.key === panelKey(item.panel) && "border-brand-strong bg-brand-soft")} onClick={() => void select(item)}><AppIcon src={null} name={item.icon} fallback={PanelsTopLeft} className="size-4" /><span className="flex min-w-0 flex-col items-start"><span className="w-full truncate">{item.label}</span><span className="w-full truncate text-xs text-muted-foreground">{item.appName}{!item.available && ` · ${item.state}`}</span><ToolActivityMark activity={activity.read(item)} /></span></Button>
            <Button variant="ghost" size="sm" role="checkbox" aria-checked={panelPreferences.isPinned(item)} disabled={!panelPreferences.ready}
              aria-label={`Pin ${item.appName} — ${item.label} to top bar`} onClick={() => panelPreferences.setPinned(item, !panelPreferences.isPinned(item))}>
              <Pin className={cn("size-4", panelPreferences.isPinned(item) && "fill-current")} />{panelPreferences.isPinned(item) ? "Pinned" : "Pin"}
            </Button>
            {!item.available && item.canStart && onStartApp && <Button variant="outline" onClick={() => void Promise.resolve(onStartApp(item.panel.appId)).then(() => host?.refresh())}>Start app</Button>}
          </div>)}</div>
        </section>)}</div>
        <Button variant="outline" onClick={() => { activity.refresh(); void host?.refresh(); }}>Refresh tools</Button>
      </DialogContent>
    </Dialog>
    {error && !picker && <Alert className="absolute bottom-4 right-4 max-w-sm" role="status"><AlertDescription>{error}<Button variant="outline" size="sm" onClick={() => setPicker(true)}>Choose tool</Button></AlertDescription></Alert>}
  </div>;
}
