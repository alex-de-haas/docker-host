import { RecoveryClient } from './RecoveryClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function RecoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ recoveryToken?: string }>;
}) {
  const params = await searchParams;
  return <RecoveryClient initialRecoveryToken={params.recoveryToken || ''} />;
}
