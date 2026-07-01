"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, ChevronDown, LineChart, ListChecks, LoaderCircle, RefreshCw } from "lucide-react";
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
import {
  isInfrastructureMetric,
  MetricSeriesCard,
  METRIC_RANGES,
  metricGroup,
  metricSeriesKey,
} from "../../observability/metric-series-card";
import { MetricSelectorTree, type MetricGroup } from "../../observability/metric-selector-tree";
import { METRICS_SELECTED_STORAGE_KEY } from "../../shell-routes";
import type { AppMetricsResponse, CoreApp } from "../../types";
import { EmptyState, PageHeader } from "../../ui";

const ALL = "__all__";

type MetricsState = { loading: boolean; error: string | null; metrics: AppMetricsResponse | null };

// The instrument names ticked on the Metrics page, read back from localStorage. Empty by default —
// only the pinned CPU/memory series show until the user opts metrics in.
function readSelectedMetrics(): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }
  try {
    const raw = window.localStorage.getItem(METRICS_SELECTED_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? new Set(parsed.filter((value): value is string => typeof value === "string")) : new Set();
  } catch {
    return new Set();
  }
}

// Cross-resource Metrics view, modelled on the .NET Aspire "Metrics" page: pick a resource (or all),
// pick a time range, then tick the instruments to chart in the meter tree on the left. CPU and memory
// (docker stats) are pinned and always charted. Charts reuse the same MetricSeriesCard as the per-app
// observability dialog.
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
  const [selected, setSelected] = useState<Set<string>>(() => readSelectedMetrics());

  // Persist the ticked instruments across reloads (empty set = only pinned CPU/memory show).
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(METRICS_SELECTED_STORAGE_KEY, JSON.stringify([...selected]));
  }, [selected]);

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

  const toggleInstrument = useCallback((name: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const setGroup = useCallback((names: string[], select: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const name of names) {
        if (select) {
          next.add(name);
        } else {
          next.delete(name);
        }
      }
      return next;
    });
  }, []);

  // The instruments Core has buffered for the current resource selection, split into the pinned
  // infrastructure series and the selectable meter groups. Each instrument name maps to a single
  // meter, so we key by name and take the first group we see for it.
  const { pinned, groups } = useMemo(() => {
    const groupByName = new Map<string, string>();
    for (const app of targetApps) {
      for (const series of metricsByApp[app.id]?.metrics?.series ?? []) {
        if (!groupByName.has(series.name)) {
          groupByName.set(series.name, metricGroup(series));
        }
      }
    }
    const pinnedNames = [...groupByName.keys()].filter(isInfrastructureMetric).sort();
    const byGroup = new Map<string, string[]>();
    for (const [name, group] of groupByName) {
      if (isInfrastructureMetric(name)) {
        continue;
      }
      const bucket = byGroup.get(group);
      if (bucket) {
        bucket.push(name);
      } else {
        byGroup.set(group, [name]);
      }
    }
    const groupList: MetricGroup[] = [...byGroup.entries()]
      .map(([group, instruments]) => ({ group, instruments: instruments.sort() }))
      .sort((a, b) => a.group.localeCompare(b.group));
    return { pinned: pinnedNames, groups: groupList };
  }, [targetApps, metricsByApp]);

  const hasAnyInstrument = pinned.length > 0 || groups.length > 0;

  const selectedLabel =
    selectedAppId === ALL ? "All resources" : apps.find((app) => app.id === selectedAppId)?.displayName ?? "All resources";

  const anyLoading = targetApps.some((app) => metricsByApp[app.id]?.loading);
  // Apps with at least one buffered series, in selection order.
  const populated = targetApps.filter((app) => (metricsByApp[app.id]?.metrics?.series.length ?? 0) > 0);
  const everyTargetSettled = targetApps.every((app) => metricsByApp[app.id] && !metricsByApp[app.id]!.loading);

  // Per resource, the series to chart: the pinned infra ones plus any ticked instrument. Infra first
  // so CPU/memory lead each section (stable sort keeps API order within each rank).
  const sections = populated
    .map((app) => ({
      app,
      series: (metricsByApp[app.id]?.metrics?.series ?? [])
        .filter((series) => isInfrastructureMetric(series.name) || selected.has(series.name))
        .sort((a, b) => Number(isInfrastructureMetric(b.name)) - Number(isInfrastructureMetric(a.name))),
    }))
    .filter((section) => section.series.length > 0);

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
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          {hasAnyInstrument && (
            <MetricSelectorTree
              groups={groups}
              pinnedInstruments={pinned}
              selected={selected}
              onToggleInstrument={toggleInstrument}
              onSetGroup={setGroup}
            />
          )}
          <div className="min-w-0 flex-1">
            {populated.length === 0 ? (
              anyLoading || !everyTargetSettled ? (
                <EmptyState icon={LoaderCircle} title="Loading metrics" iconClassName="animate-spin" />
              ) : (
                <EmptyState
                  icon={Activity}
                  title="No metrics"
                  description="Metrics appear once an app is running and observability is enabled on the host (HOSTY_OBSERVABILITY_ENABLED)."
                />
              )
            ) : sections.length === 0 ? (
              <EmptyState
                icon={ListChecks}
                title="Select metrics"
                description="Tick metrics in the list to chart them. CPU and memory appear automatically for containerized apps."
              />
            ) : (
              <div className="space-y-6">
                {sections.map(({ app, series }) => (
                  <section key={app.id} className="space-y-3">
                    <h3 className="text-sm font-medium">{app.displayName}</h3>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {series.map((entry) => (
                        <MetricSeriesCard key={metricSeriesKey(entry)} series={entry} />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
