"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogHeader, DialogFooter } from "@/components/ui/dialog";
import { DevelopmentRequestError, developmentRequest, repositoryName, type Worktree, type Workflow } from "@/lib/development-api";

export type CloseRequest = { kind: string; requestId: string; expectedRevision: number };
type Recovery = { treeId: string; leaseId: string; expectedHead: string; requestId: string; consumerExitConfirmed: true };
type Batch = { close: CloseRequest; leases: Recovery[] };
const validRecovery = (v: Recovery) => v && [v.treeId, v.leaseId, v.expectedHead, v.requestId].every(x => typeof x === "string" && x.length > 0) && v.consumerExitConfirmed === true;
function readBatch(key: string): Batch | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return ["pause", "close", "defer"].includes(v?.close?.kind) && typeof v.close.requestId === "string" && Number.isSafeInteger(v.close.expectedRevision)
      && Array.isArray(v.leases) && v.leases.every(validRecovery) ? v : null;
  } catch { return null; }
}
function retired(batch: Batch | null, closure: string | null | undefined, closeId: string | undefined) {
  return closure === "closed" || !!(batch && closeId && batch.close.requestId !== closeId);
}
export function WorkspaceLeaseRecovery({ workspaceId, trees, closure, closeRequest, disabled, refresh, onClosed, onBusyChange }: {
  workspaceId: string; trees: Worktree[]; closure?: string | null; closeRequest: CloseRequest | null;
  disabled: boolean; refresh: () => void; onClosed: (value: Workflow) => void; onBusyChange: (busy: boolean) => void;
}) {
  const key = `hosty.workspace.close-recovery.${workspaceId}`;
  const [storedPending, setPending] = useState<Batch | null>(() => readBatch(key));
  const [storedReview, setReview] = useState<Batch | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ closeId: string; message: string } | null>(null);
  const closeId = !!closeRequest && ["pause", "close", "defer"].includes(closeRequest.kind) ? closeRequest.requestId : undefined;
  const pending = retired(storedPending, closure, closeId) ? null : storedPending;
  const review = retired(storedReview, closure, closeId) ? null : storedReview;
  const error = failure?.closeId === closeId ? failure?.message : "";
  useEffect(() => {
    // A completed or superseded Close cannot own the next cycle's recovery journal.
    // Missing props alone do not prove completion: preserve uncertain same-cycle requests.
    try {
      if (retired(readBatch(key), closure, closeId)) {
        localStorage.removeItem(key);
        localStorage.removeItem(`hosty.workspace.lease-recovery.${workspaceId}`);
      }
    } catch { /* Core receipts remain authoritative. */ }
  }, [key, workspaceId, closure, closeId, storedPending]);
  const executing = useRef(false);
  const leases = trees.flatMap(tree => tree.leases.map(leaseId => ({ tree, leaseId })));
  const eligible = !!closeRequest && ["pause", "close", "defer"].includes(closeRequest.kind) && closure === "closing";
  const applicationsInUse = trees.some(tree => tree.consumers?.length);
  const sandboxInUse = trees.some(tree => tree.hasSandboxConsumers);
  const blocked = applicationsInUse || sandboxInUse;
  const observed = trees.length > 0 && trees.every(t => t.state === "active" && t.observation?.state === "ok" && t.observation.head && !t.detailError);
  const recover = async (batch: Batch) => {
    if (executing.current || !eligible || batch.close.requestId !== closeRequest?.requestId) return;
    executing.current = true; setBusy(true); onBusyChange(true); setFailure(null); setPending(batch);
    try { localStorage.setItem(key, JSON.stringify(batch)); } catch { /* In-memory replay remains available. */ }
    try {
      // Replay successful releases too: Core atomically stores each release and its receipt.
      for (const { treeId, ...body } of batch.leases)
        await developmentRequest(`/${workspaceId}/worktrees/${treeId}/recover-lease`, body);
      const { requestId, expectedRevision } = batch.close;
      const result = await developmentRequest<Workflow>(`/${workspaceId}/workflow/${batch.close.kind}`, { requestId, expectedRevision });
      if (result.closure !== "closed") throw new Error("Closure is still pending. Retry pausing to continue the original request.");
      setPending(null); setReview(null);
      try { localStorage.removeItem(key); localStorage.removeItem(`hosty.workspace.lease-recovery.${workspaceId}`); } catch { /* Core retains receipts. */ }
      onClosed(result);
    } catch (e) {
      setFailure({ closeId: batch.close.requestId, message: e instanceof Error ? e.message : String(e) });
      if (e instanceof DevelopmentRequestError && ["workspace_stale_head", "workspace_lease_invalid"].includes(e.code ?? "")) {
        setPending(null); setReview(null);
        try { localStorage.removeItem(key); localStorage.removeItem(`hosty.workspace.lease-recovery.${workspaceId}`); } catch { /* Keep memory authoritative. */ }
      }
      refresh();
    } finally { executing.current = false; setBusy(false); onBusyChange(false); }
  };
  function prepareReview() {
    if (!eligible || !observed || !closeRequest) return;
    const requests: Recovery[] = leases.map(({ tree, leaseId }) => ({ treeId: tree.id, leaseId,
      expectedHead: tree.observation!.head!, requestId: crypto.randomUUID(), consumerExitConfirmed: true }));
    // Recover a pending request from the previous single-lease UI without changing its identity.
    try {
      const legacy = JSON.parse(localStorage.getItem(`hosty.workspace.lease-recovery.${workspaceId}`) ?? "null") as Recovery;
      if (validRecovery(legacy) && trees.some(t => t.id === legacy.treeId)) {
        const index = requests.findIndex(r => r.treeId === legacy.treeId && r.leaseId === legacy.leaseId);
        if (index < 0) requests.unshift(legacy); else requests[index] = legacy;
      }
    } catch { /* No legacy journal. */ }
    setFailure(null); setReview({ close: closeRequest, leases: requests });
  }
  if (!eligible || (!leases.length && !pending)) return null;
  return <section aria-label="Pause external work" className="flex flex-col gap-3">
    <Alert><AlertTitle>External work has not confirmed completion</AlertTitle><AlertDescription>
      <p>If the external agent and its commands have stopped, you can pause this workspace without reconnecting that agent. Source files are retained.</p>
      {applicationsInUse && <p>First stop or return active runtimes and release source selections. See Activity diagnostics.</p>}
      {sandboxInUse && <p>Delete the sandboxes using these sources before confirming external work has stopped. Stop preserves their source bindings and test data.</p>}
    </AlertDescription></Alert>
    {pending
      ? <Button size="sm" variant="outline" disabled={disabled || busy || blocked} onClick={() => void recover(pending)}>Retry pausing</Button>
      : <Button size="sm" variant="outline" disabled={disabled || busy || blocked || !observed} onClick={prepareReview}>Confirm work has stopped…</Button>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Dialog open={!!review} onOpenChange={open => { if (!open && !busy) setReview(null); }}><DialogContent>
      <DialogHeader><DialogTitle>Pause external work?</DialogTitle><DialogDescription>
        Confirm that the external agent and all commands using these repositories have stopped. Core removes their reviewed activity protections and finishes pausing the workspace. It checks known consumers again. This does not stop unknown processes, complete the work or delete any source files.
      </DialogDescription></DialogHeader>
      <ul className="list-disc pl-5 text-sm">{trees.map(t => <li key={t.id}>{repositoryName(t.repository)}</li>)}</ul>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setReview(null)}>Cancel</Button>
        <Button disabled={disabled || busy || blocked} onClick={() => { if (review) void recover(review); }}>{busy ? "Pausing…" : "Work has stopped — pause workspace"}</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  </section>;
}
