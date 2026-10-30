"use client";
import { useState } from "react";
import { Hammer } from "lucide-react";
import { HostyLoader } from "../../../../../shared/web/hosty-states";
import { newBuildingSession, type AssistantSession } from "@/lib/assistant-api";
import { developmentRequest } from "@/lib/development-api";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogBody, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";

export type BuildingApp = { appId: string; name: string; acceptedHead: string | null; unavailable: string | null;
  work: { workspaceId: string; worktreeId: string; sessionId: string; assistantId: string | null;
    owned: boolean; state: string; head: string | null; accepted: boolean | null; unavailable: string | null }[] };
type Request = { appId: string; requestId: string; expectedLocalHead: string };
const pendingKey = "hosty.building.pending.v1";
function readPending(): Request | null {
  try {
    const value = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
    return value && typeof value.appId === "string" && typeof value.requestId === "string" &&
      typeof value.expectedLocalHead === "string" ? value : null;
  } catch { return null; }
}

export function ContinueBuilding({ sessions, onPick }: { sessions: AssistantSession[]; onPick: (session: AssistantSession) => void }) {
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<BuildingApp[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Request | null>(null);
  const refresh = async () => {
    setLoading(true); setError(""); setApps([]);
    try { setApps(await developmentRequest<BuildingApp[]>("/local-apps")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  const start = async (input: Request) => {
    setBusy(true); setError("");
    try {
      // Persist before dispatch. Closing/reloading the dialog never allocates another request.
      localStorage.setItem(pendingKey, JSON.stringify(input)); setPending(input);
      const session = await newBuildingSession(input);
      localStorage.removeItem(pendingKey); setPending(null); setOpen(false); onPick(session);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={value => {
    if (busy) return; setOpen(value);
    if (value) { setPending(readPending()); void refresh(); }
  }}>
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Continue building"><Hammer aria-hidden="true" /></Button></DialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">Continue building</TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <DialogContent className="sm:max-w-xl">
      <DialogHeader><DialogTitle>Continue building</DialogTitle>
        <DialogDescription>Reopen existing work or start a new session from accepted local main. Other worktrees and their unfinished changes stay intact.</DialogDescription></DialogHeader>
      <DialogBody>
        {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
        {pending && <div className="space-y-2 rounded-md border p-3 text-sm">
          <p>A new-session request for {pending.appId} needs confirmation. Retry to recover the same session.</p>
          <Button size="sm" disabled={busy} onClick={() => void start(pending)}>{busy && <HostyLoader label={null} className="size-4" />}Retry new session</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
            localStorage.removeItem(pendingKey); setPending(null);
          }}>Clear request reminder</Button>
          <p className="text-xs text-muted-foreground">Clearing this reminder keeps any session and worktree already created.</p>
        </div>}
        {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><HostyLoader label={null} className="size-4" />Reading accepted source and outstanding work…</p>}
        {!loading && !error && !apps.length && <p className="text-sm text-muted-foreground">No locally created applications are installed.</p>}
        {busy && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><HostyLoader label={null} className="size-4" />Starting the requested session…</p>}
        {apps.map(app => <section key={app.appId} className="space-y-3 rounded-md border p-3">
          <div><h3 className="font-medium">{app.name}</h3><p className="break-all text-xs text-muted-foreground">{app.appId}</p></div>
          <p className="text-sm">Accepted main: <code>{app.acceptedHead?.slice(0, 10) ?? "Unavailable"}</code></p>
          {app.unavailable && <p className="text-sm text-destructive-foreground">{app.unavailable}</p>}
          {app.work.map(work => {
            const session = work.owned && work.assistantId === "hosty.harness" ? sessions.find(s => s.id === work.sessionId) : undefined;
            return <div key={work.worktreeId} className="space-y-1 border-l-2 pl-3 text-sm">
              <p>{session?.title || work.sessionId}</p>
              <p className="text-xs text-muted-foreground">{work.state} · {work.accepted === true ? "Changes accepted" : work.accepted === false ? "Outstanding work" : "Acceptance unverified"}</p>
              {work.unavailable && <p className="text-xs text-destructive-foreground">{work.unavailable}</p>}
              {session ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setOpen(false); onPick(session); }}>Open existing session</Button>
                : <p className="text-xs text-muted-foreground">Retained workspace; use its owning agent or External workspaces.</p>}
            </div>;
          })}
          <Button size="sm" disabled={busy || loading || Boolean(pending) || Boolean(app.unavailable) || !app.acceptedHead}
            onClick={() => void start({ appId: app.appId, requestId: crypto.randomUUID(), expectedLocalHead: app.acceptedHead! })}>New building session</Button>
        </section>)}
      </DialogBody>
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="outline" disabled={loading || busy} onClick={() => void refresh()}>Refresh applications</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
