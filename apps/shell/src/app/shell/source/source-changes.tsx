"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileDiff, GitBranch, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";
import { useShellActions, useShellState } from "../shell-context";
import type { CoreApp } from "../types";

type SourceFile = { path: string; status: string; newFile: boolean; canDiscard: boolean };
type SourceStatus = {
  appId: string; state: string; scopePath: string | null; branch: string | null; head: string | null;
  files: SourceFile[]; truncated: boolean; observedAt: string; error?: string | null;
};
type SourceDiff = { path: string; combined: string; staged: string; truncated: boolean; head: string | null; newFile: boolean };
type DiscardPlan = { reviewId: string; head: string; scopePath: string; files: SourceFile[]; expiresAt: string };

function useSourceStatus(app: CoreApp, enabled: boolean) {
  const { coreOrigin } = useShellActions();
  const [status, setStatus] = useState<SourceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  const url = `${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/source/status`;
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let controller: AbortController | null = null;
    const load = async () => {
      if (controller || document.visibilityState === "hidden") return;
      controller = new AbortController();
      try {
        const response = await fetch(url, { credentials: "include", cache: "no-store", signal: controller.signal });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) throw new Error(await readCoreError(response));
        const next = await response.json() as SourceStatus;
        if (active) { setStatus(next); setError(next.error ?? null); }
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : "Source status unavailable.");
      } finally { controller = null; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; controller?.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [url, coreOrigin, enabled, nonce, app.sourceOverridePath, app.sourceManagedPath]);
  return { status, error, refresh };
}

function sourceLabel(status: SourceStatus | null, error: string | null, includeCommit = true) {
  if (error || status?.state === "unavailable") return "Source status unavailable";
  if (!status) return "Reading source…";
  if (status.state === "no-git") return "Local source · no Git";
  if (status.state === "none") return "No source";
  if (status.state === "missing") return "Source missing";
  const branch = status.branch ?? "Detached HEAD";
  return includeCommit ? `${branch} · ${status.head?.slice(0, 8) ?? "no commits"}` : branch;
}

export function SourceVersionCell({ app }: { app: CoreApp }) {
  const { canManageApps } = useShellState();
  const [open, setOpen] = useState(false);
  const { status, error, refresh } = useSourceStatus(app, canManageApps && !open);
  if (!canManageApps) return <span className="font-mono text-sm" title="Manifest version">{app.version}</span>;
  return <>
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="flex min-w-0 cursor-help items-center gap-1 font-mono text-sm">
            <GitBranch className="size-3.5 shrink-0" />
            <span className="truncate underline decoration-dotted decoration-muted-foreground/70 underline-offset-4">{sourceLabel(status, error, false)}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          <div className="space-y-1">
            <div className="font-medium">{app.displayName} · source</div>
            <div className="break-all">{sourceLabel(status, error, false)}</div>
            {error && <div>{error}</div>}
            {!error && status && <>
              {status.head && <div>Commit: <span className="break-all font-mono">{status.head}</span></div>}
              {["clean", "changes"].includes(status.state) && <>
                {!status.head && <div>No commits yet</div>}
                <div>Changed files: {status.files.length}{status.truncated ? "+ (incomplete list)" : ""}</div>
              </>}
              {status.scopePath && <div className="break-all">Scope: {status.scopePath}</div>}
              <div className="opacity-80">Observed {new Date(status.observedAt).toLocaleTimeString()}</div>
            </>}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <button type="button" className="block max-w-full text-left text-xs text-muted-foreground hover:underline" onClick={() => setOpen(true)} aria-label={`Source changes for ${app.displayName}`}>
      {!error && status && ["clean", "changes"].includes(status.state)
        ? status.truncated ? `${status.files.length}+ changes` : status.files.length ? `${status.files.length} change${status.files.length === 1 ? "" : "s"}` : "No changes"
        : "Inspect source"}
    </button>
    {open && <SourceChangesDialog app={app} onClose={() => { setOpen(false); refresh(); }} />}
  </>;
}

export function SourceChangesButton({ app }: { app: CoreApp }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button type="button" variant="outline" onClick={() => setOpen(true)}><FileDiff className="size-4" />Inspect source changes</Button>
    {open && <SourceChangesDialog app={app} onClose={() => setOpen(false)} />}
  </>;
}

function SourceChangesDialog({ app, onClose }: { app: CoreApp; onClose: () => void }) {
  const { coreOrigin, sendCsrfJson } = useShellActions();
  const { status, error: statusError, refresh } = useSourceStatus(app, true);
  const [selected, setSelected] = useState<string[]>([]);
  const [diff, setDiff] = useState<SourceDiff | null>(null);
  const [plan, setPlan] = useState<DiscardPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const diffSequence = useRef(0);
  const selectablePaths = status?.files.filter((file) => file.canDiscard).map((file) => file.path) ?? [];
  const selectedPaths = selectablePaths.filter((path) => selected.includes(path));
  const selectedCount = selectedPaths.length;
  const allSelected = selectablePaths.length > 0 && selectedCount === selectablePaths.length;
  const partlySelected = selectedCount > 0 && !allSelected;
  const endpoint = `${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/source`;
  const showDiff = async (path: string) => {
    const sequence = ++diffSequence.current;
    setError(null); setDiff(null);
    try {
      const response = await sendCsrfJson(`${endpoint}/diff`, { path });
      const next = await response.json() as SourceDiff;
      if (sequence === diffSequence.current) setDiff(next);
    } catch (failure) { if (sequence === diffSequence.current) setError(failure instanceof Error ? failure.message : "Diff unavailable."); }
  };
  const review = async () => {
    if (!selectedCount || selectedCount > 32 || statusError || status?.truncated || !status?.head) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await sendCsrfJson(`${endpoint}/discard/plan`, { paths: selectedPaths });
      setPlan(await response.json() as DiscardPlan);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Review failed."); refresh(); }
    finally { setBusy(false); }
  };
  const discard = async () => {
    if (!plan) return;
    setBusy(true); setError(null);
    try {
      await sendCsrfJson(`${endpoint}/discard`, { reviewId: plan.reviewId });
      setSelected([]); setDiff(null); ++diffSequence.current;
      setMessage("Selected changes discarded. Reload the app, or restart it if its development commands require it.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Discard failed. Refresh to inspect the result."); }
    finally { setPlan(null); setBusy(false); refresh(); }
  };
  return <Dialog open onOpenChange={(value) => { if (!value && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-3xl">
      <DialogHeader><DialogTitle>Source changes · {app.displayName}</DialogTitle>
        <DialogDescription>Changes on disk; the running process may need a reload or restart. Manifest version {app.version}.</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0"><p className="font-mono text-sm">{sourceLabel(status, statusError)}</p>
            {status?.scopePath && <p className="break-all text-xs text-muted-foreground">Scope: {status.scopePath}</p>}
            {status && <p className="text-xs text-muted-foreground">Observed {new Date(status.observedAt).toLocaleTimeString()}</p>}
          </div>
          <Button type="button" variant="ghost" size="icon" aria-label="Refresh source status" disabled={busy} onClick={refresh}><RefreshCw className="size-4" /></Button>
        </div>
        {(error || statusError) && <p role="alert" className="text-sm text-destructive">{error || statusError}</p>}
        {message && <p role="status" className="text-sm">{message}</p>}
        {status?.state === "no-git" && <p className="text-sm">This folder has no Git history. Hosty cannot restore earlier file contents.</p>}
        {status && ["clean", "changes"].includes(status.state) && !status.head && <p className="text-sm">No HEAD commit yet. Files can be inspected, but discard requires an existing commit.</p>}
        {status?.truncated && <p className="text-sm">This list is incomplete. Discard is unavailable; use Git directly to inspect this larger change.</p>}
        {plan ? <div className="space-y-3 rounded-md border border-destructive/40 p-4">
          <p className="font-medium">Discard these changes against {plan.head.slice(0, 12)}?</p>
          <p className="text-sm">Tracked files and their staging state will be restored to this commit. New files listed below will be deleted. Other changes are preserved. Hosty keeps no copy of discarded content.</p>
          <ul className="max-h-56 overflow-auto text-sm">{plan.files.map((file) => <li key={file.path} className="break-all py-1"><strong>{file.newFile ? "Delete" : "Restore"}</strong> · {file.path}</li>)}</ul>
          <p className="text-xs text-muted-foreground">The review expires at {new Date(plan.expiresAt).toLocaleTimeString()}. Changed files require a new review.</p>
        </div> : <>
          <div className="rounded-md border">
            {!!status?.files.length && <div className="space-y-1 border-b px-3 py-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={allSelected} aria-checked={partlySelected ? "mixed" : allSelected}
                  ref={(input) => { if (input) input.indeterminate = partlySelected; }}
                  disabled={busy || !!statusError || status.truncated || selectablePaths.length === 0 || selectablePaths.length > 32}
                  onChange={(event) => setSelected(event.target.checked ? selectablePaths : [])} />
                Select all
              </label>
              {selectablePaths.length > 32 && <p className="text-xs text-muted-foreground">Select up to 32 files per review.</p>}
              {selectablePaths.length < status.files.length && <p className="text-xs text-muted-foreground">Only files available for discard can be selected.</p>}
            </div>}
            <div className="max-h-56 overflow-auto">
            {status?.files.map((file) => <div key={file.path} className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
              <input type="checkbox" aria-label={`Select ${file.path}`} checked={selectedPaths.includes(file.path)} disabled={busy || !file.canDiscard || status.truncated || (selectedCount >= 32 && !selected.includes(file.path))}
                onChange={(event) => setSelected((current) => event.target.checked ? [...current, file.path] : current.filter((path) => path !== file.path))} />
              <code className="whitespace-pre text-xs text-muted-foreground">{file.status}</code>
              <button type="button" className="min-w-0 break-all text-left text-sm hover:underline" disabled={busy} onClick={() => void showDiff(file.path)}>{file.path}</button>
            </div>)}
            {status?.state === "clean" && <p className="p-3 text-sm text-muted-foreground">No changes in this source scope.</p>}
            </div>
          </div>
          {diff && <div className="space-y-2"><p className="break-all text-sm font-medium">{diff.path} · {diff.head ? `against ${diff.head.slice(0, 8)}` : "no HEAD baseline"}</p>
            {diff.truncated && <p className="text-sm">Preview truncated. Use Git to inspect the complete file.</p>}
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">{diff.combined || "No working-tree difference."}</pre>
            {diff.staged && <details><summary className="cursor-pointer text-sm">Staged changes</summary><pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">{diff.staged}</pre></details>}
          </div>}
        </>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={() => plan ? setPlan(null) : onClose()}>{plan ? "Back" : "Close"}</Button>
        <Button type="button" variant={plan ? "destructive" : "default"} disabled={busy || (!plan && (selectedCount === 0 || !!statusError || status?.truncated || !status?.head))} onClick={() => void (plan ? discard() : review())}>
          {busy && <LoaderCircle className="size-4 animate-spin" />}{plan ? "Discard selected changes" : `Review discard (${selectedCount})`}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
