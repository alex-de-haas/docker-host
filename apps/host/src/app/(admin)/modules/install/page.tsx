import { InstallModuleClient } from './InstallModuleClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function InstallModulePage() {
  return <InstallModuleClient />;
}
