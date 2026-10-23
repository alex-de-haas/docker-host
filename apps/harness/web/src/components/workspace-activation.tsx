"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRightLeft, CircleAlert, GitBranch, Hammer, LoaderCircle, TriangleAlert } from "lucide-react";
import { ContextAppIcon } from "@/components/context-app-icon";
import type { ContextApp } from "@/lib/assistant-api";
import { HostyLoader } from "../../../../../shared/web/hosty-states";
import { Button } from "@/components/ui/button";
import { openInstallationConfirmation, showInstallationConfirmation } from "@hosty-sdk/app/install";
import { approveWorkspaceAccess, type WorkspaceAccessReview } from "@/lib/workspace-access-review";
import { developmentRequest, DevelopmentRequestError } from "@/lib/development-api";
import { useWorkspaceApplications, workspaceApplicationIsCurrent, workspaceApplicationStatus, workspaceApplicationTarget, type WorkspaceApplication } from "@/lib/workspace-applications";
import { cn } from "@/lib/utils";

type Selection = { requestId: string; kind: "workspace" | "package"; appId?: string; workspaceId?: string; worktreeId?: string; runtime?: string };
type Result = { requestId: string; state: string; error?: string; apps: { appId: string; state: string; error?: string; code?: string; review?: WorkspaceAccessReview }[] };
const terminalCode = (code?: string) => ["dev_selection_changed", "dev_installation_changed", "execution_request_conflict", "selection_changed", "installation_changed"].includes(code || "");
const terminalStale = (result: Result) => result.apps?.some(app => terminalCode(app.code));
function savedSelection(key: string, workspaceId: string): Selection | null {
  try { const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!value || typeof value.requestId !== "string" || !["workspace", "package"].includes(value.kind)) return null;
    if (value.appId !== undefined && (typeof value.appId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value.appId)
      || value.kind !== "workspace" || value.workspaceId !== workspaceId || typeof value.worktreeId !== "string"
      || !/^[a-f0-9]{64}$/.test(value.worktreeId) || value.runtime !== undefined && typeof value.runtime !== "string")) return null;
    return value;
  } catch { return null; }
}


function selectionPath(workspaceId: string, selection: Selection) {
  return `/${workspaceId}${selection.appId ? `/applications/${encodeURIComponent(selection.appId)}` : ""}/execution-target`;
}
function selectionBody(selection: Selection) {
  return { requestId: selection.requestId, kind: selection.kind,
    ...(selection.appId ? { workspaceId: selection.workspaceId, worktreeId: selection.worktreeId,
      ...(selection.runtime !== undefined ? { runtime: selection.runtime } : {}) } : {}) };
}
function selectionResult(selection: Selection, value: Result | Omit<Result, "apps"> & { code?: string; review?: WorkspaceAccessReview }): Result {
  return selection.appId ? { requestId: value.requestId, state: value.state,
    apps: [{ ...value, appId: selection.appId }] } : value as Result;
}

export function WorkspaceActivation({ workspaceId, apps, disabled, canUse = true, refresh, appMetadata = [] }: {
  workspaceId: string; apps: { appId: string; name: string }[]; disabled?: boolean; canUse?: boolean; refresh: () => void; appMetadata?: readonly ContextApp[];
}) {
  const storageKey = `hosty.workspace.execution:${location.origin}:${workspaceId}`;
  const [pending, setPending] = useState<Selection | null>(() => savedSelection(storageKey, workspaceId));
  const inventory = useWorkspaceApplications(workspaceId, apps.length > 0);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [approvalLink, setApprovalLink] = useState<string | null>(null);
  const [error, setError] = useState("");
  const executing = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const record = (value: Selection | null) => {
    setPending(value);
    try { if (value) localStorage.setItem(storageKey, JSON.stringify(value)); else localStorage.removeItem(storageKey); }
    catch { /* Core retains the original request. */ }
  };
  const run = async (kind: Selection["kind"], application?: WorkspaceApplication, retry = false) => {
    if (executing.current || disabled || kind === "workspace" && !canUse) return;
    if (application && !retry && (!application.canSwitch || !application.target?.worktreeId || workspaceApplicationIsCurrent(application))) return;
    executing.current = true; setBusy(true); setError(""); setResult(null);
    const selection: Selection = retry && pending ? pending
      : pending?.kind === kind && pending.appId === application?.appId ? pending
      : application ? { kind, requestId: crypto.randomUUID(), appId: application.appId, workspaceId,
        worktreeId: application.target!.worktreeId!, ...(application.target?.runtime ? { runtime: application.target.runtime } : {}) }
      : { kind, requestId: crypto.randomUUID() };
    record(selection);
    try {
      let next = selectionResult(selection, await developmentRequest<Result>(selectionPath(workspaceId, selection), selectionBody(selection)));
      if (!alive.current) return;
      setResult(next);
      while (next.state === "running" && alive.current) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (!alive.current) return;
        next = selectionResult(selection, await developmentRequest<Result>(`${selectionPath(workspaceId, selection)}/${selection.requestId}`));
        if (alive.current) setResult(next);
      }
      if (!alive.current) return;
      if (next.state === "completed" || terminalStale(next)) record(null);
      inventory.refresh(); refresh();
    } catch (e) { if (alive.current) {
      setError(e instanceof Error ? e.message : String(e));
      if (e instanceof DevelopmentRequestError && terminalCode(e.code)) record(null);
    } }
    finally { executing.current = false; if (alive.current) setBusy(false); }
  };
  const reviewAccess = async (review: WorkspaceAccessReview) => {
    if (reviewing || busy) return;
    const popup = openInstallationConfirmation();
    setReviewing(true); setError("");
    try {
      const approval = await approveWorkspaceAccess(review, request => {
        showInstallationConfirmation(popup, request);
        setApprovalLink(request.status === "pending" ? request.approvalUrl : null);
      });
      setApprovalLink(null);
      if (approval.status === "succeeded" && pending) await run(pending.kind, undefined, true);
      else if (approval.status === "denied") setError("The additional access was not approved.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setReviewing(false); }
  };
  useEffect(() => {
    const saved = savedSelection(storageKey, workspaceId);
    if (!saved) return;
    const abort = new AbortController();
    void developmentRequest<Result>(`${selectionPath(workspaceId, saved)}/${saved.requestId}`, undefined, abort.signal)
      .then(raw => {
        const value = selectionResult(saved, raw);
        if (abort.signal.aborted) return;
        setResult(value);
        if (value.state === "completed" || terminalStale(value)) {
          setPending(null);
          try { localStorage.removeItem(storageKey); } catch { /* Optional local journal. */ }
        }
      }).catch(() => { /* Retry preserves the exact request if its receipt is temporarily unavailable. */ });
    return () => abort.abort();
  }, [storageKey, workspaceId]);
  if (!apps.length) return null;
  const unsettled = !!pending && !["failed", "review-required"].includes(result?.state || "");
  const problems = result?.apps?.filter(app => !["completed", "skipped"].includes(app.state)) ?? [];
  const placements = apps.map(app => {
    const live = inventory.applications.find(item => item.appId === app.appId);
    if (live && workspaceApplicationIsCurrent(live)) return "current";
    if (live?.current?.kind === "package" || live?.current?.kind === "workspace" &&
      live.current.workspaceId?.trim() && live.current.workspaceId !== workspaceId) return "elsewhere";
    // Missing/legacy bindings and another tree in this workspace can still need package recovery.
    return "unknown";
  });
  const known = !inventory.loading && !inventory.error && placements.every(value => value !== "unknown");
  const showWorkspace = !!pending || !known || !placements.every(value => value === "current");
  const showPackages = !!pending || !known || !placements.every(value => value === "elsewhere");
  return <section aria-label="Workspace applications" className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-3">
    <h4 className="text-xs font-semibold">Use on this Core</h4>
    <ul aria-label="Bound applications" className="flex min-w-0 flex-col gap-2">{apps.map(app => {
      const live = inventory.applications.find(item => item.appId === app.appId);
      const status = live ? workspaceApplicationStatus(live) : { label: inventory.loading ? "Loading…" : "Unknown", tone: "muted", busy: false };
      const current = !!live && workspaceApplicationIsCurrent(live);
      const rowBusy = busy && pending?.appId === app.appId;
      const Glyph = status.tone === "destructive" ? CircleAlert : status.tone === "warning" ? TriangleAlert : status.busy ? LoaderCircle : null;
      const reason = !live ? inventory.loading ? "Reading application status…" : "Execution target unavailable."
        : live.unavailable || live.target?.unavailable || (!live.canSwitch ? "Application lifecycle access is required." : undefined);
      const target = live ? workspaceApplicationTarget(live) : { kind: "unknown", label: inventory.loading ? "Reading execution target…" : "Execution target unavailable" };
      const TargetGlyph = target.kind === "workspace" ? Hammer : target.kind === "source" ? GitBranch : null;
      const label = target.label;
      return <li key={app.appId} className="flex min-w-0 items-center gap-2 text-xs" aria-label={app.name}>
        <ContextAppIcon app={appMetadata.find(metadata => metadata.id === app.appId)} className="size-6" />
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
        {!current && <Button type="button" variant="ghost" size="icon-sm" aria-label={`Use this workspace for ${app.name}`}
          title={rowBusy ? `Switching ${app.name}…` : reason || `Use this workspace for ${app.name}`}
          disabled={disabled || busy || reviewing || unsettled || inventory.loading || !canUse || !live?.canSwitch || !live.target?.worktreeId || status.busy || live.operationStatus === "updating"}
          onClick={() => live && void run("workspace", live)}>{rowBusy ? <HostyLoader label={null} /> : <ArrowRightLeft aria-hidden />}</Button>}
      </li>;
    })}</ul>
    {inventory.error && <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span role="status">Application status unavailable.</span><Button variant="link" size="sm" onClick={inventory.refresh}>Retry</Button></div>}
    <p className="text-xs text-muted-foreground">Switch the bound applications using their ordinary data. Return keeps the existing package recovery.</p>
    <div className="flex flex-wrap gap-2">
      {showWorkspace && <Button variant="outline" size="sm" disabled={disabled || busy || reviewing || unsettled || !canUse} onClick={() => void run("workspace")}>Use workspace</Button>}
      {showPackages && <Button variant="outline" size="sm" disabled={disabled || busy || reviewing || unsettled} onClick={() => void run("package")}>Return to packages</Button>}
      {pending && <Button variant="outline" size="sm" disabled={disabled || busy || reviewing || pending.kind === "workspace" && !canUse}
        title={pending.kind === "workspace" && !canUse ? "Resume this workspace before retrying its selection." : undefined}
        onClick={() => void run(pending.kind, undefined, true)}>Retry runtime switch</Button>}
    </div>
    {busy && <p role="status" className="flex items-center gap-2 text-xs"><HostyLoader label={null} className="size-3.5" />{pending?.appId ? `Switching ${apps.find(app => app.appId === pending.appId)?.name || pending.appId}…` : "Switching applications…"}</p>}
    {result?.state === "completed" && <p role="status" className="text-xs text-muted-foreground">{result.apps.length === 1 ? "Application switched." : "Applications switched."}</p>}
    {approvalLink && <a className="block text-xs underline" href={approvalLink} target="_blank" rel="noreferrer">Open Core access confirmation</a>}
    {(error || result?.error) && <p role="alert" className="text-xs text-destructive">{error || result?.error}</p>}
    {problems.length > 0 && <ul className="space-y-1 text-xs">{problems.map(app => <li key={app.appId}>
      {apps.find(item => item.appId === app.appId)?.name || app.appId}: {app.error || (app.state === "review-required" ? "Additional access requires approval in Core." : app.state)}
      {app.state === "review-required" && app.review && <Button size="sm" variant="link" disabled={reviewing || busy || pending?.kind === "workspace" && !canUse} onClick={() => void reviewAccess(app.review!)}>Review access</Button>}
    </li>)}</ul>}
  </section>;
}
