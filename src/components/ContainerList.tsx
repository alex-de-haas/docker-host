'use client';

import { motion } from 'framer-motion';
import {
  Play,
  Square,
  RotateCcw,
  Download,
  Trash2,
  Terminal,
  ExternalLink,
  MoreVertical,
} from 'lucide-react';
import { ContainerAction, ContainerStatus } from '@/types/docker';
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

export function ContainerList({ containers, onAction, onRemove, onViewLogs }: ContainerListProps) {
  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[200px]">Name</TableHead>
            <TableHead>Image</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Ports</TableHead>
            <TableHead>Uptime</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {containers.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                No containers found. Create one to get started.
              </TableCell>
            </TableRow>
          ) : (
            containers.map((container, index) => (
              <motion.tr
                key={container.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
                className="border-b transition-colors hover:bg-muted/50"
              >
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    <span className="truncate max-w-[180px]">{container.name}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-2 py-1 rounded">
                    {container.image}
                  </code>
                </TableCell>
                <TableCell>
                  <Status status={statusMap[container.status] || 'offline'}>
                    <StatusIndicator />
                    <StatusLabel />
                  </Status>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {container.ports.slice(0, 3).map((port, i) => (
                      <code key={i} className="text-xs bg-muted px-2 py-1 rounded">
                        {port}
                      </code>
                    ))}
                    {container.ports.length > 3 && (
                      <span className="text-xs text-muted-foreground">
                        +{container.ports.length - 3} more
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {container.uptime || '-'}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {container.status === 'running' ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onAction(container.id, 'stop')}
                        title="Stop"
                      >
                        <Square className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onAction(container.id, 'start')}
                        title="Start"
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onAction(container.id, 'restart')}
                      title="Restart"
                    >
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onAction(container.id, 'update')}
                      title="Update container"
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
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
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
