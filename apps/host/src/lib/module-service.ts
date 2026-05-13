import path from 'node:path';
import { ensureHostDataRoot, getHostRuntimeConfig } from '@/lib/host-runtime';
import {
  ensureModuleNetwork,
  getDockerDaemonStatus,
  getModuleRuntimeStatus,
  restartModuleContainer,
  startModuleContainer,
  stopModuleContainer,
  toModuleOperationError,
} from '@/lib/module-docker';
import {
  findInstalledModule,
  getModulesStoreStatus,
  readModuleMetadata,
  readModulesStore,
} from '@/lib/module-store';
import type {
  InstalledModuleRecord,
  InstalledStorageMapping,
  ModuleActionResult,
  ModuleDetail,
  ModuleImage,
  ModuleMetadata,
  ModuleRuntimeStatus,
  ModuleSummary,
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
      const [metadata, runtimeStatus] = await Promise.all([
        safeReadModuleMetadata(installedModule, config),
        getModuleRuntimeStatus(installedModule),
      ]);

      return toModuleSummary(installedModule, metadata, runtimeStatus);
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

  const [metadata, runtimeStatus] = await Promise.all([
    safeReadModuleMetadata(installedModule, config),
    getModuleRuntimeStatus(installedModule),
  ]);
  const summary = toModuleSummary(installedModule, metadata, runtimeStatus);

  return {
    ...summary,
    settings: buildSettings(installedModule, metadata),
    storage: {
      directories: buildStorageDirectories(installedModule, metadata),
    },
    dependencies: buildDependencies(installedModule, metadata),
  };
}

export async function startInstalledModule(moduleId: string): Promise<ModuleActionResult> {
  return runModuleAction(
    moduleId,
    'module.start',
    startModuleContainer,
    'Docker could not start the module container.',
    'Recreate the module container or reinstall the module when install flows are available.'
  );
}

export async function stopInstalledModule(moduleId: string): Promise<ModuleActionResult> {
  return runModuleAction(
    moduleId,
    'module.stop',
    stopModuleContainer,
    'Docker could not stop the module container.',
    'Inspect the module container in Docker, then retry the stop action.'
  );
}

export async function restartInstalledModule(moduleId: string): Promise<ModuleActionResult> {
  return runModuleAction(
    moduleId,
    'module.restart',
    restartModuleContainer,
    'Docker could not restart the module container.',
    'Inspect the module container logs and recreate it when install flows are available.'
  );
}

async function runModuleAction(
  moduleId: string,
  operation: string,
  action: (module: InstalledModuleRecord) => Promise<ModuleRuntimeStatus>,
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

  try {
    const runtimeStatus = await action(installedModule);
    const metadata = await safeReadModuleMetadata(installedModule, config);

    return {
      success: true,
      module: toModuleSummary(installedModule, metadata, runtimeStatus),
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

async function safeReadModuleMetadata(
  module: InstalledModuleRecord,
  config = getHostRuntimeConfig()
) {
  try {
    return await readModuleMetadata(module, config);
  } catch {
    return null;
  }
}

function toModuleSummary(
  module: InstalledModuleRecord,
  metadata: ModuleMetadata | null,
  runtimeStatus: ModuleRuntimeStatus
): ModuleSummary {
  return {
    id: module.id,
    name: metadata?.name || module.id,
    description: metadata?.description,
    version: metadata?.version || 'unknown',
    metadataUrl: module.metadataUrl,
    image: buildImage(module, metadata),
    operationStatus: module.operationStatus || 'installed',
    runtimeStatus,
    installedAt: module.installedAt,
    updatedAt: module.updatedAt,
    lastError: module.lastError ?? null,
  };
}

function buildImage(module: InstalledModuleRecord, metadata: ModuleMetadata | null): ModuleImage {
  const repository = metadata?.image?.repository || module.image?.repository || 'unknown';
  const tag = metadata?.image?.tag || module.image?.tag || 'latest';
  const reference = metadata?.image
    ? `${metadata.image.repository}:${metadata.image.tag}`
    : module.image?.reference || `${repository}:${tag}`;

  return {
    repository,
    tag,
    reference,
    pullPolicy: metadata?.image?.pullPolicy || module.image?.pullPolicy,
  };
}

function buildSettings(module: InstalledModuleRecord, metadata: ModuleMetadata | null) {
  const values = module.settings || {};

  return (metadata?.settings || []).map(setting => ({
    ...setting,
    valueSet: Object.prototype.hasOwnProperty.call(values, setting.key),
  }));
}

function buildStorageDirectories(
  module: InstalledModuleRecord,
  metadata: ModuleMetadata | null
): InstalledStorageMapping[] {
  const config = getHostRuntimeConfig();

  return (metadata?.storage?.directories || []).map(directory => {
    const storedMapping = getStoredStorageMapping(module, directory.key);
    const modulePath = directory.mount?.modulePath || directory.key;

    return {
      key: directory.key,
      containerPath: storedMapping?.containerPath || directory.containerPath,
      hostPath:
        storedMapping?.hostPath ||
        path.join(config.dataRootHost, 'modules', module.id, modulePath),
      required: storedMapping?.required ?? directory.required,
      writable: storedMapping?.writable ?? directory.writable,
      readOnly: storedMapping?.readOnly ?? !directory.writable,
    };
  });
}

function buildDependencies(
  module: InstalledModuleRecord,
  metadata: ModuleMetadata | null
): ResolvedDependency[] {
  const resolvedDependencies = getResolvedDependencies(module);

  return (metadata?.dependencies || []).map(dependency => {
    const resolved = resolvedDependencies.get(dependency.id);
    return {
      id: dependency.id,
      endpoint: resolved?.endpoint || dependency.connection?.endpoint,
      baseUrlEnv: resolved?.baseUrlEnv || dependency.connection?.baseUrlEnv,
      resolvedBaseUrl: resolved?.resolvedBaseUrl,
    };
  });
}

function getStoredStorageMapping(module: InstalledModuleRecord, key: string) {
  const mappings = module.storageMappings || module.storage?.directories;

  if (Array.isArray(mappings)) {
    return mappings.find(mapping => mapping.key === key);
  }

  return mappings?.[key];
}

function getResolvedDependencies(module: InstalledModuleRecord) {
  const dependencies = module.resolvedDependencies || module.dependencies || [];
  const entries = Array.isArray(dependencies) ? dependencies : Object.values(dependencies);
  return new Map(entries.map(dependency => [dependency.id, dependency]));
}

export function normalizeModuleActionStatus(result: ModuleActionResult) {
  return result.error?.httpStatus || (result.success ? 200 : 500);
}
