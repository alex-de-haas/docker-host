import { DashboardClient } from './DashboardClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function Dashboard() {
  return <DashboardClient />;
}
