'use client';

import Link from 'next/link';
import { Plus, RefreshCw } from 'lucide-react';
import { AdminShell, HostPageHeader } from '@/components/AdminShell';
import { ModuleList } from '@/components/ModuleList';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useModules } from '@/hooks/useModules';

export function InstalledModulesClient() {
  const {
    modules,
    loading,
    error,
    refreshState,
    pendingAction,
    refetch,
    performAction,
    getRecoveryPlan,
    applyRecoveryAction,
  } = useModules();

  const isRefreshing = refreshState !== 'idle';

  return (
    <AdminShell contentClassName="space-y-6">
      <HostPageHeader
        title="Installed modules"
        description="Module state is resolved through the Host backend API and Docker runtime state."
        actions={(
          <>
            <Badge variant="outline">
              {modules.length} module{modules.length !== 1 ? 's' : ''}
            </Badge>
            <Button variant="outline" size="icon" onClick={refetch} disabled={isRefreshing} aria-label="Refresh modules">
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </Button>
            <Button asChild>
              <Link href="/modules/install">
                <Plus className="h-4 w-4" />
                Install module
              </Link>
            </Button>
          </>
        )}
      />

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-lg p-4">
          <p className="text-sm font-medium">Error: {error}</p>
          <p className="text-xs mt-1">
            Module lifecycle actions require the Host backend to reach Docker and the Host modules store.
          </p>
        </div>
      )}

      {loading && modules.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <ModuleList
          modules={modules}
          pendingAction={pendingAction}
          onAction={performAction}
          onRecoveryPlan={getRecoveryPlan}
          onRecoveryApply={applyRecoveryAction}
        />
      )}
    </AdminShell>
  );
}
