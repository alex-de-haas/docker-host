"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { workspaceAction } from "@/lib/assistant-api";

type Status = { sourceHead: string; targetHead: string; sourceClean: boolean; targetClean: boolean;
  accepted: boolean; runtimeState: string; openUrl?: string; operation?: { state: string } };
type Pending = { action: "app-local-accept" | "app-local-use"; requestId: string; expectedHead: string; expectedTargetHead: string };
const safeLink = (value?: string) => { try { const u = new URL(value!); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } };
export function LocalAppHandoff({ sessionId, appId, workspaceId, observation, disabled, refresh }: {
  sessionId: string; appId: string; workspaceId: string; observation?: string; disabled: boolean; refresh: () => void;
}) {
  const key = `hosty.local-handoff.${sessionId}.${workspaceId}.${appId}`;
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"app-local-accept" | "app-local-use" | null>(null);
  const [pending, setPending] = useState<Pending | null>(() => {
    try { const v = JSON.parse(localStorage.getItem(key) ?? "null"); return v && ["app-local-accept", "app-local-use"].includes(v.action) && typeof v.requestId === "string" && typeof v.expectedHead === "string" && typeof v.expectedTargetHead === "string" ? v : null; } catch { return null; }
  });
  const executing = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void workspaceAction<Status>(sessionId, "app-local-status", { appId, workspaceId }).then(value => {
      if (!cancelled) setStatus(value);
    }).catch(e => { if (!cancelled) { setStatus(null); setError(e.message); } });
    return () => { cancelled = true; };
  }, [sessionId, appId, workspaceId, observation]);
  async function run(action: Pending["action"], retry = false) {
    if (!status || executing.current || disabled || (pending && !retry)) return;
    executing.current = true; setBusy(true); setError("");
    const request = retry && pending ? pending : { action, requestId: crypto.randomUUID(), expectedHead: status.sourceHead, expectedTargetHead: status.targetHead };
    try {
      // Persist exactly what the operator reviewed before sending a mutation.
      localStorage.setItem(key, JSON.stringify(request)); setPending(request);
      const result = await workspaceAction<Status>(sessionId, request.action, { ...request, appId, workspaceId });
      setStatus(result);
      if (result.operation?.state !== "succeeded") throw new Error("Outcome is uncertain. Retry the original request.");
      localStorage.removeItem(key); setPending(null); setConfirm(null); refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { executing.current = false; setBusy(false); }
  }
  const stopped = status && !["running", "degraded", "starting"].includes(status.runtimeState);
  return <div className="flex flex-col gap-2 rounded border p-3 text-xs" aria-label={`Local use of ${appId}`}>
    <p className="font-medium">Local source · {appId}</p>
    {status && <><p>{status.accepted ? "Accepted in local main" : "Workspace has unaccepted work"} · {status.runtimeState}</p>
      <p className="text-muted-foreground">Main {status.targetHead.slice(0, 8)} · Workspace {status.sourceHead.slice(0, 8)}</p>
      {(!status.sourceClean || !status.targetClean) && <p>Commit or resolve changes before acceptance. Nothing is committed automatically.</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={disabled || busy || !!pending || status.accepted || !status.sourceClean || !status.targetClean || !stopped} onClick={() => setConfirm("app-local-accept")}>Accept locally</Button>
        <Button size="sm" variant="outline" disabled={disabled || busy || !!pending || !status.accepted || !stopped} onClick={() => setConfirm("app-local-use")}>Use locally</Button>
        {!stopped && safeLink(status.openUrl) && <Button size="sm" variant="outline" asChild><a href={safeLink(status.openUrl)} target="_blank" rel="noreferrer">Open local app</a></Button>}
      </div>
      {!stopped && !status.accepted && <p>Stop the ordinary app before accepting new code.</p>}
    </>}
    {pending && <div className="flex flex-col gap-2"><p>Pending {pending.action === "app-local-accept" ? "acceptance" : "local start"}. Retry keeps the reviewed commits and request ID.</p>
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void run(pending.action, true)}>Retry local action</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { localStorage.removeItem(key); setPending(null); setConfirm(null); refresh(); }}>Dismiss request</Button></div></div>}
    {error && <p role="alert" className="text-destructive-foreground">{error}</p>}
    <Dialog open={!!confirm} onOpenChange={open => { if (!open) setConfirm(null); }}><DialogContent>
      <DialogTitle>{confirm === "app-local-accept" ? "Accept committed work locally?" : "Use this app locally?"}</DialogTitle>
      <DialogDescription>{confirm === "app-local-accept"
        ? "Fast-forward local main to the reviewed workspace commit. No commit, remote, push or publication is created. This is not a remote backup."
        : "Start the accepted local source with this installation’s ordinary data and caches. Sandbox users, data and secrets stay separate. Autostart stays unchanged."}</DialogDescription>
      <p className="break-all text-sm">{appId}<br />Main: {status?.targetHead}<br />Workspace: {status?.sourceHead}</p>
      {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
      <DialogFooter><Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button><Button disabled={disabled || busy || !!pending} onClick={() => confirm && void run(confirm)}>{busy ? "Working…" : confirm === "app-local-accept" ? "Accept locally" : "Start with ordinary data"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
