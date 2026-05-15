import type {
  InstallPlanSettingPrompt,
  ModuleInstallExternalMountSelection,
  ModuleInstallSettingSelection,
  ModuleInstallSettingValue,
  ModuleUpdatePlan,
  ModuleUpdateRequest,
} from '../types/modules';

export function getUpdateSettingFieldName(setting: Pick<InstallPlanSettingPrompt, 'moduleId' | 'key'>) {
  return `setting:${setting.moduleId}:${setting.key}`;
}

export function buildModuleUpdateRequest(
  plan: ModuleUpdatePlan,
  formData: FormData,
  externalMounts: ModuleInstallExternalMountSelection[]
): ModuleUpdateRequest {
  return {
    updatePlanDigest: plan.updatePlanDigest,
    confirmed: true,
    settings: collectSettingSelections(plan.settings, formData),
    externalMounts,
  };
}

export function redactModuleUpdateRequest(request: ModuleUpdateRequest): ModuleUpdateRequest {
  return {
    ...request,
    settings: request.settings.map(setting => ({
      ...setting,
      value: setting.secret ? '<redacted>' : setting.value,
    })),
  };
}

function collectSettingSelections(
  settings: InstallPlanSettingPrompt[],
  formData: FormData
): ModuleInstallSettingSelection[] {
  const selections: ModuleInstallSettingSelection[] = [];

  for (const setting of settings) {
    const value = coerceSettingValue(setting, formData.get(getUpdateSettingFieldName(setting)));
    if (value === undefined) {
      continue;
    }

    selections.push({
      moduleId: setting.moduleId,
      key: setting.key,
      value,
      secret: setting.secret,
    });
  }

  return selections;
}

function coerceSettingValue(
  setting: InstallPlanSettingPrompt,
  value: FormDataEntryValue | null
): ModuleInstallSettingValue | undefined {
  if (value === null) {
    return undefined;
  }

  const rawValue = String(value);
  if (rawValue === '' && !setting.required) {
    return undefined;
  }

  if (setting.type === 'number') {
    return Number(rawValue);
  }

  if (setting.type === 'boolean') {
    return rawValue === 'true';
  }

  return rawValue;
}
