"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Hammer, Loader2, MessageSquarePlus, Trash2, Search, ListFilter, Diamond, CircleAlert, MessageSquare, PanelLeftClose, RotateCcw } from "lucide-react";
import type { AssistantSession } from "@/lib/assistant-api";
import type { DevelopmentWorkspace, WorkspaceRemoval } from "@/lib/development-api";
import { observedSessionStatus } from "@/lib/attention";
import { navigationItems, workspaceSessionIds } from "@/lib/workspace-navigation";
import { WorkspaceRowStatus } from "./workspace-row-status";
import { WorkspaceActivityCounts } from "./workspace-activity-counts";
import { SessionActivityIndicator, SessionRowStatus } from "./session-row-status";
import { WorkspaceDelete } from "./workspace-delete";
import { useWorkspaceDeletion, type WorkspaceDeletion } from "@/lib/workspace-deletion";
import { Input } from "@/components/ui/input";
import { HostyMark } from "../../../../../shared/web/hosty-mark";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const statusFilters = [
  { key: "all", label: "All", Icon: ListFilter, tone: "text-muted-foreground" },
  { key: "waiting", label: "Needs attention", Icon: Diamond, tone: "text-warning-foreground" },
  { key: "working", label: "Working", Icon: Loader2, tone: "text-info-foreground" },
  { key: "failed", label: "Failed", Icon: CircleAlert, tone: "text-destructive-foreground" },
] as const;

export function WorkspaceDeletionFailures({ deletion, className }: { deletion: WorkspaceDeletion; className?: string }) {
  return [...deletion.failures].map(([id, failure]) => <div key={id} className={cn("space-y-1", className)}>
    <p role="alert" className="text-sm text-destructive-foreground">{failure.label}: {failure.error}</p>
    <Button size="sm" variant="outline" onClick={() => deletion.run(id, failure.label, failure.retry)}>Retry deletion</Button>
  </div>);
}

export function DevelopmentNavigation({ sessions, activeId, workspaces, removals = [], onPick, onNew, onDelete, activeWorkspaceId, onWorkspace, createAppAction, onClose, onRefresh, workspaceDeletion, deletingSessionIds }: {
  onClose?: () => void; onRefresh?: () => void; removals?: WorkspaceRemoval[];
  workspaceDeletion?: WorkspaceDeletion; deletingSessionIds?: ReadonlySet<string>;
  activeWorkspaceId?: string; onWorkspace?: (workspace: DevelopmentWorkspace, session?: AssistantSession) => void; createAppAction?: ReactNode;
  sessions: AssistantSession[]; activeId?: string; workspaces: DevelopmentWorkspace[];
  onPick: (session: AssistantSession) => void; onNew: () => void; onDelete: (sessionId: string) => Promise<void>;
}) {
  const [deleting, setDeleting] = useState<AssistantSession | null>(null);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<DevelopmentWorkspace | null>(null);
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(() => new Set());
  const localDeletes = useRef(new Set<string>());
  const localWorkspaceDeletion = useWorkspaceDeletion(() => onRefresh?.());
  const workspaceRemovals = workspaceDeletion ?? localWorkspaceDeletion;
  const latestDeleteTarget = workspaces.find(workspace => workspace.id === workspaceToDelete?.id);
  const deletingWorkspace = latestDeleteTarget ?? workspaceToDelete;
  const workspaceDeleteName = deletingWorkspace?.name?.trim() || deletingWorkspace?.owner.label?.trim() || "Workspace";
  const workspaceDeleteRequest = deletingWorkspace?.workflow.operations?.find(operation =>
    ["pending", "unknown"].includes(operation.state) && ["delete", "discard"].includes(operation.kind));
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const workspaceDeleteTrigger = useRef<HTMLButtonElement | null>(null);
  const newButton = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  const items = navigationItems(workspaces, sessions, now);
  const title = "Sessions";
  const matchesState = (item: typeof items[number], state: string) => state === "all" || item.counts[state as "waiting" | "working" | "failed"] > 0;
  const visible = items.filter(item => matchesState(item, stateFilter) && (!query.trim() || item.search.includes(query.trim().toLowerCase())));
  const sessionLabel = (session: AssistantSession) => session.title?.trim() || "Untitled session";

  const confirmSessionDeletion = async (session: AssistantSession) => {
    if (localDeletes.current.has(session.id)) return;
    localDeletes.current.add(session.id);
    setDeleting(null);
    setDeletingIds(current => new Set(current).add(session.id));
    try { await onDelete(session.id); }
    catch { /* The conversation surface reports the error. */ }
    finally {
      localDeletes.current.delete(session.id);
      setDeletingIds(current => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
    }
  };
  const renderItem = (item: typeof items[number]) => {
    const { workspace, session, label } = item;
    const removing = workspace ? workspaceRemovals.pending.has(workspace.id)
      : !!session && (deletingSessionIds?.has(session.id) || deletingIds.has(session.id));
    const removalPending = workspace?.workflow.state === "deleting";
    const selected = workspace ? activeWorkspaceId === workspace.id || !activeWorkspaceId && item.matches.some(s => s.id === activeId) : !activeWorkspaceId && activeId === session?.id;
    return <div key={item.key} className={`group mx-1 flex items-center rounded-md pr-1 hover:bg-muted ${selected ? "bg-accent" : ""}`}>
      <Button variant="ghost" type="button" aria-current={selected ? "page" : undefined} disabled={removing || removalPending} onClick={() => {
        if (workspace) {
          const match = query.trim() ? item.matches.find(s => s.title?.toLowerCase().includes(query.trim().toLowerCase())) : undefined;
          onWorkspace?.(workspace, match);
        } else if (session) onPick(session);
      }} className="h-auto min-h-9 min-w-0 flex-1 justify-start gap-2 rounded-md px-3 text-left">
        {workspace ? <Hammer className="size-3.5 shrink-0 text-muted-foreground" role="img" aria-label="Workspace" /> : <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        <span className="min-w-0 flex-1 text-left">
          <span className="flex min-w-0 items-center gap-2"><span className="block min-w-0 flex-1 truncate text-sm font-normal" title={label}>{label}</span>
            {!removing && !removalPending && (workspace ? <WorkspaceActivityCounts counts={item.counts} /> : session && <SessionActivityIndicator status={observedSessionStatus(session)} />)}
          </span>
          {removing || removalPending ? <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
            {removing && <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden />} {removing ? "Deleting…" : "Deletion pending"}
          </span> : workspace ? <WorkspaceRowStatus workspace={workspace} now={now} /> : session && <SessionRowStatus session={session} now={now} />}
        </span>
      </Button>
      {session && !removing && <Button variant="ghost" size="icon-sm" aria-label={`Delete ${label}`} title="Delete session"
        className="shrink-0 text-muted-foreground hover:text-destructive-foreground [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={event => { deleteTrigger.current = event.currentTarget; setDeleting(session); }}><Trash2 /></Button>}
      {workspace && !removing && workspace.permissions?.manage !== false && <Button variant="ghost" size="icon-sm" aria-label={(removalPending ? "Recover workspace deletion " : "Delete workspace ") + label} title={removalPending ? "Recover workspace deletion" : "Delete workspace"}
        className="shrink-0 text-muted-foreground hover:text-destructive-foreground [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={event => {
          workspaceDeleteTrigger.current = event.currentTarget;
          setWorkspaceToDelete(workspace);
        }}>{removalPending ? <RotateCcw aria-hidden /> : <Trash2 />}</Button>}
    </div>;
  };
  return <nav aria-label={title} className="flex h-full min-h-0 flex-col">
    <div className="space-y-3 border-b p-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-sm font-semibold">{title} <span className="ml-1 font-mono text-xs font-normal tabular-nums text-muted-foreground">{items.length}</span></h1>
        <div className="flex shrink-0 items-center gap-1">
          {onClose && <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label={`Hide ${title.toLowerCase()}`} title={`Hide ${title.toLowerCase()}`} onClick={onClose}><PanelLeftClose aria-hidden /></Button>}
          {createAppAction}
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
      <div className="relative"><Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" /><Input aria-label={`Search ${title.toLowerCase()}`} placeholder="Search…" className="pl-8" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <div className="flex flex-wrap gap-1" aria-label="Activity filters">{statusFilters.map(({ key, label, Icon, tone }) => {
        const count = items.filter(item => matchesState(item, key)).length;
        return <Button key={key} size="sm" variant={stateFilter === key ? "secondary" : "ghost"} aria-pressed={stateFilter === key} className="h-7 gap-1 rounded-full px-2 text-xs" onClick={() => setStateFilter(key)}>
          <span aria-hidden="true" className={cn("inline-flex shrink-0", tone, key === "working" && count > 0 && "motion-safe:animate-spin")}><Icon className="size-3.5" /></span>
          {label}<span className="font-mono text-xs font-normal tabular-nums text-muted-foreground">{count}</span>
        </Button>;
      })}</div>
    </div>
    {!workspaceDeletion && <WorkspaceDeletionFailures deletion={localWorkspaceDeletion} className="px-3 py-2" />}
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2">
      {visible.map(renderItem)}
      {!!items.length && !visible.length && <p className="p-3 text-sm text-muted-foreground">No sessions match this search and filter.</p>}
      {!items.length && <div className="flex flex-col items-center gap-3 p-5 text-center"><HostyMark appId="hosty.harness" tile className="size-12" /><p className="text-sm text-muted-foreground">Start a new session or create an app.</p></div>}
    </div>
    {removals.length > 0 && <details className="shrink-0 border-t px-3 py-2 text-sm">
      <summary className="cursor-pointer">Cleanup in progress ({removals.length})</summary>
      <ul className="mt-2 space-y-2">{removals.map(removal =>
        <li key={removal.requestId}>{removal.name}{removal.reason && <p className="text-xs text-muted-foreground">{removal.reason}</p>}</li>)}</ul>
    </details>}
    {deletingWorkspace && <WorkspaceDelete key={deletingWorkspace.id + ":" + (workspaceDeleteRequest?.id ?? "")}
      workspaceId={deletingWorkspace.id} name={workspaceDeleteName}
      sessionIds={latestDeleteTarget ? workspaceSessionIds(latestDeleteTarget) : undefined}
      pendingRequestId={workspaceDeleteRequest?.id} refresh={() => onRefresh?.()} onClose={() => setWorkspaceToDelete(null)}
      onSubmit={command => workspaceRemovals.run(deletingWorkspace.id, workspaceDeleteName, command)}
      onCloseAutoFocus={event => {
        event.preventDefault();
        (workspaceDeleteTrigger.current?.isConnected ? workspaceDeleteTrigger.current : newButton.current)?.focus();
      }} />}
    <Dialog open={deleting !== null} onOpenChange={open => { if (!open) setDeleting(null); }}>
      <DialogContent onCloseAutoFocus={event => {
        event.preventDefault();
        (deleteTrigger.current?.isConnected ? deleteTrigger.current : newButton.current)?.focus();
      }}>
        <DialogHeader><DialogTitle>Delete session?</DialogTitle>
          <DialogDescription>Delete the session “{deleting ? sessionLabel(deleting) : "Untitled session"}” and its conversation history? This cannot be undone. The session is stopped and detached. Shared source and other conversations are retained. Any unreported tool outcomes stay unknown.</DialogDescription>
        </DialogHeader>
      <DialogFooter>
          <Button variant="outline" onClick={() => setDeleting(null)}>Keep session</Button>
          <Button variant="destructive" onClick={() => { if (deleting) void confirmSessionDeletion(deleting); }}>Delete session</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </nav>;
}
