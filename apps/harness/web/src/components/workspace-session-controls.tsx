"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Link, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { listSessions, type AssistantSession } from "@/lib/assistant-api";
import { workflowIsActive, type DevelopmentWorkspace } from "@/lib/development-api";
import type { WorkspaceSessionActions } from "@/lib/use-workspace-session-actions";

export function WorkspaceSessionControls({ workspace, actions, disabled = false }: { workspace: DevelopmentWorkspace; actions: WorkspaceSessionActions; disabled?: boolean }) {
  const participation = workspace.participation!;
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  const [selectedSession, setSelectedSession] = useState("");
  const [loading, setLoading] = useState(false);
  const loadRequest = useRef(0);
  const selectId = useId();
  const { busy, retry, pending, run, command, error: actionError } = actions;
  const attachTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => () => { loadRequest.current++; }, []);
  const active = workflowIsActive(workspace.workflow);
  const candidates = sessions.filter(s => !s.workspaceAssociation && ["idle", "cancelled", "abandoned", "failed"].includes(s.status)
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
  return <Dialog open={joining} onOpenChange={changeJoining}>
    <div role="group" aria-label="Session creation" className="flex shrink-0 items-center gap-1">
      <Button size="icon-sm" variant="ghost" className="size-6 text-muted-foreground" aria-label="New session in workspace" title="New session in workspace"
        disabled={disabled || busy || retry || !active} onClick={() => void command("new")}>
        {busy ? <Loader2 aria-hidden className="motion-safe:animate-spin" /> : <Plus aria-hidden />}
      </Button>
      <Button ref={attachTrigger} size="icon-sm" variant="ghost" className="size-6 text-muted-foreground" aria-label="Attach session" title="Attach session" disabled={disabled || busy || retry || !active} onClick={() => changeJoining(true)}><Link aria-hidden className="size-3.5" /></Button>
    </div>
    <DialogContent showCloseButton={!busy} onCloseAutoFocus={event => { event.preventDefault(); attachTrigger.current?.focus(); }}>
      <DialogHeader>
        <DialogTitle>Attach session</DialogTitle>
        <DialogDescription>Choose one of your idle sessions that is not attached to a workspace. Its conversation is retained; the agent starts with a fresh context on its next message.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <FieldGroup><Field data-disabled={loading || busy || retry || !candidates.length}>
          <FieldLabel htmlFor={selectId}>Session</FieldLabel>
          <Select value={selectedSession} onValueChange={setSelectedSession} disabled={loading || busy || retry || !candidates.length}>
            <SelectTrigger id={selectId} className="w-full"><SelectValue placeholder="Choose your session" /></SelectTrigger>
            <SelectContent><SelectGroup>{candidates.map(s => <SelectItem key={s.id} value={s.id}>{s.title || "Untitled session"}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
          {loading && <p role="status" className="text-sm text-muted-foreground">Loading sessions…</p>}
          {!loading && !error && !candidates.length && <p className="text-sm text-muted-foreground">No unattached idle sessions. Create a new session, or detach an idle session from its current workspace first.</p>}
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
  </Dialog>;
}
