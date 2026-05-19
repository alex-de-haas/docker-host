import { SecuritySettingsClient } from './SecuritySettingsClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function SecuritySettingsPage() {
  return <SecuritySettingsClient />;
}
