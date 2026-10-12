"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ExternalLink, PanelsTopLeft, Plus, ArrowLeft } from "lucide-react";
import { HostyAppFrame, useHostyUiHost, type HostyAppFrameProps } from "@hosty-sdk/app/ui/react";
import type { UiHostSnapshot, UiWorkspaceRenderer } from "@hosty-sdk/app/ui/host";
import { panelKey, type PanelTarget, type UiPanel } from "@hosty-sdk/app/ui/types";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AppIcon } from "../app-icon";
import { panelFocusIndex } from "../surfaces/panel-rail-state";
import { ShellWorkspaceSplit } from "./shell-workspace-split";

const empty: UiHostSnapshot = { bootstrap: null, catalog: [], tools: [], selected: null, expanded: false, width: 360, error: null };
const noop = () => () => {};
type Props = Pick<HostyAppFrameProps, "onAskAssistant" | "onAuthRequired"> & {
  children: ReactNode;
  initialWidth?: number;
  onExpandedChange?: (expanded: boolean) => void;
  onStartApp?: (appId: string) => void | Promise<void>;
  outbound?: { target: PanelTarget; presentationId?: string; message: unknown; nonce: number } | null;
};

/** Shell owns all chrome; the SDK owns authority, presentation identity and frame transport. */
export function ShellPanelWorkspace({ children, initialWidth = 360, onExpandedChange, onStartApp, onAskAssistant, onAuthRequired, outbound }: Props) {
  const host = useHostyUiHost();
  const state = useSyncExternalStore(host?.subscribeSnapshot ?? noop, host?.getSnapshot ?? (() => empty), () => empty);
  const workspace = state.workspaces?.find(w => w.workspaceId === "default");
  const tools = state.tools.filter(t => t.workspaceId === "default");
  const tool = tools.find(t => t.presentationId === workspace?.selectedId);
  const expanded = !!workspace?.expanded && !!tool;
  const selected = state.catalog.find(p => panelKey(p.panel) === tool?.key);
  const [picker, setPicker] = useState(false), [error, setError] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null);
  const root = useRef<HTMLDivElement>(null), body = useRef<HTMLElement>(null), dismiss = useRef<HTMLButtonElement>(null);
  const frames = useRef(new Map<string, HTMLDivElement>());
  const opener = useRef<HTMLElement | null>(null);
  const bodyId = useId();
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
      const first = current.catalog.find(p => p.available); if (!first) return;
      attempted = current.catalog; opening = true;
      void host.selectPanel(first.panel).finally(() => { opening = false; restore(); });
    };
    const stop = host.subscribeSnapshot(restore); restore();
    return () => {
      live = false; stop();
      for (const item of host.getSnapshot().tools.filter(t => t.workspaceId === "default")) host.closePresentation(item.presentationId);
      unregister();
    };
  }, [host, initialWidth]);
  const workspaceExpanded = workspace?.expanded;
  useEffect(() => { if (workspaceExpanded !== undefined) preferences.current?.(workspaceExpanded); }, [workspaceExpanded]);
  useEffect(() => { if (picker) window.dispatchEvent(new CustomEvent("hosty:ui:modal", { detail: "picker:default" })); }, [picker]);
  useLayoutEffect(() => {
    const element = root.current; if (!element) return;
    const read = () => setNarrow((element.getBoundingClientRect().width || window.innerWidth) < 900);
    read(); const observer = new ResizeObserver(read); observer.observe(element); return () => observer.disconnect();
  }, []);
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
  const panel = <div className="flex h-full min-h-0 min-w-0">
    {narrow && expanded && <button aria-label="Return to document" className="fixed inset-0 z-30 bg-black/40" onClick={() => host?.collapseWorkspace("default")} />}
    <aside id={bodyId} ref={body} hidden={!expanded} inert={!expanded} aria-label={selected?.label ?? "Tool"}
      role={narrow ? "dialog" : "complementary"} aria-modal={narrow && expanded || undefined}
      className={cn("min-h-0 min-w-0 flex-1 flex-col bg-background", !expanded ? "hidden" : "flex",
        narrow && "fixed inset-y-3 right-3 z-40 w-[min(440px,calc(100vw-24px))] rounded-xl border shadow-lg")}
      onKeyDown={event => {
        if (!narrow) return;
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
        {tool?.resolved.standaloneHref && <Button variant="ghost" size="icon" asChild><a href={tool.resolved.standaloneHref} target="_blank" rel="noopener noreferrer" aria-label="Open separately" title="Open separately"><ExternalLink /></a></Button>}
      </header>
      {notice && <Alert className="m-2 w-auto" role="status"><AlertDescription>{notice}
        {unavailable && <Button variant="outline" size="sm" aria-label="Choose another tool" onClick={() => { setPicker(true); void host?.refresh(); }}>Choose tool</Button>}
      </AlertDescription></Alert>}
      {siblings.length > 1 && <label className="flex items-center gap-2 border-b p-2 text-sm">Open views
        <select aria-label="Tool instance" className="min-w-0 rounded-md border bg-background p-1" value={tool?.presentationId} onChange={event => host?.focusPresentation(event.target.value)}>
          {siblings.map((item, index) => <option key={item.presentationId} value={item.presentationId}>{selected?.label} {index + 1}</option>)}
        </select></label>}
      {tools.map(item => <div key={item.presentationId} ref={element => {
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
    <TooltipProvider delayDuration={350}><nav aria-label="Tools" inert={narrow && expanded} className={cn("flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto py-2", expanded && !narrow && "border-l")}>
      {state.catalog.map((item, index) => <Tooltip key={panelKey(item.panel)}><TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={item.label} aria-controls={bodyId} aria-expanded={expanded && tool?.key === panelKey(item.panel)}
          className={cn("relative size-9 rounded-lg", expanded && tool?.key === panelKey(item.panel) && "bg-muted shadow-xs ring-1 ring-border")}
          onClick={() => void select(item)} onKeyDown={event => {
            const next = panelFocusIndex(event.key, index, state.catalog.length);
            if (next !== null) { event.preventDefault(); root.current?.querySelectorAll<HTMLButtonElement>('nav[aria-label="Tools"] button')[next]?.focus(); }
          }}>
          <AppIcon src={null} name={item.icon} fallback={PanelsTopLeft} className="size-4" />
          {tools.some(t => t.key === panelKey(item.panel) && t.attention > 0) && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" aria-label="Needs attention" />}
        </Button></TooltipTrigger><TooltipContent side="left">{item.appName}: {item.label}</TooltipContent></Tooltip>)}
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" aria-label="Add tool" className="size-9 rounded-lg" onClick={() => { setError(null); setPicker(true); void host?.refresh(); }}><Plus /></Button></TooltipTrigger><TooltipContent side="left">Add tool</TooltipContent></Tooltip>
    </nav></TooltipProvider>
  </div>;
  return <div ref={root} className="h-full min-h-0 min-w-0" data-shell-panel-layout={narrow ? "drawer" : "dock"}>
    <ShellWorkspaceSplit panel={panel} expanded={expanded && !narrow} initialPanelWidth={initialWidth} onWidthChange={width => host?.setWidth(width)}>
      <div className="h-full min-h-0" inert={narrow && expanded}>{children}</div>
    </ShellWorkspaceSplit>
    <Dialog open={picker} onOpenChange={open => { setPicker(open); if (open) window.dispatchEvent(new CustomEvent("hosty:ui:modal", { detail: "picker:default" })); }}>
      <DialogContent><DialogHeader><DialogTitle>Add tool</DialogTitle><DialogDescription>Open a tool beside your document.</DialogDescription></DialogHeader>
        {(error || state.error) && <Alert role="status"><AlertDescription>{error ?? state.error?.message}</AlertDescription></Alert>}
        {!state.catalog.length && <p className="text-sm text-muted-foreground">No tools are available for your account.</p>}
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">{state.catalog.map(item => <div key={panelKey(item.panel)} className="flex items-center gap-2">
          <Button variant="outline" className="h-auto min-w-0 flex-1 justify-start py-3" onClick={() => void select(item)}><AppIcon src={null} name={item.icon} fallback={PanelsTopLeft} className="size-4" /><span className="flex min-w-0 flex-col items-start"><span>{item.label}</span><span className="text-xs text-muted-foreground">{item.appName}{!item.available && ` · ${item.state}`}</span></span></Button>
          {!item.available && item.canStart && onStartApp && <Button variant="outline" onClick={() => void Promise.resolve(onStartApp(item.panel.appId)).then(() => host?.refresh())}>Start app</Button>}
        </div>)}</div>
        <Button variant="outline" onClick={() => void host?.refresh()}>Refresh tools</Button>
      </DialogContent>
    </Dialog>
    {error && !picker && <Alert className="absolute bottom-4 right-4 max-w-sm" role="status"><AlertDescription>{error}<Button variant="outline" size="sm" onClick={() => setPicker(true)}>Choose tool</Button></AlertDescription></Alert>}
  </div>;
}
