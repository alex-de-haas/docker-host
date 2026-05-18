import { redirectSetupCompletePage } from '@/lib/auth-page';
import { SetupClient } from './SetupClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ setupToken?: string }>;
}) {
  await redirectSetupCompletePage();
  const { setupToken } = await searchParams;
  return <SetupClient initialSetupToken={setupToken} />;
}
