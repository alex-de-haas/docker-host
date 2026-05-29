import {
  getEndpointHostPortFieldName,
  getEndpointOriginFieldName,
} from './module-install-request.ts';
import type {
  ModuleConfigurationPlan,
  ModuleConfigurationRequest,
  ModuleConfigurationSettingPrompt,
  ModuleInstallExternalMountSelection,
  ModuleInstallEndpointOriginSelection,
  ModuleInstallSettingSelection,
  ModuleInstallSettingValue,
} from '../types/modules';

export function getConfigurationSettingFieldName(
  setting: Pick<ModuleConfigurationSettingPrompt, 'moduleId' | 'key'>
) {
  return `configurationSetting:${setting.moduleId}:${setting.key}`;
}

export function buildModuleConfigurationRequest(
  plan: ModuleConfigurationPlan,
  formData: FormData,
  externalMounts: ModuleInstallExternalMountSelection[]
): ModuleConfigurationRequest {
  return {
    configurationDigest: plan.configurationDigest,
    settings: collectSettingSelections(plan.settings, formData),
    externalMounts,
    endpointOrigins: collectEndpointOriginSelections(plan, formData),
  };
}

export function redactModuleConfigurationRequest(
  request: ModuleConfigurationRequest
): ModuleConfigurationRequest {
  return {
    ...request,
    settings: request.settings.map(setting => ({
      ...setting,
      value: setting.secret ? '<redacted>' : setting.value,
    })),
  };
}

function collectSettingSelections(
  settings: ModuleConfigurationSettingPrompt[],
  formData: FormData
): ModuleInstallSettingSelection[] {
  const selections: ModuleInstallSettingSelection[] = [];

  for (const setting of settings) {
    const rawValue = formData.get(getConfigurationSettingFieldName(setting));
    const value = coerceSettingValue(setting, rawValue);
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

function collectEndpointOriginSelections(
  plan: ModuleConfigurationPlan,
  formData: FormData
): ModuleInstallEndpointOriginSelection[] {
  return plan.runtime.endpointOrigins.flatMap(origin => {
    const publicOriginValue = formData.get(getEndpointOriginFieldName(origin));
    const hostPortValue = formData.get(getEndpointHostPortFieldName(origin));
    if (publicOriginValue === null && hostPortValue === null) {
      return [];
    }

    const publicOrigin = publicOriginValue === null ? '' : String(publicOriginValue).trim();
    const hostPort = hostPortValue === null
      ? origin.hostPort
      : Number(String(hostPortValue).trim());

    return [{
      moduleId: origin.moduleId,
      endpoint: origin.endpoint,
      hostPort,
      ...(publicOrigin ? { publicOrigin } : {}),
    }];
  });
}

function coerceSettingValue(
  setting: ModuleConfigurationSettingPrompt,
  value: FormDataEntryValue | null
): ModuleInstallSettingValue | undefined {
  if (value === null) {
    return undefined;
  }

  const rawValue = String(value).trim();
  if (setting.secret && rawValue === '' && setting.valueSet) {
    return undefined;
  }
  if (rawValue === '') {
    return '';
  }

  if (setting.type === 'number') {
    return Number(rawValue);
  }

  if (setting.type === 'boolean') {
    return rawValue === 'true';
  }

  return rawValue;
}
