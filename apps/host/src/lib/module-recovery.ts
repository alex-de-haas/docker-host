import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureHostDataRoot, getHostRuntimeConfig, pathExists } from '@/lib/host-runtime';
import {
  createAndStartModuleContainer,
  ensureModuleContainerStarted,
  ensureModuleNetwork,
  getModuleContainerName,
  getModuleNetworkAlias,
  inspectContainerNameReadOnly,
  pullModuleImage,
  removeModuleContainerIfExists,
  toModuleOperationError,
} from '@/lib/module-docker';
import { validateAndNormalizeMetadata } from '@/lib/module-metadata';
import { withModuleMutationLock } from '@/lib/module-mutation-lock';
import {
  readModulesStore,
  resolveModuleMetadataPath,
  writeModulesStore,
} from '@/lib/module-store';
import {
  findDependentModules,
  getResolvedDependencies,
  getStoredExternalMounts,
  getStoredStorageMappings,
  resolveContainerDataPath,
} from '@/lib/module-recovery-model';
import { listInstalledModules } from '@/lib/module-service';
import type { HostRuntimeConfig } from '@/lib/host-runtime';
import type {
  DockerContainerNameStatus,
} from '@/lib/module-docker';
import type {
  InstallPlanConflict,
  InstallPlanErrorEnvelope,
  InstallPlanImage,
  InstalledModuleRecord,
  InstalledSettingValue,
  InstalledStorageMapping,
  ModuleActionResult,
  ModuleOperationError,
  ModuleRecoveryAction,
  ModuleRecoveryActionResult,
  ModuleRecoveryApplyRequest,
  ModuleRecoveryPlan,
  ModuleRecoveryPlanResponse,
  ModulesStoreData,
  NormalizedModuleMetadata,
} from '@/types/modules';

type PlanStatus = 200 | 404 | 409 | 503;
type ApplyStatus = 200 | 404 | 409 | 422 | 500 | 503;

export type ModuleRecoveryPlanResult = {
  status: PlanStatus;
  body: ModuleRecoveryPlanResponse;
};

export type ModuleRecoveryApplyResult = {
  status: ApplyStatus;
  body: ModuleRecoveryActionResult;
};

export type ModuleRetryResult = {
  status: ApplyStatus;
  body: ModuleActionResult;
};

export interface ModuleRecoveryDockerOperations {
  inspectContainerName: typeof inspectContainerNameReadOnly;
  removeContainerIfExists: typeof removeModuleContainerIfExists;
  ensureNetwork: typeof ensureModuleNetwork;
  pullImage: typeof pullModuleImage;
  createAndStartContainer: typeof createAndStartModuleContainer;
  ensureContainerStarted: typeof ensureModuleContainerStarted;
}

export interface ModuleRecoveryOptions {
  config?: HostRuntimeConfig;
  docker?: ModuleRecoveryDockerOperations;
  now?: () => string;
}

const defaultDockerOperations: ModuleRecoveryDockerOperations = {
  inspectContainerName: inspectContainerNameReadOnly,
  removeContainerIfExists: removeModuleContainerIfExists,
  ensureNetwork: ensureModuleNetwork,
  pullImage: pullModuleImage,
  createAndStartContainer: createAndStartModuleContainer,
  ensureContainerStarted: ensureModuleContainerStarted,
};

export async function createModuleCleanupPlan(
  moduleId: string,
  deleteModuleData: boolean = false,
  options: ModuleRecoveryOptions = {}
): Promise<ModuleRecoveryPlanResult> {
  return buildModuleRecoveryPlan('cleanup', moduleId, deleteModuleData, options);
}

export async function createModuleRemovePlan(
  moduleId: string,
  deleteModuleData: boolean = false,
  options: ModuleRecoveryOptions = {}
): Promise<ModuleRecoveryPlanResult> {
  return buildModuleRecoveryPlan('remove', moduleId, deleteModuleData, options);
}

export async function applyModuleCleanupRequest(
  moduleId: string,
  body: unknown,
  options: ModuleRecoveryOptions = {}
): Promise<ModuleRecoveryApplyResult> {
  const request = parseRecoveryApplyRequest(body);
  if (!request.confirmed) {
    return recoveryActionFailure(422, 'module.cleanup', {
      message: 'Cleanup requires explicit confirmation.',
      nextStep: 'Review the cleanup plan, then submit confirmed=true.',
    });
  }

  return withModuleMutationLock(async () => {
    const planResult = await createModuleCleanupPlan(moduleId, request.deleteModuleData, options);
    if (planResult.status !== 200 || !planResult.body.plan?.canApply) {
      return planBlockedResult('module.cleanup', planResult);
    }

    return applyCleanupOrRemove(planResult.body.plan, options);
  });
}

export async function applyModuleRemoveRequest(
  moduleId: string,
  body: unknown,
  options: ModuleRecoveryOptions = {}
): Promise<ModuleRecoveryApplyResult> {
  const request = parseRecoveryApplyRequest(body);
  if (!request.confirmed) {
    return recoveryActionFailure(422, 'module.remove', {
      message: 'Remove requires explicit confirmation.',
      nextStep: 'Review the remove plan, then submit confirmed=true.',
    });
  }

  return withModuleMutationLock(async () => {
    const planResult = await createModuleRemovePlan(moduleId, request.deleteModuleData, options);
    if (planResult.status !== 200 || !planResult.body.plan?.canApply) {
      return planBlockedResult('module.remove', planResult);
    }

    return applyCleanupOrRemove(planResult.body.plan, options);
  });
}

export async function retryFailedModuleInstall(
  moduleId: string,
  options: ModuleRecoveryOptions = {}
): Promise<ModuleRetryResult> {
  return withModuleMutationLock(async () => {
    const config = options.config ?? getHostRuntimeConfig();
    const docker = options.docker ?? defaultDockerOperations;
    const now = options.now ?? (() => new Date().toISOString());
    await ensureHostDataRoot(config);

    const store = await readModulesStore(config);
    const installedModule = store.modules.find(candidate => candidate.id === moduleId);
    if (!installedModule) {
      return moduleActionFailure(404, 'module.retry', {
        message: `Module "${moduleId}" is not installed.`,
        nextStep: 'Install the module before retrying recovery.',
      });
    }

    if ((installedModule.operationStatus || 'installed') !== 'failed') {
      return moduleActionFailure(409, 'module.retry', {
        message: `Module "${moduleId}" is not in failed state.`,
        nextStep: 'Retry is only available for failed installs.',
      });
    }

    const metadataResult = await readNormalizedLocalMetadata(installedModule, config);
    if (!metadataResult.metadata) {
      const error = operationError('module.retry.metadata', 409, metadataResult.message, 'Refresh the metadata URL and review the install plan again.');
      await markModuleFailed(moduleId, error, config, now);
      return { status: 409, body: { success: false, module: null, error } };
    }

    const storageError = validateStoredStorageMappings(installedModule, metadataResult.metadata);
    if (storageError) {
      const error = operationError('module.retry.storage', 409, storageError, 'Clean up the failed install or review the install again.');
      await markModuleFailed(moduleId, error, config, now);
      return { status: 409, body: { success: false, module: null, error } };
    }

    const network = await docker.ensureNetwork(config);
    if (!network.ready) {
      return moduleActionFailure(503, 'module.retry.network', {
        message: network.error || `Docker network "${network.name}" is unavailable.`,
        nextStep: 'Start Docker and retry the failed install.',
      });
    }

    try {
      await updateModuleRecord(moduleId, config, existing => ({
        ...existing,
        operationStatus: 'installing',
        updatedAt: now(),
        lastError: null,
      }));

      await ensureModuleOwnedDirectories(installedModule, config);
      await startResolvedDependencies(installedModule, store, docker);
      await docker.removeContainerIfExists(installedModule);

      const containerRecord = installedModule.containers[0];
      const metadataContainer = metadataResult.metadata.containers.find(container => container.key === containerRecord?.key) ??
        metadataResult.metadata.containers[0];
      const image = buildInstallImage(installedModule, metadataResult.metadata, metadataContainer?.key);
      await docker.pullImage(image);
      await docker.createAndStartContainer({
        moduleId,
        containerName: containerRecord?.containerName || getModuleContainerName(installedModule),
        networkName: config.moduleNetwork,
        networkAlias: containerRecord?.networkAlias || getModuleNetworkAlias(installedModule.id),
        imageReference: image.reference,
        env: buildRetryEnvironment(installedModule, metadataResult.metadata, metadataContainer?.key ?? containerRecord?.key ?? ''),
        mounts: buildRetryMounts(installedModule, metadataContainer?.key ?? containerRecord?.key ?? ''),
        ports: metadataContainer?.runtime.ports ?? [],
        ...(metadataContainer?.runtime.resources ? { resources: metadataContainer.runtime.resources } : {}),
      });

      await updateModuleRecord(moduleId, config, existing => ({
        ...existing,
        operationStatus: 'installed',
        updatedAt: now(),
        installedAt: existing.installedAt || now(),
        lastError: null,
      }));

      const modules = await listInstalledModules();
      return {
        status: 200,
        body: {
          success: true,
          module: modules.find(candidate => candidate.id === moduleId) ?? null,
          error: null,
        },
      };
    } catch (error) {
      const operation = toModuleOperationError(
        `module.retry.${moduleId}`,
        error,
        `Docker Host could not retry module "${moduleId}".`,
        'Inspect the preserved files, Docker images, and containers, then retry again or run cleanup.'
      );
      await markModuleFailed(moduleId, operation, config, now);
      return {
        status: operation.httpStatus === 409 ? 409 : 500,
        body: {
          success: false,
          module: null,
          error: operation,
        },
      };
    }
  });
}

export function normalizeRecoveryActionStatus(result: ModuleRecoveryActionResult) {
  return result.error?.httpStatus || (result.success ? 200 : 500);
}

function parseRecoveryApplyRequest(body: unknown): Required<ModuleRecoveryApplyRequest> {
  if (!isObject(body)) {
    return { confirmed: false, deleteModuleData: false };
  }

  return {
    confirmed: body.confirmed === true,
    deleteModuleData: body.deleteModuleData === true,
  };
}

async function buildModuleRecoveryPlan(
  action: ModuleRecoveryAction,
  moduleId: string,
  deleteModuleData: boolean,
  options: ModuleRecoveryOptions
): Promise<ModuleRecoveryPlanResult> {
  const config = options.config ?? getHostRuntimeConfig();
  const docker = options.docker ?? defaultDockerOperations;
  await ensureHostDataRoot(config);

  const store = await readModulesStore(config);
  const installedModule = store.modules.find(candidate => candidate.id === moduleId);
  if (!installedModule) {
    return {
      status: 404,
      body: {
        error: recoveryErrorEnvelope(
          'module_not_found',
          `Module "${moduleId}" is not installed.`
        ),
      },
    };
  }

  let container: DockerContainerNameStatus;
  try {
    container = await docker.inspectContainerName(getModuleContainerName(installedModule));
  } catch (error) {
    return {
      status: 503,
      body: {
        error: recoveryErrorEnvelope(
          'docker_unavailable',
          error instanceof Error ? error.message : 'Docker daemon is unavailable.'
        ),
      },
    };
  }

  const metadata = await readLocalMetadataJson(installedModule, config);
  const dependents = findDependentModules(installedModule.id, store);
  const conflicts = collectRecoveryConflicts(action, installedModule, dependents);
  const status = installedModule.operationStatus || 'installed';
  const canApply = conflicts.length === 0 &&
    ((action === 'cleanup' && status === 'failed') ||
      (action === 'remove' && status === 'installed'));
  const metadataPath = resolveModuleMetadataPath(installedModule, config);
  const moduleDirectory = path.dirname(metadataPath);
  const metadataExists = await pathExists(metadataPath);
  const moduleDirectoryExists = await pathExists(moduleDirectory);
  const storageDirectories = await Promise.all(
    getStoredStorageMappings(installedModule).map(async mapping => ({
      ...mapping,
      exists: await storageMappingExists(mapping, config),
      willDelete: deleteModuleData,
    }))
  );

  const plan: ModuleRecoveryPlan = {
    action,
    moduleId: installedModule.id,
    moduleName: metadata?.name || installedModule.id,
    operationStatus: status,
    canApply,
    deleteModuleDataDefault: false,
    deleteModuleData,
    container: {
      name: container.name,
      exists: container.exists,
      id: container.id,
      image: container.image,
      willRemove: container.exists,
    },
    image: {
      reference: buildImageReference(installedModule, metadata),
      willRemove: false,
    },
    metadataFile: {
      path: metadataPath,
      exists: metadataExists,
      willDelete: metadataExists,
    },
    moduleDirectory: {
      path: moduleDirectory,
      exists: moduleDirectoryExists,
      willDelete: deleteModuleData && moduleDirectoryExists,
    },
    storageDirectories,
    externalMounts: getStoredExternalMounts(installedModule).map(mount => ({
      ...mount,
      willDelete: false,
    })),
    dependents,
    conflicts,
    warnings: buildPlanWarnings(action, installedModule, container, metadataExists, deleteModuleData),
  };

  return {
    status: canApply ? 200 : 409,
    body: canApply
      ? { plan }
      : {
          plan,
          error: recoveryErrorEnvelope(
            'module_recovery_conflict',
            `Module "${installedModule.id}" cannot be ${action === 'cleanup' ? 'cleaned up' : 'removed'} in its current state.`,
            conflicts
          ),
        },
  };
}

async function applyCleanupOrRemove(
  plan: ModuleRecoveryPlan,
  options: ModuleRecoveryOptions
): Promise<ModuleRecoveryApplyResult> {
  const config = options.config ?? getHostRuntimeConfig();
  const docker = options.docker ?? defaultDockerOperations;
  const now = options.now ?? (() => new Date().toISOString());
  const operation = plan.action === 'cleanup' ? 'module.cleanup' : 'module.remove';
  const store = await readModulesStore(config);
  const installedModule = store.modules.find(candidate => candidate.id === plan.moduleId);

  if (!installedModule) {
    return recoveryActionFailure(404, operation, {
      message: `Module "${plan.moduleId}" is not installed.`,
      nextStep: 'Refresh the dashboard.',
    });
  }

  if (plan.action === 'remove') {
    await updateModuleRecord(plan.moduleId, config, existing => ({
      ...existing,
      operationStatus: 'removing',
      updatedAt: now(),
      lastError: null,
    }));
  }

  try {
    await docker.removeContainerIfExists(installedModule);
    await removeModuleFiles(installedModule, plan.deleteModuleData, config);
    await removeModuleRecord(plan.moduleId, config);

    return {
      status: 200,
      body: {
        success: true,
        module: null,
        removedModuleId: plan.moduleId,
        plan,
        error: null,
      },
    };
  } catch (error) {
    const operationError = toModuleOperationError(
      operation,
      error,
      `Docker Host could not ${plan.action === 'cleanup' ? 'clean up' : 'remove'} module "${plan.moduleId}".`,
      'Inspect the preserved module files and Docker container, then retry the operation.'
    );

    if (plan.action === 'remove') {
      await updateModuleRecord(plan.moduleId, config, existing => ({
        ...existing,
        operationStatus: 'installed',
        updatedAt: now(),
        lastError: operationError,
      }));
    } else {
      await markModuleFailed(plan.moduleId, operationError, config, now);
    }

    return {
      status: 500,
      body: {
        success: false,
        module: null,
        plan,
        error: operationError,
      },
    };
  }
}

function collectRecoveryConflicts(
  action: ModuleRecoveryAction,
  module: InstalledModuleRecord,
  dependents: ModuleRecoveryPlan['dependents']
): InstallPlanConflict[] {
  const status = module.operationStatus || 'installed';
  const conflicts: InstallPlanConflict[] = [];

  if (action === 'cleanup' && status !== 'failed') {
    conflicts.push({
      code: 'module_status_conflict',
      message: `Cleanup is only available for failed modules; current status is "${status}".`,
      resourceType: 'installed_module',
      resourceId: module.id,
      path: '$.operationStatus',
      existingValue: status,
      proposedValue: 'failed',
    });
  }

  if (action === 'remove' && status !== 'installed') {
    conflicts.push({
      code: 'module_status_conflict',
      message: `Remove is only available for installed modules; current status is "${status}".`,
      resourceType: 'installed_module',
      resourceId: module.id,
      path: '$.operationStatus',
      existingValue: status,
      proposedValue: 'installed',
    });
  }

  if (action === 'remove' && dependents.length > 0) {
    conflicts.push({
      code: 'module_dependents_conflict',
      message: `Module "${module.id}" is required by ${dependents.length} installed module${dependents.length === 1 ? '' : 's'}.`,
      resourceType: 'installed_module',
      resourceId: module.id,
      path: '$.dependents',
      existingValue: dependents.map(dependent => dependent.id),
      proposedValue: [],
    });
  }

  return conflicts;
}

function buildPlanWarnings(
  action: ModuleRecoveryAction,
  module: InstalledModuleRecord,
  container: DockerContainerNameStatus,
  metadataExists: boolean,
  deleteModuleData: boolean
) {
  const warnings: string[] = [];

  if (!container.exists) {
    warnings.push(`Docker container "${getModuleContainerName(module)}" is already missing.`);
  }

  if (!metadataExists) {
    warnings.push('Local metadata.json is missing.');
  }

  if (!deleteModuleData) {
    warnings.push('Module-owned data directories will be preserved.');
  }

  if (getStoredExternalMounts(module).length > 0) {
    warnings.push('External host paths are never deleted; only Host state mappings are removed.');
  }

  if (action === 'remove') {
    warnings.push('Docker images are preserved.');
  }

  return warnings;
}

async function removeModuleFiles(
  module: InstalledModuleRecord,
  deleteModuleData: boolean,
  config: HostRuntimeConfig
) {
  const metadataPath = resolveModuleMetadataPath(module, config);
  const moduleDirectory = path.dirname(metadataPath);

  if (deleteModuleData) {
    await fs.rm(moduleDirectory, { recursive: true, force: true });
    return;
  }

  await fs.rm(metadataPath, { force: true });
}

async function readNormalizedLocalMetadata(
  module: InstalledModuleRecord,
  config: HostRuntimeConfig
): Promise<{ metadata: NormalizedModuleMetadata | null; message: string }> {
  const metadataPath = resolveModuleMetadataPath(module, config);

  try {
    const raw = await fs.readFile(metadataPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const validation = validateAndNormalizeMetadata(parsed, '$');

    if (!validation.metadata) {
      return {
        metadata: null,
        message: validation.validationErrors[0]?.message || 'Local metadata.json is invalid.',
      };
    }

    if (validation.metadata.id !== module.id) {
      return {
        metadata: null,
        message: `Local metadata id "${validation.metadata.id}" does not match module "${module.id}".`,
      };
    }

    return { metadata: validation.metadata, message: '' };
  } catch (error) {
    return {
      metadata: null,
      message: error instanceof Error ? error.message : 'Local metadata.json could not be read.',
    };
  }
}

async function readLocalMetadataJson(
  module: InstalledModuleRecord,
  config: HostRuntimeConfig
) {
  const metadata = await readNormalizedLocalMetadata(module, config);
  return metadata.metadata;
}

function validateStoredStorageMappings(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata
) {
  const mappings = new Map(getStoredStorageMappings(module).map(mapping => [mapping.key, mapping]));

  for (const directory of metadata.storage.directories.filter(candidate => candidate.required)) {
    if (!mappings.has(directory.key)) {
      return `Required storage mapping "${directory.key}" is missing.`;
    }
  }

  return null;
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
  docker: ModuleRecoveryDockerOperations
) {
  const dependencies = getResolvedDependencies(module);

  for (const dependency of dependencies) {
    const installedDependency = store.modules.find(candidate => candidate.id === dependency.id);
    if (!installedDependency || (installedDependency.operationStatus || 'installed') !== 'installed') {
      throw new Error(`Dependency "${dependency.id}" must be installed before retrying "${module.id}".`);
    }

    await docker.ensureContainerStarted(installedDependency);
  }
}

function buildRetryEnvironment(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata,
  containerKey: string
) {
  const env: Record<string, string> = {};
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

  return env;
}

function buildRetryMounts(module: InstalledModuleRecord, containerKey: string) {
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

function buildInstallImage(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata,
  containerKey?: string
): InstallPlanImage {
  const storedContainer = module.containers.find(container => container.key === containerKey) ?? module.containers[0];
  const metadataContainer = metadata.containers.find(container => container.key === containerKey) ?? metadata.containers[0];
  const repository = storedContainer?.image.repository || metadataContainer?.image.repository || 'unknown';
  const tag = storedContainer?.image.tag || metadataContainer?.image.tag || 'latest';
  const pullPolicy = storedContainer?.image.pullPolicy === 'always' ||
    storedContainer?.image.pullPolicy === 'manual' ||
    storedContainer?.image.pullPolicy === 'ifNotPresent'
    ? storedContainer.image.pullPolicy
    : metadataContainer?.image.pullPolicy || 'ifNotPresent';

  return {
    moduleId: module.id,
    container: containerKey || storedContainer?.key || metadataContainer?.key || 'main',
    repository,
    tag,
    reference: storedContainer?.image.reference || `${repository}:${tag}`,
    pullPolicy,
  };
}

function buildImageReference(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata | null
) {
  const storedContainer = module.containers[0];
  const metadataContainer = metadata?.containers[0];

  if (storedContainer?.image.reference) {
    return storedContainer.image.reference;
  }

  const repository = storedContainer?.image.repository || metadataContainer?.image.repository || 'unknown';
  const tag = storedContainer?.image.tag || metadataContainer?.image.tag || 'latest';
  return `${repository}:${tag}`;
}

async function storageMappingExists(
  mapping: InstalledStorageMapping,
  config: HostRuntimeConfig
) {
  const containerPath = resolveContainerDataPath(mapping.hostPath, config);
  return containerPath ? pathExists(containerPath) : false;
}

async function updateModuleRecord(
  moduleId: string,
  config: HostRuntimeConfig,
  updater: (existing: InstalledModuleRecord) => InstalledModuleRecord
) {
  const store = await readModulesStore(config);
  const existingIndex = store.modules.findIndex(module => module.id === moduleId);
  if (existingIndex < 0) {
    throw new Error(`Module "${moduleId}" is not installed.`);
  }

  await writeModulesStore(
    {
      ...store,
      modules: store.modules.map((module, index) =>
        index === existingIndex ? updater(module) : module
      ),
    },
    config
  );
}

async function removeModuleRecord(moduleId: string, config: HostRuntimeConfig) {
  const store = await readModulesStore(config);
  await writeModulesStore(
    {
      ...store,
      modules: store.modules.filter(module => module.id !== moduleId),
    },
    config
  );
}

async function markModuleFailed(
  moduleId: string,
  error: ModuleOperationError,
  config: HostRuntimeConfig,
  now: () => string
) {
  await updateModuleRecord(moduleId, config, existing => ({
    ...existing,
    operationStatus: 'failed',
    updatedAt: now(),
    lastError: error,
  }));
}

function recoveryErrorEnvelope(
  code: string,
  message: string,
  conflicts: InstallPlanConflict[] = []
): InstallPlanErrorEnvelope {
  return {
    code,
    message,
    validationErrors: [],
    conflicts,
  };
}

function planBlockedResult(
  operation: string,
  planResult: ModuleRecoveryPlanResult
): ModuleRecoveryApplyResult {
  return {
    status: planResult.status === 200 ? 409 : planResult.status,
    body: {
      success: false,
      module: null,
      ...(planResult.body.plan ? { plan: planResult.body.plan } : {}),
      error: {
        operation,
        httpStatus: planResult.status === 200 ? 409 : planResult.status,
        message: planResult.body.error?.message || 'The requested module recovery action is blocked.',
        nextStep: 'Review the recovery plan and resolve conflicts before applying it.',
        occurredAt: new Date().toISOString(),
      },
    },
  };
}

function recoveryActionFailure(
  status: ApplyStatus,
  operation: string,
  error: Pick<ModuleOperationError, 'message' | 'nextStep'>
): ModuleRecoveryApplyResult {
  return {
    status,
    body: {
      success: false,
      module: null,
      error: {
        operation,
        httpStatus: status,
        message: error.message,
        nextStep: error.nextStep,
        occurredAt: new Date().toISOString(),
      },
    },
  };
}

function moduleActionFailure(
  status: ApplyStatus,
  operation: string,
  error: Pick<ModuleOperationError, 'message' | 'nextStep'>
): ModuleRetryResult {
  return {
    status,
    body: {
      success: false,
      module: null,
      error: {
        operation,
        httpStatus: status,
        message: error.message,
        nextStep: error.nextStep,
        occurredAt: new Date().toISOString(),
      },
    },
  };
}

function operationError(
  operation: string,
  status: ApplyStatus,
  message: string,
  nextStep: string
): ModuleOperationError {
  return {
    operation,
    httpStatus: status,
    message,
    nextStep,
    occurredAt: new Date().toISOString(),
  };
}

function stringifySettingValue(value: InstalledSettingValue) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function localMetadataDigest(raw: string | Buffer) {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}
