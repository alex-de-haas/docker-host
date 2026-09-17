"use client";

import { useCallback, useEffect, useId, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronRight, FileDiff, GitBranch, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";
import { useShellActions, useShellState } from "../shell-context";
import type { CoreApp } from "../types";
import { isBinarySourceDiff, type SourceDiff, type SourceLineStats } from "./source-preview-data";
import SourceImageView from "./source-image-view";
import { defaultSourceDiffSettings, SourceDiffToolbar, type SourceDiffSettings } from "./source-diff-settings";

const SourceDiffView = dynamic(() => import("./source-diff-view"), {
  ssr: false,
  loading: () => <p role="status" className="p-3 text-sm text-muted-foreground">Loading diff viewer…</p>,
});

type SourceFile = { path: string; status: string; newFile: boolean; canDiscard: boolean; lineStats?: SourceLineStats | null; binary?: boolean };
type SourceStatus = {
  appId: string; state: string; scopePath: string | null; branch: string | null; head: string | null;
  fileCount: number; files: SourceFile[]; truncated: boolean; observedAt: string; error?: string | null; lineStats?: SourceLineStats | null;
};
type DiscardPlan = { reviewId: string; head: string; scopePath: string; files: SourceFile[]; expiresAt: string };

function useSourceStatus(app: CoreApp, enabled: boolean, includeFiles = false) {
  const { coreOrigin } = useShellActions();
  const [status, setStatus] = useState<SourceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  const url = `${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/source/${includeFiles ? "status" : "summary"}`;
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
        const next = await response.json() as Omit<SourceStatus, "files"> & { files?: SourceFile[] };
        if (active) { setStatus({ ...next, files: next.files ?? [] }); setError(next.error ?? null); }
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
                <div>Changed files: {status.fileCount}{status.truncated ? "+ (incomplete list)" : ""}</div>
                {status.lineStats
                  ? <div>Lines: +{status.lineStats.additions} / −{status.lineStats.deletions} (HEAD to working tree)</div>
                  : status.fileCount > 0 && <div>Line totals unavailable or incomplete.</div>}
              </>}
              {status.scopePath && <div className="break-all">Scope: {status.scopePath}</div>}
              <div className="opacity-80">Observed {new Date(status.observedAt).toLocaleTimeString()}</div>
            </>}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <button type="button" className="flex max-w-full flex-wrap items-center gap-x-2 text-left text-xs text-muted-foreground hover:underline" onClick={() => setOpen(true)} aria-label={`Source changes for ${app.displayName}`}>
      {!error && status && ["clean", "changes"].includes(status.state)
        ? status.truncated ? `${status.fileCount}+ files` : status.fileCount ? `${status.fileCount} file${status.fileCount === 1 ? "" : "s"}` : "No changes"
        : "Inspect source"}
      {!error && status?.fileCount && status.lineStats ? <LineCounts stats={status.lineStats} /> : null}
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

function LineCounts({ stats }: { stats: SourceLineStats }) {
  return <span className="inline-flex shrink-0 gap-2 whitespace-nowrap font-mono text-xs tabular-nums" role="img" aria-label={`${stats.additions} lines added, ${stats.deletions} lines deleted`}>
    <span aria-hidden="true" className="text-green-700 dark:text-green-400">+{stats.additions}</span>
    <span aria-hidden="true" className="text-red-700 dark:text-red-400">−{stats.deletions}</span>
  </span>;
}

function SourceFilePreview({ endpoint, path, untracked, settings }: { endpoint: string; path: string; untracked: boolean; settings: SourceDiffSettings }) {
  const { sendCsrfJson } = useShellActions();
  const [diff, setDiff] = useState<SourceDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await sendCsrfJson(`${endpoint}/diff`, { path });
        const next = await response.json() as SourceDiff;
        if (active) setDiff(next);
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : "Diff unavailable.");
      }
    };
    void load();
    return () => { active = false; };
  }, [endpoint, path, sendCsrfJson]);

  if (error) return <p role="alert" className="p-3 text-sm text-destructive">{error}</p>;
  if (!diff) return <p role="status" className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Loading changes…</p>;
  if (diff.image) return <SourceImageView path={diff.path} before={diff.image.before} after={diff.image.after} />;
  if (isBinarySourceDiff(diff, untracked)) return <p className="p-3 text-sm text-muted-foreground">Binary file — a preview is not available for this format. Open it locally to view its contents.</p>;
  if (diff.truncated) return <p role="status" className="p-3 text-sm text-muted-foreground">This diff is too large to preview here. Open the repository in your editor or Git client to view the complete changes.</p>;
  return <div className="min-w-0">
    <SourceDiffView settings={settings} path={diff.path} content={diff.combined} untracked={untracked} truncated={diff.truncated} />
    {diff.staged && <details className="border-t"><summary className="cursor-pointer px-3 py-2 text-sm">Staged changes</summary><SourceDiffView settings={settings} path={diff.path} content={diff.staged} truncated={diff.truncated} /></details>}
  </div>;
}

function SourceFileSection({ file, endpoint, selected, selectionDisabled, busy, onSelect, settings }: {
  file: SourceFile;
  settings: SourceDiffSettings;
  endpoint: string;
  selected: boolean;
  selectionDisabled: boolean;
  busy: boolean;
  onSelect: (selected: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const previewId = useId();
  return <div className="min-w-0 overflow-hidden rounded-md border">
    <div className="flex items-center gap-2 bg-muted/40 px-3">
      <input type="checkbox" aria-label={`Select ${file.path}`} checked={selected} disabled={selectionDisabled} onChange={(event) => onSelect(event.target.checked)} />
      <button type="button" className="group flex min-w-0 flex-1 items-center gap-2 py-3 text-left text-sm hover:underline" aria-expanded={expanded} aria-controls={previewId} disabled={busy} onClick={() => setExpanded((value) => !value)}>
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-90" />
        <code className="shrink-0 whitespace-pre text-xs text-muted-foreground">{file.status}</code>
        <span className="min-w-0 break-all font-mono text-xs">{file.path}</span>
      </button>
      {file.lineStats && <LineCounts stats={file.lineStats} />}
    </div>
    <div id={previewId} hidden={!expanded} className="border-t">
      {expanded && <SourceFilePreview settings={settings} key={file.status} endpoint={endpoint} path={file.path} untracked={file.status === "??"} />}
    </div>
  </div>;
}

function SourceChangesDialog({ app, onClose }: { app: CoreApp; onClose: () => void }) {
  const { coreOrigin, sendCsrfJson } = useShellActions();
  const { status, error: statusError, refresh } = useSourceStatus(app, true, true);
  const [diffSettings, setDiffSettings] = useState(defaultSourceDiffSettings);
  const [selected, setSelected] = useState<string[]>([]);
  const [plan, setPlan] = useState<DiscardPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const selectablePaths = status?.files.filter((file) => file.canDiscard).map((file) => file.path) ?? [];
  const selectedPaths = selectablePaths.filter((path) => selected.includes(path));
  const selectedCount = selectedPaths.length;
  const allSelected = selectablePaths.length > 0 && selectedCount === selectablePaths.length;
  const partlySelected = selectedCount > 0 && !allSelected;
  const endpoint = `${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/source`;
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
      setSelected([]);
      setMessage("Selected changes discarded. Reload the app, or restart it if its development commands require it.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Discard failed. Refresh to inspect the result."); }
    finally { setPlan(null); setBusy(false); refresh(); }
  };
  return <Dialog open onOpenChange={(value) => { if (!value && !busy) onClose(); }}>
    <DialogContent className="h-dvh max-h-dvh max-w-full rounded-none border-0 sm:h-[calc(100dvh-2rem)] sm:max-w-[calc(100%-2rem)] sm:rounded-lg sm:border">
      <DialogHeader className="pr-6"><DialogTitle>Source changes · {app.displayName}</DialogTitle>
        <DialogDescription>Changes on disk; the running process may need a reload or restart. Manifest version {app.version}.</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0"><p className="font-mono text-sm">{sourceLabel(status, statusError)}</p>
            {status?.scopePath && <p className="break-all text-xs text-muted-foreground">Scope: {status.scopePath}</p>}
            {status && ["clean", "changes"].includes(status.state) && <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span>{status.fileCount}{status.truncated ? "+" : ""} {status.fileCount === 1 ? "file" : "files"}</span>
              {status.lineStats && <LineCounts stats={status.lineStats} />}
            </p>}
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
          {!!status?.files.length && <SourceDiffToolbar settings={diffSettings} onChange={setDiffSettings} />}
          <div className="space-y-3">
            {!!status?.files.length && <div className="space-y-1 px-3 py-1">
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
            {status?.files.map((file) => <SourceFileSection settings={diffSettings} key={`${status.scopePath}:${status.head}:${file.path}`} file={file} endpoint={endpoint}
              selected={selectedPaths.includes(file.path)} busy={busy}
              selectionDisabled={busy || !file.canDiscard || status.truncated || (selectedCount >= 32 && !selected.includes(file.path))}
              onSelect={(checked) => setSelected((current) => checked ? [...current, file.path] : current.filter((path) => path !== file.path))} />)}
            {status?.state === "clean" && <p className="p-3 text-sm text-muted-foreground">No changes in this source scope.</p>}
          </div>
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
