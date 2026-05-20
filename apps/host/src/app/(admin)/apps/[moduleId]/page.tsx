import { AppHostClient } from './AppHostClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function AppHostPage({
  params,
}: {
  params: Promise<{ moduleId: string }>;
}) {
  const { moduleId } = await params;
  return <AppHostClient appId={moduleId} />;
}
