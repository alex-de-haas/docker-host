"use client";
import { useRef, useState } from "react";
import { Folder, Loader2, MessageSquarePlus, Trash2 } from "lucide-react";
import type { AssistantSession } from "@/lib/assistant-api";
import type { DevelopmentWorkspace } from "@/lib/development-api";
import { orderSessions, isWaiting } from "@/lib/attention";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ContinueBuilding } from "@/components/continue-building";

export function DevelopmentNavigation({ sessions, activeId, workspaces, onPick, onNew, onDelete }: {
  sessions: AssistantSession[]; activeId?: string; workspaces: DevelopmentWorkspace[];
  onPick: (session: AssistantSession) => void; onNew: () => void; onDelete: (sessionId: string) => Promise<void>;
}) {
  const [deleting, setDeleting] = useState<AssistantSession | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deletionPending = useRef(false);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const newButton = useRef<HTMLButtonElement | null>(null);
  const [filter, setFilter] = useState("");
  const names = new Map<string, string>();
  const appNames = new Map(workspaces.flatMap(w => w.worktrees.flatMap(t => t.apps.map(app => [app.appId, app.name] as const))));
  for (const session of sessions) for (const id of session.appIds ?? [])
    names.set(id, session.contextApps?.find(app => app.id === id)?.displayName ?? appNames.get(id) ?? names.get(id) ?? id);
  const selectedFilter = filter === "unassigned" || names.has(filter) ? filter : "";
  const groups = [...names].sort((a,b) => a[1].localeCompare(b[1]));
  const renderGroup = (id: string, name: string, rows: AssistantSession[]) => <section key={id || "unassigned"} className="py-2">
    <h2 className="flex items-center gap-2 px-3 pb-1 text-xs font-medium text-muted-foreground"><Folder className="size-3.5" />{name}</h2>
    {orderSessions(rows).map(session => {
      const workspace = workspaces.find(w => w.owner.kind === "assistant" && w.owner.reference === session.id && w.owner.appId === "hosty.harness" && w.workflow.state !== "deleted");
      const prs = workspace?.worktrees.flatMap(t => t.pullRequests).length ?? 0;
      return <div key={session.id} className={`group mx-1 flex items-center rounded-md pr-1 hover:bg-muted ${activeId === session.id ? "bg-muted" : ""}`}>
        <button type="button" aria-current={activeId === session.id ? "page" : undefined}
        onClick={() => onPick(session)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-ring">
        <span className="min-w-0 flex-1"><span className="block truncate text-sm">{session.title || "Untitled session"}</span>
          <span className="block truncate text-xs text-muted-foreground">{isWaiting(session.status) ? "Waiting for you" : session.status}{workspace ? ` · Workspace${prs ? ` · ${prs} PR` : ""}` : ""}</span></span>
        {session.status === "running" && <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-label="Agent running" />}
        {isWaiting(session.status) && <span className="size-2 shrink-0 rounded-full bg-amber-500" aria-label="Waiting for you" />}
        </button>
        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${session.title || "Untitled session"}`} title="Delete session"
          className="shrink-0 text-muted-foreground hover:text-destructive [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          onClick={event => { deleteTrigger.current = event.currentTarget; setError(null); setDeleting(session); }}><Trash2 /></Button>
      </div>;
    })}
  </section>;
  return <nav aria-label="Sessions by application" className="flex h-full min-h-0 flex-col">
    <div className="space-y-2 border-b p-3"><Button ref={newButton} className="w-full justify-start" variant="outline" onClick={onNew}><MessageSquarePlus />New session</Button>
      <ContinueBuilding sessions={sessions} onPick={onPick} />
      <select aria-label="Filter sessions by application" value={selectedFilter} onChange={e => setFilter(e.target.value)} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
        <option value="">All applications</option>{groups.map(([id,name]) => <option key={id} value={id}>{name}</option>)}<option value="unassigned">Unassigned chats</option>
      </select></div>
    <div className="min-h-0 flex-1 overflow-y-auto py-2">
      {groups.filter(([id]) => !selectedFilter || selectedFilter === id).map(([id,name]) => renderGroup(id,name,sessions.filter(s => s.appIds?.includes(id))))}
      {(!selectedFilter || selectedFilter === "unassigned") && renderGroup("", "Unassigned chats", sessions.filter(s => !s.appIds?.length))}
      {!sessions.length && <p className="p-3 text-sm text-muted-foreground">Start a session to ask a question or work on an application.</p>}
    </div>
    <Dialog open={deleting !== null} onOpenChange={open => { if (!open && !deletionPending.current) setDeleting(null); }}>
      <DialogContent showCloseButton={!pending} onCloseAutoFocus={event => {
        event.preventDefault();
        (deleteTrigger.current?.isConnected ? deleteTrigger.current : newButton.current)?.focus();
      }}>
        <DialogHeader><DialogTitle>Delete session?</DialogTitle>
          <DialogDescription>Delete “{deleting?.title || "Untitled session"}” and its conversation history? This cannot be undone. Unfinished workspaces must be resolved before their session can be deleted.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
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
