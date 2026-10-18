"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AssistantApiError, workspaceAction } from "@/lib/assistant-api";

type Request = { requestId: string; action: "enter" | "restart" | "return"; targetRuntime?: string; worktreeId?: string; planDigest?: string; acceptDataChanges?: boolean };
type Plan = { planDigest: string; changes: string[]; outsideBackup: string[] };
type Status = { phase: string; operationId?: string; sourcePath?: string; previousRuntime?: string; backupId?: string; error?: string;
  receipts: { requestId: string; state: string }[]; app: { system: boolean; runtimeState: string; selectedRuntime?: string;
    restartRequired?: boolean; launchProgress?: { stage: string }; health?: { status: string }; lastError?: string;
    runtimeProfiles?: { key: string; type: string; development?: boolean }[]; endpoints: { browserOrigin?: string; publicOrigin?: string; url?: string }[] } };

export function AppDevMode({ sessionId, appId, worktreeId, observation, disabled, refresh }: {
  sessionId: string; appId: string; worktreeId: string; observation?: string; disabled: boolean; refresh: () => void;
}) {
  const storageKey = `hosty.dev-mode.${sessionId}.${appId}`;
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [logs, setLogs] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ request: Request; plan: Plan } | null>(null);
  const [pending, setPending] = useState<Request | null>(() => {
    try { const v = JSON.parse(localStorage.getItem(storageKey) ?? "null"); return v && typeof v.requestId === "string" && typeof v.planDigest === "string" && ["enter", "restart", "return"].includes(v.action) ? v : null; } catch { return null; }
  });
  const executing = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void workspaceAction<Status>(sessionId, "app-dev-status", { appId }).then(s => {
      if (!cancelled) { setStatus(s); setError(""); }
    }).catch(e => { if (!cancelled) { setStatus(null); setError(e.message); } });
    return () => { cancelled = true; };
  }, [sessionId, appId, observation]);
  async function prepare(action: Request["action"], targetRuntime?: string) {
    if (executing.current || disabled) return;
    executing.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const request: Request = { requestId: crypto.randomUUID(), action, targetRuntime,
        worktreeId: action === "enter" ? worktreeId : undefined, acceptDataChanges: action === "return" };
      const plan = await workspaceAction<Plan>(sessionId, "app-dev-plan", { ...request, devAction: request.action, appId });
      setReview({ request: { ...request, planDigest: plan.planDigest }, plan });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { executing.current = false; setBusy(false); }
  }
  async function apply(request: Request) {
    if (executing.current || disabled) return;
    executing.current = true; setBusy(true); setError(""); setNotice("");
    try {
      // A lost response is retried with the same identity, including after browser reload.
      localStorage.setItem(storageKey, JSON.stringify(request)); setPending(request);
      const next = await workspaceAction<Status>(sessionId, "app-dev-apply", { ...request, devAction: request.action, appId });
      setStatus(next);
      const receipt = next.receipts.find(r => r.requestId === request.requestId);
      if (receipt?.state !== "succeeded" && receipt?.state !== "superseded")
        throw new Error("Operation remains pending. Inspect state and retry the original request.");
      localStorage.removeItem(storageKey); setPending(null); setReview(null);
      if (receipt.state === "superseded") setNotice("Another operation superseded this request. Review the current state before starting a new operation.");
      refresh();
    } catch (e) {
      if (e instanceof AssistantApiError && ["dev_plan_changed", "dev_request_invalid", "dev_action_invalid"].includes(e.code ?? "")) {
        localStorage.removeItem(storageKey); setPending(null); setReview(null);
      }
      setError(e instanceof Error ? e.message : String(e)); refresh();
    }
    finally { executing.current = false; setBusy(false); }
  }
  if (status?.app.system) return null;
  const active = status && !["inactive", "returned"].includes(status.phase);
  const profiles = status?.app.runtimeProfiles?.filter(p => p.development && p.type === "docker") ?? [];
  if (status && !active && !profiles.length) return null;
  const appEndpoint = status?.app.endpoints.find(e => e.browserOrigin || e.publicOrigin);
  return <section className="space-y-2 rounded border p-3 text-xs" aria-label={`Development mode for ${appId}`}>
    <p className="font-medium">Dev mode · {appId}</p>
    <p className="text-muted-foreground">Live code with this installed app’s ordinary data and Core users.</p>
    {status && <p>{status.phase} · {status.app.selectedRuntime} · {status.app.runtimeState}{status.app.health ? ` · ${status.app.health.status}` : ""}
      {status.app.launchProgress ? ` · ${status.app.launchProgress.stage}` : ""}{status.app.restartRequired ? " · Restart required" : ""}</p>}
    {active && <><p className="break-all">Source: {status.sourcePath}</p><p>Return to {status.previousRuntime} · Backup {status.backupId ?? "pending"}</p></>}
    <div className="flex flex-wrap gap-2">
      {!active && profiles.map(p => <Button key={p.key} size="sm" variant="outline" disabled={busy || disabled || !!pending} onClick={() => void prepare("enter", p.key)}>Dev on ordinary data · {p.key}</Button>)}
      {active && <><Button size="sm" variant="outline" disabled={busy || disabled || !!pending || status.phase !== "active"} onClick={() => void prepare("restart")}>Restart dev runtime</Button>
        <Button size="sm" variant="outline" disabled={busy || disabled} onClick={() => void prepare("return")}>Return to previous runtime</Button></>}
      {appEndpoint && <Button size="sm" variant="outline" asChild><a target="_blank" rel="noreferrer" href={appEndpoint.browserOrigin || appEndpoint.publicOrigin}>Open app</a></Button>}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void workspaceAction<{ text?: string }>(sessionId, "app-dev-logs", { appId }).then(r => { setLogs(r.text ?? "No logs."); setError(""); }).catch(e => setError(e.message))}>Logs</Button>
      {pending && <Button size="sm" variant="outline" disabled={busy || disabled} onClick={() => void apply(pending)}>Retry {pending.action}</Button>}
    </div>
    {notice && <p role="status" className="text-muted-foreground">{notice}</p>}
    {(error || status?.error || status?.app.lastError) && <p role="alert" className="text-destructive">{error || status?.error || status?.app.lastError}</p>}
    {logs !== null && <div className="space-y-2"><Button size="sm" variant="ghost" onClick={() => setLogs(null)}>Hide logs</Button><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{logs}</pre></div>}
    <Dialog open={!!review} onOpenChange={open => { if (!open && !busy) setReview(null); }}><DialogContent className="max-h-[85vh] overflow-y-auto">
      <DialogTitle>{review?.request.action === "return" ? "Return and keep current data?" : "Use ordinary application data?"}</DialogTitle>
      <DialogDescription>Changes apply to the installed application in this Core. Its data and users are separate from sandbox preview.</DialogDescription>
      <ul className="space-y-2 text-sm">{review?.plan.changes.map((s, i) => <li key={i}>{s}</li>)}</ul>
      <div className="space-y-1 text-xs text-muted-foreground">{review?.plan.outsideBackup.map((s, i) => <p key={i}>{s}</p>)}</div>
      {review?.request.action === "return" && <p className="text-sm">Confirm only after checking that current data is compatible with the previous runtime. This action does not restore a backup.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setReview(null)}>Cancel</Button>
        <Button disabled={busy || disabled} onClick={() => review && void apply(review.request)}>{busy ? "Working…" : "Apply"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}
