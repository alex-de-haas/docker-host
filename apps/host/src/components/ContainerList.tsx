'use client';

import { Fragment, useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import {
  ChevronRight,
  Play,
  Square,
  RotateCcw,
  Download,
  LoaderCircle,
  Trash2,
  Terminal,
  ExternalLink,
  MoreVertical,
  Plus,
  Save,
  X,
} from 'lucide-react';
import { ContainerAction, ContainerStatus, ContainerWithConfig, EnvironmentVariable } from '@/types/docker';
import { Status, StatusIndicator, StatusLabel } from '@/components/ui/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ContainerListProps {
  containers: ContainerStatus[];
  pendingAction: { id: string; action: Extract<ContainerAction, 'start' | 'stop' | 'restart' | 'update' | 'environment'> } | null;
  updateAvailableByContainerId: Record<string, boolean>;
  onAction: (id: string, action: Extract<ContainerAction, 'start' | 'stop' | 'restart' | 'update'>) => void;
  onRemove: (id: string) => void;
  onViewLogs: (id: string) => void;
  onUpdateEnvironment: (id: string, envVars: EnvironmentVariable[]) => Promise<boolean>;
}

const statusMap: Record<string, 'online' | 'offline' | 'maintenance' | 'degraded'> = {
  running: 'online',
  stopped: 'offline',
  exited: 'offline',
  restarting: 'maintenance',
  paused: 'degraded',
  dead: 'offline',
};

export function ContainerList({
  containers,
  pendingAction,
  updateAvailableByContainerId,
  onAction,
  onRemove,
  onViewLogs,
  onUpdateEnvironment,
}: ContainerListProps) {
  const [expandedContainerId, setExpandedContainerId] = useState<string | null>(null);
  const [containerDetails, setContainerDetails] = useState<Record<string, ContainerWithConfig>>({});
  const [loadingDetailsId, setLoadingDetailsId] = useState<string | null>(null);
  const [detailsError, setDetailsError] = useState<Record<string, string>>({});
  const [environmentDrafts, setEnvironmentDrafts] = useState<Record<string, EnvironmentVariable[]>>({});
  const [environmentErrors, setEnvironmentErrors] = useState<Record<string, string>>({});

  const toggleExpanded = async (id: string) => {
    if (expandedContainerId === id) {
      setExpandedContainerId(null);
      return;
    }

    setExpandedContainerId(id);

    if (containerDetails[id] || loadingDetailsId === id) {
      return;
    }

    setLoadingDetailsId(id);
    setDetailsError(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });

    try {
      const response = await fetch(`/api/containers/${id}`);
      if (!response.ok) {
        throw new Error('Failed to fetch container details');
      }

      const data: ContainerWithConfig = await response.json();
      setContainerDetails(current => ({ ...current, [id]: data }));
    } catch (error) {
      setDetailsError(current => ({
        ...current,
        [id]: error instanceof Error ? error.message : 'Unknown error',
      }));
    } finally {
      setLoadingDetailsId(current => (current === id ? null : current));
    }
  };

  const addEnvironmentDraft = (id: string) => {
    setEnvironmentDrafts(current => ({
      ...current,
      [id]: [...(current[id] ?? []), { key: '', value: '' }],
    }));
    setEnvironmentErrors(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const updateEnvironmentDraft = (
    id: string,
    index: number,
    field: keyof EnvironmentVariable,
    value: string
  ) => {
    setEnvironmentDrafts(current => ({
      ...current,
      [id]: (current[id] ?? []).map((envVar, envVarIndex) =>
        envVarIndex === index ? { ...envVar, [field]: value } : envVar
      ),
    }));
  };

  const removeEnvironmentDraft = (id: string, index: number) => {
    setEnvironmentDrafts(current => ({
      ...current,
      [id]: (current[id] ?? []).filter((_, envVarIndex) => envVarIndex !== index),
    }));
  };

  const handleEnvironmentSubmit = async (event: FormEvent, id: string) => {
    event.preventDefault();

    const validation = validateEnvironmentDrafts(environmentDrafts[id] ?? []);
    if (!validation.ok) {
      setEnvironmentErrors(current => ({ ...current, [id]: validation.error }));
      return;
    }

    setEnvironmentErrors(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });

    const success = await onUpdateEnvironment(id, validation.envVars);
    if (!success) {
      return;
    }

    setEnvironmentDrafts(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setContainerDetails(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setExpandedContainerId(current => (current === id ? null : current));
  };

  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12" />
            <TableHead className="w-[200px]">Name</TableHead>
            <TableHead>Image</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Uptime</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {containers.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                No containers found. Create one to get started.
              </TableCell>
            </TableRow>
          ) : (
            containers.map((container, index) => {
              const showUpdateAction =
                updateAvailableByContainerId[container.id] ||
                (pendingAction?.id === container.id && pendingAction.action === 'update');
              const isUpdatingEnvironment =
                pendingAction?.id === container.id && pendingAction.action === 'environment';
              const environmentDraft = environmentDrafts[container.id] ?? [];

              return (
              <Fragment key={container.id}>
                <motion.tr
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className={`border-b transition-colors hover:bg-muted/50 ${
                    pendingAction?.id === container.id ? 'bg-muted/30' : ''
                  }`}
                >
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-expanded={expandedContainerId === container.id}
                      aria-label={expandedContainerId === container.id ? 'Collapse details' : 'Expand details'}
                      onClick={() => void toggleExpanded(container.id)}
                    >
                      <ChevronRight
                        className={`h-4 w-4 transition-transform ${
                          expandedContainerId === container.id ? 'rotate-90' : ''
                        }`}
                      />
                    </Button>
                  </TableCell>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <span className="max-w-[180px] truncate">{container.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-2 py-1 text-xs">
                      {container.image}
                    </code>
                  </TableCell>
                  <TableCell>
                    <Status status={statusMap[container.status] || 'offline'}>
                      <StatusIndicator />
                      <StatusLabel />
                    </Status>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {container.uptime || '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {pendingAction?.id === container.id && (
                        <span className="mr-2 text-xs text-muted-foreground">
                          {pendingAction.action === 'update'
                            ? 'Updating...'
                            : pendingAction.action === 'environment'
                              ? 'Updating env...'
                              : 'Working...'}
                        </span>
                      )}
                      {container.status === 'running' ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onAction(container.id, 'stop')}
                          title="Stop"
                          disabled={pendingAction?.id === container.id}
                        >
                          {pendingAction?.id === container.id && pendingAction.action === 'stop' ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                          ) : (
                            <Square className="h-4 w-4" />
                          )}
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onAction(container.id, 'start')}
                          title="Start"
                          disabled={pendingAction?.id === container.id}
                        >
                          {pendingAction?.id === container.id && pendingAction.action === 'start' ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                          ) : (
                            <Play className="h-4 w-4" />
                          )}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onAction(container.id, 'restart')}
                        title="Restart"
                        disabled={pendingAction?.id === container.id}
                      >
                        {pendingAction?.id === container.id && pendingAction.action === 'restart' ? (
                          <LoaderCircle className="h-4 w-4 animate-spin" />
                        ) : (
                          <RotateCcw className="h-4 w-4" />
                        )}
                      </Button>
                      {showUpdateAction && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onAction(container.id, 'update')}
                          title="Update container"
                          disabled={pendingAction?.id === container.id}
                        >
                          {pendingAction?.id === container.id && pendingAction.action === 'update' ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                          ) : (
                            <Download className="h-4 w-4" />
                          )}
                        </Button>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" disabled={pendingAction?.id === container.id}>
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => onViewLogs(container.id)}>
                            <Terminal className="mr-2 h-4 w-4" />
                            View Logs
                          </DropdownMenuItem>
                          {container.ports.length > 0 && container.status === 'running' && (
                            <DropdownMenuItem
                              onClick={() => {
                                const port = container.ports[0]?.split(':')[0];
                                if (port) window.open(`http://localhost:${port}`, '_blank');
                              }}
                            >
                              <ExternalLink className="mr-2 h-4 w-4" />
                              Open in Browser
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => onRemove(container.id)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </motion.tr>
                {expandedContainerId === container.id && (
                  <TableRow className="bg-muted/20 hover:bg-muted/20">
                    <TableCell colSpan={6} className="p-0">
                      <div className="grid gap-3 border-t px-4 py-4 md:grid-cols-2">
                        <section className="space-y-2 rounded-md border bg-background/80 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <h3 className="text-sm font-medium">Ports</h3>
                            <span className="text-xs text-muted-foreground">Configured mappings</span>
                          </div>
                          {loadingDetailsId === container.id ? (
                            <p className="text-sm text-muted-foreground">Loading port mappings...</p>
                          ) : detailsError[container.id] ? (
                            <p className="text-sm text-destructive">{detailsError[container.id]}</p>
                          ) : (containerDetails[container.id]?.config?.ports.length ?? 0) > 0 ? (
                            <div className="flex flex-wrap gap-2">
                              {containerDetails[container.id]?.config?.ports.map((port) => (
                                <code
                                  key={`${port.hostPort}-${port.containerPort}-${port.protocol}`}
                                  className="rounded bg-muted px-2 py-1 text-xs"
                                >
                                  {port.hostPort}:{port.containerPort}/{port.protocol}
                                </code>
                              ))}
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground">No ports configured.</p>
                          )}
                        </section>

                        <section className="space-y-2 rounded-md border bg-background/80 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <h3 className="text-sm font-medium">Environment</h3>
                              <span className="text-xs text-muted-foreground">Container variables</span>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => addEnvironmentDraft(container.id)}
                              disabled={loadingDetailsId === container.id || pendingAction?.id === container.id}
                            >
                              <Plus className="h-4 w-4" />
                              Add
                            </Button>
                          </div>
                          <div className="space-y-3">
                            {loadingDetailsId === container.id ? (
                              <p className="text-sm text-muted-foreground">Loading environment variables...</p>
                            ) : detailsError[container.id] ? (
                              <p className="text-sm text-destructive">{detailsError[container.id]}</p>
                            ) : (containerDetails[container.id]?.config?.envVars.length ?? 0) > 0 ? (
                              <div className="space-y-2">
                                {containerDetails[container.id]?.config?.envVars.map((envVar) => (
                                  <div
                                    key={`${envVar.key}-${envVar.value}`}
                                    className="grid gap-1 rounded bg-muted/60 px-2 py-2 text-xs md:grid-cols-[minmax(0,180px)_1fr] md:items-start md:gap-3"
                                  >
                                    <code className="truncate font-medium">{envVar.key}</code>
                                    <code className="overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground">
                                      {envVar.value || '<empty>'}
                                    </code>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-sm text-muted-foreground">No environment variables configured.</p>
                            )}

                            {environmentDraft.length > 0 && !detailsError[container.id] && (
                              <form
                                onSubmit={(event) => void handleEnvironmentSubmit(event, container.id)}
                                className="space-y-2 border-t pt-3"
                              >
                                {environmentDraft.map((envVar, envVarIndex) => (
                                  <div
                                    key={envVarIndex}
                                    className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] md:items-center"
                                  >
                                    <Input
                                      placeholder="KEY"
                                      value={envVar.key}
                                      onChange={(event) =>
                                        updateEnvironmentDraft(container.id, envVarIndex, 'key', event.target.value)
                                      }
                                      disabled={isUpdatingEnvironment}
                                      aria-label="Environment variable key"
                                    />
                                    <span className="hidden text-sm text-muted-foreground md:block">=</span>
                                    <Input
                                      placeholder="value"
                                      value={envVar.value}
                                      onChange={(event) =>
                                        updateEnvironmentDraft(container.id, envVarIndex, 'value', event.target.value)
                                      }
                                      disabled={isUpdatingEnvironment}
                                      aria-label="Environment variable value"
                                    />
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-sm"
                                      onClick={() => removeEnvironmentDraft(container.id, envVarIndex)}
                                      disabled={isUpdatingEnvironment}
                                      aria-label="Remove environment variable"
                                      title="Remove"
                                    >
                                      <X className="h-4 w-4" />
                                    </Button>
                                  </div>
                                ))}
                                {environmentErrors[container.id] && (
                                  <p className="text-sm text-destructive">{environmentErrors[container.id]}</p>
                                )}
                                <div className="flex justify-end">
                                  <Button type="submit" size="sm" disabled={isUpdatingEnvironment}>
                                    {isUpdatingEnvironment ? (
                                      <LoaderCircle className="h-4 w-4 animate-spin" />
                                    ) : (
                                      <Save className="h-4 w-4" />
                                    )}
                                    Apply
                                  </Button>
                                </div>
                              </form>
                            )}
                          </div>
                        </section>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function validateEnvironmentDrafts(envVars: EnvironmentVariable[]):
  | { ok: true; envVars: EnvironmentVariable[] }
  | { ok: false; error: string } {
  const normalized = envVars
    .map(envVar => ({ key: envVar.key.trim(), value: envVar.value }))
    .filter(envVar => envVar.key || envVar.value);

  if (normalized.length === 0) {
    return { ok: false, error: 'Add at least one environment variable.' };
  }

  const seenKeys = new Set<string>();

  for (const envVar of normalized) {
    if (!envVar.key) {
      return { ok: false, error: 'Environment variable key is required.' };
    }

    if (envVar.key.includes('=')) {
      return { ok: false, error: 'Environment variable key must not contain "=".' };
    }

    if (seenKeys.has(envVar.key)) {
      return { ok: false, error: `Environment variable "${envVar.key}" is duplicated.` };
    }

    seenKeys.add(envVar.key);
  }

  return { ok: true, envVars: normalized };
}
