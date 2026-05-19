import { AccessDeniedClient } from '@/components/AccessDeniedClient';
import { requireHostPrincipalPage } from '@/lib/auth-page';
import { SecuritySettingsClient } from './SecuritySettingsClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function SecuritySettingsPage() {
  const user = await requireHostPrincipalPage();
  if (user.role !== 'host.admin') {
    return <AccessDeniedClient resourceName="Security settings" />;
  }

  return <SecuritySettingsClient />;
}
