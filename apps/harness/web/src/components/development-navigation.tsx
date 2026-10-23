"use client";
import { useRef, useState, type ReactNode } from "react";
import { Folder, Hammer, Loader2, MessageSquarePlus, Trash2, Search, Diamond, CircleAlert, ArrowUpRight } from "lucide-react";
import type { AssistantSession } from "@/lib/assistant-api";
import type { DevelopmentWorkspace } from "@/lib/development-api";
import { orderSessions, isWaiting } from "@/lib/attention";
import { Input } from "@/components/ui/input";
import { HostyMark } from "../../../../../shared/web/hosty-mark";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ContinueBuilding } from "@/components/continue-building";

export function DevelopmentNavigation({ sessions, activeId, workspaces, onPick, onNew, onDelete, externalCount = 0, onExternal, createAppAction }: {
  externalCount?: number; onExternal?: () => void; createAppAction?: ReactNode;
  sessions: AssistantSession[]; activeId?: string; workspaces: DevelopmentWorkspace[];
  onPick: (session: AssistantSession) => void; onNew: () => void; onDelete: (sessionId: string) => Promise<void>;
}) {
  const [deleting, setDeleting] = useState<AssistantSession | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deletionPending = useRef(false);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const newButton = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const matchesState = (session: AssistantSession, state: string) => state === "all" || (state === "waiting" ? isWaiting(session.status) : state === "working" ? session.status === "running" : session.status === "failed");
  const sessionWorkspaces = new Map<string, DevelopmentWorkspace>();
  for (const workspace of workspaces) {
    if (workspace.owner.kind === "assistant" && workspace.owner.appId === "hosty.harness" && workspace.workflow.state !== "deleted" && !sessionWorkspaces.has(workspace.owner.reference))
      sessionWorkspaces.set(workspace.owner.reference, workspace);
  }
  const sessionLabel = (session: AssistantSession) => {
    const workspace = sessionWorkspaces.get(session.id);
    return workspace ? workspace.name?.trim() || workspace.owner.label?.trim() || session.title?.trim() || "Workspace"
      : session.title?.trim() || "Untitled session";
  };
  const visibleSessions = sessions.filter(session => matchesState(session, stateFilter) && (!query.trim() || [sessionLabel(session), session.title, ...(session.contextApps ?? []).map(app => app.displayName), ...(session.appIds ?? [])].join(" ").toLowerCase().includes(query.trim().toLowerCase())));

  const renderSession = (session: AssistantSession) => {
      const workspace = sessionWorkspaces.get(session.id);
      const label = sessionLabel(session);
      return <div key={session.id} className={`group mx-1 flex items-center rounded-md pr-1 hover:bg-muted ${activeId === session.id ? "bg-accent" : ""}`}>
        <Button variant="ghost" type="button" aria-current={activeId === session.id ? "page" : undefined}
        onClick={() => onPick(session)} className="h-9 min-w-0 flex-1 justify-start gap-2 rounded-md px-3 text-left">
        {workspace && <Hammer className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        <span className="min-w-0 flex-1 truncate text-sm font-normal" title={label}>{label}</span>
        {session.status === "running" && <Loader2 className="size-3.5 shrink-0 animate-spin text-info-foreground motion-reduce:animate-none" aria-label="Agent running" />}
        {isWaiting(session.status) && <Diamond className="size-3.5 shrink-0 text-warning-foreground" aria-label="Waiting for you" />}
        {session.status === "failed" && <CircleAlert className="size-3.5 shrink-0 text-destructive-foreground" aria-label="Failed" />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${label}`} title="Delete session"
          className="shrink-0 text-muted-foreground hover:text-destructive-foreground [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          onClick={event => { deleteTrigger.current = event.currentTarget; setError(null); setDeleting(session); }}><Trash2 /></Button>
      </div>;
  };
  return <nav aria-label="Sessions" className="flex h-full min-h-0 flex-col">
    <div className="space-y-3 border-b p-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-sm font-semibold">Sessions <span className="ml-1 font-mono text-xs font-normal tabular-nums text-muted-foreground">{sessions.length}</span></h1>
        <div className="flex shrink-0 items-center gap-1">
          {createAppAction}
          <ContinueBuilding sessions={sessions} onPick={onPick} />
          <TooltipProvider delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button ref={newButton} variant="ghost" size="icon-sm" aria-label="New session" onClick={onNew}><MessageSquarePlus aria-hidden="true" /></Button>
              </TooltipTrigger>
              <TooltipContent side="right">New session</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
      <div className="relative"><Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" /><Input aria-label="Search sessions" placeholder="Search sessions…" className="pl-8" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <div className="flex flex-wrap gap-1" aria-label="Session status filters">{[["all", "All"], ["waiting", "Needs you"], ["working", "Working"], ["failed", "Failed"]].map(([key, label]) => <Button key={key} size="sm" variant={stateFilter === key ? "secondary" : "ghost"} aria-pressed={stateFilter === key} className="h-7 gap-1 rounded-full px-2 text-xs" onClick={() => setStateFilter(key)}>{label}<span className="font-mono text-xs font-normal tabular-nums text-muted-foreground">{sessions.filter(session => matchesState(session, key)).length}</span></Button>)}</div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto py-2">
      {orderSessions(visibleSessions).map(renderSession)}
      {!!sessions.length && !visibleSessions.length && <p className="p-3 text-sm text-muted-foreground">No sessions match this search and filter.</p>}
      {!sessions.length && <div className="flex flex-col items-center gap-3 p-5 text-center"><HostyMark appId="hosty.harness" tile className="size-12" /><p className="text-sm text-muted-foreground">Start a session to ask a question or work on an application.</p></div>}
    </div>
    {onExternal && <div className="border-t p-2"><Button variant="ghost" className="w-full justify-start" onClick={onExternal}><Folder className="size-4" />External workspaces<span className="ml-auto font-mono text-xs font-normal tabular-nums text-muted-foreground">{externalCount}</span><ArrowUpRight className="size-3.5" /></Button></div>}
    <Dialog open={deleting !== null} onOpenChange={open => { if (!open && !deletionPending.current) setDeleting(null); }}>
      <DialogContent showCloseButton={!pending} onCloseAutoFocus={event => {
        event.preventDefault();
        (deleteTrigger.current?.isConnected ? deleteTrigger.current : newButton.current)?.focus();
      }}>
        <DialogHeader><DialogTitle>Delete session?</DialogTitle>
          <DialogDescription>Delete the session “{deleting ? sessionLabel(deleting) : "Untitled session"}” and its conversation history? This cannot be undone. Unfinished workspaces must be resolved before their session can be deleted.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => setDeleting(null)}>Keep session</Button>
          <Button variant="destructive" disabled={pending} onClick={async () => {
            if (!deleting || deletionPending.current) return;
            deletionPending.current = true; setPending(true); setError(null);
            try { await onDelete(deleting.id); setDeleting(null); }
            catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
            finally { deletionPending.current = false; setPending(false); }
          }}>{pending ? <><Loader2 className="animate-spin" />Deleting…</> : "Delete session"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </nav>;
}
