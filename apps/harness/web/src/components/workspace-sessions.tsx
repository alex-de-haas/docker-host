"use client";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
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
  const [loading, setLoading] = useState(false);
  const loadRequest = useRef(0);
  const selectId = useId();
  const localActions = useWorkspaceSessionActions(actions ? undefined : workspace, refresh, onSelect);
  const { busy, retry, pending, run, command, error: actionError } = actions ?? localActions;
  const active = workflowIsActive(workspace.workflow);
  const mine = participation.sessions.some(s => s.attached && s.canOpen && s.sessionId === sessionId);
  const candidates = sessions.filter(s => !["running", "awaiting_approval", "awaiting_question"].includes(s.status)
    && !participation.sessions.some(b => b.attached && b.canOpen && b.sessionId === s.id));
  const loadSessions = async () => {
    const request = ++loadRequest.current;
    setLoading(true); setError(""); setSessions([]); setSelectedSession("");
    try {
      const records = await listSessions();
      if (request === loadRequest.current) setSessions(records);
    } catch (cause) {
      if (request === loadRequest.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (request === loadRequest.current) setLoading(false); }
  };
  const changeJoining = (open: boolean) => {
    if (busy) return;
    setJoining(open);
    if (open) void loadSessions();
    else { loadRequest.current++; setError(""); }
  };
  const attach = async () => {
    const succeeded = retry && pending ? await run(pending) : await command("attach", {}, selectedSession);
    if (succeeded) setJoining(false);
  };
  return <Dialog open={joining} onOpenChange={changeJoining}><section aria-label="Workspace sessions" className="space-y-3 rounded-md border p-3 text-xs">
    <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">Participants</h3><span className="text-muted-foreground">{participation.role}</span></div>
    <p className="text-muted-foreground">Sessions share these files and can run in parallel. Applications and users with workspace permission can access this source; conversations and approvals stay private. Concurrent edits require coordination.</p>
    <ul className="space-y-2">{participation.sessions.filter(s => s.attached).map(s => <li key={`${s.appId}:${s.userId}:${s.sessionId}`} className="flex items-start justify-between gap-2">
      <div className="min-w-0"><div className="truncate">{s.title}{s.sessionId === sessionId && s.canOpen ? " · this session" : ""}</div>
        <div className="text-muted-foreground">{participation.members.find(m => m.userId === s.userId)?.name ?? "Participant"} · {s.status.replaceAll("_", " ")}{s.status === "unknown" ? " (not confirmed)" : ""}</div></div>
      {!s.canOpen && <span className="shrink-0 text-muted-foreground">Private chat</span>}
    </li>)}</ul>
    {!participation.sessions.some(s => s.attached) && <p className="text-muted-foreground">No sessions attached. Source is retained.</p>}
    <div className="flex flex-wrap gap-2">
      <DialogTrigger asChild><Button size="sm" variant="ghost" disabled={busy || retry || !active}>Attach session</Button></DialogTrigger>
      {mine && <Button size="sm" variant="ghost" disabled={busy || retry || running} onClick={() => void command("detach", {}, sessionId)}>Detach this session</Button>}
    </div>
    <DialogContent showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>Attach session</DialogTitle>
        <DialogDescription>Choose an idle session to attach to this workspace. Its conversation is retained; the agent starts with a fresh context on its next message.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <FieldGroup><Field data-disabled={loading || busy || retry || !candidates.length}>
          <FieldLabel htmlFor={selectId}>Session</FieldLabel>
          <Select value={selectedSession} onValueChange={setSelectedSession} disabled={loading || busy || retry || !candidates.length}>
            <SelectTrigger id={selectId} className="w-full"><SelectValue placeholder="Choose your session" /></SelectTrigger>
            <SelectContent><SelectGroup>{candidates.map(s => <SelectItem key={s.id} value={s.id}>{s.title || "Untitled session"}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
          {loading && <p role="status" className="text-sm text-muted-foreground">Loading sessions…</p>}
          {!loading && !error && !candidates.length && <p className="text-sm text-muted-foreground">No available sessions. Create a new session or stop an active one before attaching it.</p>}
          {(error || actionError) && <FieldError>{error || actionError}</FieldError>}
          {error && <Button variant="outline" disabled={loading || busy} onClick={() => void loadSessions()}>Reload sessions</Button>}
        </Field></FieldGroup>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => changeJoining(false)}>Cancel</Button>
        {retry && pending ? <Button disabled={busy} onClick={() => void attach()}>{busy ? "Attaching…" : "Retry same request"}</Button>
          : <Button disabled={loading || busy || !active || !candidates.some(s => s.id === selectedSession)} onClick={() => void attach()}>{busy ? "Attaching…" : "Attach session"}</Button>}
      </DialogFooter>
    </DialogContent>
    {!joining && actionError && <p role="alert" className="text-destructive-foreground">{actionError}</p>}
    {!joining && retry && !busy && pending && <Button size="sm" variant="outline" onClick={() => void run(pending!)}>Retry same request</Button>}
  </section></Dialog>;
}
