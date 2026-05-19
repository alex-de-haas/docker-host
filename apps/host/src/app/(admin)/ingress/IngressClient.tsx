'use client';

import { useState } from 'react';
import { AdminShell } from '@/components/AdminShell';
import { ExternalIngressReadinessPanel } from '@/components/ExternalIngressReadinessPanel';
import { GatewayExposureManagementPanel } from '@/components/GatewayExposureManagementPanel';

export function IngressClient() {
  const [refreshSignal, setRefreshSignal] = useState(0);

  return (
    <AdminShell
      title="Gateway exposures"
      description="Service/API endpoint publishing and external ingress readiness"
    >
      <div className="space-y-8">
        <GatewayExposureManagementPanel onChanged={() => setRefreshSignal(value => value + 1)} />
        <ExternalIngressReadinessPanel refreshSignal={refreshSignal} />
      </div>
    </AdminShell>
  );
}
