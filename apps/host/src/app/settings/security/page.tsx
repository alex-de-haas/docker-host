import { SecuritySettingsClient } from './SecuritySettingsClient';
import { requireHostAdminPage } from '@/lib/auth-page';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function SecuritySettingsPage() {
  const user = await requireHostAdminPage();
  return <SecuritySettingsClient user={user} />;
}
