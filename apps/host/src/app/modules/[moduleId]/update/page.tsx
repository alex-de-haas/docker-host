import { UpdateModuleClient } from './UpdateModuleClient';

export default async function UpdateModulePage({
  params,
}: {
  params: Promise<{ moduleId: string }>;
}) {
  const { moduleId } = await params;
  return <UpdateModuleClient moduleId={moduleId} />;
}
