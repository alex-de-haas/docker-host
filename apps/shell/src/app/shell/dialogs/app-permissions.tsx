"use client";

import { fetchCore } from "../core-transport.js";
import { useCallback, useEffect, useState } from "react";
import { Check, ChevronRight, CircleMinus, TriangleAlert } from "lucide-react";
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

export function AppPermissions({ app, active = true }: { app: CoreApp; active?: boolean }) {
  const { coreOrigin, refresh } = useShellActions();
  const coreReviewUrl = `${coreOrigin}/install/permissions/${encodeURIComponent(app.id)}`;
  const [state, setState] = useState<AppPermissionObservation | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetchCore(`${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/permissions`, { credentials: "include", cache: "no-store", signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Could not load permissions.");
      if (!signal?.aborted) setState(result as AppPermissionObservation);
    } catch (error) { if (!signal?.aborted) setMessage(String(error)); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [app.id, coreOrigin]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void load(controller.signal);
    const returned = () => { void load(controller.signal); void refresh(); };
    window.addEventListener("focus", returned);
    return () => { controller.abort(); window.removeEventListener("focus", returned); };
  }, [active, load, refresh]);
  function review() {
    if (!state || state.status !== "known") return;
    window.open(coreReviewUrl, "_blank", "noopener,noreferrer");
    setMessage("Change permissions in Core, then return here and refresh.");
  }
  const permissions = state ? [...new Set([...state.required, ...state.optional, ...state.acceptedRequired, ...state.acceptedOptional, ...state.granted])] : [];
  return <section className="space-y-4 p-1 text-sm" aria-label="App permissions">
    <div className="flex items-center justify-between gap-3">
      <p className="text-muted-foreground">Review access. Expand a permission for details.</p>
      <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>Refresh</Button>
    </div>
    {!state && <p role="status">{loading ? "Checking the app manifest…" : "Permission information is unavailable."}</p>}
    {state && state.status !== "known" && !state.error && <p role="status">Permission information is not ready. Refresh to check the current manifest.</p>}
    {state?.error && <p role="alert" className="text-amber-600">The manifest could not be checked. {state.error}</p>}
    {state?.status === "known" && !!state.unsupportedRequired?.length && <p role="alert" className="text-destructive">Core does not support these required permissions: {state.unsupportedRequired.join(", ")}. Install compatible app/Core versions or wait for an app update.</p>}
    {state?.status === "known" && state.missingRequired.length > 0 && <p className="text-destructive">Required permissions need approval. Operations using these permissions are unavailable until approval.</p>}
    {state?.status === "known" && state.reviewRequired && <p>Manifest declarations have changed and need review.</p>}
    {state?.status === "known" && !permissions.length && <p>This app requests no Core permissions.</p>}
    {state && [
      { label: "Required", items: permissions.filter(p => state.required.includes(p)) },
      { label: "Optional", items: permissions.filter(p => !state.required.includes(p) && state.optional.includes(p)) },
      { label: "Previously declared", items: permissions.filter(p => !state.required.includes(p) && !state.optional.includes(p)) },
    ].filter(group => group.items.length > 0).map(group => <div key={group.label} className="space-y-1.5" role="group" aria-label={`${group.label} permissions`}>
      <h3 className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
        {group.label}<span className="font-normal tabular-nums">{group.items.length}</span>
      </h3>
      <div className="divide-y overflow-hidden rounded-lg border">
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
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground group-open/permission:rotate-90" />
            <span className="min-w-0 flex-1 break-words text-sm">
              {permissionLabels[permission] ?? permission}
              {change && <span className="mt-0.5 block text-xs text-warning">{change}</span>}
            </span>
            <span className={`flex shrink-0 items-center gap-1.5 text-xs ${attention ? "text-destructive" : granted ? "text-success" : "text-muted-foreground"}`}>
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
    {!!state?.unconfirmedRoles.length && <p className="text-amber-600">Provider roles require a separate app update review: {state.unconfirmedRoles.join(", ")}. Saving permissions does not approve these roles.</p>}
    {state?.status === "known" && <Button type="button" variant="outline" size="sm" disabled={loading || !!state.unsupportedRequired?.length} onClick={() => void review()}>Change permissions</Button>}
    {message && <p><a href={coreReviewUrl} target="_blank" rel="noopener noreferrer" className="underline">Change permissions in Core</a></p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
