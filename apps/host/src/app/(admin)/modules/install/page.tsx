import { AccessDeniedClient } from '@/components/AccessDeniedClient';
import { requireHostPrincipalPage } from '@/lib/auth-page';
import { InstallModuleClient } from './InstallModuleClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function InstallModulePage() {
  const user = await requireHostPrincipalPage();
  if (user.role !== 'host.admin') {
    return <AccessDeniedClient resourceName="Module installation" />;
  }

  return <InstallModuleClient />;
}
