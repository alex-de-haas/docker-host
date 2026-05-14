'use client';

import { Boxes, LoaderCircle, RefreshCw } from 'lucide-react';
import { ModuleList } from '@/components/ModuleList';
import { ModuleStatsCards } from '@/components/ModuleStatsCards';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useModules } from '@/hooks/useModules';

export default function Dashboard() {
  const {
    modules,
    loading,
    error,
    lastUpdatedAt,
    refreshState,
    pendingAction,
    refetch,
    performAction,
  } = useModules();

  const isRefreshing = refreshState !== 'idle';
  const refreshLabel =
    refreshState === 'refreshing'
      ? 'Refreshing data'
      : lastUpdatedAt
        ? `Updated ${new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }).format(lastUpdatedAt)}`
        : 'Waiting for first sync';

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Boxes className="h-6 w-6 text-primary" />
            <h1 className="text-xl font-semibold">Docker Host Manager</h1>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="hidden sm:inline-flex">
              {isRefreshing ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <span className="h-2 w-2 rounded-full bg-emerald-500" />}
              {refreshLabel}
            </Badge>
            <Button variant="outline" size="icon" onClick={refetch} disabled={isRefreshing}>
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </header>

      <main className="container px-4 py-8 space-y-8">
        {error && (
          <div className="bg-destructive/10 text-destructive rounded-lg p-4">
            <p className="text-sm font-medium">Error: {error}</p>
            <p className="text-xs mt-1">
              Module lifecycle actions require the Host backend to reach Docker and the Host modules store.
            </p>
          </div>
        )}

        <section>
          <ModuleStatsCards modules={modules} />
        </section>

        <section className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Installed modules</h2>
              <p className="text-sm text-muted-foreground">
                Module state is resolved through the Host backend API and Docker runtime state.
              </p>
            </div>
            <span className="text-sm text-muted-foreground">
              {modules.length} module{modules.length !== 1 ? 's' : ''}
            </span>
          </div>

          {loading && modules.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ModuleList
              modules={modules}
              pendingAction={pendingAction}
              onAction={performAction}
            />
          )}
        </section>
      </main>
    </div>
  );
}
