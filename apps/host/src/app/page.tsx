import { DashboardClient } from './DashboardClient';
import { requireHostAdminPage } from '@/lib/auth-page';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function Dashboard() {
  const user = await requireHostAdminPage();
  return <DashboardClient user={user} />;
}
