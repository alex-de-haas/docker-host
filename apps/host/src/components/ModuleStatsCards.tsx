'use client';

import { Activity, Boxes, CircleAlert, PackageCheck } from 'lucide-react';
import type { ModuleSummary } from '@/types/modules';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface ModuleStatsCardsProps {
  modules: ModuleSummary[];
}

export function ModuleStatsCards({ modules }: ModuleStatsCardsProps) {
  const runningServices = modules.reduce(
    (count, module) => count + module.containers.filter(container => container.runtimeStatus.state === 'running').length,
    0
  );
  const attention = modules.filter(module =>
    module.operationStatus === 'failed' ||
    module.runtimeStatus.state === 'degraded' ||
    module.runtimeStatus.state === 'unknown' ||
    Boolean(module.lastError)
  ).length;

  const stats = [
    {
      title: 'Installed modules',
      value: modules.length,
      icon: Boxes,
      color: 'text-sky-600',
      bg: 'bg-sky-500/10',
    },
    {
      title: 'Running services',
      value: runningServices,
      icon: Activity,
      color: 'text-emerald-600',
      bg: 'bg-emerald-500/10',
    },
    {
      title: 'Installed',
      value: modules.filter(module => module.operationStatus === 'installed').length,
      icon: PackageCheck,
      color: 'text-zinc-600',
      bg: 'bg-zinc-500/10',
    },
    {
      title: 'Needs attention',
      value: attention,
      icon: CircleAlert,
      color: 'text-amber-600',
      bg: 'bg-amber-500/10',
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {stats.map(stat => (
        <div key={stat.title}>
          <Card className="rounded-lg">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
              <div className={`rounded-md p-2 ${stat.bg}`}>
                <stat.icon className={`h-4 w-4 ${stat.color}`} />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{stat.value}</div>
            </CardContent>
          </Card>
        </div>
      ))}
    </div>
  );
}
