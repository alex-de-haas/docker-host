import { UpdateModuleClient } from './UpdateModuleClient';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function UpdateModulePage({
  params,
}: {
  params: Promise<{ moduleId: string }>;
}) {
  const { moduleId } = await params;
  return <UpdateModuleClient moduleId={moduleId} />;
}
