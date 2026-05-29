import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureHostDataRoot, getHostRuntimeConfig } from '@/lib/host-runtime';
import type { HostRuntimeConfig } from '@/lib/host-runtime';
import {
  createAndStartModuleContainer,
  ensureModuleContainersStarted,
  ensureModuleNetwork,
  pullModuleImage,
  removeModuleContainersIfExist,
  toModuleOperationError,
} from '@/lib/module-docker';
import { buildLocalEndpointOrigin, canonicalJson } from '@/lib/module-install-plan';
import { isSafeExternalMountKey } from '@/lib/module-install-request';
import { getModuleContainersInStartOrder } from '@/lib/module-lifecycle';
import { validateAndNormalizeMetadata } from '@/lib/module-metadata';
import {
  readModuleMetadata,
  readModulesStore,
  writeModulesStore,
} from '@/lib/module-store';
import {
  buildModuleServiceEnvironment,
  createModuleServiceToken,
  revokeModuleServiceToken,
} from '@/lib/module-directory-service';
import {
  getResolvedDependencies,
  getStoredExternalMounts,
  getStoredStorageMappings,
  resolveContainerDataPath,
} from '@/lib/module-recovery-model';
import { listInstalledModules } from '@/lib/module-service';
import { withModuleMutationLock } from '@/lib/module-mutation-lock';
import type {
  InstallPlanConflict,
  InstallPlanEndpointOrigin,
  InstallPlanErrorEnvelope,
  InstallPlanMountCollection,
  InstallPlanValidationError,
  InstalledExternalMountMapping,
  InstalledModuleRecord,
  InstalledSettingValue,
  ModuleConfigurationPlan,
  ModuleConfigurationPlanResponse,
  ModuleConfigurationRequest,
  ModuleConfigurationResponse,
  ModuleInstallEndpointOriginSelection,
  ModuleInstallExternalMountSelection,
  ModuleInstallSettingSelection,
  ModuleInstallSettingValue,
  ModuleOperationError,
  ModulesStoreData,
  NormalizedModuleMetadata,
} from '@/types/modules';

type ConfigurationPlanStatus = 200 | 404 | 409 | 422 | 500 | 503;

type ConfigurationPlanResult = {
  status: ConfigurationPlanStatus;
  body: ModuleConfigurationPlanResponse;
};

type ConfigurationApplyResult = {
  status: 200 | 404 | 409 | 422 | 500 | 503;
  body: ModuleConfigurationResponse;
};

interface ConfigurationContext {
  store: ModulesStoreData;
  module: InstalledModuleRecord;
  metadata: NormalizedModuleMetadata;
  plan: ModuleConfigurationPlan;
}

interface ConfigurationDecisions {
  settings: Record<string, InstalledSettingValue>;
  externalMounts: InstalledExternalMountMapping[];
  endpointOrigins: Map<string, EndpointOriginDecision>;
}

interface EndpointOriginDecision {
  hostPort: number;
  publicOrigin: string | null;
}

export async function createModuleConfigurationPlan(
  moduleId: string,
  config = getHostRuntimeConfig()
): Promise<ConfigurationPlanResult> {
  const contextResult = await loadConfigurationContext(moduleId, config);
  if (!contextResult.context) {
    return {
      status: contextResult.status,
      body: { error: contextResult.error },
    };
  }

  return {
    status: 200,
    body: { plan: contextResult.context.plan },
  };
}

export async function applyModuleConfigurationRequest(
  moduleId: string,
  body: unknown
): Promise<ConfigurationApplyResult> {
  const requestValidation = parseConfigurationRequest(body);
  if (requestValidation.validationErrors.length > 0 || !requestValidation.request) {
    return configurationEnvelopeResult(422, {
      code: 'module_configuration_request_invalid',
      message: 'Module configuration request is invalid.',
      validationErrors: requestValidation.validationErrors,
      conflicts: [],
    });
  }

  const request = requestValidation.request;
  if (!request) {
    return configurationEnvelopeResult(422, {
      code: 'module_configuration_request_invalid',
      message: 'Module configuration request is invalid.',
      validationErrors: [],
      conflicts: [],
    });
  }

  return withModuleMutationLock(() =>
    applyValidatedConfigurationRequest(moduleId, request)
  );
}

async function applyValidatedConfigurationRequest(
  moduleId: string,
  request: ModuleConfigurationRequest
): Promise<ConfigurationApplyResult> {
  const config = getHostRuntimeConfig();
  const contextResult = await loadConfigurationContext(moduleId, config);
  if (!contextResult.context) {
    return configurationEnvelopeResult(contextResult.status, contextResult.error);
  }

  const { store, module, metadata, plan } = contextResult.context;
  if (plan.configurationDigest !== request.configurationDigest) {
    return configurationEnvelopeResult(409, {
      code: 'module_configuration_digest_mismatch',
      message: 'The module configuration changed since review. Reload the configuration dialog and retry.',
      validationErrors: [],
      conflicts: [{
        code: 'module_configuration_digest_mismatch',
        message: 'The submitted configurationDigest does not match the current module configuration.',
        resourceType: 'module_configuration',
        resourceId: moduleId,
        path: '$.configurationDigest',
        node: moduleId,
        existingValue: plan.configurationDigest,
        proposedValue: request.configurationDigest,
      }],
    });
  }

  const decisionValidation = validateConfigurationDecisions(plan, metadata, request, module, store);
  if (decisionValidation.validationErrors.length > 0) {
    return configurationEnvelopeResult(422, {
      code: 'module_configuration_request_invalid',
      message: 'Module configuration decisions are invalid.',
      validationErrors: decisionValidation.validationErrors,
      conflicts: [],
    });
  }

  if (decisionValidation.conflicts.length > 0) {
    return configurationEnvelopeResult(409, {
      code: 'module_configuration_conflict',
      message: 'Module configuration decisions conflict with current Host state.',
      validationErrors: [],
      conflicts: decisionValidation.conflicts,
    });
  }

  const nextModule = buildConfiguredModuleRecord(
    module,
    plan,
    decisionValidation.decisions,
    new Date().toISOString()
  );
  const recreateContainers = requiresContainerRecreate(module, nextModule);

  if (!recreateContainers) {
    await writeConfiguredModule(store, nextModule, config);
    const updatedModule = await getConfiguredModuleSummary(moduleId);
    if (!updatedModule) {
      return configurationEnvelopeResult(500, {
        code: 'module_configuration_summary_failed',
        message: `Module "${moduleId}" was configured but could not be read back from modules.json.`,
        validationErrors: [],
        conflicts: [],
      });
    }

    return {
      status: 200,
      body: {
        module: updatedModule,
        recreatedContainers: false,
        error: null,
      },
    };
  }

  return recreateConfiguredContainers({
    store,
    module,
    nextModule,
    metadata,
    config,
  });
}

async function loadConfigurationContext(
  moduleId: string,
  config: HostRuntimeConfig
): Promise<{
  status: ConfigurationPlanStatus;
  context: ConfigurationContext | null;
  error: InstallPlanErrorEnvelope;
}> {
  await ensureHostDataRoot(config);
  const store = await readModulesStore(config);
  const installedModule = store.modules.find(candidate => candidate.id === moduleId);
  if (!installedModule) {
    return contextError(404, 'module_not_found', `Module "${moduleId}" is not installed.`);
  }

  const status = installedModule.operationStatus || 'installed';
  if (status !== 'installed') {
    return contextError(
      409,
      'module_configuration_status_conflict',
      `Module "${moduleId}" cannot be configured while operationStatus is "${status}".`,
      [{
        code: 'module_configuration_status_conflict',
        message: 'Only installed modules can be configured.',
        resourceType: 'installed_module',
        resourceId: moduleId,
        path: '$.operationStatus',
        node: moduleId,
        existingValue: status,
        proposedValue: 'installed',
      }]
    );
  }

  const metadataResult = await readNormalizedLocalMetadata(installedModule, config);
  if (!metadataResult.metadata) {
    return {
      status: 422,
      context: null,
      error: {
        code: 'module_configuration_metadata_invalid',
        message: metadataResult.message,
        validationErrors: metadataResult.validationErrors,
        conflicts: [],
      },
    };
  }

  const plan = buildConfigurationPlan(installedModule, metadataResult.metadata);
  return {
    status: 200,
    context: {
      store,
      module: installedModule,
      metadata: metadataResult.metadata,
      plan,
    },
    error: {
      code: 'ok',
      message: 'ok',
      validationErrors: [],
      conflicts: [],
    },
  };
}

async function readNormalizedLocalMetadata(
  module: InstalledModuleRecord,
  config: HostRuntimeConfig
) {
  try {
    const metadata = await readModuleMetadata(module, config);
    if (!metadata) {
      return {
        metadata: null,
        message: `Module "${module.id}" metadata file could not be found.`,
        validationErrors: [],
      };
    }

    const result = validateAndNormalizeMetadata(metadata, '$');
    if (result.validationErrors.length > 0 || !result.metadata) {
      return {
        metadata: null,
        message: `Module "${module.id}" metadata file is invalid.`,
        validationErrors: result.validationErrors,
      };
    }

    return {
      metadata: result.metadata,
      message: '',
      validationErrors: [],
    };
  } catch (error) {
    return {
      metadata: null,
      message: error instanceof Error ? error.message : 'Unknown module metadata error.',
      validationErrors: [],
    };
  }
}

function buildConfigurationPlan(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata
): ModuleConfigurationPlan {
  const endpointOrigins = buildConfigurationEndpointOrigins(module, metadata);

  return {
    moduleId: module.id,
    moduleName: metadata.name,
    moduleVersion: metadata.version,
    metadataUrl: module.metadataUrl,
    configurationDigest: buildConfigurationDigest(module, metadata, endpointOrigins),
    settings: buildConfigurationSettingPrompts(module, metadata),
    runtime: {
      endpoints: metadata.endpoints,
      endpointOrigins,
    },
    storage: {
      mountCollections: buildConfigurationMountCollections(module.id, metadata),
      externalMounts: getStoredExternalMounts(module),
    },
    conflicts: [],
    warnings: buildConfigurationWarnings(module, metadata),
  };
}

function buildConfigurationDigest(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata,
  endpointOrigins: InstallPlanEndpointOrigin[]
) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson({
      moduleId: module.id,
      metadataDigest: module.metadataDigest,
      metadata: {
        settings: metadata.settings.map(setting => ({
          key: setting.key,
          type: setting.type,
          required: setting.required,
          targets: setting.targets,
        })),
        endpoints: metadata.endpoints,
        mountCollections: metadata.storage.mountCollections,
      },
      installed: {
        settings: module.settings || {},
        endpointOrigins: endpointOrigins.map(origin => ({
          endpoint: origin.endpoint,
          hostPort: origin.hostPort,
          publicOrigin: origin.publicOrigin,
        })),
        externalMounts: getStoredExternalMounts(module),
        updatedAt: module.updatedAt,
      },
    }))
    .digest('hex')}`;
}

function buildConfigurationSettingPrompts(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata
): ModuleConfigurationPlan['settings'] {
  const settings = module.settings || {};

  return metadata.settings.map(setting => {
    const valueSet = Object.prototype.hasOwnProperty.call(settings, setting.key);
    const storedValue = settings[setting.key];
    const defaultValue = valueSet ? storedValue : setting.default;

    return {
      moduleId: module.id,
      key: setting.key,
      type: setting.type,
      required: setting.required,
      targets: setting.targets,
      ...(setting.type !== 'secret' && defaultValue !== undefined ? { default: defaultValue } : {}),
      secret: setting.type === 'secret',
      redacted: setting.type === 'secret' && valueSet,
      valueSet,
    };
  });
}

function buildConfigurationEndpointOrigins(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata
): InstallPlanEndpointOrigin[] {
  return metadata.endpoints.flatMap(endpoint => {
    if (!endpoint.public) {
      return [];
    }

    const container = module.containers.find(candidate => candidate.key === endpoint.container);
    const port = container?.ports?.find(candidate =>
      candidate.endpointKey === endpoint.key ||
      candidate.key === endpoint.port
    );
    if (!container || !port?.hostPort) {
      return [];
    }

    const metadataContainer = metadata.containers.find(candidate => candidate.key === endpoint.container);
    const metadataPort = metadataContainer?.runtime.ports.find(candidate => candidate.key === endpoint.port);

    return [{
      moduleId: module.id,
      endpoint: endpoint.key,
      container: endpoint.container,
      portKey: endpoint.port,
      containerPort: metadataPort?.containerPort ?? port.containerPort,
      hostPort: port.hostPort,
      protocol: metadataPort?.protocol ?? port.protocol,
      localOrigin: buildLocalEndpointOrigin(port.hostPort),
      publicOrigin: port.publicOrigin ?? null,
      requiredForUi: metadata.ui?.entrypoint.portKey === endpoint.key,
    }];
  });
}

function buildConfigurationMountCollections(
  moduleId: string,
  metadata: NormalizedModuleMetadata
): InstallPlanMountCollection[] {
  return metadata.storage.mountCollections.map(collection => ({
    moduleId,
    ...collection,
  }));
}

function buildConfigurationWarnings(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata
) {
  const warnings: string[] = [];
  const configuredEndpointKeys = new Set(
    buildConfigurationEndpointOrigins(module, metadata).map(origin => origin.endpoint)
  );

  for (const endpoint of metadata.endpoints) {
    if (endpoint.public && !configuredEndpointKeys.has(endpoint.key)) {
      warnings.push(`Public endpoint "${endpoint.key}" is missing an installed Host port. Use module update to repair runtime bindings.`);
    }
  }

  return warnings;
}

function parseConfigurationRequest(body: unknown): {
  request: ModuleConfigurationRequest | null;
  validationErrors: InstallPlanValidationError[];
} {
  const validationErrors: InstallPlanValidationError[] = [];
  if (!isObject(body)) {
    return {
      request: null,
      validationErrors: [{
        code: 'module_configuration_request_invalid',
        message: 'Request body must be an object.',
        path: '$',
      }],
    };
  }

  const configurationDigest = readString(
    body,
    'configurationDigest',
    '$.configurationDigest',
    validationErrors
  );
  const settings = readSettingSelections(body.settings, validationErrors);
  const externalMounts = readExternalMountSelections(body.externalMounts, validationErrors);
  const endpointOrigins = readEndpointOriginSelections(body.endpointOrigins, validationErrors);

  if (!configurationDigest || validationErrors.length > 0) {
    return { request: null, validationErrors };
  }

  return {
    request: {
      configurationDigest,
      settings,
      externalMounts,
      endpointOrigins,
    },
    validationErrors,
  };
}

function validateConfigurationDecisions(
  plan: ModuleConfigurationPlan,
  metadata: NormalizedModuleMetadata,
  request: ModuleConfigurationRequest,
  module: InstalledModuleRecord,
  store: ModulesStoreData
) {
  const settingValidation = validateSettingSelections(metadata, request.settings, module);
  const externalMountValidation = validateExternalMountSelections(
    plan,
    request.externalMounts,
    store
  );
  const endpointOriginValidation = validateEndpointOriginSelections(
    plan,
    request.endpointOrigins,
    module,
    store
  );

  return {
    decisions: {
      settings: settingValidation.settings,
      externalMounts: externalMountValidation.externalMounts,
      endpointOrigins: endpointOriginValidation.endpointOrigins,
    },
    validationErrors: [
      ...settingValidation.validationErrors,
      ...externalMountValidation.validationErrors,
      ...endpointOriginValidation.validationErrors,
    ],
    conflicts: [
      ...externalMountValidation.conflicts,
      ...endpointOriginValidation.conflicts,
    ],
  };
}

function validateSettingSelections(
  metadata: NormalizedModuleMetadata,
  selections: ModuleInstallSettingSelection[],
  module: InstalledModuleRecord
) {
  const validationErrors: InstallPlanValidationError[] = [];
  const prompts = new Map(metadata.settings.map(prompt => [settingKey(module.id, prompt.key), prompt]));
  const selected = new Map<string, ModuleInstallSettingSelection>();
  const settings: Record<string, InstalledSettingValue> = { ...(module.settings || {}) };

  for (const selection of selections) {
    const key = settingKey(selection.moduleId, selection.key);
    const prompt = prompts.get(key);
    if (!prompt) {
      validationErrors.push({
        code: 'module_configuration_setting_unknown',
        message: `Setting "${selection.key}" is not configurable for module "${selection.moduleId}".`,
        path: '$.settings',
        node: selection.moduleId,
      });
      continue;
    }

    if (selected.has(key)) {
      validationErrors.push({
        code: 'module_configuration_setting_duplicate',
        message: `Setting "${selection.key}" is submitted more than once for module "${selection.moduleId}".`,
        path: '$.settings',
        node: selection.moduleId,
      });
      continue;
    }

    if (selection.secret !== (prompt.type === 'secret')) {
      validationErrors.push({
        code: 'module_configuration_setting_secret_mismatch',
        message: `Setting "${selection.key}" secret marker does not match module metadata.`,
        path: '$.settings',
        node: selection.moduleId,
      });
      continue;
    }

    const valueValidation = validateSettingValue(prompt.type, selection.value, prompt.required);
    if (valueValidation) {
      validationErrors.push({
        code: 'module_configuration_setting_value_invalid',
        message: valueValidation,
        path: '$.settings',
        node: selection.moduleId,
      });
      continue;
    }

    selected.set(key, selection);

    if (!prompt.required && typeof selection.value === 'string' && selection.value.trim() === '') {
      delete settings[prompt.key];
    } else {
      settings[prompt.key] = selection.value;
    }
  }

  for (const setting of metadata.settings) {
    const currentValue = settings[setting.key];
    if (currentValue !== undefined) {
      continue;
    }

    if (setting.type !== 'secret' && Object.prototype.hasOwnProperty.call(setting, 'default')) {
      settings[setting.key] = setting.default as InstalledSettingValue;
      continue;
    }

    if (setting.required) {
      validationErrors.push({
        code: 'module_configuration_setting_required',
        message: `Required setting "${setting.key}" is missing for module "${module.id}".`,
        path: '$.settings',
        node: module.id,
      });
    }
  }

  return { settings, validationErrors };
}

function validateEndpointOriginSelections(
  plan: ModuleConfigurationPlan,
  selections: ModuleInstallEndpointOriginSelection[],
  module: InstalledModuleRecord,
  store: ModulesStoreData
) {
  const validationErrors: InstallPlanValidationError[] = [];
  const conflicts: InstallPlanConflict[] = [];
  const origins = new Map(
    plan.runtime.endpointOrigins.map(origin => [settingKey(origin.moduleId, origin.endpoint), origin])
  );
  const selected = new Map<string, EndpointOriginDecision>();

  for (const selection of selections) {
    const key = settingKey(selection.moduleId, selection.endpoint);
    const plannedOrigin = origins.get(key);
    if (!plannedOrigin) {
      validationErrors.push({
        code: 'module_configuration_endpoint_origin_unknown',
        message: `Endpoint "${selection.endpoint}" is not a configurable public endpoint for module "${selection.moduleId}".`,
        path: '$.endpointOrigins',
        node: selection.moduleId,
      });
      continue;
    }

    if (selected.has(key)) {
      validationErrors.push({
        code: 'module_configuration_endpoint_origin_duplicate',
        message: `Endpoint origin for "${selection.endpoint}" is submitted more than once.`,
        path: '$.endpointOrigins',
        node: selection.moduleId,
      });
      continue;
    }

    const hostPort = selection.hostPort ?? plannedOrigin.hostPort;
    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
      validationErrors.push({
        code: 'module_configuration_endpoint_host_port_invalid',
        message: 'Endpoint hostPort must be an integer between 1 and 65535.',
        path: '$.endpointOrigins',
        node: selection.moduleId,
      });
      continue;
    }

    const publicOrigin = selection.publicOrigin
      ? normalizePublicOrigin(selection.publicOrigin)
      : null;
    if (selection.publicOrigin && !publicOrigin) {
      validationErrors.push({
        code: 'module_configuration_endpoint_origin_invalid',
        message: 'Endpoint publicOrigin must be an http or https origin without a path, query, or fragment.',
        path: '$.endpointOrigins',
        node: selection.moduleId,
      });
      continue;
    }

    selected.set(key, {
      hostPort,
      publicOrigin,
    });
  }

  const endpointOrigins = new Map<string, EndpointOriginDecision>();
  const selectedHostPorts = new Map<number, string>();
  const reservedPorts = collectReservedHostPorts(module.id, store);
  const endpointByStoredPort = new Map(
    plan.runtime.endpointOrigins.map(origin => [
      `${origin.container}:${origin.portKey}`,
      origin.endpoint,
    ])
  );

  for (const origin of plan.runtime.endpointOrigins) {
    const key = settingKey(origin.moduleId, origin.endpoint);
    const decision = selected.get(key) ?? {
      hostPort: origin.hostPort,
      publicOrigin: origin.publicOrigin ?? null,
    };

    const selectedOwner = selectedHostPorts.get(decision.hostPort);
    if (selectedOwner) {
      validationErrors.push({
        code: 'module_configuration_endpoint_host_port_duplicate',
        message: `Host port "${decision.hostPort}" is selected more than once by "${selectedOwner}" and "${key}".`,
        path: '$.endpointOrigins',
        node: origin.moduleId,
      });
    }
    selectedHostPorts.set(decision.hostPort, key);

    const reservedOwner = reservedPorts.get(decision.hostPort);
    if (reservedOwner) {
      conflicts.push({
        code: 'module_configuration_endpoint_host_port_conflict',
        message: `Host port "${decision.hostPort}" conflicts with installed module "${reservedOwner}".`,
        resourceType: 'host_port',
        resourceId: String(decision.hostPort),
        path: '$.endpointOrigins',
        node: origin.moduleId,
        existingValue: reservedOwner,
        proposedValue: origin.moduleId,
      });
    }

    endpointOrigins.set(origin.endpoint, decision);
  }

  for (const container of module.containers) {
    for (const port of container.ports ?? []) {
      const endpointKey = port.endpointKey ?? endpointByStoredPort.get(`${container.key}:${port.key}`);
      if (endpointKey && endpointOrigins.has(endpointKey)) {
        continue;
      }

      if (selectedHostPorts.has(port.hostPort)) {
        validationErrors.push({
          code: 'module_configuration_endpoint_host_port_duplicate',
          message: `Host port "${port.hostPort}" conflicts with another installed port on the same module.`,
          path: '$.endpointOrigins',
          node: module.id,
        });
      }
    }
  }

  return { endpointOrigins, validationErrors, conflicts };
}

function validateExternalMountSelections(
  plan: ModuleConfigurationPlan,
  selections: ModuleInstallExternalMountSelection[],
  store: ModulesStoreData
) {
  const validationErrors: InstallPlanValidationError[] = [];
  const conflicts: InstallPlanConflict[] = [];
  const collections = new Map(
    plan.storage.mountCollections.map(collection => [
      settingKey(collection.moduleId, collection.key),
      collection,
    ])
  );
  const selectionsByCollection = new Map<string, ModuleInstallExternalMountSelection[]>();
  const selectedHostPaths = new Map<string, ModuleInstallExternalMountSelection>();
  const externalMounts: InstalledExternalMountMapping[] = [];

  for (const selection of selections) {
    const collection = collections.get(settingKey(selection.moduleId, selection.collectionKey));
    if (!collection) {
      validationErrors.push({
        code: 'module_configuration_external_mount_unknown',
        message: `External mount collection "${selection.collectionKey}" is not configurable for module "${selection.moduleId}".`,
        path: '$.externalMounts',
        node: selection.moduleId,
      });
      continue;
    }

    const collectionKeyValue = settingKey(selection.moduleId, selection.collectionKey);
    const collectionSelections = selectionsByCollection.get(collectionKeyValue) ?? [];
    collectionSelections.push(selection);
    selectionsByCollection.set(collectionKeyValue, collectionSelections);

    if (!isSafeExternalMountKey(selection.key)) {
      validationErrors.push({
        code: 'module_configuration_external_mount_key_invalid',
        message: 'External mount key must be a safe path segment.',
        path: '$.externalMounts',
        node: selection.moduleId,
      });
      continue;
    }

    if (selection.hostPath.includes('\0')) {
      validationErrors.push({
        code: 'module_configuration_external_mount_path_invalid',
        message: 'External mount hostPath must not contain null bytes.',
        path: '$.externalMounts',
        node: selection.moduleId,
      });
      continue;
    }

    const primaryTarget = collection.targets[0];
    const expectedContainerPath = primaryTarget?.itemContainerPathTemplate.replace('{key}', selection.key);
    if (selection.containerPath !== expectedContainerPath) {
      validationErrors.push({
        code: 'module_configuration_external_mount_container_path_mismatch',
        message: `External mount containerPath must be "${expectedContainerPath}".`,
        path: '$.externalMounts',
        node: selection.moduleId,
      });
      continue;
    }

    if (!collection.targets.some(target => target.writable) && selection.access !== 'readOnly') {
      validationErrors.push({
        code: 'module_configuration_external_mount_access_invalid',
        message: 'Read-only external mount collection targets cannot submit readWrite access.',
        path: '$.externalMounts',
        node: selection.moduleId,
      });
      continue;
    }

    const normalizedHostPath = path.resolve(selection.hostPath);
    const existingSelection = selectedHostPaths.get(normalizedHostPath);
    if (existingSelection) {
      conflicts.push({
        code: 'module_configuration_external_mount_path_conflict',
        message: `External host path "${selection.hostPath}" is selected more than once.`,
        resourceType: 'storage_mapping',
        resourceId: selection.hostPath,
        path: '$.externalMounts',
        node: selection.moduleId,
        existingValue: existingSelection.moduleId,
        proposedValue: selection.moduleId,
      });
    }
    selectedHostPaths.set(normalizedHostPath, selection);

    externalMounts.push(...collection.targets.map(target => {
      const readOnly = selection.access === 'readOnly' || !target.writable;
      return {
        collectionKey: selection.collectionKey,
        key: selection.key,
        ...(selection.label ? { label: selection.label } : {}),
        hostPath: selection.hostPath,
        container: target.container,
        containerPath: target.itemContainerPathTemplate.replace('{key}', selection.key),
        access: readOnly ? 'readOnly' : selection.access,
        readOnly,
      };
    }));
  }

  for (const collection of plan.storage.mountCollections) {
    const collectionSelections =
      selectionsByCollection.get(settingKey(collection.moduleId, collection.key)) ?? [];
    const requiredCount = collection.required ? collection.minItems : 0;

    if (collectionSelections.length < requiredCount) {
      validationErrors.push({
        code: 'module_configuration_external_mount_required',
        message: `External mount collection "${collection.key}" requires at least ${requiredCount} item${requiredCount === 1 ? '' : 's'}.`,
        path: '$.externalMounts',
        node: collection.moduleId,
      });
    }

    if (collection.maxItems !== null && collectionSelections.length > collection.maxItems) {
      validationErrors.push({
        code: 'module_configuration_external_mount_too_many',
        message: `External mount collection "${collection.key}" allows at most ${collection.maxItems} item${collection.maxItems === 1 ? '' : 's'}.`,
        path: '$.externalMounts',
        node: collection.moduleId,
      });
    }

    const seenKeys = new Set<string>();
    for (const selection of collectionSelections) {
      if (!selection.key || !isSafeExternalMountKey(selection.key)) {
        continue;
      }

      if (seenKeys.has(selection.key)) {
        validationErrors.push({
          code: 'module_configuration_external_mount_duplicate_key',
          message: `External mount item key "${selection.key}" is duplicated.`,
          path: '$.externalMounts',
          node: collection.moduleId,
        });
      }
      seenKeys.add(selection.key);
    }
  }

  conflicts.push(...collectExternalMountConflicts(plan.moduleId, selections, store));
  return { externalMounts, validationErrors, conflicts };
}

function collectExternalMountConflicts(
  moduleId: string,
  selections: ModuleInstallExternalMountSelection[],
  store: ModulesStoreData
) {
  const conflicts: InstallPlanConflict[] = [];
  const selectedPaths = new Map(
    selections.map(selection => [path.resolve(selection.hostPath), selection])
  );

  for (const installedModule of store.modules) {
    for (const mapping of getStoredStorageMappings(installedModule)) {
      const selection = selectedPaths.get(path.resolve(mapping.hostPath));
      if (!selection) {
        continue;
      }

      conflicts.push({
        code: 'module_configuration_external_mount_path_conflict',
        message: `External host path "${selection.hostPath}" conflicts with module-owned storage for "${installedModule.id}".`,
        resourceType: 'storage_mapping',
        resourceId: selection.hostPath,
        path: '$.externalMounts',
        node: selection.moduleId,
        existingValue: installedModule.id,
        proposedValue: selection.moduleId,
      });
    }

    if (installedModule.id === moduleId) {
      continue;
    }

    for (const mount of getStoredExternalMounts(installedModule)) {
      const selection = selectedPaths.get(path.resolve(mount.hostPath));
      if (!selection) {
        continue;
      }

      conflicts.push({
        code: 'module_configuration_external_mount_path_conflict',
        message: `External host path "${selection.hostPath}" is already mounted by module "${installedModule.id}".`,
        resourceType: 'storage_mapping',
        resourceId: selection.hostPath,
        path: '$.externalMounts',
        node: selection.moduleId,
        existingValue: installedModule.id,
        proposedValue: selection.moduleId,
      });
    }
  }

  return conflicts;
}

function buildConfiguredModuleRecord(
  module: InstalledModuleRecord,
  plan: ModuleConfigurationPlan,
  decisions: ConfigurationDecisions,
  now: string
): InstalledModuleRecord {
  const endpointByStoredPort = new Map(
    plan.runtime.endpointOrigins.map(origin => [
      `${origin.container}:${origin.portKey}`,
      origin.endpoint,
    ])
  );

  return {
    ...module,
    settings: decisions.settings,
    externalMounts: decisions.externalMounts,
    containers: module.containers.map(container => ({
      ...container,
      ports: (container.ports ?? []).map(port => {
        const endpointKey = port.endpointKey ?? endpointByStoredPort.get(`${container.key}:${port.key}`);
        const decision = endpointKey ? decisions.endpointOrigins.get(endpointKey) : null;
        if (!decision) {
          return port;
        }

        if (!decision.publicOrigin) {
          return {
            ...omitPublicOrigin(port),
            hostPort: decision.hostPort,
          };
        }

        return {
          ...port,
          hostPort: decision.hostPort,
          publicOrigin: decision.publicOrigin,
        };
      }),
    })),
    operationStatus: 'installed',
    lastOperation: 'configure',
    updatedAt: now,
    lastError: null,
  };
}

function omitPublicOrigin<T extends { publicOrigin?: string }>(value: T) {
  const clone = { ...value };
  delete clone.publicOrigin;
  return clone;
}

function requiresContainerRecreate(
  current: InstalledModuleRecord,
  next: InstalledModuleRecord
) {
  const settingsChanged = canonicalJson(current.settings || {}) !== canonicalJson(next.settings || {});
  const externalMountsChanged =
    canonicalJson(getStoredExternalMounts(current)) !== canonicalJson(getStoredExternalMounts(next));
  const hostPortsChanged =
    canonicalJson(collectInstalledHostPorts(current)) !== canonicalJson(collectInstalledHostPorts(next));

  return settingsChanged || externalMountsChanged || hostPortsChanged;
}

async function recreateConfiguredContainers({
  store,
  module,
  nextModule,
  metadata,
  config,
}: {
  store: ModulesStoreData;
  module: InstalledModuleRecord;
  nextModule: InstalledModuleRecord;
  metadata: NormalizedModuleMetadata;
  config: HostRuntimeConfig;
}): Promise<ConfigurationApplyResult> {
  const network = await ensureModuleNetwork(config);
  if (!network.ready) {
    return configurationEnvelopeResult(503, {
      code: 'docker_unavailable',
      message: network.error || `Docker network "${network.name}" is unavailable.`,
      validationErrors: [],
      conflicts: [],
    });
  }

  let moduleServiceTokenId: string | null = null;

  try {
    await writeConfiguredModule(store, {
      ...nextModule,
      operationStatus: 'updating',
      lastOperation: 'configure',
      lastError: null,
    }, config);

    await ensureModuleOwnedDirectories(nextModule, config);
    await startResolvedDependencies(nextModule, store, config);

    for (const container of nextModule.containers) {
      await pullModuleImage({
        moduleId: nextModule.id,
        container: container.key,
        repository: container.image.repository,
        tag: container.image.tag,
        reference: container.image.reference,
        pullPolicy: container.image.pullPolicy === 'always' ||
          container.image.pullPolicy === 'manual' ||
          container.image.pullPolicy === 'ifNotPresent'
          ? container.image.pullPolicy
          : 'ifNotPresent',
      });
    }

    await removeModuleContainersIfExist(module);

    const moduleServiceToken = await createModuleServiceToken({
      moduleId: nextModule.id,
      label: 'Module container directory API token',
    }, undefined, config);
    moduleServiceTokenId = moduleServiceToken.tokenId;

    for (const container of getModuleContainersInStartOrder(nextModule, metadata)) {
      const metadataContainer = metadata.containers.find(candidate => candidate.key === container.key);
      await createAndStartModuleContainer({
        moduleId: nextModule.id,
        containerName: container.containerName,
        networkName: config.moduleNetwork,
        networkAlias: container.networkAlias,
        imageReference: container.image.reference,
        env: buildConfiguredEnvironment(
          nextModule,
          metadata,
          container.key,
          moduleServiceToken.token,
          config
        ),
        mounts: buildConfiguredMounts(nextModule, container.key),
        ports: buildConfiguredPorts(nextModule, metadata, container.key),
        ...(metadataContainer?.runtime.resources ? { resources: metadataContainer.runtime.resources } : {}),
      });
    }

    await writeConfiguredModule(store, nextModule, config);
    moduleServiceTokenId = null;

    const updatedModule = await getConfiguredModuleSummary(nextModule.id);
    if (!updatedModule) {
      throw new Error(`Module "${nextModule.id}" was configured but could not be read back from modules.json.`);
    }

    return {
      status: 200,
      body: {
        module: updatedModule,
        recreatedContainers: true,
        error: null,
      },
    };
  } catch (error) {
    if (moduleServiceTokenId) {
      await revokeModuleServiceToken(moduleServiceTokenId, undefined, config);
    }

    const operationError = toModuleOperationError(
      `module.configure.${nextModule.id}`,
      error,
      `Docker Host could not configure module "${nextModule.id}".`,
      'Inspect the preserved files and Docker containers, then retry the failed install recovery action.'
    );
    await markModuleFailed(nextModule.id, operationError, config);
    return configurationEnvelopeResult(500, {
      code: 'module_configuration_apply_failed',
      message: operationError.dockerMessage || operationError.message,
      validationErrors: [],
      conflicts: [],
    });
  }
}

async function writeConfiguredModule(
  store: ModulesStoreData,
  nextModule: InstalledModuleRecord,
  config: HostRuntimeConfig
) {
  await writeModulesStore(
    {
      ...store,
      modules: store.modules.map(module => module.id === nextModule.id ? nextModule : module),
    },
    config
  );
}

async function markModuleFailed(
  moduleId: string,
  error: ModuleOperationError,
  config: HostRuntimeConfig
) {
  const store = await readModulesStore(config);
  await writeModulesStore(
    {
      ...store,
      modules: store.modules.map(module =>
        module.id === moduleId
          ? {
              ...module,
              operationStatus: 'failed',
              lastOperation: 'configure',
              updatedAt: new Date().toISOString(),
              lastError: error,
            }
          : module
      ),
    },
    config
  );
}

async function getConfiguredModuleSummary(moduleId: string) {
  const modules = await listInstalledModules();
  return modules.find(candidate => candidate.id === moduleId) ?? null;
}

async function ensureModuleOwnedDirectories(
  module: InstalledModuleRecord,
  config: HostRuntimeConfig
) {
  await Promise.all(
    getStoredStorageMappings(module).map(async mapping => {
      const containerPath = resolveContainerDataPath(mapping.hostPath, config);
      if (containerPath) {
        await fs.mkdir(containerPath, { recursive: true });
      }
    })
  );
}

async function startResolvedDependencies(
  module: InstalledModuleRecord,
  store: ModulesStoreData,
  config: HostRuntimeConfig
) {
  for (const dependency of getResolvedDependencies(module)) {
    const installedDependency = store.modules.find(candidate => candidate.id === dependency.id);
    if (!installedDependency || (installedDependency.operationStatus || 'installed') !== 'installed') {
      throw new Error(`Dependency "${dependency.id}" must be installed before configuring "${module.id}".`);
    }

    const dependencyMetadata = await readModuleMetadata(installedDependency, config).catch(() => null);
    await ensureModuleContainersStarted(installedDependency, dependencyMetadata);
  }
}

function buildConfiguredEnvironment(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata,
  containerKey: string,
  moduleServiceToken: string,
  config: HostRuntimeConfig
) {
  const env: Record<string, string> = buildModuleServiceEnvironment({
    moduleId: module.id,
    serviceToken: moduleServiceToken,
    hostInternalOrigin: config.hostInternalOrigin,
  });
  const settings = module.settings || {};

  for (const setting of metadata.settings) {
    const value = settings[setting.key];
    if (value !== undefined) {
      for (const target of setting.targets.filter(target => target.container === containerKey)) {
        env[target.name] = stringifySettingValue(value);
      }
    }
  }

  for (const dependency of getResolvedDependencies(module)) {
    if (dependency.resolvedBaseUrl) {
      for (const target of (dependency.targets ?? []).filter(target => target.container === containerKey)) {
        env[target.name] = dependency.resolvedBaseUrl;
      }
    }
  }

  for (const connection of metadata.connections) {
    const endpoint = metadata.endpoints.find(candidate => candidate.key === connection.source.key);
    const sourceContainer = module.containers.find(candidate => candidate.key === endpoint?.container);
    const metadataContainer = metadata.containers.find(candidate => candidate.key === endpoint?.container);
    const port = metadataContainer?.runtime.ports.find(candidate => candidate.key === endpoint?.port);
    if (!endpoint || !sourceContainer || !port) {
      continue;
    }

    for (const target of connection.targets.filter(target => target.container === containerKey)) {
      env[target.name] = `http://${sourceContainer.networkAlias}:${port.containerPort}`;
    }
  }

  return env;
}

function buildConfiguredMounts(module: InstalledModuleRecord, containerKey: string) {
  return [
    ...getStoredStorageMappings(module).filter(mapping => mapping.container === containerKey).map(mapping => ({
      hostPath: mapping.hostPath,
      containerPath: mapping.containerPath,
      readOnly: Boolean(mapping.readOnly),
    })),
    ...getStoredExternalMounts(module).filter(mount => mount.container === containerKey).map(mount => ({
      hostPath: mount.hostPath,
      containerPath: mount.containerPath,
      readOnly: mount.readOnly,
    })),
  ];
}

function buildConfiguredPorts(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata,
  containerKey: string
) {
  const storedContainer = module.containers.find(container => container.key === containerKey);
  const storedPorts = new Map((storedContainer?.ports ?? []).map(port => [port.key, port]));
  const metadataContainer = metadata.containers.find(container => container.key === containerKey);

  return (metadataContainer?.runtime.ports ?? []).map(port => {
    const storedPort = storedPorts.get(port.key);
    if (!storedPort) {
      return {
        ...port,
        hostPublished: false,
      };
    }

    return {
      ...port,
      hostPublished: true,
      hostPort: storedPort.hostPort,
    };
  });
}

function collectReservedHostPorts(moduleId: string, store: ModulesStoreData) {
  const reserved = new Map<number, string>();

  for (const installedModule of store.modules) {
    if (installedModule.id === moduleId) {
      continue;
    }

    for (const container of installedModule.containers) {
      for (const port of container.ports ?? []) {
        reserved.set(port.hostPort, installedModule.id);
      }
    }
  }

  return reserved;
}

function collectInstalledHostPorts(module: InstalledModuleRecord) {
  return module.containers.flatMap(container =>
    (container.ports ?? []).map(port => ({
      container: container.key,
      key: port.key,
      hostPort: port.hostPort,
    }))
  );
}

function validateSettingValue(
  type: string,
  value: ModuleInstallSettingValue,
  required: boolean
) {
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
      ? null
      : 'Number settings must submit a finite number.';
  }

  if (type === 'boolean') {
    return typeof value === 'boolean' ? null : 'Boolean settings must submit a boolean.';
  }

  if (type === 'url') {
    if (typeof value !== 'string') {
      return 'URL settings must submit a string.';
    }

    if (required && !value.trim()) {
      return 'Required URL settings must not be empty.';
    }

    if (!value.trim() && !required) {
      return null;
    }

    try {
      new URL(value);
      return null;
    } catch {
      return 'URL settings must submit a valid URL.';
    }
  }

  if (typeof value !== 'string') {
    return 'String and secret settings must submit a string.';
  }

  if (required && !value.trim()) {
    return 'Required string and secret settings must not be empty.';
  }

  return null;
}

function readSettingSelections(
  value: unknown,
  validationErrors: InstallPlanValidationError[]
): ModuleInstallSettingSelection[] {
  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'module_configuration_request_invalid',
      message: 'settings must be an array.',
      path: '$.settings',
    });
    return [];
  }

  return value.flatMap((item, index) => {
    const itemPath = `$.settings[${index}]`;
    if (!isObject(item)) {
      validationErrors.push({
        code: 'module_configuration_request_invalid',
        message: 'settings[] item must be an object.',
        path: itemPath,
      });
      return [];
    }

    const moduleId = readString(item, 'moduleId', `${itemPath}.moduleId`, validationErrors);
    const key = readString(item, 'key', `${itemPath}.key`, validationErrors);
    const secret = readBoolean(item, 'secret', `${itemPath}.secret`, validationErrors);
    const settingValue = item.value;

    if (
      settingValue !== undefined &&
      typeof settingValue !== 'string' &&
      typeof settingValue !== 'number' &&
      typeof settingValue !== 'boolean'
    ) {
      validationErrors.push({
        code: 'module_configuration_request_invalid',
        message: 'settings[].value must be a string, number, or boolean.',
        path: `${itemPath}.value`,
      });
    }

    if (!moduleId || !key || secret === undefined || settingValue === undefined) {
      return [];
    }

    return [{
      moduleId,
      key,
      value: settingValue as ModuleInstallSettingValue,
      secret,
    }];
  });
}

function readExternalMountSelections(
  value: unknown,
  validationErrors: InstallPlanValidationError[]
): ModuleInstallExternalMountSelection[] {
  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'module_configuration_request_invalid',
      message: 'externalMounts must be an array.',
      path: '$.externalMounts',
    });
    return [];
  }

  return value.flatMap((item, index) => {
    const itemPath = `$.externalMounts[${index}]`;
    if (!isObject(item)) {
      validationErrors.push({
        code: 'module_configuration_request_invalid',
        message: 'externalMounts[] item must be an object.',
        path: itemPath,
      });
      return [];
    }

    const moduleId = readString(item, 'moduleId', `${itemPath}.moduleId`, validationErrors);
    const collectionKey = readString(item, 'collectionKey', `${itemPath}.collectionKey`, validationErrors);
    const key = readString(item, 'key', `${itemPath}.key`, validationErrors);
    const hostPath = readString(item, 'hostPath', `${itemPath}.hostPath`, validationErrors);
    const containerPath = readString(item, 'containerPath', `${itemPath}.containerPath`, validationErrors);
    const access = readString(item, 'access', `${itemPath}.access`, validationErrors);
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : undefined;

    if (!moduleId || !collectionKey || !key || !hostPath || !containerPath || !access) {
      return [];
    }

    if (access !== 'readOnly' && access !== 'readWrite') {
      validationErrors.push({
        code: 'module_configuration_request_invalid',
        message: 'externalMounts[].access must be readOnly or readWrite.',
        path: `${itemPath}.access`,
      });
      return [];
    }

    return [{
      moduleId,
      collectionKey,
      key,
      ...(label ? { label } : {}),
      hostPath,
      containerPath,
      access,
    }];
  });
}

function readEndpointOriginSelections(
  value: unknown,
  validationErrors: InstallPlanValidationError[]
): ModuleInstallEndpointOriginSelection[] {
  if (!Array.isArray(value)) {
    validationErrors.push({
      code: 'module_configuration_request_invalid',
      message: 'endpointOrigins must be an array.',
      path: '$.endpointOrigins',
    });
    return [];
  }

  return value.flatMap((item, index) => {
    const itemPath = `$.endpointOrigins[${index}]`;
    if (!isObject(item)) {
      validationErrors.push({
        code: 'module_configuration_request_invalid',
        message: 'endpointOrigins[] item must be an object.',
        path: itemPath,
      });
      return [];
    }

    const moduleId = readString(item, 'moduleId', `${itemPath}.moduleId`, validationErrors);
    const endpoint = readString(item, 'endpoint', `${itemPath}.endpoint`, validationErrors);
    const publicOrigin = typeof item.publicOrigin === 'string' ? item.publicOrigin.trim() : undefined;
    const hostPort = item.hostPort;
    if (hostPort !== undefined && typeof hostPort !== 'number') {
      validationErrors.push({
        code: 'module_configuration_request_invalid',
        message: 'endpointOrigins[].hostPort must be a number.',
        path: `${itemPath}.hostPort`,
      });
    }

    if (!moduleId || !endpoint) {
      return [];
    }

    return [{
      moduleId,
      endpoint,
      ...(typeof hostPort === 'number' ? { hostPort } : {}),
      ...(publicOrigin ? { publicOrigin } : {}),
    }];
  });
}

function configurationEnvelopeResult(
  status: ConfigurationApplyResult['status'],
  error: InstallPlanErrorEnvelope
): ConfigurationApplyResult {
  return {
    status,
    body: { error },
  };
}

function contextError(
  status: ConfigurationPlanStatus,
  code: string,
  message: string,
  conflicts: InstallPlanConflict[] = []
) {
  return {
    status,
    context: null,
    error: {
      code,
      message,
      validationErrors: [],
      conflicts,
    },
  };
}

function readString(
  object: Record<string, unknown>,
  key: string,
  pathToValue: string,
  validationErrors: InstallPlanValidationError[]
) {
  const value = object[key];

  if (typeof value !== 'string' || !value.trim()) {
    validationErrors.push({
      code: 'module_configuration_request_invalid',
      message: `${key} must be a non-empty string.`,
      path: pathToValue,
    });
    return null;
  }

  return value.trim();
}

function readBoolean(
  object: Record<string, unknown>,
  key: string,
  pathToValue: string,
  validationErrors: InstallPlanValidationError[]
) {
  const value = object[key];

  if (typeof value !== 'boolean') {
    validationErrors.push({
      code: 'module_configuration_request_invalid',
      message: `${key} must be a boolean.`,
      path: pathToValue,
    });
    return undefined;
  }

  return value;
}

function stringifySettingValue(value: InstalledSettingValue) {
  return typeof value === 'boolean' ? String(value) : String(value);
}

function settingKey(moduleId: string, key: string) {
  return `${moduleId}:${key}`;
}

function normalizePublicOrigin(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    if (parsed.username || parsed.password) {
      return null;
    }

    if (
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      !parsed.hostname
    ) {
      return null;
    }

    return parsed.origin;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
