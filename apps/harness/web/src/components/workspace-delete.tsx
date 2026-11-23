"use client";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { developmentRequest, repositoryName } from "@/lib/development-api";
import { clearDeleteCommand, storedCommand, type DeleteCommand, type DeleteProgress } from "@/lib/workspace-deletion";

export type { DeleteProgress } from "@/lib/workspace-deletion";
export type DeleteDetails = {
  name: string;
  trees: { id: string; repository: string; path: string; branch: string; head: string | null; fingerprint: string;
    changedFiles: string[]; untrackedFiles: string[]; ignoredFiles: string[]; unmergedCommits: number }[];
  resources: { id: string; kind: string; state: string; name: string; dataPath?: string }[];
  warnings?: string[];
  blockers?: string[];
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function WorkspaceDelete({ workspaceId, name, pendingRequestId, onClose, refresh, sessionIds, onSubmit, onCloseAutoFocus }: {
  workspaceId: string; name: string; pendingRequestId?: string; onClose: () => void; refresh: () => void;
  sessionIds?: readonly string[];
  onSubmit: (command: DeleteCommand) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [command, setCommand] = useState<DeleteCommand | null>(() => {
    const stored = storedCommand(workspaceId);
    return pendingRequestId && stored?.requestId !== pendingRequestId ? { requestId: pendingRequestId } : stored;
  });
  const [details, setDetails] = useState<DeleteDetails | null>(null);
  const [progress, setProgress] = useState<DeleteProgress | null>(null);
  const [withSessions, setWithSessions] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const submitted = useRef(false);
  const initial = useRef(command);
  const retireCompleted = useEffectEvent((requestId: string) => {
    if (storedCommand(workspaceId)?.requestId === requestId) clearDeleteCommand(workspaceId);
    setCommand(null);
    refresh();
  });
  useEffect(() => {
    const abort = new AbortController();
    const ignore = () => abort.signal.aborted || submitted.current;
    const load = async () => {
      try {
        const previous = initial.current;
        if (previous) {
          const value = await developmentRequest<DeleteProgress>(`/${workspaceId}/delete/status?requestId=${encodeURIComponent(previous.requestId)}`, undefined, abort.signal);
          if (ignore()) return;
          setProgress(value);
          if (value.state === "removed" && !previous.sessionIds?.length) {
            retireCompleted(previous.requestId);
            // A completed receipt can outlive its source allocation. Inspect the current
            // workspace before offering a new request for a replacement with the same ID.
            try {
              const current = await developmentRequest<DeleteDetails>(`/${workspaceId}/delete/details`, undefined, abort.signal);
              if (!ignore()) { setDetails(current); setProgress(null); }
            } catch { /* The completed receipt remains visible when no current workspace can be inspected. */ }
          }
        } else {
          const value = await developmentRequest<DeleteDetails>(`/${workspaceId}/delete/details`, undefined, abort.signal);
          if (!ignore()) setDetails(value);
        }
      } catch (e) { if (!ignore()) setError(message(e)); }
      finally { if (!ignore()) setLoading(false); }
    };
    void load();
    return () => abort.abort();
  }, [workspaceId]);
  const removed = progress?.state === "removed";
  const sessionsPending = !!command?.sessionIds?.length;
  const submit = () => {
    if (submitted.current || (removed && !sessionsPending)) return;
    const request = command ?? { requestId: crypto.randomUUID() };
    submitted.current = true;
    onSubmit(!command && withSessions ? { ...request, captureSessions: true } : request);
    onClose();
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="sm:max-w-2xl" onCloseAutoFocus={onCloseAutoFocus}>
      <DialogHeader><DialogTitle>{removed ? "Workspace deleted" : command ? "Workspace deletion" : "Delete workspace?"}</DialogTitle>
        <DialogDescription>{removed ? "The workspace source, local branches and temporary test data have been removed." : "Permanently delete this workspace, including unfinished source, local branches and temporary test data. This cannot be undone."}</DialogDescription></DialogHeader>
      <DialogBody>
        <h3 className="font-semibold">{details?.name ?? name}</h3>
        {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />Loading deletion details…</p>}
        {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
        {!details && !progress && <p className="text-sm">Source and activity details are {loading ? "still loading" : "unavailable"}. Deletion includes any uncommitted files and unmerged commits. An agent may still be using this directory.</p>}
        {details && !progress && <>
          {!!details.blockers?.length && <Alert variant="destructive" aria-label="Workspace is in use">
            <AlertTitle>Workspace is in use</AlertTitle>
            <AlertDescription>
              <p>Switch Core and applications away from this workspace, or use Return, before deleting it.</p>
              <ul className="list-disc pl-5">{details.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>
            </AlertDescription>
          </Alert>}
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
        {sessionsPending && <p className="text-sm">This request includes deletion of your selected sessions after workspace removal.</p>}
        {!command && !removed && (withSessions || !!sessionIds?.length) && <label className="flex items-center gap-2 text-sm"><Checkbox checked={withSessions} onCheckedChange={value => setWithSessions(value === true)} />Also delete all my attached sessions</label>}
      </DialogBody>
      <DialogFooter className="sm:justify-between">
        <Button variant="outline" onClick={onClose}>{removed ? "Close" : command ? "Close for now" : "Cancel"}</Button>
        {(!removed || sessionsPending) && <Button variant="destructive" onClick={submit}>{removed ? "Retry session deletion" : command ? "Retry deletion" : "Delete"}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
