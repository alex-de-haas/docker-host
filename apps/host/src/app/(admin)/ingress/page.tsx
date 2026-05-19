import { AccessDeniedClient } from '@/components/AccessDeniedClient';
import { requireHostPrincipalPage } from '@/lib/auth-page';
import { IngressClient } from './IngressClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function IngressPage() {
  const user = await requireHostPrincipalPage();
  if (user.role !== 'host.admin') {
    return <AccessDeniedClient resourceName="Gateway exposure management" />;
  }

  return <IngressClient />;
}
