import { requireHostAdminPage } from '@/lib/auth-page';
import { InstallModuleClient } from './InstallModuleClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function InstallModulePage() {
  await requireHostAdminPage();
  return <InstallModuleClient />;
}
