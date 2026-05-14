'use client';

import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Boxes,
  ChevronRight,
  CircleAlert,
  Clock3,
  LoaderCircle,
  Play,
  RotateCcw,
  Square,
} from 'lucide-react';
import type { ModuleLifecycleAction } from '@/hooks/useModules';
import type { ModuleRuntimeState, ModuleSummary } from '@/types/modules';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Status, StatusIndicator, StatusLabel } from '@/components/ui/status';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface ModuleListProps {
  modules: ModuleSummary[];
  pendingAction: { id: string; action: ModuleLifecycleAction } | null;
  onAction: (id: string, action: ModuleLifecycleAction) => void;
}

const runtimeStatusMap: Record<ModuleRuntimeState, 'online' | 'offline' | 'maintenance' | 'degraded'> = {
  not_created: 'offline',
  created: 'offline',
  running: 'online',
  paused: 'degraded',
  restarting: 'maintenance',
  exited: 'offline',
  dead: 'offline',
  unknown: 'degraded',
};

const runtimeLabels: Record<ModuleRuntimeState, string> = {
  not_created: 'Not created',
  created: 'Created',
  running: 'Running',
  paused: 'Paused',
  restarting: 'Restarting',
  exited: 'Exited',
  dead: 'Dead',
  unknown: 'Unknown',
};

export function ModuleList({ modules, pendingAction, onAction }: ModuleListProps) {
  const [expandedModuleId, setExpandedModuleId] = useState<string | null>(null);

  if (modules.length === 0) {
    return <EmptyModuleState />;
  }

  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12" />
            <TableHead className="min-w-[220px]">Module</TableHead>
            <TableHead className="min-w-[180px]">Image</TableHead>
            <TableHead>Runtime</TableHead>
            <TableHead>Operation</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {modules.map(module => {
            const isExpanded = expandedModuleId === module.id;
            const modulePendingAction = pendingAction?.id === module.id ? pendingAction.action : null;
            const isRunning = module.runtimeStatus.state === 'running';
            const disabled = Boolean(modulePendingAction);

            return (
              <Fragment key={module.id}>
                <TableRow
                  className={`border-b transition-colors hover:bg-muted/50 ${
                    modulePendingAction ? 'bg-muted/30' : ''
                  }`}
                >
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? 'Collapse module details' : 'Expand module details'}
                      onClick={() => setExpandedModuleId(current => (current === module.id ? null : module.id))}
                    >
                      <ChevronRight className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                    </Button>
                  </TableCell>
                  <TableCell className="font-medium">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="max-w-[260px] truncate">{module.name}</span>
                      <span className="max-w-[260px] truncate text-xs text-muted-foreground">{module.id}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-2 py-1 text-xs">{module.image.reference}</code>
                  </TableCell>
                  <TableCell>
                    <Status status={runtimeStatusMap[module.runtimeStatus.state]} title={module.runtimeStatus.containerName}>
                      <StatusIndicator />
                      <StatusLabel>{runtimeLabels[module.runtimeStatus.state]}</StatusLabel>
                    </Status>
                  </TableCell>
                  <TableCell>
                    <Badge variant={module.operationStatus === 'failed' ? 'destructive' : 'outline'}>
                      {module.operationStatus}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {modulePendingAction && (
                        <span className="mr-2 hidden text-xs text-muted-foreground sm:inline">
                          {actionProgressLabels[modulePendingAction]}
                        </span>
                      )}
                      {isRunning ? (
                        <IconActionButton
                          action="stop"
                          title="Stop module"
                          icon={<Square className="h-4 w-4" />}
                          pendingAction={modulePendingAction}
                          disabled={disabled}
                          onClick={() => onAction(module.id, 'stop')}
                        />
                      ) : (
                        <IconActionButton
                          action="start"
                          title="Start module"
                          icon={<Play className="h-4 w-4" />}
                          pendingAction={modulePendingAction}
                          disabled={disabled || module.runtimeStatus.state === 'not_created'}
                          onClick={() => onAction(module.id, 'start')}
                        />
                      )}
                      <IconActionButton
                        action="restart"
                        title="Restart module"
                        icon={<RotateCcw className="h-4 w-4" />}
                        pendingAction={modulePendingAction}
                        disabled={disabled || module.runtimeStatus.state === 'not_created'}
                        onClick={() => onAction(module.id, 'restart')}
                      />
                    </div>
                  </TableCell>
                </TableRow>
                {isExpanded && (
                  <TableRow className="bg-muted/20 hover:bg-muted/20">
                    <TableCell colSpan={6} className="p-0 whitespace-normal">
                      <ModuleDetails module={module} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function EmptyModuleState() {
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center rounded-lg border bg-card px-6 text-center">
      <div className="mb-4 rounded-md bg-muted p-3">
        <Boxes className="h-6 w-6 text-muted-foreground" />
      </div>
      <h3 className="text-base font-semibold">No installed modules</h3>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        The Host modules store is empty. Phase 4 validates this state directly; module install flows arrive in a later phase.
      </p>
    </div>
  );
}

function ModuleDetails({ module }: { module: ModuleSummary }) {
  const installedAt = formatDate(module.installedAt);
  const updatedAt = formatDate(module.updatedAt);
  const startedAt = formatDate(module.runtimeStatus.startedAt);
  const finishedAt = formatDate(module.runtimeStatus.finishedAt);

  return (
    <div className="grid gap-4 border-t px-4 py-4 md:grid-cols-3">
      <section className="space-y-2">
        <h4 className="text-sm font-medium">Metadata</h4>
        <dl className="space-y-1 text-sm">
          <DetailRow label="Version" value={module.version} />
          <DetailRow label="Metadata URL" value={module.metadataUrl} />
          <DetailRow label="Updated" value={updatedAt} icon={<Clock3 className="h-3.5 w-3.5" />} />
        </dl>
      </section>
      <section className="space-y-2">
        <h4 className="text-sm font-medium">Container</h4>
        <dl className="space-y-1 text-sm">
          <DetailRow label="Name" value={module.runtimeStatus.containerName} />
          <DetailRow label="Container ID" value={module.runtimeStatus.containerId || '-'} />
          <DetailRow label="Started" value={startedAt} />
          <DetailRow label="Finished" value={finishedAt} />
        </dl>
      </section>
      <section className="space-y-2">
        <h4 className="text-sm font-medium">Install record</h4>
        <dl className="space-y-1 text-sm">
          <DetailRow label="Installed" value={installedAt} />
          <DetailRow label="Pull policy" value={module.image.pullPolicy || '-'} />
          {module.description && <DetailRow label="Description" value={module.description} />}
          {(module.lastError || module.runtimeStatus.error) && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">
              <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase">
                <CircleAlert className="h-3.5 w-3.5" />
                Last error
              </div>
              <p className="text-sm">{module.lastError?.message || module.runtimeStatus.error}</p>
            </div>
          )}
        </dl>
      </section>
    </div>
  );
}

function DetailRow({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1 break-all text-foreground">
        {icon}
        <span>{value}</span>
      </dd>
    </div>
  );
}

function IconActionButton({
  action,
  title,
  icon,
  pendingAction,
  disabled,
  onClick,
}: {
  action: ModuleLifecycleAction;
  title: string;
  icon: ReactNode;
  pendingAction: ModuleLifecycleAction | null;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button variant="ghost" size="icon" title={title} disabled={disabled} onClick={onClick}>
      {pendingAction === action ? <LoaderCircle className="h-4 w-4 animate-spin" /> : icon}
    </Button>
  );
}

function formatDate(value?: string | null) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

const actionProgressLabels: Record<ModuleLifecycleAction, string> = {
  start: 'Starting...',
  stop: 'Stopping...',
  restart: 'Restarting...',
};
