'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Plus, RefreshCw, Container } from 'lucide-react';
import { useContainers } from '@/hooks/useDocker';
import { ContainerList } from '@/components/ContainerList';
import { CreateContainerDialog } from '@/components/CreateContainerDialog';
import { LogsDialog } from '@/components/LogsDialog';
import { StatsCards } from '@/components/StatsCards';
import { Button } from '@/components/ui/button';

export default function Dashboard() {
  const { containers, loading, error, refetch, performAction, removeContainer, createContainer } = useContainers();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [logsDialog, setLogsDialog] = useState<{ open: boolean; containerId: string | null; containerName: string }>({
    open: false,
    containerId: null,
    containerName: '',
  });

  const handleViewLogs = (id: string) => {
    const container = containers.find(c => c.id === id);
    setLogsDialog({
      open: true,
      containerId: id,
      containerName: container?.name || 'Unknown',
    });
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between px-4">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex items-center gap-2"
          >
            <Container className="h-6 w-6 text-primary" />
            <h1 className="text-xl font-semibold">Docker Host Manager</h1>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex items-center gap-2"
          >
            <Button variant="outline" size="icon" onClick={refetch} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button onClick={() => setCreateDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              New Container
            </Button>
          </motion.div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container px-4 py-8 space-y-8">
        {/* Error Banner */}
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-destructive/10 text-destructive rounded-lg p-4"
          >
            <p className="text-sm font-medium">Error: {error}</p>
            <p className="text-xs mt-1">
              When this app runs inside Docker Desktop, mount the Docker socket into the app container
              or configure `DOCKER_HOST` or `DOCKER_SOCKET_PATH`.
            </p>
          </motion.div>
        )}

        {/* Stats */}
        <section>
          <StatsCards containers={containers} />
        </section>

        {/* Container List */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Containers</h2>
            <span className="text-sm text-muted-foreground">
              {containers.length} container{containers.length !== 1 ? 's' : ''}
            </span>
          </div>
          
          {loading && containers.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ContainerList
              containers={containers}
              onAction={performAction}
              onRemove={removeContainer}
              onViewLogs={handleViewLogs}
            />
          )}
        </section>
      </main>

      {/* Dialogs */}
      <CreateContainerDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreate={createContainer}
      />
      
      <LogsDialog
        containerId={logsDialog.containerId}
        containerName={logsDialog.containerName}
        open={logsDialog.open}
        onOpenChange={(open) => setLogsDialog(prev => ({ ...prev, open }))}
      />
    </div>
  );
}
