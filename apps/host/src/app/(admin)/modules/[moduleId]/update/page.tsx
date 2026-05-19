import { AccessDeniedClient } from '@/components/AccessDeniedClient';
import { requireHostPrincipalPage } from '@/lib/auth-page';
import { UpdateModuleClient } from './UpdateModuleClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function UpdateModulePage({
  params,
}: {
  params: Promise<{ moduleId: string }>;
}) {
  const user = await requireHostPrincipalPage();
  if (user.role !== 'host.admin') {
    return <AccessDeniedClient resourceName="Module update" />;
  }

  const { moduleId } = await params;
  return <UpdateModuleClient moduleId={moduleId} />;
}
