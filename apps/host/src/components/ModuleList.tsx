'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Boxes,
  ChevronRight,
  CircleAlert,
  Clock3,
  Eraser,
  ArrowUpCircle,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react';
import type { ModuleLifecycleAction } from '@/hooks/useModules';
import type {
  ModuleRecoveryAction,
  ModuleRecoveryPlan,
  ModuleRecoveryPlanResponse,
  ModuleAggregateRuntimeState,
  ModuleRuntimeState,
  ModuleSummary,
} from '@/types/modules';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
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
  onRecoveryPlan: (
    id: string,
    action: ModuleRecoveryAction,
    deleteModuleData: boolean
  ) => Promise<ModuleRecoveryPlanResponse>;
  onRecoveryApply: (
    id: string,
    action: ModuleRecoveryAction,
    deleteModuleData: boolean
  ) => Promise<boolean>;
}

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

const aggregateRuntimeStatusMap: Record<ModuleAggregateRuntimeState, 'online' | 'offline' | 'maintenance' | 'degraded'> = {
  not_created: 'offline',
  running: 'online',
  degraded: 'degraded',
  exited: 'offline',
  unknown: 'degraded',
};

const aggregateRuntimeLabels: Record<ModuleAggregateRuntimeState, string> = {
  not_created: 'Not created',
  running: 'Running',
  degraded: 'Degraded',
  exited: 'Stopped',
  unknown: 'Unknown',
};

interface RecoveryDialogState {
  module: ModuleSummary;
  action: ModuleRecoveryAction;
  deleteModuleData: boolean;
  plan: ModuleRecoveryPlan | null;
  loading: boolean;
  applying: boolean;
  error: string | null;
}

export function ModuleList({
  modules,
  pendingAction,
  onAction,
  onRecoveryPlan,
  onRecoveryApply,
}: ModuleListProps) {
  const [expandedModuleId, setExpandedModuleId] = useState<string | null>(null);
  const [recoveryDialog, setRecoveryDialog] = useState<RecoveryDialogState | null>(null);

  if (modules.length === 0) {
    return <EmptyModuleState />;
  }

  async function openRecoveryDialog(module: ModuleSummary, action: ModuleRecoveryAction) {
    setRecoveryDialog({
      module,
      action,
      deleteModuleData: false,
      plan: null,
      loading: true,
      applying: false,
      error: null,
    });

    try {
      const response = await onRecoveryPlan(module.id, action, false);
      setRecoveryDialog(current =>
        current && current.module.id === module.id && current.action === action
          ? {
              ...current,
              plan: response.plan ?? null,
              loading: false,
              error: response.error ? formatPlanError(response) : null,
            }
          : current
      );
    } catch (error) {
      setRecoveryDialog(current =>
        current && current.module.id === module.id && current.action === action
          ? {
              ...current,
              loading: false,
              error: error instanceof Error ? error.message : 'Recovery plan could not be loaded.',
            }
          : current
      );
    }
  }

  async function setDeleteModuleData(deleteModuleData: boolean) {
    const current = recoveryDialog;
    if (!current) {
      return;
    }

    setRecoveryDialog({
      ...current,
      deleteModuleData,
      loading: true,
      error: null,
    });

    try {
      const response = await onRecoveryPlan(current.module.id, current.action, deleteModuleData);
      setRecoveryDialog(previous =>
        previous && previous.module.id === current.module.id && previous.action === current.action
          ? {
              ...previous,
              plan: response.plan ?? null,
              loading: false,
              error: response.error ? formatPlanError(response) : null,
            }
          : previous
      );
    } catch (error) {
      setRecoveryDialog(previous =>
        previous && previous.module.id === current.module.id && previous.action === current.action
          ? {
              ...previous,
              loading: false,
              error: error instanceof Error ? error.message : 'Recovery plan could not be refreshed.',
            }
          : previous
      );
    }
  }

  async function applyRecoveryDialog() {
    const current = recoveryDialog;
    if (!current || !current.plan?.canApply) {
      return;
    }

    setRecoveryDialog({ ...current, applying: true, error: null });
    const applied = await onRecoveryApply(
      current.module.id,
      current.action,
      current.deleteModuleData
    );

    if (applied) {
      setRecoveryDialog(null);
    } else {
      setRecoveryDialog(previous =>
        previous
          ? {
              ...previous,
              applying: false,
            }
          : previous
      );
    }
  }

  return (
    <>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12" />
              <TableHead className="min-w-[220px]">Module</TableHead>
              <TableHead className="min-w-[180px]">Services</TableHead>
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
              const disabled = Boolean(modulePendingAction) || module.operationStatus === 'removing';
              const lifecycleDisabled = disabled || module.operationStatus !== 'installed';

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
                    <div className="flex flex-wrap gap-1">
                      {module.containers.map(container => (
                        <Badge key={container.key} variant="outline" className="max-w-[180px] truncate">
                          {container.key}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Status status={aggregateRuntimeStatusMap[module.runtimeStatus.state]} title={`${module.runtimeStatus.runningContainers}/${module.runtimeStatus.totalContainers} running`}>
                      <StatusIndicator />
                      <StatusLabel>{aggregateRuntimeLabels[module.runtimeStatus.state]}</StatusLabel>
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
                          disabled={lifecycleDisabled}
                          onClick={() => onAction(module.id, 'stop')}
                        />
                      ) : (
                        <IconActionButton
                          action="start"
                          title="Start module"
                          icon={<Play className="h-4 w-4" />}
                          pendingAction={modulePendingAction}
                          disabled={lifecycleDisabled || module.runtimeStatus.state === 'not_created'}
                          onClick={() => onAction(module.id, 'start')}
                        />
                      )}
                      <IconActionButton
                        action="restart"
                        title="Restart module"
                        icon={<RotateCcw className="h-4 w-4" />}
                        pendingAction={modulePendingAction}
                        disabled={lifecycleDisabled || module.runtimeStatus.state === 'not_created'}
                        onClick={() => onAction(module.id, 'restart')}
                      />
                      {module.operationStatus === 'failed' && module.lastOperation === 'update' && (
                        <>
                          <IconActionButton
                            action="update-retry"
                            title="Retry failed update"
                            icon={<RefreshCw className="h-4 w-4" />}
                            pendingAction={modulePendingAction}
                            disabled={disabled}
                            onClick={() => onAction(module.id, 'update-retry')}
                          />
                          <IconLinkButton
                            title="Review update again"
                            href={`/modules/${encodeURIComponent(module.id)}/update`}
                            icon={<ArrowUpCircle className="h-4 w-4" />}
                            disabled={disabled}
                          />
                        </>
                      )}
                      {module.operationStatus === 'failed' && module.lastOperation !== 'update' && (
                        <>
                          <IconActionButton
                            action="retry"
                            title="Retry failed install"
                            icon={<RefreshCw className="h-4 w-4" />}
                            pendingAction={modulePendingAction}
                            disabled={disabled}
                            onClick={() => onAction(module.id, 'retry')}
                          />
                          <IconActionButton
                            action="cleanup"
                            title="Clean up failed install"
                            icon={<Eraser className="h-4 w-4" />}
                            pendingAction={modulePendingAction}
                            disabled={disabled}
                            onClick={() => void openRecoveryDialog(module, 'cleanup')}
                          />
                        </>
                      )}
                      {module.operationStatus === 'installed' && (
                        <>
                          <IconLinkButton
                            title="Update module"
                            href={`/modules/${encodeURIComponent(module.id)}/update`}
                            icon={<ArrowUpCircle className="h-4 w-4" />}
                            disabled={disabled}
                          />
                          <IconActionButton
                            action="remove"
                            title="Remove module"
                            icon={<Trash2 className="h-4 w-4" />}
                            pendingAction={modulePendingAction}
                            disabled={disabled}
                            onClick={() => void openRecoveryDialog(module, 'remove')}
                          />
                        </>
                      )}
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
      <RecoveryPlanDialog
        state={recoveryDialog}
        onOpenChange={open => {
          if (!open) {
            setRecoveryDialog(null);
          }
        }}
        onDeleteModuleDataChange={value => void setDeleteModuleData(value)}
        onApply={() => void applyRecoveryDialog()}
      />
    </>
  );
}

function RecoveryPlanDialog({
  state,
  onOpenChange,
  onDeleteModuleDataChange,
  onApply,
}: {
  state: RecoveryDialogState | null;
  onOpenChange: (open: boolean) => void;
  onDeleteModuleDataChange: (value: boolean) => void;
  onApply: () => void;
}) {
  const plan = state?.plan ?? null;
  const actionLabel = state?.action === 'cleanup' ? 'Clean up failed install' : 'Remove module';
  const applying = Boolean(state?.applying);
  const loading = Boolean(state?.loading);
  const canApply = Boolean(plan?.canApply) && !loading && !applying;

  return (
    <Dialog open={Boolean(state)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{actionLabel}</DialogTitle>
          <DialogDescription>
            {state?.module.name || 'Module'} artifacts are listed before anything is changed.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Loading recovery plan
          </div>
        )}

        {state?.error && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {state.error}
          </div>
        )}

        {plan && (
          <div className="grid gap-4">
            <div className="grid gap-3 rounded-md border p-3 text-sm sm:grid-cols-2">
              <PlanItem
                label="Services"
                value={plan.containers.map(container => `${container.key}: ${container.name} (${container.exists ? 'will be removed' : 'missing'})`).join(', ') || 'none'}
              />
              <PlanItem
                label="Images"
                value={plan.images.map(image => `${image.container}: ${image.reference} (preserved)`).join(', ') || 'none'}
              />
              <PlanItem label="Metadata" value={plan.metadataFile.exists ? 'will be deleted' : 'missing'} />
              <PlanItem label="Dependents" value={plan.dependents.length ? plan.dependents.map(item => item.id).join(', ') : 'none'} />
            </div>

            <div className="space-y-2">
              <h4 className="text-sm font-medium">Module-owned data</h4>
              <div className="max-h-40 overflow-auto rounded-md border">
                {plan.storageDirectories.length === 0 ? (
                  <p className="p-3 text-sm text-muted-foreground">No module-owned storage mappings.</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {plan.storageDirectories.map(directory => (
                      <li key={`${directory.key}:${directory.container}:${directory.containerPath}`} className="grid gap-1 p-3">
                        <span className="font-medium">{directory.key} / {directory.container}</span>
                        <span className="break-all text-xs text-muted-foreground">{directory.hostPath}</span>
                        <span className="text-xs text-muted-foreground">
                          {directory.willDelete ? 'will be deleted' : 'will be preserved'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {plan.externalMounts.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">External mounts</h4>
                <div className="max-h-32 overflow-auto rounded-md border">
                  <ul className="divide-y text-sm">
                    {plan.externalMounts.map(mount => (
                      <li key={`${mount.collectionKey}:${mount.key}:${mount.container}:${mount.containerPath}`} className="grid gap-1 p-3">
                        <span className="font-medium">{mount.label || mount.key} / {mount.container}</span>
                        <span className="break-all text-xs text-muted-foreground">{mount.hostPath}</span>
                        <span className="text-xs text-muted-foreground">mapping removed; host path preserved</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            <Label className="items-start gap-3 rounded-md border p-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={state?.deleteModuleData ?? false}
                disabled={loading || applying}
                onChange={event => onDeleteModuleDataChange(event.target.checked)}
              />
              <span className="grid gap-1">
                <span>Delete module-owned data directories</span>
                <span className="text-xs font-normal text-muted-foreground">
                  External host paths are never deleted.
                </span>
              </span>
            </Label>

            {plan.warnings.length > 0 && (
              <ul className="grid gap-1 text-xs text-muted-foreground">
                {plan.warnings.map(warning => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>
            Cancel
          </Button>
          <Button
            variant={state?.action === 'remove' || state?.deleteModuleData ? 'destructive' : 'default'}
            onClick={onApply}
            disabled={!canApply}
          >
            {applying && <LoaderCircle className="h-4 w-4 animate-spin" />}
            {state?.action === 'cleanup' ? 'Apply cleanup' : 'Remove module'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlanItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="break-all">{value}</span>
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
        The Host modules store is empty. Install a module from a metadata URL to populate this dashboard.
      </p>
    </div>
  );
}

function ModuleDetails({ module }: { module: ModuleSummary }) {
  const installedAt = formatDate(module.installedAt);
  const updatedAt = formatDate(module.updatedAt);

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
        <h4 className="text-sm font-medium">Services</h4>
        <div className="space-y-3 text-sm">
          {module.containers.map(container => (
            <dl key={container.key} className="space-y-1 rounded-md border p-3">
              <DetailRow label="Service" value={container.key} />
              <DetailRow label="Name" value={container.runtimeStatus.containerName} />
              <DetailRow label="Container ID" value={container.runtimeStatus.containerId || '-'} />
              <DetailRow label="Runtime" value={runtimeLabels[container.runtimeStatus.state]} />
              <DetailRow label="Started" value={formatDate(container.runtimeStatus.startedAt)} />
              <DetailRow label="Finished" value={formatDate(container.runtimeStatus.finishedAt)} />
            </dl>
          ))}
        </div>
      </section>
      <section className="space-y-2">
        <h4 className="text-sm font-medium">Install record</h4>
        <dl className="space-y-1 text-sm">
          <DetailRow label="Installed" value={installedAt} />
          <DetailRow label="Pull policy" value={module.containers.map(container => `${container.key}: ${container.image.pullPolicy || '-'}`).join(', ') || '-'} />
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

function IconLinkButton({
  title,
  href,
  icon,
  disabled,
}: {
  title: string;
  href: string;
  icon: ReactNode;
  disabled: boolean;
}) {
  if (disabled) {
    return (
      <Button variant="ghost" size="icon" title={title} disabled>
        {icon}
      </Button>
    );
  }

  return (
    <Button asChild variant="ghost" size="icon" title={title}>
      <Link href={href}>{icon}</Link>
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
  retry: 'Retrying...',
  'update-retry': 'Retrying update...',
  cleanup: 'Cleaning up...',
  remove: 'Removing...',
};

function formatPlanError(response: ModuleRecoveryPlanResponse) {
  if (!response.error) {
    return null;
  }

  return [
    response.error.message,
    ...response.error.conflicts.map(conflict => conflict.message),
  ].filter(Boolean).join(' ');
}
