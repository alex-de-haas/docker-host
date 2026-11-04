"use client";
import { useTaskExecutionSummary } from "@/lib/task-execution-api";
import { useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WorkspaceSessionControls } from "./workspace-session-controls";
import { WorkspaceSectionHeading } from "./workspace-section-heading";
import type { AssistantSession } from "@/lib/assistant-api";
import type { DevelopmentWorkspace } from "@/lib/development-api";
import { useWorkspaceSessionActions, type WorkspaceSessionActions } from "@/lib/use-workspace-session-actions";

type Props = { actions?: WorkspaceSessionActions; workspace: DevelopmentWorkspace; sessionId?: string; running?: boolean; refresh: () => void; onSelect?: (session: AssistantSession) => void; onPick?: (sessionId: string) => void; onDelete?: (sessionId: string) => Promise<void> };
export function WorkspaceSessions({ workspace, sessionId, running, refresh, onSelect, actions, onPick, onDelete }: Props) {
  const participation = workspace.participation;
  const execution = useTaskExecutionSummary(workspace.id, participation?.revision);
  const [deleting, setDeleting] = useState<{ sessionId: string; title: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const removalPending = useRef(false);
  const section = useRef<HTMLElement>(null);
  const localActions = useWorkspaceSessionActions(actions ? undefined : workspace, refresh, onSelect);
  const sessionActions = actions ?? localActions;
  const { busy, retry, pending, run, command, error } = sessionActions;
  const sessions = participation?.sessions.filter(s => s.attached) ?? [];
  return <section ref={section} aria-label="Workspace sessions" data-workspace-section className="space-y-3 text-xs">
    <WorkspaceSectionHeading actions={participation && <WorkspaceSessionControls key={`${participation.viewerUserId}:${workspace.id}`} workspace={workspace} actions={sessionActions} disabled={removing} />} informationLabel="About workspace sessions" information="Attached chats share workspace files. Task executions show the profile used for that attempt; owners and private conversations retain their access rules.">Sessions</WorkspaceSectionHeading>
    {!!execution.summary?.roots.length && <nav aria-label="Workspace root tasks" className="space-y-1">{execution.summary.roots.map(root => <a key={root.taskRef.id} href={root.path} className="block text-primary underline">{root.number} · {root.title}</a>)}</nav>}
    {execution.error && <p role="status" className="text-muted-foreground">Task attribution is unavailable. {execution.error}</p>}
    {sessions.length ? <ul className="space-y-1">{sessions.map(s => {
      const selected = s.canOpen && s.sessionId === sessionId;
      const inactive = ["idle", "failed"].includes(s.status) && !(selected && running);
      const attribution = execution.summary?.sessions.find(row => row.appId === s.appId && row.ownerId === s.userId && row.sessionId === s.sessionId);
      const label = attribution?.executor ? attribution.executor.kind === "option" ? attribution.executor.name : attribution.executor.kind === "none" ? "No profile" : `Task-specific executor · ${attribution.executor.name}` : null;
      const description = <><span className="block truncate">{label ?? s.title ?? "Untitled session"}</span>
        {label && <span className="block truncate text-muted-foreground">{s.title || attribution?.title || "Untitled session"}</span>}
        <span className="block truncate text-muted-foreground">{participation?.members.find(m => m.userId === s.userId)?.name ?? "Participant"} · {s.status.replaceAll("_", " ")}{s.status === "unknown" ? " (not confirmed)" : ""}</span></>;
      return <li key={`${s.appId}:${s.userId}:${s.sessionId}`} className={`flex items-center gap-1 rounded-md pr-1 ${selected ? "bg-accent" : ""}`}>
        {s.canOpen ? <Button type="button" variant="ghost" className="h-auto min-w-0 flex-1 justify-start px-2 py-2 text-left text-xs font-normal" aria-label={`Open session ${s.title || "Untitled session"}`} aria-current={selected ? "page" : undefined} disabled={!onPick || removing} onClick={() => onPick?.(s.sessionId)}><span className="min-w-0 flex-1">{description}</span></Button>
          : <div className="min-w-0 flex-1 px-2 py-2">{description}</div>}
        {s.canOpen ? <DropdownMenu>
          <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-sm" className="size-6 shrink-0 text-muted-foreground" disabled={busy || retry || removing} aria-label={`Session actions for ${s.title}`}><MoreHorizontal className="size-3.5" aria-hidden /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={event => { if (deleting) event.preventDefault(); }}>
            <DropdownMenuItem disabled={busy || retry || removing || !inactive} onSelect={() => void command("detach", {}, s.sessionId)}>Detach session</DropdownMenuItem>
            {onDelete && <DropdownMenuItem variant="destructive" disabled={busy || retry || removing || !inactive} onSelect={() => { setDeleteError(""); setDeleting({ sessionId: s.sessionId, title: s.title || "Untitled session" }); }}>Delete session…</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu> : <span className="shrink-0 text-muted-foreground">Private chat</span>}
      </li>;
    })}</ul> : <p className="text-muted-foreground">No sessions.</p>}
    {execution.summary?.sessions.filter(row => !sessions.some(s => s.appId === row.appId && s.userId === row.ownerId && s.sessionId === row.sessionId)).map(row => <div key={row.executionId} className="rounded-md border border-dashed px-2 py-2">
      <span className="block truncate">{row.executor?.kind === "option" ? row.executor.name : row.executor?.kind === "none" ? "No profile" : "Task-specific executor"}</span>
      <span className="block truncate text-muted-foreground">{row.title} · {row.associationState}</span>
      {row.historyPath && <a className="text-primary underline" href={row.historyPath}>Open retained history</a>}
    </div>)}
    <Dialog open={deleting !== null} onOpenChange={open => { if (!open && !removalPending.current) setDeleting(null); }}>
      <DialogContent showCloseButton={!removing} onCloseAutoFocus={event => { event.preventDefault(); section.current?.querySelector<HTMLButtonElement>("button")?.focus(); }}>
        <DialogHeader><DialogTitle>Delete session?</DialogTitle><DialogDescription>Delete “{deleting?.title}” and its conversation history? This cannot be undone. The session is detached; workspace files and other conversations are retained.</DialogDescription></DialogHeader>
        {deleteError && <p role="alert" className="text-sm text-destructive-foreground">{deleteError}</p>}
        <DialogFooter><Button variant="outline" disabled={removing} onClick={() => setDeleting(null)}>Keep session</Button>
          <Button variant="destructive" disabled={removing || busy || retry} onClick={async () => {
            if (!deleting || !onDelete || removalPending.current) return;
            removalPending.current = true; setRemoving(true); setDeleteError("");
            try { await onDelete(deleting.sessionId); setDeleting(null); }
            catch (cause) { setDeleteError(cause instanceof Error ? cause.message : String(cause)); }
            finally { removalPending.current = false; setRemoving(false); refresh(); }
          }}>{removing ? "Deleting…" : "Delete session"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {error && <p role="alert" className="text-destructive-foreground">{error}</p>}
    {retry && !busy && pending && <Button size="sm" variant="outline" onClick={() => void run(pending)}>Retry same request</Button>}
  </section>;
}
