import { InviteSetupClient } from './InviteSetupClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function InviteSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ setupToken?: string }>;
}) {
  const { setupToken } = await searchParams;
  return <InviteSetupClient initialSetupToken={setupToken || ''} />;
}
