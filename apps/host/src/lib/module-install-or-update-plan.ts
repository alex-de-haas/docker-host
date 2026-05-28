import { createInstallPlan } from '@/lib/module-install-plan';
import { createModuleUpdatePlan } from '@/lib/module-update-plan';
import type {
  InstallPlanConflict,
  InstallPlanErrorEnvelope,
  InstallPlanResponse,
} from '@/types/modules';

export type InstallOrUpdatePlanResult = {
  status: number;
  body: InstallPlanResponse;
};

export async function createInstallOrUpdatePlan(
  metadataUrl: string
): Promise<InstallOrUpdatePlanResult> {
  const installResult = await createInstallPlan(metadataUrl);
  const installError = 'error' in installResult.body ? installResult.body.error : undefined;
  const existingModuleId = findSameSourceInstalledModuleId(installError?.conflicts);

  if (!existingModuleId) {
    return {
      status: installResult.status,
      body: {
        mode: 'install',
        ...installResult.body,
      },
    };
  }

  const updateResult = await createModuleUpdatePlan(existingModuleId);
  return {
    status: updateResult.status,
    body: {
      mode: 'update',
      existingModuleId,
      ...(updateResult.body.plan ? { updatePlan: updateResult.body.plan } : {}),
      ...(updateResult.body.error ? { error: updateResult.body.error } : {}),
      ...(!updateResult.body.plan && !updateResult.body.error
        ? { error: buildUpdateHandoffFailure(existingModuleId) }
        : {}),
    },
  };
}

export function findSameSourceInstalledModuleId(
  conflicts: InstallPlanConflict[] | undefined
) {
  const sameSourceConflict = (conflicts ?? []).find(conflict =>
    conflict.code === 'module_id_conflict' &&
    conflict.resourceType === 'installed_module' &&
    asString(conflict.existingValue) === asString(conflict.proposedValue)
  );

  return sameSourceConflict?.resourceId || null;
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function buildUpdateHandoffFailure(moduleId: string): InstallPlanErrorEnvelope {
  return {
    code: 'install_update_handoff_failed',
    message: `Module "${moduleId}" is already installed, but an update plan could not be created.`,
    validationErrors: [],
    conflicts: [],
  };
}
