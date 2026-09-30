"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { InstallationError, createInstallationClient, openInstallationConfirmation, showInstallationConfirmation } from "@hosty-sdk/app/install";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useShellActions } from "../shell-context";
import type { AppPermissionObservation, CoreApp } from "../types";

export function AppPermissions({ app, active = true }: { app: CoreApp; active?: boolean }) {
  const { coreOrigin, sendCsrfJson, refresh } = useShellActions();
  const client = useMemo(() => createInstallationClient({ baseUrl: `${coreOrigin}/api/installations`, request: sendCsrfJson }), [coreOrigin, sendCsrfJson]);
  const [state, setState] = useState<AppPermissionObservation | null>(null);
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<{ id: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetch(`${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/permissions`, { credentials: "include", cache: "no-store", signal });
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
    return () => controller.abort();
  }, [active, load]);
  useEffect(() => {
    if (!pending) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await client.status(pending!.id);
        if (disposed) return;
        if (["succeeded", "denied", "failed"].includes(result.status)) {
          setPending(null); setBusy(false);
          setMessage(result.status === "succeeded" ? "Permissions updated." : result.error ?? "Permission review cancelled. Your draft is preserved.");
          if (result.status === "succeeded") { setChoices({}); await load(); void refresh(); }
        } else {
          setMessage(result.status === "executing" ? "Applying permissions…" : "Waiting for confirmation in Core…");
          timer = setTimeout(() => void poll(), 1500);
        }
      } catch (error) {
        if (!disposed) {
          if (error instanceof InstallationError && error.status >= 400 && error.status < 500 && error.status !== 429) {
            setMessage(`${error.message} Your draft is preserved; refresh and review again.`);
            setPending(null); setBusy(false);
          } else { setMessage(`Could not check confirmation: ${String(error)}. Retrying…`); timer = setTimeout(() => void poll(), 3000); }
        }
      }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [client, pending, refresh, load]);
  async function review() {
    if (!state || state.status !== "known") return;
    const popup = openInstallationConfirmation();
    setBusy(true); setMessage("");
    try {
      const draft = await client.prepare({ permissionsAppId: app.id });
      const plan = draft.permissionPlan;
      if (!plan || JSON.stringify(plan.required) !== JSON.stringify(state.required) || JSON.stringify(plan.optional) !== JSON.stringify(state.optional)) {
        await load();
        throw new Error("The manifest changed. Check the refreshed permissions and review again.");
      }
      const selected = state.optional.filter(p => choices[p] ?? (state.granted.includes(p) && state.acceptedOptional.includes(p)));
      const result = await client.submit(draft.id, {}, true, selected);
      showInstallationConfirmation(popup, result);
      setPending({ id: result.id, url: result.approvalUrl });
    } catch (error) { popup?.close(); setBusy(false); setMessage(String(error)); }
  }
  const permissions = state ? [...new Set([...state.required, ...state.optional, ...state.acceptedRequired, ...state.acceptedOptional, ...state.granted])] : [];
  return <section className="space-y-4 p-1 text-sm" aria-label="App permissions">
    <div className="flex items-center justify-between gap-3">
      <p className="text-muted-foreground">Review access requested by this app. Changes take effect after confirmation in Core.</p>
      <Button type="button" variant="ghost" size="sm" disabled={busy || loading} onClick={() => void load()}>Refresh</Button>
    </div>
    {!state && <p role="status">{loading ? "Checking the app manifest…" : "Permission information is unavailable."}</p>}
    {state && state.status !== "known" && !state.error && <p role="status">Permission information is not ready. Refresh to check the current manifest.</p>}
    {state?.error && <p role="alert" className="text-amber-600">The manifest could not be checked. Existing access is unchanged. {state.error}</p>}
    {state?.status === "known" && state.missingRequired.length > 0 && <p className="text-destructive">Required permissions need approval. Operations using these permissions are blocked.</p>}
    {state?.status === "known" && state.reviewRequired && <p>Manifest declarations have changed and need review.</p>}
    {state?.status === "known" && !permissions.length && <p>This app requests no Core permissions.</p>}
    <div className="divide-y rounded-md border empty:hidden">
      {permissions.map(permission => {
        const required = state!.required.includes(permission);
        const optional = state!.optional.includes(permission);
        const granted = state!.granted.includes(permission);
        const acceptedRequired = state!.acceptedRequired.includes(permission);
        const acceptedOptional = state!.acceptedOptional.includes(permission);
        const change = !required && !optional ? "Removal pending review" : required && acceptedOptional ? "Optional → required" : optional && acceptedRequired ? "Required → optional" : !acceptedRequired && !acceptedOptional ? "New in manifest" : null;
        return <div key={permission} className="flex items-start justify-between gap-3 p-3">
          <div className="min-w-0 space-y-1">
            <p>{state!.descriptions[permission] ?? permission}</p>
            <code className="block break-all text-xs text-muted-foreground">{permission}</code>
            <p className={required && !granted ? "text-destructive" : "text-muted-foreground"}>
              {required ? "Required" : optional ? "Optional" : "Previously declared"} · {granted ? "Allowed" : required ? "Approval needed" : "Not allowed"}
            </p>
            {change && <p className="text-xs">{change}</p>}
          </div>
          {optional && <Switch aria-label={`Allow ${permission}`} disabled={busy || state!.status !== "known"}
            checked={choices[permission] ?? (granted && acceptedOptional)}
            onCheckedChange={checked => setChoices(previous => ({ ...previous, [permission]: checked }))} />}
        </div>;
      })}
    </div>
    {!!state?.unconfirmedRoles.length && <p className="text-amber-600">Provider roles require a separate app update review: {state.unconfirmedRoles.join(", ")}. Saving permissions does not approve these roles.</p>}
    {state?.status === "known" && <Button type="button" variant="outline" size="sm" disabled={busy || loading} onClick={() => void review()}>Review changes</Button>}
    {pending && <p><a href={pending.url} target="_blank" rel="noopener noreferrer" className="underline">Confirm permissions in Core</a></p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
