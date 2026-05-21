import { AccessDeniedClient } from '@/components/AccessDeniedClient';
import { requireHostPrincipalPage } from '@/lib/auth-page';
import { InstalledModulesClient } from './InstalledModulesClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function InstalledModulesPage() {
  const user = await requireHostPrincipalPage();
  if (user.role !== 'host.admin') {
    return <AccessDeniedClient resourceName="Installed modules" />;
  }

  return <InstalledModulesClient />;
}
