'use client';

import { AdminShell } from '@/components/AdminShell';
import { ExternalIngressReadinessPanel } from '@/components/ExternalIngressReadinessPanel';

export function IngressClient() {
  return (
    <AdminShell
      title="External ingress"
      description="Manual publish readiness for gateway exposure hostnames"
    >
      <ExternalIngressReadinessPanel />
    </AdminShell>
  );
}
