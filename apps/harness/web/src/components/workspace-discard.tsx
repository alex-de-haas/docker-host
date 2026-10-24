"use client";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DevelopmentRequestError, developmentRequest, repositoryName } from "@/lib/development-api";

export type DiscardCommand = { requestId: string; expectedRevision: number; digest: string; confirmationName: string };
export type DiscardPlan = {
  workspaceId: string; name: string; revision: number; digest: string; expiresAt: string;
  trees: { id: string; repository: string; path: string; branch: string; head: string; fingerprint: string;
    changedFiles: string[]; untrackedFiles: string[]; ignoredFiles: string[]; unmergedCommits: number }[];
  resources: { id: string; kind: string; state: string; revision: number; name: string; dataPath?: string }[];
  blockers: string[]; removedTrees?: string[];
};
export type DiscardProgress = { workspaceId: string; requestId: string; state: "pending" | "removed" | "review-required"; error?: string;
  trees: { id: string; state: string }[]; resources: { id: string; kind: string; state: string }[]; command?: DiscardCommand };
function validCommand(value: unknown): value is DiscardCommand {
  if (!value || typeof value !== "object") return false;
  const v = value as DiscardCommand;
  return typeof v.requestId === "string" && /^[a-f0-9-]{36}$/i.test(v.requestId) && Number.isSafeInteger(v.expectedRevision)
    && v.expectedRevision >= 0 && typeof v.digest === "string" && !!v.digest && typeof v.confirmationName === "string" && !!v.confirmationName;
}
function storedCommand(key: string): DiscardCommand | null {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null"); return validCommand(value) ? value : null; } catch { return null; }
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function WorkspaceDiscard({ workspaceId, pendingRequestId, disabled, canPause, onPause, onClose, refresh, deleteConversation }: {
  workspaceId: string; pendingRequestId?: string; disabled: boolean; canPause: boolean; onPause: () => void;
  onClose: () => void; refresh: () => void; deleteConversation?: () => Promise<void>;
}) {
  const key = `hosty.workspace.discard.${workspaceId}`;
  const [command, setCommand] = useState<DiscardCommand | null>(() => storedCommand(key));
  const [plan, setPlan] = useState<DiscardPlan | null>(null);
  const [reviewingAgain, setReviewingAgain] = useState(false);
  const [progress, setProgress] = useState<DiscardProgress | null>(null);
  const [withConversation, setWithConversation] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [removing, setRemoving] = useState(false);
  const [now, setNow] = useState(Date.now);
  const executing = useRef(false);
  const reviewAbort = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const conversationRemovalStarted = useRef(false);
  const initial = useRef({ command, pendingRequestId });
  const remember = (value: DiscardCommand | null) => {
    setCommand(value);
    try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); } catch { /* Core retains admitted receipts. */ }
  };
  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    const load = async () => {
      try {
        const requestId = initial.current.pendingRequestId ?? initial.current.command?.requestId;
        if (requestId) {
          const value = await developmentRequest<DiscardProgress>(`/${workspaceId}/discard/status?requestId=${encodeURIComponent(requestId)}`, undefined, abort.signal);
          if (abort.signal.aborted) return;
          setProgress(value);
          if (validCommand(value.command)) { setCommand(value.command); try { localStorage.setItem(key, JSON.stringify(value.command)); } catch { /* Optional local journal. */ } }
          if (value.state === "removed") { setCommand(null); try { localStorage.removeItem(key); } catch {} }
        } else {
          const value = await developmentRequest<DiscardPlan>(`/${workspaceId}/discard/plan`, undefined, abort.signal);
          if (!abort.signal.aborted) setPlan(value);
        }
      } catch (e) { if (!abort.signal.aborted) setError(message(e)); }
      finally { if (!abort.signal.aborted) setBusy(false); }
    };
    void load();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive.current = false; abort.abort(); reviewAbort.current?.abort(); clearInterval(timer); };
  }, [workspaceId, key]);
  const review = async () => {
    if (executing.current || (progress?.state !== "review-required" && (command || (!reviewingAgain && pendingRequestId) || progress))) return;
    executing.current = true; setBusy(true); setError(""); remember(null); setProgress(null); setReviewingAgain(true); setPlan(null);
    try {
      const abort = new AbortController(); reviewAbort.current = abort;
      const value = await developmentRequest<DiscardPlan>(`/${workspaceId}/discard/plan`, undefined, abort.signal);
      if (alive.current && !abort.signal.aborted) setPlan(value);
    }
    catch (e) { if (alive.current) setError(message(e)); }
    finally { executing.current = false; if (alive.current) setBusy(false); }
  };
  const finishConversation = async () => {
    if (!withConversation || !deleteConversation || conversationRemovalStarted.current) return;
    conversationRemovalStarted.current = true;
    try { await deleteConversation(); }
    catch (e) { if (alive.current) setError(`Workspace removed. Conversation was retained: ${message(e)}`); }
  };
  const recover = async () => {
    const requestId = progress?.requestId ?? pendingRequestId ?? command?.requestId;
    if (!requestId || executing.current) return;
    executing.current = true; setBusy(true); setError("");
    try {
      const value = await developmentRequest<DiscardProgress>(`/${workspaceId}/discard/status?requestId=${encodeURIComponent(requestId)}`);
      if (!alive.current) return;
      setProgress(value); if (validCommand(value.command)) remember(value.command);
      if (value.state === "removed") { remember(null); await finishConversation(); }
    } catch (e) { if (alive.current) setError(message(e)); }
    finally { executing.current = false; if (alive.current) setBusy(false); }
  };
  const expired = !!plan && (!Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= now);
  const apply = async () => {
    if (executing.current || disabled || progress?.state === "removed") return;
    if (!command && (!plan || expired || plan.blockers.length)) return;
    const request = command ?? { requestId: crypto.randomUUID(), expectedRevision: plan!.revision, digest: plan!.digest, confirmationName: plan!.name };
    executing.current = true; setBusy(true); setRemoving(true); setError(""); remember(request);
    let removed = false;
    try {
      const value = await developmentRequest<DiscardProgress>(`/${workspaceId}/discard/apply`, request);
      if (!alive.current) return;
      setProgress(value); removed = value.state === "removed";
      if (removed) { remember(null); await finishConversation(); }
    } catch (e) {
      if (!alive.current) return;
      setError(message(e));
      // A 4xx can follow durable admission. Check its receipt before retiring this identity.
      try {
        const value = await developmentRequest<DiscardProgress>(`/${workspaceId}/discard/status?requestId=${encodeURIComponent(request.requestId)}`);
        if (!alive.current) return;
        setProgress(value); removed = value.state === "removed";
        if (removed) { remember(null); setError(""); await finishConversation(); }
      } catch (statusError) {
        if (e instanceof DevelopmentRequestError && e.status && e.status >= 400 && e.status < 500 && ![408, 425, 429].includes(e.status)
          && statusError instanceof DevelopmentRequestError && statusError.status === 404 && alive.current) {
          remember(null); setPlan(null);
        }
      }
    } finally {
      executing.current = false;
      if (alive.current) { setBusy(false); setRemoving(false); refresh(); }
    }
  };
  const requiresReview = progress?.state === "review-required";
  const recovering = !!(command || (!reviewingAgain && pendingRequestId) || progress);
  const removed = progress?.state === "removed";
  return <Dialog open onOpenChange={open => { if (!open && !removing) onClose(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" showCloseButton={!removing}>
    <DialogHeader><DialogTitle>{removed ? "Workspace removed" : recovering ? "Workspace removal" : "Discard and remove workspace?"}</DialogTitle>
      <DialogDescription>{removed ? "Core verified physical cleanup of this workspace and its owned temporary resources." : "Permanently remove the reviewed local worktrees, workspace branches and temporary test data, including unfinished work. This cannot be undone."}</DialogDescription></DialogHeader>
    {busy && <div role="status" className="flex items-start gap-3 rounded-lg border bg-muted/40 px-3 py-4 text-sm">
      <LoaderCircle aria-hidden className="mt-0.5 size-5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
      <div className="space-y-1">
        <p className="font-medium">{removing ? removed ? "Finishing cleanup…" : "Removing workspace…" : "Checking removal…"}</p>
        <p className="text-xs text-muted-foreground">{removing ? "This may take a while. Keep this window open while Core confirms the result." : "Loading the current workspace and removal details."}</p>
      </div>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
    {plan && !recovering && <>
      <h3 className="font-semibold">{plan.name}</h3>
      {!!plan.removedTrees?.length && <p className="text-sm">{plan.removedTrees.length} repositories were already removed by earlier confirmed cleanup. This review covers the remaining source.</p>}
      <div className="space-y-3">{plan.trees.map(tree => <section key={tree.id} className="space-y-1 rounded-lg border p-3 text-sm">
        <h4 className="font-semibold">{repositoryName(tree.repository)}</h4>
        <p className="break-all font-mono text-xs">{tree.path}</p><p className="break-all font-mono text-xs text-muted-foreground">Local branch: {tree.branch}</p>
        {tree.fingerprint ? <p>{tree.changedFiles.length} changed · {tree.untrackedFiles.length} untracked · {tree.ignoredFiles.length} ignored · {tree.unmergedCommits} unmerged {tree.unmergedCommits === 1 ? "commit" : "commits"}</p> : <p>Source inspection is unavailable. Resolve the blockers before confirming removal.</p>}
        {[{ label: "Changed files", files: tree.changedFiles }, { label: "Untracked files", files: tree.untrackedFiles }, { label: "Ignored files", files: tree.ignoredFiles }].filter(group => group.files.length).map(group => <details key={group.label}><summary>{group.label}</summary><ul className="max-h-36 overflow-y-auto pl-4 font-mono text-xs">{group.files.map(file => <li key={file} className="break-all">{file}</li>)}</ul></details>)}
      </section>)}</div>
      {plan.resources.length > 0 && <section className="space-y-2 text-sm"><h3 className="font-semibold">Temporary resources and data to remove</h3><ul className="space-y-2">{plan.resources.map(resource => <li key={`${resource.kind}:${resource.id}`} className="rounded-lg border p-2"><span>{resource.name} · {resource.kind} · {resource.state}</span>{resource.dataPath && <p className="break-all font-mono text-xs">{resource.dataPath}</p>}</li>)}</ul></section>}
      <p className="text-xs text-muted-foreground">Published pull requests, remote branches, shared Git caches and installed-application data are retained. No source archive is created.</p>
      {plan.blockers.length > 0 && <div className="space-y-2 text-sm"><h3 className="font-semibold">Resolve before removal</h3><ul className="list-disc space-y-1 pl-5">{plan.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul><p>Use Pause, confirmed external activity recovery, Return or test-resource cleanup in workspace details. Then review removal again.</p>{canPause && <Button variant="outline" size="sm" disabled={busy} onClick={() => { onClose(); onPause(); }}>Pause workspace</Button>}</div>}
      {expired && <p role="status" className="text-sm">This review expired. Refresh the review before confirming.</p>}
      {deleteConversation && <label className="flex items-center gap-2 text-sm"><Checkbox checked={withConversation} disabled={busy} onCheckedChange={value => setWithConversation(value === true)} />Also delete this conversation after physical cleanup succeeds</label>}
    </>}
    {progress && <div className="space-y-2 text-sm"><p role="status">{removed ? "Worktrees, branches, registrations and workspace records have been removed." : requiresReview ? "The remaining source changed after confirmation. It is preserved. Review the remaining removal scope and confirm again." : "Removal is pending. The original confirmed request is preserved for recovery."}</p>{progress.error && <p className="text-destructive-foreground">{progress.error}</p>}<ul className="space-y-1">{progress.trees.map(tree => <li key={tree.id}>Repository {tree.id.slice(0, 12)}: {tree.state}</li>)}{progress.resources.map(resource => <li key={`${resource.kind}:${resource.id}`}>{resource.kind} {resource.id.slice(0, 12)}: {resource.state}</li>)}</ul></div>}
    {recovering && !progress && !busy && <p className="text-sm">The outcome of the original removal request is unconfirmed. Check its status or retry that same request.</p>}
    <DialogFooter className="flex-col gap-4 sm:justify-between">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={removing} onClick={onClose}>{removed ? "Close" : recovering ? "Close for now" : "Keep workspace"}</Button>
        {!removed && recovering && <Button variant="outline" disabled={busy} onClick={() => void recover()}>Check removal status</Button>}
        {!removed && (!recovering || requiresReview) && <Button variant="outline" disabled={busy} onClick={() => void review()}>Refresh review</Button>}
      </div>
      {!removed && !requiresReview && <Button className="min-w-40 self-end sm:ml-auto" variant="destructive" aria-busy={removing} disabled={busy || disabled || (!command && (recovering || !plan || expired || !!plan.blockers.length))} onClick={() => void apply()}>{removing ? <><LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" />Removing…</> : recovering ? "Resume removal" : "Discard and remove"}</Button>}
    </DialogFooter>
  </DialogContent></Dialog>;
}
