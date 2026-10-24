"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Info, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HostyLoader } from "../../../../../../shared/web/hosty-states";
import { appSupportsReviewedUpdate, formatUpdateChange } from "../app-helpers";
import { fetchCore } from "../core-transport.js";
import { isAuthRequiredRedirectError, readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";
import type { AppPendingUpdatePlanResponse, CoreApp, CoreUpdatePlan } from "../types";

function observedTime(value?: string | null) {
  if (!value) return "Not checked yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Check time unavailable" : date.toLocaleString();
}

/** A read-only plan preview. Submission stays in Shell's existing update/approval flow. */
export function AppUpdatesPanel({ app, coreOrigin, active, isShell, busyAction, onCheckUpdate, onUpdate }: {
  app: CoreApp; coreOrigin: string; active: boolean; isShell: boolean; busyAction: string | null;
  onCheckUpdate?: (app: CoreApp) => Promise<CoreUpdatePlan>;
  onUpdate?: (app: CoreApp) => void;
}) {
  const [plan, setPlan] = useState<CoreUpdatePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const supported = appSupportsReviewedUpdate(app);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!active || !supported) return;
    const controller = new AbortController();
    const request = ++generation.current;
    void fetchCore(`${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/update/plan`, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async response => {
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) throw new Error(await readCoreError(response));
        const payload = await response.json() as AppPendingUpdatePlanResponse;
        if (!controller.signal.aborted && request === generation.current) { setPlan(payload.plan); setError(null); }
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted && request === generation.current && !isAuthRequiredRedirectError(cause)) setError(cause instanceof Error ? cause.message : "Update details are unavailable.");
      });
    return () => controller.abort();
  }, [active, app.id, app.updateCheck?.planDigest, coreOrigin, supported]);
  const check = async () => {
    if (!onCheckUpdate || checking) return;
    const request = ++generation.current;
    setChecking(true); setError(null);
    try {
      const result = await onCheckUpdate(app);
      if (mounted.current && request === generation.current) setPlan(result);
    } catch (cause) {
      if (mounted.current && request === generation.current && !isAuthRequiredRedirectError(cause)) setError(cause instanceof Error ? cause.message : "The update check failed.");
    } finally { if (mounted.current) setChecking(false); }
  };
  // A failed/latest verdict must not turn an older cached plan into fresh update evidence.
  const verdict = app.updateCheck;
  const validPlan = !verdict?.error && plan?.appId === app.id && plan.currentVersion === app.version && (!plan.currentRuntime || !app.selectedRuntime || plan.currentRuntime === app.selectedRuntime) && (!verdict?.planDigest || plan.planDigest === verdict.planDigest) ? plan : null;
  const failed = error || verdict?.error || validPlan?.error;
  const available = supported && !failed && validPlan?.sourceConfigured !== false && (validPlan ? validPlan.changes.length > 0 : verdict?.updateAvailable);
  const requiresReview = validPlan ? validPlan.requiresReview !== false : verdict?.requiresReview;
  const targetVersion = validPlan?.targetVersion || verdict?.targetVersion;
  const busy = checking || !!busyAction || app.operationStatus === "updating";
  const permissionFactsKnown = validPlan?.currentCorePermissions !== undefined && validPlan.targetCorePermissions !== undefined;
  const addedPermissions = permissionFactsKnown ? validPlan!.targetCorePermissions!.filter(permission => !validPlan!.currentCorePermissions!.includes(permission)) : [];
  return <section className="max-w-[920px] space-y-4 text-sm" aria-label="App updates">
    {available && <div className="flex flex-wrap items-start gap-3 rounded-xl bg-info-soft p-4 text-info-foreground">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 basis-56 space-y-1"><h3 className="font-semibold text-foreground">{targetVersion && targetVersion !== app.version ? `${targetVersion} is available` : "An updated build is available"}</h3>
        <p className="text-xs">{requiresReview ? "Core review required" : "Routine update"}{permissionFactsKnown ? addedPermissions.length ? ` · ${addedPermissions.length} added Core permission${addedPermissions.length === 1 ? "" : "s"}` : " · no added Core permissions" : " · Core checks permission changes before installation"}</p>
      </div>
      {onUpdate && <Button type="button" size="sm" disabled={busy} onClick={() => onUpdate(app)}><ArrowDownToLine className="size-4" />{requiresReview ? "Review update" : "Update"}</Button>}
    </div>}
    {app.operationStatus === "updating" && <p role="status" className="text-info-foreground">Update in progress{app.updateProgress?.stage ? ` · ${app.updateProgress.stage}` : ""}</p>}
    {failed && <div role="alert" className="rounded-xl border border-warning/30 bg-warning-soft p-4"><h3 className="font-medium">Update check incomplete</h3><p className="mt-1 break-words text-muted-foreground">{failed}</p></div>}
    {validPlan && validPlan.changes.length > 0 && <section aria-label="Update changes"><h3 className="mb-2 text-xs font-medium text-muted-foreground">What changed</h3><ul className="list-disc space-y-1 pl-5 text-muted-foreground">{validPlan.changes.map((change, index) => <li key={`${index}:${change}`}>{formatUpdateChange(change)}</li>)}</ul></section>}
    <dl className="divide-y border-y">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"><dt className="w-full shrink-0 text-muted-foreground sm:w-44">Installed version</dt><dd className="min-w-0 flex-1 font-mono">{app.version}</dd></div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"><dt className="w-full shrink-0 text-muted-foreground sm:w-44">Last update check</dt><dd className="min-w-0 flex-1 space-y-1"><p>{observedTime(verdict?.checkedAt)}</p><p className="text-xs text-muted-foreground">{app.live ? "This runtime runs from source. Restart adopts manifest changes; hot reload depends on its profile." : validPlan?.sourceConfigured === false ? "No external update source is configured. Core cannot detect newer releases from the installed copy." : failed ? "Resolve the source or check error, then try again." : available ? "Core reported an available update." : verdict && !verdict.updateAvailable ? "The latest check reported no available update." : "Check the configured source for available updates."}</p></dd>
        {supported && onCheckUpdate && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void check()}>{checking ? <HostyLoader label={null} className="size-4" /> : <RefreshCw className="size-4" />}Check now</Button>}
      </div>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3"><dt className="w-full shrink-0 text-muted-foreground sm:w-44">Update behavior</dt><dd className="min-w-0 flex-1 space-y-1"><p>Started by you</p><p className="text-xs text-muted-foreground">Routine updates use Core’s update queue. Changes that need approval open a separate review in Core.{isShell && " Updating Shell restarts this interface; the page reloads after it is ready."}</p></dd></div>
    </dl>
  </section>;
}
