'use client';

import Link from 'next/link';
import {
  Activity,
  ArrowRight,
  Boxes,
  CircleAlert,
  PackageCheck,
  RefreshCw,
} from 'lucide-react';
import type { ModuleSummary } from '@/types/modules';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface InstalledModulesWidgetProps {
  modules: ModuleSummary[];
  lastUpdatedAt: number | null;
  refreshState: 'idle' | 'refreshing';
  onRefresh: () => void;
  installedModulesHref: string;
}

export function InstalledModulesWidget({
  modules,
  lastUpdatedAt,
  refreshState,
  onRefresh,
  installedModulesHref,
}: InstalledModulesWidgetProps) {
  const running = modules.filter(module => module.runtimeStatus.state === 'running').length;
  const installed = modules.filter(module => module.operationStatus === 'installed').length;
  const attention = modules.filter(module =>
    module.operationStatus === 'failed' ||
    module.runtimeStatus.state === 'degraded' ||
    module.runtimeStatus.state === 'unknown' ||
    Boolean(module.lastError)
  ).length;
  const isRefreshing = refreshState !== 'idle';
  const refreshLabel = getRefreshLabel(refreshState, lastUpdatedAt);
  const health = getHealthSummary(modules.length, running, attention);
  const metrics = [
    {
      label: 'Running',
      value: running,
      icon: Activity,
      tone: 'text-emerald-700 bg-emerald-500/10',
    },
    {
      label: 'Installed',
      value: installed,
      icon: PackageCheck,
      tone: 'text-zinc-700 bg-zinc-500/10',
    },
    {
      label: 'Needs attention',
      value: attention,
      icon: CircleAlert,
      tone: 'text-amber-700 bg-amber-500/10',
    },
  ];

  return (
    <Card className="rounded-lg py-0">
      <CardHeader className="gap-4 border-b px-5 py-4 sm:flex sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">Installed modules</CardTitle>
            <Badge variant="outline" className={cn('border-transparent', health.className)}>
              {health.label}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Module count, runtime state, and basic health checks.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline" className="gap-1.5">
            {isRefreshing ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
            )}
            {refreshLabel}
          </Badge>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label="Refresh installed modules widget"
          >
            <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-5 px-5 py-5">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-4xl font-semibold leading-none">{modules.length}</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {pluralize(modules.length, 'module')} installed
                </div>
              </div>
              <div className="rounded-md bg-sky-500/10 p-2 text-sky-700">
                <Boxes className="h-5 w-5" />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Runtime coverage</span>
                <span>{running}/{modules.length || 0} running</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    attention > 0 ? 'bg-amber-500' : 'bg-emerald-500'
                  )}
                  style={{ width: `${getRuntimeCoverage(running, modules.length)}%` }}
                />
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {metrics.map(metric => (
              <div key={metric.label} className="rounded-md border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">{metric.label}</span>
                  <span className={cn('rounded-md p-1.5', metric.tone)}>
                    <metric.icon className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-3 text-2xl font-semibold">{metric.value}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            The full module list, lifecycle actions, and install flow live on the Installed modules page.
          </p>
          <Button asChild variant="outline">
            <Link href={installedModulesHref}>
              Open installed modules
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function getRefreshLabel(refreshState: InstalledModulesWidgetProps['refreshState'], lastUpdatedAt: number | null) {
  if (refreshState === 'refreshing') {
    return 'Refreshing';
  }

  if (!lastUpdatedAt) {
    return 'Waiting for sync';
  }

  return `Updated ${new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(lastUpdatedAt)}`;
}

function getHealthSummary(total: number, running: number, attention: number) {
  if (attention > 0) {
    return {
      label: `${attention} need attention`,
      className: 'bg-amber-500/10 text-amber-700',
    };
  }

  if (total === 0) {
    return {
      label: 'No modules',
      className: 'bg-muted text-muted-foreground',
    };
  }

  if (running === total) {
    return {
      label: 'Healthy',
      className: 'bg-emerald-500/10 text-emerald-700',
    };
  }

  return {
    label: `${running}/${total} running`,
    className: 'bg-sky-500/10 text-sky-700',
  };
}

function getRuntimeCoverage(running: number, total: number) {
  if (total === 0) {
    return 0;
  }

  return Math.round((running / total) * 100);
}

function pluralize(value: number, singular: string) {
  return value === 1 ? singular : `${singular}s`;
}
