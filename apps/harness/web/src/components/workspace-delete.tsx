"use client";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { developmentRequest, repositoryName } from "@/lib/development-api";

export type DeleteCommand = { requestId: string };
export type DeleteDetails = {
  name: string;
  trees: { id: string; repository: string; path: string; branch: string; head: string | null; fingerprint: string;
    changedFiles: string[]; untrackedFiles: string[]; ignoredFiles: string[]; unmergedCommits: number }[];
  resources: { id: string; kind: string; state: string; name: string; dataPath?: string }[];
  warnings?: string[];
};
export type DeleteProgress = { workspaceId: string; requestId: string; state: "pending" | "removed" | "review-required"; error?: string;
  trees: { id: string; state: string }[]; resources: { id: string; kind: string; state: string }[];
  activity?: { kind: string; reference: string; state: string; detail?: string }[] };
function storedCommand(workspaceId: string): DeleteCommand | null {
  for (const prefix of ["hosty.workspace.delete.", "hosty.workspace.discard."]) {
    try {
      const value = JSON.parse(localStorage.getItem(prefix + workspaceId) ?? "null");
      if (typeof value?.requestId === "string" && /^[a-f0-9-]{36}$/i.test(value.requestId)) return { requestId: value.requestId };
    } catch { /* Core retains the accepted operation if local storage is unavailable. */ }
  }
  return null;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function WorkspaceDelete({ workspaceId, name, pendingRequestId, onClose, refresh, deleteConversation }: {
  workspaceId: string; name: string; pendingRequestId?: string; onClose: () => void; refresh: () => void;
  deleteConversation?: () => Promise<void>;
}) {
  const [command, setCommand] = useState<DeleteCommand | null>(() => pendingRequestId ? { requestId: pendingRequestId } : storedCommand(workspaceId));
  const [details, setDetails] = useState<DeleteDetails | null>(null);
  const [progress, setProgress] = useState<DeleteProgress | null>(null);
  const [withConversation, setWithConversation] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState(false);
  const executing = useRef(false);
  const applied = useRef(false);
  const alive = useRef(true);
  const initial = useRef(command);
  const remember = (value: DeleteCommand | null) => {
    setCommand(value);
    try {
      if (value) localStorage.setItem(`hosty.workspace.delete.${workspaceId}`, JSON.stringify(value));
      else for (const prefix of ["hosty.workspace.delete.", "hosty.workspace.discard."]) localStorage.removeItem(prefix + workspaceId);
    } catch { /* The same request is also retained in memory and in Core after admission. */ }
  };
  const retireCompleted = useEffectEvent(() => { remember(null); refresh(); });
  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    const load = async () => {
      try {
        if (initial.current) {
          const value = await developmentRequest<DeleteProgress>(`/${workspaceId}/delete/status?requestId=${encodeURIComponent(initial.current.requestId)}`, undefined, abort.signal);
          if (abort.signal.aborted || applied.current) return;
          setProgress(value);
          if (value.state === "removed") {
            retireCompleted();
            // A completed receipt can outlive its source allocation. Inspect the current
            // workspace before offering a new request for a replacement with the same ID.
            try {
              const current = await developmentRequest<DeleteDetails>(`/${workspaceId}/delete/details`, undefined, abort.signal);
              if (!abort.signal.aborted && !applied.current) { setDetails(current); setProgress(null); }
            } catch { /* The completed receipt remains visible when no current workspace can be inspected. */ }
          }
        } else {
          const value = await developmentRequest<DeleteDetails>(`/${workspaceId}/delete/details`, undefined, abort.signal);
          if (!abort.signal.aborted && !applied.current) setDetails(value);
        }
      } catch (e) { if (!abort.signal.aborted && !applied.current) setError(message(e)); }
      finally { if (!abort.signal.aborted) setLoading(false); }
    };
    void load();
    return () => { alive.current = false; abort.abort(); };
  }, [workspaceId]);
  const apply = async () => {
    if (executing.current || progress?.state === "removed") return;
    const request = command ?? { requestId: crypto.randomUUID() };
    applied.current = true; executing.current = true; setRemoving(true); setError(""); remember(request);
    try {
      const value = await developmentRequest<DeleteProgress>(`/${workspaceId}/delete`, request);
      if (!alive.current) return;
      setProgress(value);
      if (value.state === "removed") {
        remember(null);
        if (withConversation && deleteConversation) {
          try { await deleteConversation(); }
          catch (e) { if (alive.current) setError(`Workspace deleted. Conversation retained: ${message(e)}`); }
        }
      } else remember({ requestId: value.requestId });
    } catch (e) { if (alive.current) setError(`${message(e)} Retry uses the same deletion request.`); }
    finally { executing.current = false; if (alive.current) { setRemoving(false); refresh(); } }
  };
  const removed = progress?.state === "removed";
  return <Dialog open onOpenChange={open => { if (!open && !removing) onClose(); }}>
    <DialogContent className="sm:max-w-2xl" showCloseButton={!removing}>
      <DialogHeader><DialogTitle>{removed ? "Workspace deleted" : command ? "Workspace deletion" : "Delete workspace?"}</DialogTitle>
        <DialogDescription>{removed ? "The workspace source, local branches and temporary test data have been removed." : "Permanently delete this workspace, including unfinished source, local branches and temporary test data. This cannot be undone."}</DialogDescription></DialogHeader>
      <DialogBody>
        <h3 className="font-semibold">{details?.name ?? name}</h3>
        {loading && !removing && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />Loading deletion details…</p>}
        {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
        {!details && !progress && <p className="text-sm">Source and activity details are {loading ? "still loading" : "unavailable"}. Deletion includes any uncommitted files and unmerged commits. An agent may still be using this directory.</p>}
        {details && !progress && <>
          <div className="space-y-3">{details.trees.map(tree => <section key={tree.id} className="space-y-1 rounded-lg border p-3 text-sm">
            <h4 className="font-semibold">{repositoryName(tree.repository)}</h4>
            <p className="break-all font-mono text-xs">{tree.path}</p><p className="break-all font-mono text-xs text-muted-foreground">Local branch: {tree.branch}</p>
            {tree.fingerprint ? <p>{tree.changedFiles.length} changed · {tree.untrackedFiles.length} untracked · {tree.ignoredFiles.length} ignored · {tree.unmergedCommits} unmerged {tree.unmergedCommits === 1 ? "commit" : "commits"}</p> : <p>Source details are unknown. Any remaining local files will be deleted.</p>}
            {[{ label: "Changed files", files: tree.changedFiles }, { label: "Untracked files", files: tree.untrackedFiles }, { label: "Ignored files", files: tree.ignoredFiles }].filter(group => group.files.length).map(group => <details key={group.label}><summary>{group.label}</summary><ul className="max-h-36 overflow-y-auto pl-4 font-mono text-xs">{group.files.map(file => <li key={file} className="break-all">{file}</li>)}</ul></details>)}
          </section>)}</div>
          {details.resources.length > 0 && <section className="space-y-2 text-sm"><h3 className="font-semibold">Temporary resources and data</h3><ul>{details.resources.map(resource => <li key={`${resource.kind}:${resource.id}`} className="rounded-lg border p-2">{resource.name} · {resource.state}{resource.dataPath && <p className="break-all font-mono text-xs">{resource.dataPath}</p>}</li>)}</ul></section>}
          {!!details.warnings?.length && <section className="space-y-2 text-sm"><h3 className="font-semibold">Activity and unknown details</h3><ul className="list-disc space-y-1 pl-5">{details.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></section>}
        </>}
        {!removed && <p className="text-xs text-muted-foreground">Published pull requests, remote branches and ordinary application data are retained. Activity leases are retired; this does not prove that an external agent stopped.</p>}
        {progress && <div className="space-y-2 text-sm"><p role="status">{removed ? "Workspace deletion completed." : "Deletion is pending. Retry continues the accepted request."}</p>
          {progress.error && <p role="alert" className="text-destructive-foreground">{progress.error}</p>}
          <ul>{progress.trees.map(tree => <li key={tree.id}>Repository {tree.id.slice(0, 12)}: {tree.state}</li>)}{progress.resources.map(resource => <li key={`${resource.kind}:${resource.id}`}>{resource.kind} {resource.id.slice(0, 12)}: {resource.state}</li>)}</ul>
          {progress.activity?.map((item, index) => <p key={index}>{item.kind} {item.reference}: {item.state}. {item.detail}</p>)}
        </div>}
        {!command && !removed && deleteConversation && <label className="flex items-center gap-2 text-sm"><Checkbox checked={withConversation} disabled={removing} onCheckedChange={value => setWithConversation(value === true)} />Also delete this conversation after workspace deletion</label>}
      </DialogBody>
      <DialogFooter className="sm:justify-between">
        <Button variant="outline" disabled={removing} onClick={onClose}>{removed ? "Close" : command ? "Close for now" : "Cancel"}</Button>
        {!removed && <Button variant="destructive" disabled={removing} aria-busy={removing} onClick={() => void apply()}>{removing ? <><LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" />Deleting…</> : command ? "Retry deletion" : "Delete"}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
