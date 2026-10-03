"use client";

import { fetchCore } from "../core-transport.js";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useShellActions } from "../shell-context";
import type { AppPermissionObservation, CoreApp } from "../types";

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
      <p className="text-muted-foreground">View access requested by this app. Change permissions in Core.</p>
      <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>Refresh</Button>
    </div>
    {!state && <p role="status">{loading ? "Checking the app manifest…" : "Permission information is unavailable."}</p>}
    {state && state.status !== "known" && !state.error && <p role="status">Permission information is not ready. Refresh to check the current manifest.</p>}
    {state?.error && <p role="alert" className="text-amber-600">The manifest could not be checked. {state.error}</p>}
    {state?.status === "known" && !!state.unsupportedRequired?.length && <p role="alert" className="text-destructive">Core does not support these required permissions: {state.unsupportedRequired.join(", ")}. Install compatible app/Core versions or wait for an app update.</p>}
    {state?.status === "known" && state.missingRequired.length > 0 && <p className="text-destructive">Required permissions need approval. Operations using these permissions are unavailable until approval.</p>}
    {state?.status === "known" && state.reviewRequired && <p>Manifest declarations have changed and need review.</p>}
    {state?.status === "known" && !permissions.length && <p>This app requests no Core permissions.</p>}
    <div className="divide-y rounded-md border empty:hidden">
      {permissions.map(permission => {
        const required = state!.required.includes(permission);
        const optional = state!.optional.includes(permission);
        const granted = state!.granted.includes(permission);
        const acceptedRequired = state!.acceptedRequired.includes(permission);
        const acceptedOptional = state!.acceptedOptional.includes(permission);
        const unsupported = state!.unsupportedRequired?.includes(permission) || state!.unsupportedOptional?.includes(permission);
        const change = !required && !optional ? "Removal pending review" : required && acceptedOptional ? "Optional → required" : optional && acceptedRequired ? "Required → optional" : !acceptedRequired && !acceptedOptional ? "New in manifest" : null;
        return <div key={permission} className="flex items-start justify-between gap-3 p-3">
          <div className="min-w-0 space-y-1">
            <p>{state!.descriptions[permission] ?? permission}</p>
            <code className="block break-all text-xs text-muted-foreground">{permission}</code>
            <p className={required && !granted ? "text-destructive" : "text-muted-foreground"}>
              {required ? "Required" : optional ? "Optional" : "Previously declared"} · {unsupported ? "Unsupported by Core" : granted ? "Allowed" : required ? "Approval needed" : "Not allowed"}
            </p>
            {change && <p className="text-xs">{change}</p>}
          </div>

        </div>;
      })}
    </div>
    {!!state?.unconfirmedRoles.length && <p className="text-amber-600">Provider roles require a separate app update review: {state.unconfirmedRoles.join(", ")}. Saving permissions does not approve these roles.</p>}
    {state?.status === "known" && <Button type="button" variant="outline" size="sm" disabled={loading || !!state.unsupportedRequired?.length} onClick={() => void review()}>Change permissions</Button>}
    {message && <p><a href={coreReviewUrl} target="_blank" rel="noopener noreferrer" className="underline">Change permissions in Core</a></p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
