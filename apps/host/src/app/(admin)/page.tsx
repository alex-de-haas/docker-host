import { redirect } from 'next/navigation';
import { getDefaultHostShellPath } from '@/lib/auth-policy';
import { requireHostPrincipalPage } from '@/lib/auth-page';
import { DashboardClient } from './DashboardClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function Dashboard() {
  const user = await requireHostPrincipalPage();
  const defaultPath = getDefaultHostShellPath(user);
  if (defaultPath !== '/') {
    redirect(defaultPath);
  }

  return <DashboardClient />;
}
