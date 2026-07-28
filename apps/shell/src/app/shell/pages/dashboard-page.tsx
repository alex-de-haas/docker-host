"use client";

import { Activity, ArrowRight, Boxes, CircleAlert, LoaderCircle, PackageCheck, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getHealthSummary, getRuntimeCoverage, pluralize } from "../app-helpers";
import type { CoreApp, CoreStatus, LoadState } from "../types";
import { Fact, PageHeader, StatusBadge } from "../ui";
import { isAppBusy, isAppUp } from "../runtime-states";

export function DashboardPage({
  state,
  runtimeApps,
  onRefresh,
  onOpenInstalledApps,
}: {
  state: LoadState;
  runtimeApps: CoreApp[];
  onRefresh: () => void;
  onOpenInstalledApps: () => void;
}) {
  const running = runtimeApps.filter((app) => isAppUp(app.runtimeState)).length;
  // Apps mid-verb are counted apart from both buckets: calling them "not running" reads as a
  // shortfall during a boot that is going fine, and calling them a problem is worse.
  const transitioning = runtimeApps.filter((app) => isAppBusy(app.runtimeState)).length;
  const installed = runtimeApps.length;
  const attention = runtimeApps.filter((app) => app.lastError || app.operationStatus === "failed" || app.runtimeState === "unknown").length;

  return (
    <div className="space-y-8">
      <PageHeader title="Dashboard" description="Host overview widgets" />

      <InstalledAppsWidget
        apps={runtimeApps}
        running={running}
        transitioning={transitioning}
        installed={installed}
        attention={attention}
        loading={state.loading}
        onRefresh={onRefresh}
        onOpenInstalledApps={onOpenInstalledApps}
      />

      <CoreStatusWidget status={state.status} loading={state.loading} />
    </div>
  );
}

function InstalledAppsWidget({
  apps,
  running,
  transitioning,
  installed,
  attention,
  loading,
  onRefresh,
  onOpenInstalledApps,
}: {
  apps: CoreApp[];
  running: number;
  transitioning: number;
  installed: number;
  attention: number;
  loading: boolean;
  onRefresh: () => void;
  onOpenInstalledApps: () => void;
}) {
  const health = getHealthSummary(apps.length, running, attention);
  const metrics = [
    { label: "Running", value: running, icon: Activity, tone: "text-emerald-700 bg-emerald-500/10" },
    // Only shown while something is actually in flight, so the steady-state widget keeps its
    // three tiles and does not grow a permanent zero.
    ...(transitioning > 0
      ? [{ label: "In progress", value: transitioning, icon: LoaderCircle, tone: "text-sky-700 bg-sky-500/10 dark:text-sky-300" }]
      : []),
    { label: "Installed", value: installed, icon: PackageCheck, tone: "text-zinc-700 bg-zinc-500/10 dark:text-zinc-300" },
    { label: "Needs attention", value: attention, icon: CircleAlert, tone: "text-amber-700 bg-amber-500/10" },
  ];

  return (
    <Card className="rounded-lg py-0">
      <CardHeader className="gap-4 border-b px-5 py-4 sm:flex sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">Installed Apps</CardTitle>
            <Badge variant="outline" className={cn("border-transparent", health.className)}>{health.label}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">App count, runtime state, and basic Core health checks.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="outline" size="icon" onClick={onRefresh} disabled={loading} aria-label="Refresh installed apps widget">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 px-5 py-5">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-4xl font-semibold leading-none">{apps.length}</div>
                <div className="mt-1 text-sm text-muted-foreground">{pluralize(apps.length, "app")} installed</div>
              </div>
              <div className="rounded-md bg-sky-500/10 p-2 text-sky-700">
                <Boxes className="h-5 w-5" />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Runtime coverage</span>
                <span>{running}/{apps.length || 0} running</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full transition-all", attention > 0 ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${getRuntimeCoverage(running, apps.length)}%` }} />
              </div>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {metrics.map((metric) => (
              <div key={metric.label} className="rounded-md border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">{metric.label}</span>
                  <span className={cn("rounded-md p-1.5", metric.tone)}>
                    <metric.icon className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-3 text-2xl font-semibold">{metric.value}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">The full app list, lifecycle actions, install flow, updates, backups, and settings live on the Installed Apps page.</p>
          <Button type="button" variant="outline" onClick={onOpenInstalledApps}>
            Open Installed Apps
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CoreStatusWidget({ status, loading }: { status: CoreStatus | null; loading: boolean }) {
  const facts = [
    ["Component", status?.component || "unknown"],
    ["Version", status?.version ? `v${status.version}` : "unknown"],
    ["Listen URL", status?.listenUrl || "unknown"],
    ["Core origin", status?.corePublicOrigin || "not configured"],
    ["Shell origin", status?.shellPublicOrigin || "not configured"],
    ["Local runtime host", status?.runtimePublicHost || "unknown"],
    ["Data root", status?.dataRoot || "unknown"],
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>Core</CardTitle>
            <CardDescription>Core process and runtime origins.</CardDescription>
          </div>
          <StatusBadge value={status?.status || (loading ? "loading" : "offline")} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <Fact key={label} label={label} value={value} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
