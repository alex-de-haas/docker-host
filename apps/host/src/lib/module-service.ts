import path from 'node:path';
import { ensureHostDataRoot, getHostRuntimeConfig } from '@/lib/host-runtime';
import {
  ensureModuleNetwork,
  getDockerDaemonStatus,
  getModuleRuntimeStatuses,
  restartModuleContainers,
  startModuleContainers,
  stopModuleContainers,
  toModuleOperationError,
} from '@/lib/module-docker';
import { buildModuleAggregateRuntimeStatus } from './module-lifecycle.ts';
import { validateAndNormalizeMetadata } from './module-metadata.ts';
import {
  findInstalledModule,
  readModuleMetadata,
  getModulesStoreStatus,
  readModulesStore,
  writeModulesStore,
} from '@/lib/module-store';
import type {
  InstalledExternalMountMapping,
  InstalledModuleRecord,
  InstalledStorageMapping,
  ModuleActionResult,
  ModuleDetail,
  ModuleImage,
  ModuleRuntimeState,
  ModuleRuntimeStatus,
  ModuleSummary,
  NormalizedModuleMetadata,
  ResolvedDependency,
} from '@/types/modules';

export interface HostStatus {
  host: {
    ready: boolean;
    dataRoot: Awaited<ReturnType<typeof ensureHostDataRoot>>;
    store: Awaited<ReturnType<typeof getModulesStoreStatus>>;
    moduleNetwork: Awaited<ReturnType<typeof ensureModuleNetwork>>;
  };
  docker: Awaited<ReturnType<typeof getDockerDaemonStatus>>;
}

export async function getHostStatus(): Promise<HostStatus> {
  const config = getHostRuntimeConfig();
  const dataRoot = await ensureHostDataRoot(config);
  const [store, docker, moduleNetwork] = await Promise.all([
    getModulesStoreStatus(config),
    getDockerDaemonStatus(),
    ensureModuleNetwork(config),
  ]);

  return {
    host: {
      ready: dataRoot.ready && store.readable && store.writable && moduleNetwork.ready,
      dataRoot,
      store,
      moduleNetwork,
    },
    docker,
  };
}

export async function listInstalledModules(): Promise<ModuleSummary[]> {
  const config = getHostRuntimeConfig();
  await ensureHostDataRoot(config);
  const store = await readModulesStore(config);

  return Promise.all(
    store.modules.map(async installedModule => {
      const [metadata, runtimeStatuses] = await Promise.all([
        safeReadModuleMetadata(installedModule, config),
        getModuleRuntimeStatuses(installedModule),
      ]);

      return toModuleSummary(installedModule, metadata, runtimeStatuses);
    })
  );
}

export async function getInstalledModuleDetail(moduleId: string): Promise<ModuleDetail | null> {
  const config = getHostRuntimeConfig();
  await ensureHostDataRoot(config);
  const installedModule = await findInstalledModule(moduleId, config);

  if (!installedModule) {
    return null;
  }

  const [metadata, runtimeStatuses] = await Promise.all([
    safeReadModuleMetadata(installedModule, config),
    getModuleRuntimeStatuses(installedModule),
  ]);
  const summary = toModuleSummary(installedModule, metadata, runtimeStatuses);

  return {
    ...summary,
    settings: buildSettings(installedModule, metadata),
    storage: {
      directories: buildStorageDirectories(installedModule, metadata),
      externalMounts: getStoredExternalMounts(installedModule),
    },
    dependencies: buildDependencies(installedModule, metadata),
  };
}

export async function startInstalledModule(moduleId: string): Promise<ModuleActionResult> {
  return runModuleAction(
    moduleId,
    'module.start',
    startModuleContainers,
    'Docker could not start all module containers.',
    'Retry the failed install or reinstall the module if a container is missing.'
  );
}

export async function stopInstalledModule(moduleId: string): Promise<ModuleActionResult> {
  return runModuleAction(
    moduleId,
    'module.stop',
    stopModuleContainers,
    'Docker could not stop all module containers.',
    'Inspect the module containers in Docker, then retry the stop action.'
  );
}

export async function restartInstalledModule(moduleId: string): Promise<ModuleActionResult> {
  return runModuleAction(
    moduleId,
    'module.restart',
    restartModuleContainers,
    'Docker could not restart all module containers.',
    'Inspect the module container logs and retry the restart action.'
  );
}

async function runModuleAction(
  moduleId: string,
  operation: string,
  action: (module: InstalledModuleRecord, metadata?: NormalizedModuleMetadata | null) => Promise<ModuleRuntimeStatus[]>,
  fallbackMessage: string,
  nextStep: string
): Promise<ModuleActionResult> {
  const config = getHostRuntimeConfig();
  await ensureHostDataRoot(config);
  const installedModule = await findInstalledModule(moduleId, config);

  if (!installedModule) {
    return {
      success: false,
      module: null,
      error: {
        operation,
        httpStatus: 404,
        message: `Module "${moduleId}" is not installed.`,
        nextStep: 'Install the module before running lifecycle actions.',
        occurredAt: new Date().toISOString(),
      },
    };
  }

  const preflightError = await getPersistentLifecyclePreflightError(
    installedModule,
    operation,
    config
  );
  if (preflightError) {
    await markModuleFailed(moduleId, preflightError, config);
    return {
      success: false,
      module: null,
      error: preflightError,
    };
  }

  try {
    const metadata = await safeReadModuleMetadata(installedModule, config);
    const runtimeStatuses = await action(installedModule, metadata);

    return {
      success: true,
      module: toModuleSummary(installedModule, metadata, runtimeStatuses),
      error: null,
    };
  } catch (error) {
    return {
      success: false,
      module: null,
      error: toModuleOperationError(operation, error, fallbackMessage, nextStep),
    };
  }
}

async function getPersistentLifecyclePreflightError(
  module: InstalledModuleRecord,
  operation: string,
  config = getHostRuntimeConfig()
): Promise<ModuleActionResult['error']> {
  const runtimeStatuses = await getModuleRuntimeStatuses(module);
  const missingContainers = runtimeStatuses.filter(status => status.state === 'not_created');
  if (missingContainers.length > 0) {
    return {
      operation,
      httpStatus: 409,
      message: `Module "${module.id}" is missing Docker container${missingContainers.length === 1 ? '' : 's'} ${missingContainers.map(status => `"${status.containerName}"`).join(', ')}.`,
      nextStep: 'Retry the failed install or remove the module and install it again.',
      occurredAt: new Date().toISOString(),
    };
  }

  if (operation !== 'module.start' && operation !== 'module.restart') {
    return null;
  }

  const metadata = await safeReadModuleMetadata(module, config);
  if (!metadata) {
    return null;
  }

  for (const directory of metadata.storage?.directories || []) {
    if (!directory.required) {
      continue;
    }

    for (const target of directory.targets) {
      if (!getStoredStorageMapping(module, directory.key, target.container)) {
        return {
          operation,
          httpStatus: 409,
          message: `Module "${module.id}" is missing required storage mapping "${directory.key}" for container "${target.container}".`,
          nextStep: 'Clean up the module record or review the install again.',
          occurredAt: new Date().toISOString(),
        };
      }
    }
  }

  return null;
}

async function markModuleFailed(
  moduleId: string,
  error: NonNullable<ModuleActionResult['error']>,
  config = getHostRuntimeConfig()
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
              updatedAt: new Date().toISOString(),
              lastError: error,
            }
          : module
      ),
    },
    config
  );
}

async function safeReadModuleMetadata(
  module: InstalledModuleRecord,
  config = getHostRuntimeConfig()
): Promise<NormalizedModuleMetadata | null> {
  try {
    const metadata = await readModuleMetadata(module, config);
    if (!metadata) {
      return null;
    }

    return validateAndNormalizeMetadata(metadata, '$').metadata;
  } catch {
    return null;
  }
}

function toModuleSummary(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata | null,
  runtimeStatuses: ModuleRuntimeStatus[]
): ModuleSummary {
  const containers = buildContainerSummaries(module, metadata, runtimeStatuses);

  return {
    id: module.id,
    name: metadata?.name || module.id,
    description: metadata?.description,
    version: metadata?.version || 'unknown',
    metadataUrl: module.metadataUrl,
    containers,
    operationStatus: module.operationStatus || 'installed',
    runtimeStatus: buildModuleAggregateRuntimeStatus(runtimeStatuses),
    installedAt: module.installedAt,
    updatedAt: module.updatedAt,
    lastOperation: module.lastOperation,
    lastError: module.lastError ?? null,
  };
}

function buildContainerSummaries(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata | null,
  runtimeStatuses: ModuleRuntimeStatus[]
): ModuleSummary['containers'] {
  return module.containers.map((container, index) => {
    const metadataContainer = metadata?.containers.find(candidate => candidate.key === container.key);
    const runtimeStatus = runtimeStatuses[index] ?? {
      state: 'unknown' as ModuleRuntimeState,
      containerId: null,
      containerName: container.containerName,
      startedAt: null,
      finishedAt: null,
    };

    return {
      key: container.key,
      image: buildContainerImage(container.image, metadataContainer?.image),
      runtimeStatus,
      networkAlias: container.networkAlias,
      endpoints: metadata?.endpoints?.filter(endpoint => endpoint.container === container.key) ?? [],
    };
  });
}

function buildContainerImage(
  storedImage: ModuleImage,
  metadataImage: NormalizedModuleMetadata['containers'][number]['image'] | undefined
): ModuleImage {
  const repository = metadataImage?.repository || storedImage.repository || 'unknown';
  const tag = metadataImage?.tag || storedImage.tag || 'latest';

  return {
    repository,
    tag,
    reference: metadataImage ? `${repository}:${tag}` : storedImage.reference || `${repository}:${tag}`,
    pullPolicy: metadataImage?.pullPolicy || storedImage.pullPolicy,
  };
}

function buildSettings(module: InstalledModuleRecord, metadata: NormalizedModuleMetadata | null) {
  const values = module.settings || {};

  return (metadata?.settings || []).map(setting => ({
    ...setting,
    valueSet: Object.prototype.hasOwnProperty.call(values, setting.key),
  }));
}

function buildStorageDirectories(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata | null
): InstalledStorageMapping[] {
  const config = getHostRuntimeConfig();

  return (metadata?.storage?.directories || []).flatMap(directory => directory.targets.map(target => {
    const storedMapping = getStoredStorageMapping(module, directory.key, target.container);
    const modulePath = directory.mount?.modulePath || directory.key;

    return {
      key: directory.key,
      container: target.container,
      containerPath: storedMapping?.containerPath || target.containerPath,
      hostPath:
        storedMapping?.hostPath ||
        path.join(config.dataRootHost, 'modules', module.id, modulePath),
      required: storedMapping?.required ?? directory.required,
      writable: storedMapping?.writable ?? target.writable,
      readOnly: storedMapping?.readOnly ?? !target.writable,
    };
  }));
}

function buildDependencies(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata | null
): ResolvedDependency[] {
  const resolvedDependencies = getResolvedDependencies(module);

  return (metadata?.dependencies || []).map(dependency => {
    const resolved = resolvedDependencies.get(dependency.id);
    return {
      id: dependency.id,
      endpoint: resolved?.endpoint || dependency.connection?.endpoint,
      targets: resolved?.targets || dependency.connection?.targets,
      resolvedBaseUrl: resolved?.resolvedBaseUrl,
    };
  });
}

function getStoredStorageMapping(module: InstalledModuleRecord, key: string, container?: string) {
  const mappings = module.storageMappings || module.storage?.directories;

  if (Array.isArray(mappings)) {
    return mappings.find(mapping => mapping.key === key && (!container || mapping.container === container));
  }

  const mapping = mappings?.[key];
  return mapping && (!container || mapping.container === container) ? mapping : undefined;
}

function getStoredExternalMounts(module: InstalledModuleRecord): InstalledExternalMountMapping[] {
  const mounts = module.externalMounts || [];
  return Array.isArray(mounts) ? mounts : Object.values(mounts).flat();
}

function getResolvedDependencies(module: InstalledModuleRecord) {
  const dependencies = module.resolvedDependencies || module.dependencies || [];
  const entries = Array.isArray(dependencies) ? dependencies : Object.values(dependencies);
  return new Map(entries.map(dependency => [dependency.id, dependency]));
}

export function normalizeModuleActionStatus(result: ModuleActionResult) {
  return result.error?.httpStatus || (result.success ? 200 : 500);
}
