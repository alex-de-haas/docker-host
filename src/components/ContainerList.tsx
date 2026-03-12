'use client';

import { Fragment, useState } from 'react';
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
} from 'lucide-react';
import { ContainerAction, ContainerStatus, ContainerWithConfig } from '@/types/docker';
import { Status, StatusIndicator, StatusLabel } from '@/components/ui/status';
import { Button } from '@/components/ui/button';
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
  pendingAction: { id: string; action: Extract<ContainerAction, 'start' | 'stop' | 'restart' | 'update'> } | null;
  updateAvailableByContainerId: Record<string, boolean>;
  onAction: (id: string, action: Extract<ContainerAction, 'start' | 'stop' | 'restart' | 'update'>) => void;
  onRemove: (id: string) => void;
  onViewLogs: (id: string) => void;
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
}: ContainerListProps) {
  const [expandedContainerId, setExpandedContainerId] = useState<string | null>(null);
  const [containerDetails, setContainerDetails] = useState<Record<string, ContainerWithConfig>>({});
  const [loadingDetailsId, setLoadingDetailsId] = useState<string | null>(null);
  const [detailsError, setDetailsError] = useState<Record<string, string>>({});

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
                          {pendingAction.action === 'update' ? 'Updating...' : 'Working...'}
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
                            <h3 className="text-sm font-medium">Environment</h3>
                            <span className="text-xs text-muted-foreground">Container variables</span>
                          </div>
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
