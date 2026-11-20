"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRightLeft, ChevronDown, CircleAlert, GitBranch, Hammer, LoaderCircle, TriangleAlert } from "lucide-react";
import { ContextAppIcon } from "@/components/context-app-icon";
import type { ContextApp } from "@/lib/assistant-api";
import { HostyLoader } from "../../../../../shared/web/hosty-states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { type WorkspaceApplication, useWorkspaceApplications, workspaceApplicationIsCurrent, workspaceApplicationStatus, workspaceApplicationTarget } from "@/lib/workspace-applications";
import { developmentRequest } from "@/lib/development-api";
import { useWorkspaceExecution } from "@/lib/workspace-execution";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type SwitchKind = "package" | "workspace";
type SwitchTarget = { appId: string; name: string; worktreeId?: string | null; runtime?: string | null };
type SwitchReview = { kind: SwitchKind; application?: WorkspaceApplication; targets: SwitchTarget[] };

function errorSummary(error: string, apps: { appId: string; name: string }[]) {
  const firstLine = error.trim().split(/\r?\n/, 1)[0];
  const app = apps.find(item => firstLine.startsWith(item.appId + ": "));
  const message = app ? app.name + firstLine.slice(app.appId.length) : firstLine;
  return message.length > 200 ? message.slice(0, 199) + "…" : message;
}

function knownTarget(app?: WorkspaceApplication) {
  const current = app?.current;
  return current?.kind === "package" || current?.kind === "legacy" ||
    (current?.kind === "workspace" && !!current.workspaceId && !!current.worktreeId);
}

function canSelectApplication(app?: WorkspaceApplication) {
  return !!app && knownTarget(app) && app.canSwitch && !!app.target?.worktreeId &&
    !workspaceApplicationIsCurrent(app) && !workspaceApplicationStatus(app).busy && app.operationStatus !== "updating";
}

function WorkspaceAppLogs({ workspaceId, appId, name }: { workspaceId: string; appId: string; name: string }) {
  const [opened, setOpened] = useState(false);
  const [content, setContent] = useState<{ text: string; failed?: boolean } | null>(null);
  useEffect(() => {
    if (!opened) return;
    const request = new AbortController();
    void developmentRequest<{ text: string }>(`/${workspaceId}/applications/${encodeURIComponent(appId)}/logs`, undefined, request.signal)
      .then(result => {
        if (!request.signal.aborted) setContent({ text: result.text || "No application logs available." });
      }).catch(cause => {
        if (!request.signal.aborted) setContent({ text: cause instanceof Error ? cause.message : "Application logs unavailable.", failed: true });
      });
    return () => request.abort();
  }, [appId, opened, workspaceId]);
  return <Dialog open={opened} onOpenChange={setOpened}>
    <DialogTrigger asChild><Button type="button" size="sm" variant="outline" aria-label={`Show logs for ${name}`}
      onClick={() => setContent(null)}>Logs</Button></DialogTrigger>
    <DialogContent><DialogHeader><DialogTitle>{name} logs</DialogTitle>
      <DialogDescription>Recent output from the application on this Core.</DialogDescription></DialogHeader>
      <DialogBody>{!content || content.failed
        ? <p role={content?.failed ? "alert" : "status"}>{content?.text ?? "Loading logs…"}</p>
        : <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-all text-xs">{content.text}</pre>}</DialogBody>
    </DialogContent>
  </Dialog>;
}

export function WorkspaceActivation({ workspaceId, workspaceName, apps, disabled, canUse = true, refresh, appMetadata = [] }: {
  workspaceId: string; workspaceName: string; apps: { appId: string; name: string }[]; disabled?: boolean; canUse?: boolean; refresh: () => void; appMetadata?: readonly ContextApp[];
}) {
  const inventory = useWorkspaceApplications(workspaceId, apps.length > 0);
  const execution = useWorkspaceExecution(workspaceId, { disabled, canUse, refresh: () => { inventory.refresh(); refresh(); } });
  const [review, setReview] = useState<SwitchReview | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const otherActions = useRef<HTMLButtonElement>(null);
  if (!apps.length) return null;
  const { busy, phase, pending } = execution;
  const rows = apps.map(app => inventory.applications.find(item => item.appId === app.appId));
  const observed = !inventory.loading && !inventory.error;
  const known = observed && rows.every(knownTarget);
  const hasCurrent = rows.some(app => app?.current?.kind === "workspace" && app.current.workspaceId === workspaceId);
  const allCurrent = known && rows.every(app => app && workspaceApplicationIsCurrent(app));
  const kind = allCurrent ? "package" : "workspace";
  const retry = phase === "failed" && !!pending;
  const allowed = !disabled && (retry ? pending.kind === "package" || canUse : kind === "package" || canUse && rows.every(app => app?.canSwitch));
  const label = retry ? "Try again" : kind === "package" ? "Return to packages" : "Use workspace";
  function targetsFor(kind: SwitchKind, application?: WorkspaceApplication): SwitchTarget[] {
    return apps.flatMap((app, index) => {
      if (application && app.appId !== application.appId) return [];
      const row = rows[index];
      // A group Return affects bound installations still using this workspace. Include any
      // unobserved row as a possible participant in the operator's review.
      if (kind === "package" && knownTarget(row) && row?.current?.workspaceId !== workspaceId) return [];
      const target = kind === "package" ? row?.current : row?.target;
      return [{ appId: app.appId, name: app.name, worktreeId: target?.worktreeId, runtime: target?.runtime }];
    });
  }
  function reviewSwitch(kind: SwitchKind, trigger: HTMLElement | null, application?: WorkspaceApplication) {
    opener.current = trigger;
    setReview({ kind, application, targets: targetsFor(kind, application) });
  }
  const reviewedApp = review?.application;
  const latestApp = reviewedApp && rows.find(app => app?.appId === reviewedApp.appId);
  const groupCanUseWorkspace = known && !allCurrent && rows.every(app => app?.canSwitch);
  const available = review?.kind === "package" ? hasCurrent
    : canUse && (reviewedApp ? canSelectApplication(latestApp) : groupCanUseWorkspace);
  const canConfirm = !!review && !disabled && !busy && observed && available &&
    JSON.stringify(review.targets) === JSON.stringify(targetsFor(review.kind, reviewedApp));
  // Once the observed rows describe every failed launch, they supersede the selection receipt,
  // including when an operator repairs and starts the app from Dashboard.
  const launchOutcomesVisible = observed && execution.failedStarts.length > 0 && execution.failedStarts.every(id => {
    const app = rows.find(row => row?.appId === id);
    return app?.current?.workspaceId === workspaceId && (app.startError || app.runtimeState === "running");
  });
  const failureSummary = errorSummary(execution.error, apps);
  const progress = phase === "approval" ? "Waiting for access confirmation…" : phase === "checking" ? "Checking the switch…"
    : pending?.appId ? `Switching ${apps.find(app => app.appId === pending.appId)?.name || pending.appId}…` : "Switching applications…";
  return <section aria-label="Workspace applications" className="flex min-w-0 flex-col gap-3">
    <ul aria-label="Bound applications" className="flex min-w-0 flex-col gap-2">{apps.map(app => {
      const live = inventory.applications.find(item => item.appId === app.appId);
      const status = live ? workspaceApplicationStatus(live) : { label: inventory.loading ? "Loading…" : "Unknown", tone: "muted", busy: false };
      const current = !!live && workspaceApplicationIsCurrent(live);
      const Glyph = status.tone === "destructive" ? CircleAlert : status.tone === "warning" ? TriangleAlert : status.busy ? LoaderCircle : null;
      const reason = !live ? inventory.loading ? "Reading application status…" : "Execution target unavailable."
        : live.unavailable || live.target?.unavailable || (!live.canSwitch ? "Application lifecycle access is required." : undefined);
      const target = live ? workspaceApplicationTarget(live) : { kind: "unknown", label: inventory.loading ? "Reading execution target…" : "Execution target unavailable" };
      const TargetGlyph = target.kind === "workspace" ? Hammer : target.kind === "source" ? GitBranch : null;
      const label = target.label;
      return <li key={app.appId} className="flex min-w-0 items-center gap-2 text-xs" aria-label={app.name}>
        <ContextAppIcon app={appMetadata.find(metadata => metadata.id === app.appId)} className="size-10" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2"><span className="min-w-0 truncate font-medium" title={`${app.name} · ${app.appId}`}>{app.name}</span>
            <span className={cn("inline-flex shrink-0 items-center gap-1", status.tone === "success" ? "text-success-foreground" : status.tone === "destructive" ? "text-destructive-foreground" : status.tone === "warning" ? "text-warning-foreground" : status.tone === "info" ? "text-info-foreground" : "text-muted-foreground")}>
              {Glyph ? <Glyph aria-hidden className={cn("size-3 shrink-0", status.busy && "animate-spin motion-reduce:animate-none")} /> : <span aria-hidden className="size-1.5 rounded-full bg-current" />}<span>{status.label}</span>
            </span>
          </div>
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground" title={live?.source?.path && live.current?.kind !== "workspace" && live.current?.kind !== "package" ? `${label}\n${live.source.path}` : label}>
            {TargetGlyph && <><TargetGlyph aria-hidden className="size-3 shrink-0" /><span className="sr-only">{target.kind === "workspace" ? "Workspace: " : "Source: "}</span></>}
            <span className="truncate">{"detail" in target ? target.detail : label}</span>
          </span>
          {live?.startError && <div className="text-xs text-destructive-foreground">
            {live.startError.length > 200 || live.startError.includes("\n")
              ? <details><summary className="cursor-pointer">Start failed. {errorSummary(live.startError, [])}</summary>
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all">{live.startError}</pre></details>
              : <span className="break-words">Start failed. {live.startError}</span>}
          </div>}
        </div>
        {live?.startError && live.canReadLogs && <WorkspaceAppLogs key={live.current?.worktreeId} workspaceId={workspaceId} appId={app.appId} name={app.name} />}
        {apps.length > 1 && !busy && !retry && !current && <Button type="button" variant="ghost" size="icon-sm" aria-label={`Use this workspace for ${app.name}`}
          title={reason || `Use this workspace for ${app.name}`}
          disabled={disabled || !observed || !canUse || !canSelectApplication(live)}
          onClick={event => live && reviewSwitch("workspace", event.currentTarget, live)}><ArrowRightLeft aria-hidden /></Button>}
      </li>;
    })}</ul>
    {busy ? <div className="flex items-center gap-2 text-xs" role="status">
      <HostyLoader label={null} className="size-3.5" /><span>{progress}</span>
      {phase === "approval" && <Button type="button" variant="ghost" size="sm" onClick={execution.cancelReview}>Cancel</Button>}
    </div> : <div className="flex items-center gap-1">
      {!known && !inventory.loading && !retry ? <Button type="button" variant="outline" size="sm" onClick={inventory.refresh}>Refresh applications</Button>
        : <Button type="button" variant="outline" size="sm" disabled={!allowed || !known && !retry}
          title={!canUse && (retry ? pending.kind : kind) === "workspace" ? "Resume this workspace before switching its applications." : undefined}
          onClick={event => retry ? execution.retry() : reviewSwitch(kind, event.currentTarget)}>{!known && !retry ? "Checking applications…" : label}</Button>}
      {!inventory.loading && !inventory.error && hasCurrent && (kind !== "package" || retry && pending.kind !== "package") && <DropdownMenu>
        <DropdownMenuTrigger asChild><Button ref={otherActions} type="button" variant="ghost" size="icon-sm" aria-label="Other application actions" disabled={disabled}><ChevronDown aria-hidden /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="start"><DropdownMenuItem onSelect={() => reviewSwitch("package", otherActions.current)}>Return to packages</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>}
    </div>}
    <Dialog open={!!review} onOpenChange={open => { if (!open) setReview(null); }}>
      <DialogContent showCloseButton={false} onCloseAutoFocus={event => { event.preventDefault(); opener.current?.focus(); }}>
        <DialogHeader>
          <DialogTitle>{review?.kind === "package" ? "Return to installed packages?" : "Switch to workspace source?"}</DialogTitle>
          <DialogDescription>{review?.kind === "package"
            ? `Return all apps still using “${workspaceName}” to their installed packages. The packages will use the current data, including changes made by workspace migrations.`
            : <>{reviewedApp ? `Switch ${reviewedApp.name} to source from “${workspaceName}”.` : `Switch all apps bound to “${workspaceName}” when Core accepts the request.`} Workspace code uses current application data. A migration can make it incompatible with the installed package.</>}</DialogDescription>
        </DialogHeader>
        <DialogBody><ul aria-label={reviewedApp ? "Application to switch" : "Currently observed applications"} className="space-y-1 text-sm font-medium">
          {review?.targets.map(app => <li key={app.appId}>{app.name}</li>)}
        </ul>
        {!canConfirm && <p role="status" className="text-sm text-muted-foreground">The selection has changed or is unavailable. Close this dialog and check the application status.</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setReview(null)}>Cancel</Button>
          <Button type="button" disabled={!canConfirm} onClick={() => {
            if (!review || !canConfirm) return;
            setReview(null);
            execution.run(review.kind, reviewedApp);
          }}>Confirm switch</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {execution.approvalLink && <a className="text-xs underline" href={execution.approvalLink} onClick={event => { event.preventDefault(); execution.reopenReview(); }} target="_blank" rel="noreferrer">Open access confirmation</a>}
    {inventory.error && <p role="status" className="text-xs text-muted-foreground">Application status unavailable.</p>}
    {execution.error && !launchOutcomesVisible && <div className="space-y-1 text-xs">
      <p role="alert" className="break-words">{failureSummary}</p>
      {execution.error !== failureSummary && <details className="text-muted-foreground"><summary className="cursor-pointer">Details</summary><p className="whitespace-pre-wrap break-words pt-1">{execution.error}</p></details>}
    </div>}
  </section>;
}
