import { AppHostClient } from '../../[moduleId]/AppHostClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function DeveloperAppHostPage({
  params,
}: {
  params: Promise<{ targetId: string }>;
}) {
  const { targetId } = await params;
  return <AppHostClient appId={`dev:${targetId}`} />;
}
