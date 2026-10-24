"use client";
import { useEffect, useState } from "react";
import { CircleAlert, CircleHelp, ExternalLink, FlaskConical, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { HostyLoader } from "../../../../../shared/web/hosty-states";
import type { CoreEnvironment, SandboxInstance } from "@hosty-sdk/app/sandbox/server";
import { developmentRequest } from "@/lib/development-api";
import { WorkspaceResourceActions } from "./workspace-resource-actions";
import { PreviewChecks } from "./preview-checks";
type Previews = { environments: CoreEnvironment[]; instances: SandboxInstance[]; applications: Record<string, { state: string; error?: string;
  apps: PreviewApp[] }> };
type PreviewApp = { id: string; displayName: string; runtimeState: string; previewUrl?: string; health?: string;
  services?: { service: string; status: string; health?: string | null }[] | null;
  restartRequired?: boolean | null; manifestError?: string | null; lastError?: string | null;
  launchProgress?: { stage: string; changedAt: string; service?: string; buildState?: string | null } | null;
  development?: { reloadMode: string; manifestState: string; restartRequired?: boolean | null } | null };
function safeLink(value?: string) { try { const u = new URL(value ?? ""); return ["http:","https:"].includes(u.protocol) && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } }
export function WorkspacePreviews({ workspaceId, canStart = true, disabled = false, refresh }: {
  workspaceId: string; canStart?: boolean; disabled?: boolean; refresh?: () => void;
}) {
  const [value, setValue] = useState<Previews | null>(null), [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); let loading = false;
    const load = async () => {
      if (loading) return; loading = true;
      try { const next = await developmentRequest<Previews>(`/${workspaceId}/previews`, undefined, abort.signal);
        if (!abort.signal.aborted) { setValue(next); setError(""); } }
      catch (e) { if (!abort.signal.aborted) { setValue(null); setError(e instanceof Error ? e.message : String(e)); } }
      finally { loading = false; }
    };
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); },10000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [workspaceId, revision]);
  const changed = () => { setRevision(n => n + 1); refresh?.(); };
  const instances = value?.instances.filter(item => item.state !== "disposed") ?? [];
  if (value && !value.environments.length && !instances.length) return null;
  return <section className="space-y-3 border-t pt-4" aria-label="Sandbox previews"><h3 className="text-xs font-semibold text-muted-foreground">Previews</h3>
    {!value && !error && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><HostyLoader label={null} className="size-4" />Loading sandbox previews…</p>}
    {error && <Alert variant="destructive"><AlertTitle>Preview status unavailable</AlertTitle><AlertDescription>
      <p>{error}</p><Button variant="outline" size="sm" onClick={() => { setError(""); setRevision(n => n + 1); }}>Retry previews</Button>
    </AlertDescription></Alert>}
    {value?.environments.map(item => <div key={item.id} className="min-w-0 space-y-3 rounded-xl border bg-card p-3 text-xs">
      <div className="flex min-w-0 items-start gap-2"><FlaskConical className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /><p className="min-w-0 flex-1 break-words text-sm font-semibold">{item.label}</p><PreviewState state={item.state} /></div>
      <p className="text-muted-foreground">Separate Core and test data</p>
      {item.process?.startedAt && Number.isFinite(Date.parse(item.process.startedAt)) && <p className="tabular-nums text-muted-foreground">Process started <time dateTime={item.process.startedAt}>{new Date(item.process.startedAt).toLocaleString()}</time></p>}
      {safeLink(item.previewUrl) && <p className="truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs text-muted-foreground" title={safeLink(item.previewUrl)}>{safeLink(item.previewUrl)}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {item.state === "running" && safeLink(item.previewUrl) && <Button asChild variant="outline" size="sm"><a target="_blank" rel="noreferrer" href={new URL("/login", safeLink(item.previewUrl)).href}>Open test Core<ExternalLink className="size-3" /></a></Button>}
        <WorkspaceResourceActions compact key={item.id} workspaceId={workspaceId} kind="environments" resource={item} label={item.label} canStart={canStart} disabled={disabled} refresh={changed} />
      </div>
      {value.applications[item.id]?.apps.map(app => <div key={app.id} className="space-y-2 border-t pt-3"><ApplicationPreview app={app} />
        {item.state === "running" && canStart && !disabled && <PreviewChecks compact workspaceId={workspaceId} environmentId={item.id} appId={app.id} refresh={() => setRevision(n => n + 1)} />}
      </div>)}
      {item.state === "running" && !value.applications[item.id]?.apps.length && !value.applications[item.id]?.error && <p role="status" className="text-muted-foreground">
        {value.applications[item.id]?.state === "ready" ? "No applications in this preview."
          : value.applications[item.id]?.state === "setup-required" ? "Set up this test Core to inspect its applications."
          : "Application status unobserved."}
      </p>}
      {(item.error || value.applications[item.id]?.error) && <p role="status" className="text-destructive-foreground">{item.error || value.applications[item.id]?.error}</p>}
    </div>)}
    {instances.map(item => <div key={item.id} className="min-w-0 space-y-3 rounded-xl border bg-card p-3 text-xs">
      <div className="flex min-w-0 items-start gap-2"><FlaskConical className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /><p className="min-w-0 flex-1 break-all font-mono text-xs font-normal">{item.appId}</p><PreviewState state={item.state} /></div>
      <p className="tabular-nums text-muted-foreground">{item.users.length} test {item.users.length === 1 ? "user" : "users"} · Separate sandbox data</p>
      {safeLink(item.previewUrl) && <p className="truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs text-muted-foreground" title={safeLink(item.previewUrl)}>{safeLink(item.previewUrl)}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {item.state === "ready" && safeLink(item.previewUrl) && <Button asChild variant="outline" size="sm"><a target="_blank" rel="noreferrer" href={personaLink(item.previewUrl!)}>Open preview<ExternalLink className="size-3" /></a></Button>}
        <WorkspaceResourceActions compact key={item.id} workspaceId={workspaceId} kind="sandboxes" resource={item} label={item.appId} canStart={canStart} disabled={disabled} refresh={changed} />
      </div>
      {item.errorCode && <p role="status" className="text-destructive-foreground">{item.errorCode}</p>}
    </div>)}
  </section>;
}
function personaLink(value: string) { const url = new URL(safeLink(value)!); url.searchParams.set("hosty_sandbox_persona", "core"); return url.href; }
function PreviewState({ state }: { state: string }) {
  const working = ["starting", "preparing", "finishing", "stopping"].includes(state);
  const failed = ["failed", "cleanup-failed"].includes(state);
  const color = ["running", "ready"].includes(state) ? "bg-success-foreground" : "bg-muted-foreground";
  return <Badge variant="outline" className="gap-1.5 text-xs font-medium">
    {failed ? <CircleAlert aria-hidden className="size-3 shrink-0 text-destructive-foreground" />
      : working ? <span aria-hidden className="inline-flex shrink-0 text-info-foreground motion-safe:animate-spin"><Loader2 className="size-3" /></span>
      : <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${color}`} />}
    {state.replaceAll("-", " ")}
  </Badge>;
}

function ApplicationPreview({ app }: { app: PreviewApp }) {
  const progress = app.launchProgress;
  const pending = app.restartRequired === true || app.development?.restartRequired === true;
  const launchLabels: Record<string, string> = { preparing: "Preparing", building: "Building environment", "build-ready": "Environment built", "build-reused": "Reusing environment", starting: "Starting", checking: "Checking readiness", ready: "Started", failed: "Failed", interrupted: "Interrupted" };
  const buildLabels: Record<string, string> = { building: "Building", ready: "Built", reused: "Reused", failed: "Failed", interrupted: "Interrupted" };
  return <div className="space-y-2 break-words text-xs" aria-label={`${app.displayName} runtime`}>
    <div className="flex flex-wrap items-center gap-2"><p className="min-w-0 flex-1 font-semibold">{app.displayName}</p><PreviewState state={app.runtimeState} /></div>
    {app.health && <p className="text-muted-foreground">Health: {app.health}</p>}
    {safeLink(app.previewUrl) && <Button asChild variant="outline" size="sm"><a target="_blank" rel="noreferrer" href={safeLink(app.previewUrl)}>Open preview<ExternalLink className="size-3" /></a></Button>}
    {app.services?.length ? <ul aria-label="Service status" className="space-y-1 text-muted-foreground">
      {app.services.map(service => <li key={service.service}><span className="font-mono">{service.service}</span> · {service.status}{service.health ? ` · ${service.health}` : ""}</li>)}
    </ul> : <Alert role="status"><CircleHelp aria-hidden="true" /><AlertTitle>Service status unobserved</AlertTitle><AlertDescription>No service observation is available.</AlertDescription></Alert>}
    {pending && <p role="status" className="text-warning-foreground">Restart required{app.development?.manifestState === "changed" ? " · Source manifest or location changed" : " · Configuration changed"}</p>}
    <details className="rounded-lg border bg-muted/30 p-2"><summary className="cursor-pointer text-muted-foreground">Launch: {progress ? launchLabels[progress.stage] ?? progress.stage : "Unobserved"}{progress?.service ? ` · ${progress.service}` : ""}
      {progress && Number.isFinite(Date.parse(progress.changedAt)) && <> · <time dateTime={progress.changedAt} className="tabular-nums">{new Date(progress.changedAt).toLocaleTimeString()}</time></>}</summary>
    <div className="mt-2 space-y-1.5">{progress?.buildState && <p>Environment build: {buildLabels[progress.buildState] ?? progress.buildState}</p>}
    {app.restartRequired == null && <p className="text-muted-foreground">Restart requirement unavailable</p>}
    {app.development && <>
      <p className="text-muted-foreground">Live source · Reload and compilation are managed by the application; verify the preview.</p>
      {["unavailable", "unobserved"].includes(app.development.manifestState) && <p className="text-muted-foreground">Source manifest: {app.development.manifestState}. Restart requirement is not verified.</p>}
    </>}
    </div></details>
    {(app.manifestError || app.lastError) && <div role="status" className="text-destructive-foreground">
      <p>{app.manifestError ? "Manifest error" : progress?.buildState === "failed" ? "Environment build failed" : "Application start failed"}</p>
      <details><summary>Error details</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{app.manifestError || app.lastError}</pre></details>
      <p>Fix the source in the existing worktree, review manifest changes if required, then Restart app. This sandbox and its test data are retained.</p>
    </div>}
  </div>;
}
