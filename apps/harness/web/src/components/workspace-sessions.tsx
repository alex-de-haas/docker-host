"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listSessions, type AssistantSession } from "@/lib/assistant-api";
import { workflowIsActive, type DevelopmentWorkspace } from "@/lib/development-api";

import { useWorkspaceSessionActions, type WorkspaceSessionActions } from "@/lib/use-workspace-session-actions";
type Props = { actions?: WorkspaceSessionActions; workspace: DevelopmentWorkspace; sessionId?: string; running?: boolean; refresh: () => void; onSelect?: (session: AssistantSession) => void };
export function WorkspaceSessions(props: Props) {
  return <WorkspaceSessionsContent key={`${props.workspace.participation?.viewerUserId ?? "legacy"}:${props.workspace.id}`} {...props} />;
}
function WorkspaceSessionsContent({ workspace, sessionId, running, refresh, onSelect, actions }: Props) {
  const participation = workspace.participation!;
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  const [selectedSession, setSelectedSession] = useState("");
  const localActions = useWorkspaceSessionActions(actions ? undefined : workspace, refresh, onSelect);
  const { busy, retry, pending, run, command, error: actionError } = actions ?? localActions;
  const active = workflowIsActive(workspace.workflow);
  const mine = participation.sessions.some(s => s.attached && s.canOpen && s.sessionId === sessionId);
  return <section aria-label="Workspace sessions" className="space-y-3 rounded-md border p-3 text-xs">
    <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">Participants</h3><span className="text-muted-foreground">{participation.role}</span></div>
    <p className="text-muted-foreground">Sessions share these files and can run in parallel. Applications and users with workspace permission can access this source; conversations and approvals stay private. Concurrent edits require coordination.</p>
    <ul className="space-y-2">{participation.sessions.filter(s => s.attached).map(s => <li key={`${s.appId}:${s.userId}:${s.sessionId}`} className="flex items-start justify-between gap-2">
      <div className="min-w-0"><div className="truncate">{s.title}{s.sessionId === sessionId && s.canOpen ? " · this session" : ""}</div>
        <div className="text-muted-foreground">{participation.members.find(m => m.userId === s.userId)?.name ?? "Participant"} · {s.status.replaceAll("_", " ")}{s.status === "unknown" ? " (not confirmed)" : ""}</div></div>
      {!s.canOpen && <span className="shrink-0 text-muted-foreground">Private chat</span>}
    </li>)}</ul>
    {!participation.sessions.some(s => s.attached) && <p className="text-muted-foreground">No sessions attached. Source is retained.</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="ghost" disabled={busy || retry || !active} onClick={async () => {
        setJoining(!joining); setError("");
        try { setSessions(await listSessions()); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }}>Attach session</Button>
      {mine && <Button size="sm" variant="ghost" disabled={busy || retry || running} onClick={() => void command("detach", {}, sessionId)}>Detach this session</Button>}
    </div>
    {joining && <div className="space-y-2">
      <p>Choose an idle session. Attaching starts a fresh agent context on its next message and retains its conversation.</p>
      <Select value={selectedSession} onValueChange={setSelectedSession}><SelectTrigger aria-label="Session to attach"><SelectValue placeholder="Choose your session" /></SelectTrigger><SelectContent>
        {sessions.filter(s => !["running", "awaiting_approval", "awaiting_question"].includes(s.status) && !participation.sessions.some(b => b.attached && b.canOpen && b.sessionId === s.id)).map(s => <SelectItem key={s.id} value={s.id}>{s.title || "Untitled session"}</SelectItem>)}
      </SelectContent></Select>
      <Button size="sm" disabled={!selectedSession || busy || retry} onClick={() => void command("attach", {}, selectedSession)}>Attach selected session</Button>
    </div>}
    {(error || actionError) && <p role="alert" className="text-destructive-foreground">{error || actionError}</p>}
    {retry && !busy && pending && <Button size="sm" variant="outline" onClick={() => void run(pending!)}>Retry same request</Button>}
  </section>;
}
