"use client";
import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogHeader, DialogFooter } from "@/components/ui/dialog";
import { DevelopmentRequestError, developmentRequest } from "@/lib/development-api";
type Request = { action: string; requestId: string; expectedRevision: number };
type Operation = { id: string; state: string; error?: string; message?: string };
type Resource = { id: string; state: string; revision: number; error?: string; operations?: Operation[] };
// App-sandbox Start/Stop receipts are terminal; only Dispose supports same-ID recovery.
const terminalFailure = (kind: string, request: Request | null, operation?: Operation) =>
  kind === "sandboxes" && ["start", "stop"].includes(request?.action ?? "") && operation?.state === "failed";
function read(key: string): Request | null {
  try { const v = JSON.parse(localStorage.getItem(key) ?? "null"); return v && ["start", "stop", "finish", "dispose"].includes(v.action)
    && typeof v.requestId === "string" && Number.isSafeInteger(v.expectedRevision) ? v : null; } catch { return null; }
}
const sameId = (a: string, b: string) => a.replaceAll("-", "") === b.replaceAll("-", "");
export function WorkspaceResourceActions({ workspaceId, kind, resource, label, canStart, disabled, refresh, compact = false }: {
  workspaceId: string; kind: "environments" | "sandboxes"; resource: Resource; label: string;
  canStart: boolean; disabled: boolean; refresh: () => void; compact?: boolean;
}) {
  const key = `hosty.workspace.resource.${workspaceId}.${kind}.${resource.id}`;
  const [stored, setStored] = useState<Request | null>(() => read(key));
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const executing = useRef(false);
  const observed = stored ? resource.operations?.find(o => sameId(o.id, stored.requestId)) : undefined;
  const failed = terminalFailure(kind, stored, observed);
  const done = observed?.state === "succeeded" || failed;
  const pending = done ? null : stored;
  const inFlight = resource.operations?.some(o => ["pending", "running"].includes(o.state));
  useEffect(() => { if (done) { try { localStorage.removeItem(key); } catch { /* Core has the receipt. */ } } }, [done, key]);
  async function run(request: Request) {
    if (executing.current) return;
    executing.current = true; setBusy(true); setError(""); setStored(request);
    try { localStorage.setItem(key, JSON.stringify(request)); } catch { /* Keep the request in memory. */ }
    try {
      const { action, ...body } = request;
      const result = await developmentRequest<Resource>(`/${workspaceId}/${kind}/${resource.id}/${action}`, body);
      const operation = result.operations?.find(o => sameId(o.id, request.requestId));
      if (operation?.state === "succeeded" || terminalFailure(kind, request, operation)) {
        if (operation?.state === "failed") setError(operation.message ?? operation.error ?? "The action failed. Inspect the sandbox state before choosing a new action.");
        setStored(null); setConfirm(false);
        try { localStorage.removeItem(key); } catch { /* The receipt remains available in Core. */ }
      } else if (["failed", "unknown"].includes(operation?.state ?? "")) {
        setError(operation?.error ?? operation?.message ?? result.error ?? "The operation needs recovery. Retry with the same request.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // A revision refusal happens before admission. Never silently retry a destructive action
      // against a new revision: refresh and ask for a new action instead.
      if (e instanceof DevelopmentRequestError && ["environment_revision_conflict", "sandbox_revision_stale"].includes(e.code ?? "")) {
        setStored(null); setConfirm(false);
        try { localStorage.removeItem(key); } catch { /* In-memory state is current. */ }
      }
    } finally { executing.current = false; setBusy(false); refresh(); }
  }
  const request = (action: string) => ({ action, requestId: crypto.randomUUID(), expectedRevision: resource.revision });
  const locked = disabled || busy || !Number.isSafeInteger(resource.revision);
  const stopped = ["stopped", "prepared", "created"].includes(resource.state);
  const removing = ["finishing", "cleanup-failed", "disposing", "disposed", "finished"].includes(resource.state);
  return <div aria-label={`${label} controls`} className="flex flex-col gap-2">
    {compact && !pending ? <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`${label} sandbox actions`}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {stopped && <DropdownMenuItem disabled={locked || !canStart || inFlight} onSelect={() => void run(request("start"))}>Start sandbox</DropdownMenuItem>}
        {!stopped && !removing && <DropdownMenuItem disabled={locked || inFlight} onSelect={() => void run(request("stop"))}>Stop sandbox</DropdownMenuItem>}
        <DropdownMenuItem variant="destructive" disabled={locked || inFlight} onSelect={() => setConfirm(true)}>Delete sandbox…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu> : <div className="flex flex-wrap gap-2">
      {pending ? <Button size="sm" variant="outline" disabled={locked} onClick={() => void run(pending)}>Retry sandbox action</Button> : <>
        {stopped && <Button size="sm" variant="outline" disabled={locked || !canStart || inFlight} onClick={() => void run(request("start"))}>Start sandbox</Button>}
        {!stopped && !removing && <Button size="sm" variant="outline" disabled={locked || inFlight} onClick={() => void run(request("stop"))}>Stop sandbox</Button>}
        <Button size="sm" variant="outline" disabled={locked || inFlight} onClick={() => setConfirm(true)}>Delete sandbox…</Button>
      </>}
    </div>}
    {stopped && <p className="text-xs text-muted-foreground">Test data is retained. This sandbox still protects its workspace source until deleted.{!canStart && " Resume the workspace before starting it."}</p>}
    {(busy || inFlight) && <p role="status" className="text-xs">Sandbox operation in progress…</p>}
    {pending && !busy && <p className="text-xs text-muted-foreground">An action is unfinished or its response was lost. Retry continues the same request.</p>}
    {(error || failed) && <p role="alert" className="text-xs text-destructive">{error || observed?.message || "The action failed. Inspect the sandbox state before choosing a new action."}</p>}
    <Dialog open={confirm} onOpenChange={open => { if (!busy) setConfirm(open); }}><DialogContent>
      <DialogHeader><DialogTitle>Delete sandbox “{label}”?</DialogTitle><DialogDescription>
        Stop this sandbox and permanently remove its test data and owned runtime resources. Workspace source files, commits and ordinary application data are preserved.
      </DialogDescription></DialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>Cancel</Button>
        <Button variant="destructive" disabled={locked} onClick={() => void run(pending ?? request(kind === "environments" ? "finish" : "dispose"))}>{busy ? "Deleting…" : "Delete sandbox"}</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
