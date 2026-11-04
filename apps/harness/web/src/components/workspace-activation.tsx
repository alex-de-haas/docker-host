"use client";

import { ArrowRightLeft, ChevronDown, CircleAlert, GitBranch, Hammer, LoaderCircle, TriangleAlert } from "lucide-react";
import { ContextAppIcon } from "@/components/context-app-icon";
import type { ContextApp } from "@/lib/assistant-api";
import { HostyLoader } from "../../../../../shared/web/hosty-states";
import { Button } from "@/components/ui/button";
import { useWorkspaceApplications, workspaceApplicationIsCurrent, workspaceApplicationStatus, workspaceApplicationTarget } from "@/lib/workspace-applications";
import { useWorkspaceExecution } from "@/lib/workspace-execution";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function WorkspaceActivation({ workspaceId, apps, disabled, canUse = true, refresh, appMetadata = [] }: {
  workspaceId: string; apps: { appId: string; name: string }[]; disabled?: boolean; canUse?: boolean; refresh: () => void; appMetadata?: readonly ContextApp[];
}) {
  const inventory = useWorkspaceApplications(workspaceId, apps.length > 0);
  const execution = useWorkspaceExecution(workspaceId, { disabled, canUse, refresh: () => { inventory.refresh(); refresh(); } });
  if (!apps.length) return null;
  const { busy, phase, pending } = execution;
  const rows = apps.map(app => inventory.applications.find(item => item.appId === app.appId));
  const known = !inventory.loading && !inventory.error && rows.every(app => app?.current &&
    (app.current.kind === "package" || app.current.kind === "workspace" && app.current.workspaceId && app.current.worktreeId));
  const hasCurrent = rows.some(app => app?.current?.kind === "workspace" && app.current.workspaceId === workspaceId);
  const allCurrent = known && rows.every(app => app && workspaceApplicationIsCurrent(app));
  const kind = allCurrent ? "package" : "workspace";
  const retry = phase === "failed" && !!pending;
  const allowed = !disabled && (retry ? pending.kind === "package" || canUse : kind === "package" || canUse && rows.every(app => app?.canSwitch));
  const label = retry ? "Try again" : kind === "package" ? "Return to packages" : "Use workspace";
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
        </div>
        {apps.length > 1 && !busy && !retry && !current && <Button type="button" variant="ghost" size="icon-sm" aria-label={`Use this workspace for ${app.name}`}
          title={reason || `Use this workspace for ${app.name}`}
          disabled={disabled || busy || !known || inventory.loading || !canUse || !live?.canSwitch || !live.target?.worktreeId || status.busy || live.operationStatus === "updating"}
          onClick={() => live && execution.run("workspace", live)}><ArrowRightLeft aria-hidden /></Button>}
      </li>;
    })}</ul>
    {busy ? <div className="flex items-center gap-2 text-xs" role="status">
      <HostyLoader label={null} className="size-3.5" /><span>{progress}</span>
      {phase === "approval" && <Button type="button" variant="ghost" size="sm" onClick={execution.cancelReview}>Cancel</Button>}
    </div> : <div className="flex items-center gap-1">
      {!known && !inventory.loading && !retry ? <Button type="button" variant="outline" size="sm" onClick={inventory.refresh}>Refresh applications</Button>
        : <Button type="button" variant="outline" size="sm" disabled={!allowed || !known && !retry}
          title={!canUse && (retry ? pending.kind : kind) === "workspace" ? "Resume this workspace before switching its applications." : undefined}
          onClick={() => retry ? execution.retry() : execution.run(kind)}>{!known && !retry ? "Checking applications…" : label}</Button>}
      {!inventory.loading && !inventory.error && hasCurrent && (kind !== "package" || retry && pending.kind !== "package") && <DropdownMenu>
        <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label="Other application actions" disabled={disabled}><ChevronDown aria-hidden /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="start"><DropdownMenuItem onSelect={() => execution.run("package")}>Return to packages</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>}
    </div>}
    {execution.approvalLink && <a className="text-xs underline" href={execution.approvalLink} onClick={event => { event.preventDefault(); execution.reopenReview(); }} target="_blank" rel="noreferrer">Open access confirmation</a>}
    {inventory.error && <p role="status" className="text-xs text-muted-foreground">Application status unavailable.</p>}
    {execution.error && <div className="space-y-1 text-xs">
      <p role="alert">{execution.error.startsWith("Access ") ? execution.error : "The switch could not be completed."}</p>
      {!execution.error.startsWith("Access ") && <details className="text-muted-foreground"><summary className="cursor-pointer">Details</summary><p className="whitespace-pre-wrap break-words pt-1">{execution.error}</p></details>}
    </div>}
  </section>;
}
