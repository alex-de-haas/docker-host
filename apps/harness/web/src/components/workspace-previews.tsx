"use client";
import { useEffect, useState } from "react";
import type { CoreEnvironment, SandboxInstance } from "@hosty-sdk/app/sandbox/server";
import { developmentRequest } from "@/lib/development-api";
type Previews = { environments: CoreEnvironment[]; instances: SandboxInstance[]; applications: Record<string, { state: string; error?: string;
  apps: PreviewApp[] }> };
type PreviewApp = { id: string; displayName: string; runtimeState: string; previewUrl?: string; health?: string;
  restartRequired?: boolean | null; manifestError?: string | null; lastError?: string | null;
  launchProgress?: { stage: string; changedAt: string; service?: string; buildState?: string | null } | null;
  development?: { reloadMode: string; manifestState: string; restartRequired?: boolean | null } | null };
function safeLink(value?: string) { try { const u = new URL(value ?? ""); return ["http:","https:"].includes(u.protocol) && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } }
export function WorkspacePreviews({ workspaceId }: { workspaceId: string }) {
  const [value, setValue] = useState<Previews | null>(null), [error, setError] = useState("");
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
  }, [workspaceId]);
  if (!error && (!value || (!value.environments.length && !value.instances.length))) return null;
  return <section className="space-y-3 border-t pt-4" aria-label="Sandbox previews"><h3 className="text-sm text-muted-foreground">Sandboxes</h3>
    {error && <p role="status" className="text-xs text-destructive">{error}</p>}
    {value?.environments.map(item => <div key={item.id} className="space-y-1 text-sm">
      <p className="font-medium">{item.label}</p><p className="text-xs text-muted-foreground">{item.state} · Separate Core and test data</p>
      {item.state === "running" && safeLink(item.previewUrl) && <a className="block text-xs underline" target="_blank" rel="noreferrer" href={new URL("/login", safeLink(item.previewUrl)).href}>Open sandbox Core</a>}
      {value.applications[item.id]?.apps.map(app => <ApplicationPreview key={app.id} app={app} />)}
      {(item.error || value.applications[item.id]?.error) && <p className="text-xs text-destructive">{item.error || value.applications[item.id]?.error}</p>}
    </div>)}
    {value?.instances.map(item => <div key={item.id} className="space-y-1 text-sm"><p className="font-medium">{item.appId}</p>
      <p className="text-xs text-muted-foreground">{item.state} · {item.users.length} test users</p>
      {item.state === "ready" && safeLink(item.previewUrl ?? undefined) && <a target="_blank" rel="noreferrer" className="text-xs underline" href={`${safeLink(item.previewUrl ?? undefined)}?hosty_sandbox_persona=core`}>Open preview</a>}
    </div>)}
  </section>;
}

function ApplicationPreview({ app }: { app: PreviewApp }) {
  const progress = app.launchProgress;
  const pending = app.restartRequired === true || app.development?.restartRequired === true;
  const launchLabels: Record<string, string> = { preparing: "Preparing", building: "Building environment", "build-ready": "Environment built", "build-reused": "Reusing environment", starting: "Starting", checking: "Checking readiness", ready: "Started", failed: "Failed", interrupted: "Interrupted" };
  const buildLabels: Record<string, string> = { building: "Building", ready: "Built", reused: "Reused", failed: "Failed", interrupted: "Interrupted" };
  return <div className="space-y-1 break-words text-xs" aria-label={`${app.displayName} runtime`}>
    <p>{safeLink(app.previewUrl) ? <a className="underline" target="_blank" rel="noreferrer" href={safeLink(app.previewUrl)}>{app.displayName}</a> : app.displayName} · {app.runtimeState}{app.health ? ` · ${app.health}` : ""}</p>
    <p className="text-muted-foreground">Launch: {progress ? launchLabels[progress.stage] ?? progress.stage : "Unobserved"}{progress?.service ? ` · ${progress.service}` : ""}
      {progress && Number.isFinite(Date.parse(progress.changedAt)) && <> · <time dateTime={progress.changedAt}>{new Date(progress.changedAt).toLocaleTimeString()}</time></>}</p>
    {progress?.buildState && <p>Environment build: {buildLabels[progress.buildState] ?? progress.buildState}</p>}
    {pending && <p role="status" className="font-medium text-amber-700 dark:text-amber-400">Restart required{app.development?.manifestState === "changed" ? " · Source manifest or location changed" : " · Configuration changed"}</p>}
    {app.restartRequired == null && <p className="text-muted-foreground">Restart requirement unavailable</p>}
    {app.development && <>
      <p className="text-muted-foreground">Live source · Reload and compilation are managed by the application; verify the preview.</p>
      {["unavailable", "unobserved"].includes(app.development.manifestState) && <p className="text-muted-foreground">Source manifest: {app.development.manifestState}. Restart requirement is not verified.</p>}
    </>}
    {(app.manifestError || app.lastError) && <p role="status" className="text-destructive">{app.manifestError || app.lastError}</p>}
  </div>;
}
