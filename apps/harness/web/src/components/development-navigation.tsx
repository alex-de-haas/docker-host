"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Hammer, Loader2, MessageSquarePlus, Trash2, Search, ListFilter, Diamond, CircleAlert, MessageSquare } from "lucide-react";
import type { AssistantSession } from "@/lib/assistant-api";
import type { DevelopmentWorkspace } from "@/lib/development-api";
import { navigationItems } from "@/lib/workspace-navigation";
import { WorkspaceActivityCounts } from "./workspace-activity-counts";
import { Input } from "@/components/ui/input";
import { HostyMark } from "../../../../../shared/web/hosty-mark";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ContinueBuilding } from "@/components/continue-building";
import { cn } from "@/lib/utils";

const statusFilters = [
  { key: "all", label: "All", Icon: ListFilter, tone: "text-muted-foreground" },
  { key: "waiting", label: "Needs attention", Icon: Diamond, tone: "text-warning-foreground" },
  { key: "working", label: "Working", Icon: Loader2, tone: "text-info-foreground" },
  { key: "failed", label: "Failed", Icon: CircleAlert, tone: "text-destructive-foreground" },
] as const;

export function DevelopmentNavigation({ sessions, activeId, workspaces, onPick, onNew, onDelete, activeWorkspaceId, onWorkspace, createAppAction, view = "chats" }: {
  view?: "workspaces" | "chats";
  activeWorkspaceId?: string; onWorkspace?: (workspace: DevelopmentWorkspace, session?: AssistantSession) => void; createAppAction?: ReactNode;
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
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  const items = navigationItems(workspaces, sessions, now, view);
  const title = view === "workspaces" ? "Workspaces" : "Chats";
  const matchesState = (item: typeof items[number], state: string) => state === "all" || item.counts[state as "waiting" | "working" | "failed"] > 0;
  const visible = items.filter(item => matchesState(item, stateFilter) && (!query.trim() || item.search.includes(query.trim().toLowerCase())));
  const sessionLabel = (session: AssistantSession) => session.title?.trim() || "Untitled session";

  const renderItem = (item: typeof items[number]) => {
    const { workspace, session, label } = item;
    const selected = workspace ? activeWorkspaceId === workspace.id || !activeWorkspaceId && item.matches.some(s => s.id === activeId) : !activeWorkspaceId && activeId === session?.id;
    return <div key={item.key} className={`group mx-1 flex items-center rounded-md pr-1 hover:bg-muted ${selected ? "bg-accent" : ""}`}>
      <Button variant="ghost" type="button" aria-current={selected ? "page" : undefined} onClick={() => {
        if (workspace) {
          const match = query.trim() ? item.matches.find(s => s.title?.toLowerCase().includes(query.trim().toLowerCase())) : undefined;
          onWorkspace?.(workspace, match);
        } else if (session) onPick(session);
      }} className="h-auto min-h-9 min-w-0 flex-1 justify-start gap-2 rounded-md px-3 text-left">
        {workspace ? <Hammer className="size-3.5 shrink-0 text-muted-foreground" role="img" aria-label="Workspace" /> : <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        <span className="min-w-0 flex-1 text-left"><span className="block truncate text-sm font-normal" title={label}>{label}</span>
          <WorkspaceActivityCounts counts={item.counts} />
        </span>
      </Button>
      {session && <Button variant="ghost" size="icon-sm" aria-label={`Delete ${label}`} title="Delete session"
        className="shrink-0 text-muted-foreground hover:text-destructive-foreground [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={event => { deleteTrigger.current = event.currentTarget; setError(null); setDeleting(session); }}><Trash2 /></Button>}
    </div>;
  };
  return <nav aria-label={title} className="flex h-full min-h-0 flex-col">
    <div className="space-y-3 border-b p-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-sm font-semibold">{title} <span className="ml-1 font-mono text-xs font-normal tabular-nums text-muted-foreground">{items.length}</span></h1>
        <div className="flex shrink-0 items-center gap-1">
          {view === "workspaces" && <>{createAppAction}<ContinueBuilding sessions={sessions} onPick={onPick} /></>}
          {view === "chats" && <TooltipProvider delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button ref={newButton} variant="ghost" size="icon-sm" aria-label="New session" onClick={onNew}><MessageSquarePlus aria-hidden="true" /></Button>
              </TooltipTrigger>
              <TooltipContent side="right">New session</TooltipContent>
            </Tooltip>
          </TooltipProvider>}
        </div>
      </div>
      <div className="relative"><Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" /><Input aria-label={`Search ${title.toLowerCase()}`} placeholder="Search…" className="pl-8" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <div className="flex flex-wrap gap-1" aria-label="Activity filters">{statusFilters.map(({ key, label, Icon, tone }) => {
        const count = items.filter(item => matchesState(item, key)).length;
        return <Button key={key} size="sm" variant={stateFilter === key ? "secondary" : "ghost"} aria-pressed={stateFilter === key} className="h-7 gap-1 rounded-full px-2 text-xs" onClick={() => setStateFilter(key)}>
          <span aria-hidden="true" className={cn("inline-flex shrink-0", tone, key === "working" && count > 0 && "motion-safe:animate-spin")}><Icon className="size-3.5" /></span>
          {label}<span className="font-mono text-xs font-normal tabular-nums text-muted-foreground">{count}</span>
        </Button>;
      })}</div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto py-2">
      {visible.map(renderItem)}
      {!!items.length && !visible.length && <p className="p-3 text-sm text-muted-foreground">No {title.toLowerCase()} match this search and filter.</p>}
      {!items.length && <div className="flex flex-col items-center gap-3 p-5 text-center"><HostyMark appId="hosty.harness" tile className="size-12" /><p className="text-sm text-muted-foreground">{view === "workspaces" ? "Create an app or continue building to start a workspace." : "Start a new chat to ask a question."}</p></div>}
    </div>
    <Dialog open={deleting !== null} onOpenChange={open => { if (!open && !deletionPending.current) setDeleting(null); }}>
      <DialogContent showCloseButton={!pending} onCloseAutoFocus={event => {
        event.preventDefault();
        (deleteTrigger.current?.isConnected ? deleteTrigger.current : newButton.current)?.focus();
      }}>
        <DialogHeader><DialogTitle>Delete session?</DialogTitle>
          <DialogDescription>Delete the session “{deleting ? sessionLabel(deleting) : "Untitled session"}” and its conversation history? This cannot be undone. The session is stopped and detached. Shared source and other conversations are retained; unresolved session resources must be reconciled first.</DialogDescription>
        </DialogHeader>
      <DialogBody>
          {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
      </DialogBody>
      <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => setDeleting(null)}>Keep session</Button>
          <Button variant="destructive" disabled={pending} onClick={async () => {
            if (!deleting || deletionPending.current) return;
            deletionPending.current = true; setPending(true); setError(null);
            try { await onDelete(deleting.id); setDeleting(null); }
            catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
            finally { deletionPending.current = false; setPending(false); }
          }}>{pending ? <><Loader2 className="motion-safe:animate-spin" aria-hidden />Deleting…</> : "Delete session"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </nav>;
}
