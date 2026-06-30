"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, ChevronDown, LineChart, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { isAuthRequiredRedirectError, readCoreError, redirectToCoreLoginIfAuthRequired } from "../../core-api";
import { MetricSeriesCard, METRIC_RANGES, metricSeriesKey } from "../../observability/metric-series-card";
import type { AppMetricsResponse, CoreApp } from "../../types";
import { EmptyState, PageHeader } from "../../ui";

const ALL = "__all__";

type MetricsState = { loading: boolean; error: string | null; metrics: AppMetricsResponse | null };

// Cross-resource Metrics view, modelled on the .NET Aspire "Metrics" page: pick a resource (or all),
// pick a time range, and see the metric series Core has buffered for it. Charts reuse the same
// MetricSeriesCard as the per-app observability dialog.
export function ObservabilityMetricsPage({
  runtimeApps,
  systemApps,
  coreOrigin,
}: {
  runtimeApps: CoreApp[];
  systemApps: CoreApp[];
  coreOrigin: string;
}) {
  const apps = useMemo(() => [...runtimeApps, ...systemApps], [runtimeApps, systemApps]);
  const [selectedAppId, setSelectedAppId] = useState<string>(ALL);
  const [rangeSeconds, setRangeSeconds] = useState(900);
  const [metricsByApp, setMetricsByApp] = useState<Record<string, MetricsState>>({});

  // Keep the selection valid as the app set changes (e.g. an app is uninstalled) — adjust during
  // render, not in an effect. https://react.dev/learn/you-might-not-need-an-effect
  const appsSignature = apps.map((app) => app.id).join(",");
  const [prevAppsSignature, setPrevAppsSignature] = useState(appsSignature);
  if (prevAppsSignature !== appsSignature) {
    setPrevAppsSignature(appsSignature);
    if (selectedAppId !== ALL && !apps.some((app) => app.id === selectedAppId)) {
      setSelectedAppId(ALL);
    }
  }

  // The apps the current selection asks for (all of them, or a single resource).
  const targetApps = useMemo(
    () => (selectedAppId === ALL ? apps : apps.filter((app) => app.id === selectedAppId)),
    [apps, selectedAppId],
  );

  const loadAppMetrics = useCallback(
    async (app: CoreApp, range: number) => {
      setMetricsByApp((current) => ({
        ...current,
        [app.id]: { loading: true, error: null, metrics: current[app.id]?.metrics ?? null },
      }));
      try {
        const response = await fetch(`${coreOrigin}/api/apps/${encodeURIComponent(app.id)}/metrics?range=${range}`, {
          credentials: "include",
        });
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          throw new Error(await readCoreError(response));
        }
        const metrics = (await response.json()) as AppMetricsResponse;
        setMetricsByApp((current) => ({ ...current, [app.id]: { loading: false, error: null, metrics } }));
      } catch (error) {
        if (isAuthRequiredRedirectError(error)) {
          return;
        }
        setMetricsByApp((current) => ({
          ...current,
          [app.id]: {
            loading: false,
            error: error instanceof Error ? error.message : "Metrics are unavailable.",
            metrics: current[app.id]?.metrics ?? null,
          },
        }));
      }
    },
    [coreOrigin],
  );

  const refresh = useCallback(
    (range: number) => {
      for (const app of targetApps) {
        void loadAppMetrics(app, range);
      }
    },
    [targetApps, loadAppMetrics],
  );

  // Reload whenever the selection or range changes. `refresh` is memoized on `targetApps`, which is
  // referentially stable (derived from the memoized app list), so depending on it does not loop.
  useEffect(() => {
    refresh(rangeSeconds);
  }, [refresh, rangeSeconds]);

  const selectRange = (seconds: number) => setRangeSeconds(seconds);

  const selectedLabel =
    selectedAppId === ALL ? "All resources" : apps.find((app) => app.id === selectedAppId)?.displayName ?? "All resources";

  const anyLoading = targetApps.some((app) => metricsByApp[app.id]?.loading);
  // Apps with at least one buffered series, in selection order.
  const populated = targetApps.filter((app) => (metricsByApp[app.id]?.metrics?.series.length ?? 0) > 0);
  const everyTargetSettled = targetApps.every((app) => metricsByApp[app.id] && !metricsByApp[app.id]!.loading);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Metrics"
        description="Resource metrics Core has buffered over the selected range (live, last hour)."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  {selectedLabel}
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Resource</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup value={selectedAppId} onValueChange={setSelectedAppId}>
                  <DropdownMenuRadioItem value={ALL}>All resources</DropdownMenuRadioItem>
                  {apps.map((app) => (
                    <DropdownMenuRadioItem key={app.id} value={app.id}>
                      {app.displayName}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex gap-1">
              {METRIC_RANGES.map((range) => (
                <Button
                  key={range.seconds}
                  variant={range.seconds === rangeSeconds ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => selectRange(range.seconds)}
                >
                  {range.label}
                </Button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={() => refresh(rangeSeconds)} disabled={targetApps.length === 0}>
              <RefreshCw className={cn("h-4 w-4", anyLoading && "animate-spin")} />
              Refresh
            </Button>
          </div>
        }
      />

      {targetApps.some((app) => metricsByApp[app.id]?.error) && (
        <div className="space-y-2">
          {targetApps.map((app) => {
            const error = metricsByApp[app.id]?.error;
            return error ? (
              <div
                key={app.id}
                className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
              >
                {app.displayName}: {error}
              </div>
            ) : null;
          })}
        </div>
      )}

      {targetApps.length === 0 ? (
        <EmptyState icon={LineChart} title="No resources" description="Install an app to see its metrics." />
      ) : populated.length === 0 ? (
        anyLoading || !everyTargetSettled ? (
          <EmptyState icon={LoaderCircle} title="Loading metrics" iconClassName="animate-spin" />
        ) : (
          <EmptyState
            icon={Activity}
            title="No metrics"
            description="Metrics appear once an app is running and observability is enabled on the host (HOSTY_OBSERVABILITY_ENABLED)."
          />
        )
      ) : (
        <div className="space-y-6">
          {populated.map((app) => (
            <section key={app.id} className="space-y-3">
              <h3 className="text-sm font-medium">{app.displayName}</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {(metricsByApp[app.id]?.metrics?.series ?? []).map((entry) => (
                  <MetricSeriesCard key={metricSeriesKey(entry)} series={entry} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
