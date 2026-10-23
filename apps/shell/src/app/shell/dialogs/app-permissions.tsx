"use client";

import { fetchCore } from "../core-transport.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, CircleMinus, ExternalLink, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { HostyLoader } from "../../../../../../shared/web/hosty-states";
import { Badge } from "@/components/ui/badge";
import { isAuthRequiredRedirectError, readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";
import { Button } from "@/components/ui/button";
import { useShellActions } from "../shell-context";
import type { AppPermissionObservation, CoreApp } from "../types";

// Compact navigation labels only; the full, authoritative description comes from Core.
const permissionLabels: Record<string, string> = {
  "apps.read": "App list and status",
  "apps.logs": "App logs",
  "apps.notifications": "App notifications",
  "apps.lifecycle": "App lifecycle",
  "apps.configure": "App settings and backups",
  "apps.install": "Install, update and remove apps",
  "apps.sources.full": "Source code and selected connections",
  "apps.sources.read": "Repository documentation and workspace changes",
  "sources.connections": "Personal source accounts and Git identity",
  "apps.workspaces.read": "Development workspace information",
  "apps.workspaces.cleanup": "Clean up completed workspaces",
  "apps.mcp.access.request": "Request reviewed MCP access",
  "apps.sandboxes.read": "Authorized test environments",
  "apps.sandboxes.manage": "Create and manage test environments",
  "apps.sandboxes.inspect": "Inspect your test environments across apps",
  "apps.sandboxes.operate": "Manage your test environments across apps",
  "core.environments.read": "Owned Core environments",
  "core.environments.manage": "Create and manage owned Core environments",
  "core.environments.inspect": "Inspect your Core environments across apps",
  "core.environments.operate": "Manage your Core environments across apps",
  "core.workspace.activate": "Run and return from a workspace Core build",
  "credentials.read": "Token and device information",
  "credentials.revoke": "Request token and device revocation",
  "apps.panels.read": "App panels",
  "providers.translation": "Translation providers",
  "apps.skills.read": "Agent skills",
  "core.read": "Core status",
  "core.update": "Core updates",
  "core.lifecycle": "Restart Core",
  "core.configure": "Core settings",
  "core.logs": "Core logs",
  "users.read": "User information",
  "users.manage": "User management",
  "providers.speech-to-text": "Speech recognition",
  "providers.assistant": "Assistant conversations",
};

async function fetchPermissions(coreOrigin: string, appId: string, signal?: AbortSignal): Promise<AppPermissionObservation> {
  const response = await fetchCore(`${coreOrigin}/api/apps/${encodeURIComponent(appId)}/permissions`, { credentials: "include", cache: "no-store", signal });
  redirectToCoreLoginIfAuthRequired(response, coreOrigin);
  if (!response.ok) throw new Error(await readCoreError(response));
  return await response.json() as AppPermissionObservation;
}

export function AppPermissions({ app, active = true }: { app: CoreApp; active?: boolean }) {
  const { coreOrigin, refresh } = useShellActions();
  const coreReviewUrl = `${coreOrigin}/install/permissions/${encodeURIComponent(app.id)}`;
  const [state, setState] = useState<AppPermissionObservation | null>(null);
  const [loading, setLoading] = useState(active);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Becoming active starts a read (effect below); it shows as loading from the same render.
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setLoading(true);
  }
  const load = useCallback((signal?: AbortSignal) => {
    const request = ++requestId.current;
    return fetchPermissions(coreOrigin, app.id, signal).then(result => {
      if (mounted.current && !signal?.aborted && request === requestId.current) { setState(result); setError(null); }
    }, (cause: unknown) => {
      if (mounted.current && !signal?.aborted && request === requestId.current && !isAuthRequiredRedirectError(cause)) setError(cause instanceof Error ? cause.message : "Could not load permissions.");
    }).finally(() => {
      if (mounted.current && !signal?.aborted && request === requestId.current) setLoading(false);
    });
  }, [app.id, coreOrigin]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void load(controller.signal);
    const returned = () => { setLoading(true); void load(controller.signal); void refresh(); };
    window.addEventListener("focus", returned);
    return () => { controller.abort(); window.removeEventListener("focus", returned); };
  }, [active, load, refresh]);
  function review() {
    if (!state || state.status !== "known") return;
    window.open(coreReviewUrl, "_blank", "noopener,noreferrer");
    setMessage("Change permissions in Core, then return here and refresh.");
  }
  const permissions = state ? [...new Set([...state.required, ...state.optional, ...state.acceptedRequired, ...state.acceptedOptional, ...state.granted])] : [];
  return <section className="max-w-[920px] space-y-4 text-sm" aria-label="App permissions" aria-busy={loading}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1"><h3 className="font-medium">Core permissions</h3><p className="text-xs text-muted-foreground">Access confirmed by Core. Expand a permission to read what it allows.</p></div>
      <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => { setLoading(true); void load(); }}><RefreshCw className="size-3.5" />Refresh</Button>
    </header>
    {error && <p role="alert" className="rounded-xl border border-destructive/25 bg-destructive-soft p-3 text-destructive-foreground">{error} Refresh to try again.</p>}
    {!state && <p role="status" className="flex items-center gap-2 py-3 text-muted-foreground">{loading && <HostyLoader label={null} className="size-5" />}{loading ? "Checking the app manifest…" : "Permission information is unavailable."}</p>}
    {state && state.status !== "known" && !state.error && <p role="status">Permission information is not ready. Refresh to check the current manifest.</p>}
    {state?.error && <p role="alert" className="rounded-xl border border-warning/30 bg-warning-soft p-3 text-warning-foreground">The manifest could not be checked. {state.error}</p>}
    {state?.status === "known" && !!state.unsupportedRequired?.length && <p role="alert" className="text-destructive-foreground">Core does not support these required permissions: {state.unsupportedRequired.join(", ")}. Install compatible app/Core versions or wait for an app update.</p>}
    {state?.status === "known" && state.missingRequired.length > 0 && <p className="rounded-xl border border-destructive/25 bg-destructive-soft p-3 text-destructive-foreground">Required permissions need approval. Operations using these permissions are unavailable until approval.</p>}
    {state?.status === "known" && state.reviewRequired && <p>Manifest declarations have changed and need review.</p>}
    {state?.status === "known" && !permissions.length && <p>This app requests no Core permissions.</p>}
    {state && [
      { label: "Required", items: permissions.filter(p => state.required.includes(p)) },
      { label: "Optional", items: permissions.filter(p => !state.required.includes(p) && state.optional.includes(p)) },
      { label: "Previously declared", items: permissions.filter(p => !state.required.includes(p) && !state.optional.includes(p)) },
    ].filter(group => group.items.length > 0).map(group => <div key={group.label} className="space-y-2" role="group" aria-label={`${group.label} permissions`}>
      <h3 className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
        {group.label}<span className="font-normal tabular-nums">{group.items.length}</span>
      </h3>
      <div className="divide-y overflow-hidden rounded-xl border">
      {group.items.map(permission => {
        const required = state!.required.includes(permission);
        const optional = state!.optional.includes(permission);
        const granted = state!.granted.includes(permission);
        const acceptedRequired = state!.acceptedRequired.includes(permission);
        const acceptedOptional = state!.acceptedOptional.includes(permission);
        const unsupported = state!.unsupportedRequired?.includes(permission) || state!.unsupportedOptional?.includes(permission);
        const change = !required && !optional ? "Removal pending review" : required && acceptedOptional ? "Optional → required" : optional && acceptedRequired ? "Required → optional" : !acceptedRequired && !acceptedOptional ? "New in manifest" : null;
        const attention = unsupported || (required && !granted);
        const status = unsupported ? "Unsupported by Core" : granted ? "Allowed" : required ? "Approval needed" : "Not allowed";
        const StatusIcon = attention ? TriangleAlert : granted ? Check : CircleMinus;
        return <details key={permission} className="group/permission">
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-3 py-3 sm:gap-3 sm:px-4 hover:bg-muted/50 focus-visible:border-brand focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand focus-visible:ring-0 [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground group-open/permission:rotate-90" />
            <span className="min-w-0 flex-1 break-words text-sm">
              {permissionLabels[permission] ?? permission}
              {change && <span className="mt-0.5 block text-xs text-warning-foreground">{change}</span>}
            </span>
            <span className={`flex max-w-32 shrink-0 items-center gap-1.5 text-xs ${attention ? "text-destructive-foreground" : granted ? "text-success-foreground" : "text-muted-foreground"}`}>
              <StatusIcon aria-hidden="true" className="size-3.5" />{status}
            </span>
          </summary>
          <div className="space-y-1.5 bg-muted/30 py-2.5 pr-3 pl-8 text-xs">
            <p className="leading-relaxed text-muted-foreground">{state!.descriptions[permission] ?? permission}</p>
            <code className="block break-all text-muted-foreground">{permission}</code>
          </div>
        </details>;
      })}
      </div>
    </div>)}
    {!!state?.unconfirmedRoles.length && <p className="rounded-xl border border-warning/30 bg-warning-soft p-3 text-warning-foreground">Provider roles require a separate app update review: {state.unconfirmedRoles.join(", ")}. Saving permissions does not approve these roles.</p>}
    {!!app.confirmedRoles?.length && <section className="space-y-2" aria-label="Confirmed provider roles"><h3 className="text-xs font-medium text-muted-foreground">Provider roles</h3><ul className="divide-y rounded-xl border">{app.confirmedRoles.map(role => <li key={role} className="flex flex-wrap items-center gap-3 px-4 py-3"><ShieldCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden /><span className="min-w-0 flex-1 break-words">{role}</span><Badge variant="secondary">Confirmed role</Badge></li>)}</ul></section>}
    {state?.status === "known" && <footer className="flex flex-wrap items-center justify-between gap-3 border-t pt-3"><p className="text-xs text-muted-foreground">Changes are reviewed and confirmed in Core.</p><Button type="button" variant="outline" size="sm" disabled={loading || !!error || !!state.unsupportedRequired?.length} onClick={() => void review()}>Review permissions<ExternalLink className="size-3.5" /></Button></footer>}
    {message && <p><a href={coreReviewUrl} target="_blank" rel="noopener noreferrer" className="underline">Change permissions in Core</a></p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
