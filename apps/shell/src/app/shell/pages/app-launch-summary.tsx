"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, Box, Layers3, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { AppHealthResponse, AppUpdateStatusResponse, CoreApp, RuntimeServiceRow } from "../types";
import { buildRuntimeServiceRows, shortDigest } from "../app-helpers";
import { fetchCore } from "../core-transport.js";
import { isAuthRequiredRedirectError, readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";
import { isAppUp } from "../runtime-states";
import { Alert, StatusBadge } from "../ui";
import { ResourceUsage, ResourceUsageProvider } from "../resources/resource-usage";

type ServiceDetails = {
  key: string;
  health: AppHealthResponse | null;
  update: AppUpdateStatusResponse | null;
  healthLoading: boolean;
  updateLoading: boolean;
  healthError: string | null;
  updateError: string | null;
};

function normalizeDigest(value?: string | null): string | null {
  if (!value) return null;
  const index = value.indexOf("sha256:");
  return index === -1 ? null : value.slice(index);
}

function ServiceDigestRow({ label, digest, tone }: { label: string; digest: string; tone?: "warning" | "update" }) {
  return <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
    <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
    <span className={"truncate font-mono " + (tone === "warning" ? "text-warning-foreground" : tone === "update" ? "text-success-foreground" : "text-foreground")} title={digest}>{shortDigest(digest) ?? digest}</span>
  </div>;
}

/** Detail reads happen on entry, an app change or an explicit refresh; resource samples remain live. */
export function AppLaunchSummary({ app, coreOrigin, serviceRevision = 0 }: { app: CoreApp; coreOrigin: string; serviceRevision?: number }) {
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [details, setDetails] = useState<ServiceDetails | null>(null);
  // Summary metrics and SSE snapshots must not trigger repeated health probes. These primitive
  // facts change when a lifecycle/update/source action makes previous service detail obsolete.
  const readKey = JSON.stringify([coreOrigin, app.id, app.version, app.selectedRuntime, app.runtimeState,
    app.operationStatus, app.health?.status, app.sourceLivePath, app.sourceOverridePath, app.sourceManagedPath, app.artifactLocks, app.updateCheck?.planDigest, app.updateCheck?.checkedAt, serviceRevision]);
  useEffect(() => {
    const controller = new AbortController();
    setDetails(previous => ({
      key: readKey,
      health: previous?.key === readKey ? previous.health : null,
      update: previous?.key === readKey ? previous.update : null,
      healthLoading: true, updateLoading: true, healthError: null, updateError: null,
    }));
    const load = async (kind: "health" | "update") => {
      try {
        // Without refresh=true, update-status projects Core's cached plan without registry work.
        const response = await fetchCore(coreOrigin + "/api/apps/" + encodeURIComponent(app.id) + "/" + (kind === "health" ? "health" : "update-status"), {
          credentials: "include", cache: "no-store", signal: controller.signal,
        });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) throw new Error(await readCoreError(response));
        const payload = await response.json();
        if (!controller.signal.aborted) setDetails(previous => previous?.key === readKey ? {
          ...previous, [kind]: payload, [kind + "Loading"]: false, [kind + "Error"]: null,
        } : previous);
      } catch (cause) {
        if (!controller.signal.aborted) setDetails(previous => previous?.key === readKey ? {
          ...previous, [kind + "Loading"]: false,
          [kind + "Error"]: isAuthRequiredRedirectError(cause) ? null : cause instanceof Error ? cause.message : "Service details are unavailable.",
        } : previous);
      }
    };
    void load("health");
    void load("update");
    return () => controller.abort();
  }, [app.id, coreOrigin, readKey, refreshRevision]);
  const current = details?.key === readKey ? details : null;
  const health = current?.health;
  const observedHealth: AppHealthResponse | null = health ?? (app.health ? {
    appId: app.id, runtime: app.selectedRuntime ?? "", runtimeType: "", status: app.health.status,
    services: app.health.services,
  } : null);
  const healthByService = new Map((observedHealth?.services ?? []).map(service => [service.service, service]));
  const statusByService = new Map((current?.update?.services ?? []).map(service => [service.service, service]));
  const services = new Map(buildRuntimeServiceRows(app, observedHealth).map(service => [service.service, {
    ...service, status: healthByService.get(service.service)?.status || "unknown",
  }]));
  // A background/worker image may have neither an endpoint nor a health observation.
  for (const name of [...Object.keys(app.artifactLocks ?? {}), ...statusByService.keys()]) {
    if (!services.has(name)) services.set(name, { service: name, status: "unknown", message: null, endpoints: [] } satisfies RuntimeServiceRow);
  }
  const dependencies = app.dependencies ?? [];
  const canReadResources = isAppUp(app.runtimeState) && app.operationStatus !== "updating";
  const rows = [...services.values()].sort((a, b) => a.service.localeCompare(b.service));
  const hasReadings = canReadResources && rows.some(service => !["stopped", "exited", "unknown"].includes(service.status));
  const loading = !current || current.healthLoading || current.updateLoading;
  const body = <section aria-labelledby={"app-services-" + app.id} className="overflow-hidden rounded-xl border bg-card">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/25 px-4 py-3">
      <div><h3 id={"app-services-" + app.id} className="flex items-center gap-2 text-sm font-medium"><Box className="size-4 text-muted-foreground" aria-hidden />Services</h3><p className="mt-1 text-xs text-muted-foreground">Observed state and resource use. CPU: 100% is one logical core.</p></div>
      <div className="flex flex-wrap items-center gap-1">
        <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => setRefreshRevision(value => value + 1)}><RefreshCw className={"size-3.5 " + (loading ? "animate-spin motion-reduce:animate-none" : "")} aria-hidden />{loading ? "Loading services" : "Refresh services"}</Button>
        <Button asChild variant="ghost" size="sm"><Link href="/dashboard">Dashboard<ArrowUpRight className="size-3.5" /></Link></Button>
      </div>
    </div>
    {current?.healthError && <div className="px-4 pt-3"><Alert severity="warning" title="Service health is unavailable" detail={current.healthError} />{health && <p className="mt-2 text-xs text-muted-foreground">Last loaded service details are shown.</p>}</div>}
    {current?.updateError && <div className="px-4 pt-3"><Alert severity="warning" title="Digest details are unavailable" detail={current.updateError} /></div>}
    <div className="divide-y">{rows.length ? rows.map(service => {
      const serviceHealth = healthByService.get(service.service);
      const serviceStatus = statusByService.get(service.service);
      const locked = normalizeDigest(app.artifactLocks?.[service.service]?.imageDigest ?? serviceStatus?.lockedDigest);
      const running = normalizeDigest(serviceHealth?.image);
      const matchedDigest = locked && running && locked === running ? locked : null;
      const drift = Boolean(locked && running && locked !== running);
      const candidate = serviceStatus?.updateAvailable ? normalizeDigest(serviceStatus.candidateDigest) : null;
      const digestRows = Boolean(locked || running || serviceStatus) && !matchedDigest;
      return <article key={service.service} aria-label={"Service " + service.service} className="min-w-0 space-y-3 px-4 py-3">
        <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(8rem,11rem)] sm:items-center">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2"><h4 className="break-all font-mono text-sm">{service.service}</h4>
              {serviceHealth?.runtimeType && <Badge variant="outline" className="text-[10px] font-normal">{serviceHealth.runtimeType === "docker" ? "Docker" : serviceHealth.runtimeType === "localCommand" ? "Local" : serviceHealth.runtimeType}{serviceHealth.artifact ? " · " + serviceHealth.artifact : ""}</Badge>}
              {matchedDigest && <Badge variant="outline" className="font-mono text-[10px] font-normal text-muted-foreground" title={"Running the locked build — " + matchedDigest}>{shortDigest(matchedDigest) ?? matchedDigest}</Badge>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{service.endpoints.map(endpoint => endpoint.protocol).filter((value, index, all) => all.indexOf(value) === index).join(", ") || "No declared endpoints"}</p>
            {service.message && <p className="mt-1 break-words text-xs text-muted-foreground">{service.message}</p>}
          </div>
          <div className="flex flex-wrap gap-1.5">{serviceHealth?.health && <StatusBadge value={serviceHealth.health} />}<StatusBadge value={service.status} /></div>
          {canReadResources && !["stopped", "exited", "unknown"].includes(service.status)
            ? <ResourceUsage appId={app.id} service={service.service} label={app.displayName + " · " + service.service} />
            : <p className="text-xs text-muted-foreground">Resource readings unavailable</p>}
        </div>
        {(serviceHealth?.startedAt || serviceHealth?.restartCount != null) && <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          {serviceHealth.startedAt && <div className="min-w-0"><dt className="inline">Started </dt><dd className="inline break-all"><time dateTime={serviceHealth.startedAt}>{serviceHealth.startedAt}</time></dd></div>}
          {serviceHealth.restartCount != null && <div><dt className="inline">Restarts </dt><dd className="inline font-mono">{serviceHealth.restartCount}</dd></div>}
        </dl>}
        {(digestRows || candidate || serviceStatus?.unknown) && <div className="grid gap-1 rounded-md border bg-muted/20 px-3 py-2 text-xs">
          {digestRows && <>{locked && <ServiceDigestRow label="Locked" digest={locked} />}{running && <ServiceDigestRow label="Running" digest={running} tone={drift ? "warning" : undefined} />}</>}
          {drift && <p className="text-[11px] text-warning-foreground">Running a different build than the recorded lock.</p>}
          {candidate && <ServiceDigestRow label="Available" digest={candidate} tone="update" />}
          {serviceStatus?.unknown && <p className="text-[11px] text-muted-foreground">Update check unavailable (registry unreachable).</p>}
        </div>}
      </article>;
    }) : <p className="px-4 py-5 text-sm text-muted-foreground">No service observations are available.</p>}</div>
  </section>;
  return <div className="space-y-4">
    <section aria-labelledby={"app-dependencies-" + app.id} className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b bg-muted/25 px-4 py-3"><h3 id={"app-dependencies-" + app.id} className="flex items-center gap-2 text-sm font-medium"><Layers3 className="size-4 text-muted-foreground" aria-hidden />Starts after</h3><p className="mt-1 text-xs text-muted-foreground">Application dependencies declared by this app.</p></div>
      <div className="divide-y">{dependencies.length ? dependencies.map(dependency => <div key={dependency.appId} className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0"><p className="break-all font-mono text-sm">{dependency.appId}</p><p className="mt-1 text-xs text-muted-foreground">{dependency.required ? "Required" : "Optional"}{dependency.version ? " · " + dependency.version : ""}</p></div>
        <div className="flex flex-wrap gap-1.5"><Badge variant="outline">{!dependency.installed ? "Not installed" : dependency.ready === true ? "Ready" : dependency.ready === false ? "Not ready" : dependency.running ? "Running · readiness unavailable" : "Stopped"}</Badge>{dependency.endpoints?.some(endpoint => !endpoint.resolved) && <Badge variant="outline">Endpoint unresolved</Badge>}</div>
      </div>) : <p className="px-4 py-5 text-sm text-muted-foreground">This app declares no application dependencies.</p>}</div>
    </section>
    {hasReadings ? <ResourceUsageProvider coreOrigin={coreOrigin}>{body}</ResourceUsageProvider> : body}
  </div>;
}
