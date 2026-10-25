"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ExternalLink, PanelsTopLeft, Ellipsis, ArrowLeft, X, Pin } from "lucide-react";
import { HostyAppFrame, useHostyUiHost, useHostyChrome, type HostyAppFrameProps } from "@hosty-sdk/app/ui/react";
import type { UiHostSnapshot, UiWorkspaceRenderer } from "@hosty-sdk/app/ui/host";
import { panelKey, type PanelTarget, type UiPanel } from "@hosty-sdk/app/ui/types";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HostyEmptySlots, HostyLoader } from "../../../../../../shared/web/hosty-states";
import { AppIcon } from "../app-icon";
import { usePanelPreferences } from "./panel-preferences";
import { ShellWorkspaceSplit } from "./shell-workspace-split";

const empty: UiHostSnapshot = { bootstrap: null, catalog: [], tools: [], selected: null, expanded: false, width: 360, error: null };
const noop = () => () => {};
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
  const state = useSyncExternalStore(host?.subscribeSnapshot ?? noop, host?.getSnapshot ?? (() => empty), () => empty);
  const toolsEnabled = chrome.tools.enabled && !state.error?.code.startsWith("unsupported");
  const workspace = state.workspaces?.find(w => w.workspaceId === "default");
  const tools = state.tools.filter(t => t.workspaceId === "default");
  const tool = tools.find(t => t.presentationId === workspace?.selectedId);
  const expanded = !!workspace?.expanded && !!tool;
  const selected = state.catalog.find(p => panelKey(p.panel) === tool?.key);
  const [picker, setPicker] = useState(false), [error, setError] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [query, setQuery] = useState("");
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null);
  const root = useRef<HTMLDivElement>(null), body = useRef<HTMLElement>(null), dismiss = useRef<HTMLButtonElement>(null);
  const frames = useRef(new Map<string, HTMLDivElement>());
  const opener = useRef<HTMLElement | null>(null);
  const bodyId = useId();
  const panelPreferences = usePanelPreferences();
  const latestPins = useRef(panelPreferences);
  const restorePinned = useRef<(() => void) | null>(null);
  useEffect(() => { latestPins.current = panelPreferences; restorePinned.current?.(); }, [panelPreferences]);
  const preferences = useRef(onExpandedChange);
  useEffect(() => { preferences.current = onExpandedChange; }, [onExpandedChange]);

  useEffect(() => {
    if (!host) return;
    const renderer: UiWorkspaceRenderer = {
      async present(_instance, signal) {
        // The mounted Shell slot owns the retained frame tree populated by the host snapshot.
        return !signal.aborted && root.current?.isConnected ? "accepted" : "unavailable";
      },
      focus(id) { setFocusRequest({ id }); },
      collapse() { setPicker(false); },
      release() { /* React removes frames when the host removes their presentation. */ },
      async showToolPicker(signal) {
        if (signal.aborted || !root.current?.isConnected) return "unavailable";
        setPicker(true); return "accepted";
      },
    };
    const unregister = host.registerWorkspace({ workspaceId: "default", renderer });
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
      void host.selectPanel(first.panel).finally(() => { opening = false; restore(); });
    };
    restorePinned.current = restore;
    const stop = host.subscribeSnapshot(restore); restore();
    return () => {
      live = false; restorePinned.current = null; stop();
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
  useLayoutEffect(() => {
    const element = root.current; if (!element) return;
    const read = () => setNarrow((element.getBoundingClientRect().width || window.innerWidth) < pageMinimum + 320 + 24);
    read(); const observer = new ResizeObserver(read); observer.observe(element); return () => observer.disconnect();
  }, [pageMinimum]);
  useLayoutEffect(() => {
    if (!expanded) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (opener.current?.isConnected) opener.current.focus(); };
  }, [expanded]);
  useEffect(() => {
    if (!narrow || !expanded) return;
    window.dispatchEvent(new CustomEvent("hosty:ui:modal", { detail: "tools:default" }));
    dismiss.current?.focus();
    const close = (event: Event) => { if ((event as CustomEvent).detail === "default") host?.collapseWorkspace("default"); };
    window.addEventListener("hosty:ui:drawer-dismiss", close);
    return () => window.removeEventListener("hosty:ui:drawer-dismiss", close);
  }, [host, narrow, expanded]);
  const selectedPresentationId = tool?.presentationId;
  useEffect(() => {
    // Host acceptance can precede React's frame commit. Retry after mounting and readiness,
    // after the layout effect has recorded the document element to restore on collapse.
    if (expanded && selectedPresentationId && focusRequest?.id === selectedPresentationId) {
      frames.current.get(selectedPresentationId)?.querySelector<HTMLIFrameElement>("iframe")?.focus();
    }
  }, [expanded, selectedPresentationId, tool?.readiness, focusRequest]);
  useEffect(() => {
    const modal = (event: Event) => {
      const kind = (event as CustomEvent).detail;
      if (kind !== "picker:default") setPicker(false);
      if (narrow && kind !== "tools:default" && kind !== "picker:default") host?.collapseWorkspace("default");
    };
    window.addEventListener("hosty:ui:modal", modal); return () => window.removeEventListener("hosty:ui:modal", modal);
  }, [host, narrow]);

  async function select(panel: UiPanel) {
    if (!host) return;
    if (!picker && expanded && tool?.key === panelKey(panel.panel)) { host.collapseWorkspace("default"); return; }
    const result = await host.selectPanel(panel.panel);
    if (result.status === "opened") { setError(null); setPicker(false); }
    else setError(panel.available ? "Could not open this tool. Try again." : `${panel.appName} is ${panel.state}.`);
  }
  const unavailable = !!tool && !tool.resolved.surface;
  const notice = unavailable ? "This tool is no longer available in this view. Its access, configuration or runtime may have changed. Choose a tool to reopen it with current settings."
    : tool?.readiness === "auth-required" ? "Check access in the tool below, then retry opening the discussion."
    : tool?.readiness === "unreported" ? "This tool has not confirmed that it loaded. If it stays blank, open it separately."
    : tool?.resolved.state === "degraded" ? "This app’s health check is failing. Its page may still work." : null;
  const siblings = tools.filter(t => t.key === tool?.key);
  const search = query.trim().toLowerCase();
  const matchingTools = state.catalog.filter(item => `${item.label} ${item.appName}`.toLowerCase().includes(search));
  const toolGroups = new Map<string, { appName: string; items: UiPanel[] }>();
  for (const item of matchingTools) {
    const group = toolGroups.get(item.panel.appId) ?? { appName: item.appName, items: [] };
    group.items.push(item); toolGroups.set(item.panel.appId, group);
  }

  const panel = <div className="flex h-full min-h-0 min-w-0">
    {narrow && expanded && <button aria-label="Return to document" className="fixed inset-0 z-30 bg-black/40" onClick={() => host?.collapseWorkspace("default")} />}
    <aside id={bodyId} ref={body} hidden={!expanded} inert={!expanded} aria-label={selected?.label ?? "Tool"}
      role={narrow ? "dialog" : "complementary"} aria-modal={narrow && expanded || undefined}
      className={cn("min-h-0 min-w-0 flex-1 flex-col bg-background", !expanded ? "hidden" : "flex",
        narrow && "shell-tool-sheet fixed inset-y-3 right-3 z-40 w-[min(440px,calc(100vw-24px))] rounded-xl border shadow-lg")}
      onKeyDown={event => {
        // Portaled menus own their keyboard events even though React bubbles them through the sheet.
        if (!narrow || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
        if (event.key === "Escape") { event.preventDefault(); host?.collapseWorkspace("default"); }
        if (event.key === "Tab") {
          const elements = Array.from(body.current?.querySelectorAll<HTMLElement>('button,a[href],select,iframe') ?? []).filter(e => !e.closest("[hidden]") && !(e as HTMLButtonElement).disabled);
          const first = elements[0], last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        {narrow && <Button ref={dismiss} variant="ghost" size="icon" aria-label="Return to document" onClick={() => host?.collapseWorkspace("default")}><ArrowLeft /></Button>}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{selected?.label ?? "Tool"}</span>
        <Button variant="ghost" size="sm" onClick={() => { setQuery(""); setPicker(true); }}>All tools</Button>
        {tool?.resolved.standaloneHref && <Button variant="ghost" size="icon" asChild><a href={tool.resolved.standaloneHref} target="_blank" rel="noopener noreferrer" aria-label="Open separately" title="Open separately"><ExternalLink /></a></Button>}
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="Tool actions"><Ellipsis /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={!tool} onSelect={() => { if (tool) host?.closePresentation(tool.presentationId); }}>End this tool view</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        <Button ref={narrow ? undefined : dismiss} variant="ghost" size="icon" aria-label="Hide tool" title="Hide tool" onClick={() => host?.collapseWorkspace("default")}><X /></Button>
      </header>
      {notice && <Alert className="m-2 w-auto" role="status"><AlertDescription>{notice}
        {unavailable && <Button variant="outline" size="sm" aria-label="Choose another tool" onClick={() => { setPicker(true); void host?.refresh(); }}>Choose tool</Button>}
      </AlertDescription></Alert>}
      {siblings.length > 1 && <label className="flex items-center gap-2 border-b p-2 text-sm">Open views
        <Select value={tool?.presentationId ?? ""} onValueChange={value => host?.focusPresentation(value)}>
          <SelectTrigger aria-label="Tool instance" size="sm" className="min-w-0"><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>
            {siblings.map((item, index) => <SelectItem key={item.presentationId} value={item.presentationId}>{selected?.label} {index + 1}</SelectItem>)}
          </SelectGroup></SelectContent>
        </Select></label>}
      {tools.map(item => <div data-shell-panel-frame key={item.presentationId} ref={element => {
        if (element) { frames.current.set(item.presentationId, element); }
        else frames.current.delete(item.presentationId);
      }} hidden={!expanded || item !== tool} inert={!expanded || item !== tool} className="min-h-0 flex-1 overflow-hidden">
        {item.resolved.surface && <HostyAppFrame surface={{ ...item.resolved.surface, panelId: item.target.panel.panelId }}
          view={{ viewId: `tool-${item.presentationId}`, workspaceId: "default", presentationId: item.presentationId, chrome: { navigation: "hide", tools: { launcher: "hide" } } }}
          title={state.catalog.find(p => panelKey(p.panel) === item.key)?.label ?? "Tool"} standaloneHref={item.resolved.standaloneHref}
          onAskAssistant={onAskAssistant} onAuthRequired={onAuthRequired} onAttention={count => host?.setAttention(item.presentationId, count)}
          outbound={outbound && panelKey(outbound.target.panel) === item.key && (outbound.presentationId ? outbound.presentationId === item.presentationId : item === tool && outbound.target.route === item.currentRoute) ? outbound : null} />}
      </div>)}
      {narrow && <span tabIndex={0} className="sr-only" onFocus={() => dismiss.current?.focus()} />}
    </aside>

  </div>;
  return <div ref={root} className="h-full min-h-0 min-w-0" data-shell-panel-layout={narrow ? "drawer" : "dock"}>
    <style>{frameStyles}</style>
    <ShellWorkspaceSplit panel={panel} showPanel={expanded && !narrow} keepPanelVisible={expanded && narrow} railSize={0} expanded={expanded && !narrow} initialPanelWidth={initialWidth} pageMinimum={pageMinimum} onWidthChange={width => host?.setWidth(width)}>
      <div className="h-full min-h-0" inert={narrow && expanded}>{children}</div>
    </ShellWorkspaceSplit>
    <Dialog open={picker && toolsEnabled} onOpenChange={open => { setPicker(open); if (open) window.dispatchEvent(new CustomEvent("hosty:ui:modal", { detail: "picker:default" })); }}>
      <DialogContent><DialogHeader><DialogTitle>All tools</DialogTitle><DialogDescription>Open a tool and keep its current conversation or draft.</DialogDescription></DialogHeader>
        {(error || state.error) && <Alert role="status"><AlertDescription>{error ?? state.error?.message}</AlertDescription></Alert>}
        {panelPreferences.error && <p role="status" className="text-sm text-warning-foreground">{panelPreferences.error}</p>}
        <Input className="shrink-0" aria-label="Search tools" placeholder="Search tools and apps" value={query} onChange={event => setQuery(event.target.value)} />
        {!state.bootstrap && !state.error && !state.catalog.length ? <p role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><HostyLoader label={null} className="size-6" />Loading tools…</p>
          : !matchingTools.length && (!state.error || state.catalog.length > 0) && <div role="status" className="flex flex-col items-center gap-2 rounded-lg border bg-card px-4 py-5 text-center"><HostyEmptySlots className="size-12" /><p className="text-sm font-medium">{state.catalog.length ? "No tools match your search" : "No tools are available for your account."}</p>{state.catalog.length > 0 && <Button variant="outline" size="sm" onClick={() => setQuery("")}>Clear search</Button>}</div>}
        <div className="min-h-0 space-y-4 overflow-y-auto">{[...toolGroups].map(([appId, group]) => <section key={appId} className="space-y-2" aria-label={`${group.appName} tools`}>
          <h3 className="text-xs font-medium text-muted-foreground">{group.appName}</h3>
          <div className="grid grid-cols-2 gap-2 min-[400px]:grid-cols-4">{group.items.map(item => <div key={panelKey(item.panel)} className="flex min-w-0 flex-col gap-2">
            <Button variant="outline" aria-pressed={tool?.key === panelKey(item.panel)} className={cn("h-auto w-full min-w-0 flex-1 flex-col justify-start px-2 py-3", tool?.key === panelKey(item.panel) && "border-brand-strong bg-brand-soft")} onClick={() => void select(item)}><AppIcon src={null} name={item.icon} fallback={PanelsTopLeft} className="size-4" /><span className="flex min-w-0 flex-col items-start"><span className="w-full truncate">{item.label}</span><span className="w-full truncate text-xs text-muted-foreground">{item.appName}{!item.available && ` · ${item.state}`}</span></span></Button>
            <Button variant="ghost" size="sm" role="checkbox" aria-checked={panelPreferences.isPinned(item)} disabled={!panelPreferences.ready}
              aria-label={`Pin ${item.appName} — ${item.label} to top bar`} onClick={() => panelPreferences.setPinned(item, !panelPreferences.isPinned(item))}>
              <Pin className={cn("size-4", panelPreferences.isPinned(item) && "fill-current")} />{panelPreferences.isPinned(item) ? "Pinned" : "Pin"}
            </Button>
            {!item.available && item.canStart && onStartApp && <Button variant="outline" onClick={() => void Promise.resolve(onStartApp(item.panel.appId)).then(() => host?.refresh())}>Start app</Button>}
          </div>)}</div>
        </section>)}</div>
        <Button variant="outline" onClick={() => void host?.refresh()}>Refresh tools</Button>
      </DialogContent>
    </Dialog>
    {error && !picker && <Alert className="absolute bottom-4 right-4 max-w-sm" role="status"><AlertDescription>{error}<Button variant="outline" size="sm" onClick={() => setPicker(true)}>Choose tool</Button></AlertDescription></Alert>}
  </div>;
}
