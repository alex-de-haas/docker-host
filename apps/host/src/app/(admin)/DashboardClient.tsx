'use client';

import { AdminShell, HostPageHeader } from '@/components/AdminShell';
import { InstalledModulesWidget } from '@/components/InstalledModulesWidget';
import { useModules } from '@/hooks/useModules';

export function DashboardClient() {
  const {
    modules,
    error,
    lastUpdatedAt,
    refreshState,
    refetch,
  } = useModules();

  return (
    <AdminShell>
      <HostPageHeader
        title="Dashboard"
        description="Host overview widgets"
      />

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-lg p-4">
          <p className="text-sm font-medium">Error: {error}</p>
          <p className="text-xs mt-1">
            Module lifecycle actions require the Host backend to reach Docker and the Host modules store.
          </p>
        </div>
      )}

      <section>
        <InstalledModulesWidget
          modules={modules}
          lastUpdatedAt={lastUpdatedAt}
          refreshState={refreshState}
          onRefresh={refetch}
          installedModulesHref="/modules"
        />
      </section>
    </AdminShell>
  );
}
