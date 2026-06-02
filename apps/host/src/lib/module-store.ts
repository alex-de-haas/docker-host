import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getHostRuntimeConfig, pathExists, syncPathOwnershipWithDataRoot } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import {
  readAppsStoreSnapshot,
  writeAppsStore,
} from './app-store.ts';
import type {
  AppsStoreData,
  InstalledAppRecord,
} from './app-store.ts';
import type {
  InstalledModuleContainerRecord,
  InstalledModuleRecord,
  ModuleImage,
  ModuleMetadata,
  ModulesStoreData,
} from '@/types/modules';

const STORE_SCHEMA_VERSION = '0.2';
const PRIVATE_STORE_FILE_MODE = 0o600;

export interface ModulesStoreStatus {
  path: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  moduleCount: number;
  error: string | null;
}

export async function readModulesStore(config = getHostRuntimeConfig()): Promise<ModulesStoreData> {
  await ensureModulesStore(config);
  return readModulesStoreSnapshot(config);
}

async function readLegacyModulesStoreSnapshot(
  config: HostRuntimeConfig
): Promise<ModulesStoreData> {
  if (!(await pathExists(config.modulesStorePath))) {
    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      hostSettings: {},
      modules: [],
      updatedAt: new Date().toISOString(),
    };
  }

  const raw = await fs.readFile(config.modulesStorePath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  if (Array.isArray(parsed)) {
    return normalizeStore({
      schemaVersion: STORE_SCHEMA_VERSION,
      hostSettings: {},
      modules: parsed,
      updatedAt: new Date().toISOString(),
    });
  }

  return normalizeStore(parsed);
}

export async function readModulesStoreSnapshot(
  config = getHostRuntimeConfig()
): Promise<ModulesStoreData> {
  const [legacyStore, appsStore] = await Promise.all([
    readLegacyModulesStoreSnapshot(config),
    readAppsStoreSnapshot(config),
  ]);

  return mergeLegacyModulesWithAppRecords(legacyStore, appsStore, config);
}

export async function writeModulesStore(
  store: ModulesStoreData,
  config = getHostRuntimeConfig()
) {
  const { legacyStore, appsStore } = splitMergedStore(store, config);
  await writeLegacyModulesStore(legacyStore, config);
  await writeAppsStore(appsStore, config);
}

async function writeLegacyModulesStore(
  store: ModulesStoreData,
  config: HostRuntimeConfig
) {
  await fs.mkdir(path.dirname(config.modulesStorePath), { recursive: true });
  const nextStore: ModulesStoreData = {
    ...store,
    schemaVersion: STORE_SCHEMA_VERSION,
    hostSettings: store.hostSettings ?? {},
    modules: store.modules ?? [],
    updatedAt: new Date().toISOString(),
  };
  const temporaryPath = `${config.modulesStorePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(nextStore, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: PRIVATE_STORE_FILE_MODE,
  });
  await fs.rename(temporaryPath, config.modulesStorePath);
  await fs.chmod(config.modulesStorePath, PRIVATE_STORE_FILE_MODE);
  await syncPathOwnershipWithDataRoot(config.modulesStorePath, config);
}

export async function getModulesStoreStatus(
  config = getHostRuntimeConfig()
): Promise<ModulesStoreStatus> {
  try {
    await ensureModulesStore(config);
    const store = await readModulesStore(config);

    return {
      path: config.modulesStorePath,
      exists: true,
      readable: true,
      writable: await isWritable(config.modulesStorePath),
      moduleCount: store.modules.length,
      error: null,
    };
  } catch (error) {
    return {
      path: config.modulesStorePath,
      exists: await pathExists(config.modulesStorePath),
      readable: false,
      writable: false,
      moduleCount: 0,
      error: error instanceof Error ? error.message : 'Unknown modules store error',
    };
  }
}

export async function findInstalledModule(
  moduleId: string,
  config = getHostRuntimeConfig()
) {
  const store = await readModulesStore(config);
  return store.modules.find(module => module.id === moduleId) ?? null;
}

export async function readModuleMetadata(
  module: InstalledModuleRecord,
  config = getHostRuntimeConfig()
): Promise<ModuleMetadata | null> {
  const metadataPath = resolveModuleMetadataPath(module, config);

  try {
    const raw = await fs.readFile(metadataPath, 'utf-8');
    return JSON.parse(raw) as ModuleMetadata;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export function resolveModuleMetadataPath(
  module: InstalledModuleRecord,
  config = getHostRuntimeConfig()
) {
  if (module.metadataPath) {
    return path.isAbsolute(module.metadataPath)
      ? module.metadataPath
      : path.join(config.dataRootContainer, module.metadataPath);
  }

  if (module.manifestPath) {
    return path.isAbsolute(module.manifestPath)
      ? module.manifestPath
      : path.join(config.dataRootContainer, module.manifestPath);
  }

  return path.join(config.modulesRootContainer, module.id, 'metadata.json');
}

async function ensureModulesStore(config: HostRuntimeConfig) {
  await fs.mkdir(config.dataRootContainer, { recursive: true });
  await fs.mkdir(config.modulesRootContainer, { recursive: true });

  if (!(await pathExists(config.modulesStorePath))) {
    await writeLegacyModulesStore(
      {
        schemaVersion: STORE_SCHEMA_VERSION,
        hostSettings: {},
        modules: [],
        updatedAt: new Date().toISOString(),
      },
      config
    );
  }
}

function normalizeStore(parsed: unknown): ModulesStoreData {
  if (Array.isArray(parsed)) {
    return normalizeStore({
      schemaVersion: STORE_SCHEMA_VERSION,
      hostSettings: {},
      modules: parsed,
      updatedAt: new Date().toISOString(),
    });
  }

  if (!isObject(parsed)) {
    throw new Error('modules.json must contain a JSON object.');
  }

  const modules = Array.isArray(parsed.modules) ? parsed.modules : [];
  const hostSettings = isObject(parsed.hostSettings) ? parsed.hostSettings : {};

  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    hostSettings,
    modules: modules
      .map(normalizeInstalledModuleRecord)
      .filter((module): module is InstalledModuleRecord => module !== null),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

function mergeLegacyModulesWithAppRecords(
  legacyStore: ModulesStoreData,
  appsStore: AppsStoreData,
  config: HostRuntimeConfig
): ModulesStoreData {
  const appRecordsById = new Map(appsStore.apps.map(app => [app.id, app]));
  const legacyModuleIds = new Set(legacyStore.modules.map(module => module.id));
  const mergedModules = legacyStore.modules.map(module => {
    const app = appRecordsById.get(module.id);
    if (!app) {
      return module;
    }

    return {
      ...module,
      ...appRecordToInstalledModuleRecord(app, config),
      containers: app.containers ?? module.containers,
      operationStatus: app.operationStatus ?? module.operationStatus,
      lastOperation: app.lastOperation ?? module.lastOperation,
      lastError: app.lastError !== undefined ? app.lastError : module.lastError,
      updateAttempt: app.updateAttempt ?? module.updateAttempt,
      settings: app.settings ?? module.settings,
      storage: app.storage ?? module.storage,
      storageMappings: app.storageMappings ?? module.storageMappings,
      externalMounts: app.externalMounts ?? module.externalMounts,
      resolvedDependencies: app.resolvedDependencies ?? module.resolvedDependencies,
      dependencies: app.dependencies ?? module.dependencies,
    };
  });
  const appOnlyModules = appsStore.apps
    .filter(app => !legacyModuleIds.has(app.id))
    .map(app => appRecordToInstalledModuleRecord(app, config));

  return {
    ...legacyStore,
    modules: [...mergedModules, ...appOnlyModules],
    updatedAt: appsStore.apps.length > 0 && appsStore.updatedAt > legacyStore.updatedAt
      ? appsStore.updatedAt
      : legacyStore.updatedAt,
  };
}

function splitMergedStore(
  store: ModulesStoreData,
  config: HostRuntimeConfig
): {
  legacyStore: ModulesStoreData;
  appsStore: AppsStoreData;
} {
  const legacyModules: InstalledModuleRecord[] = [];
  const appRecords: InstalledAppRecord[] = [];

  for (const installedModule of store.modules ?? []) {
    if (isAppLifecycleModuleRecord(installedModule, config)) {
      appRecords.push(installedModuleRecordToAppRecord(installedModule));
    } else {
      legacyModules.push(installedModule);
    }
  }

  return {
    legacyStore: {
      ...store,
      schemaVersion: STORE_SCHEMA_VERSION,
      modules: legacyModules,
    },
    appsStore: {
      schemaVersion: 'app-store.0.1',
      apps: appRecords,
      updatedAt: store.updatedAt ?? new Date().toISOString(),
    },
  };
}

function appRecordToInstalledModuleRecord(
  app: InstalledAppRecord,
  config: HostRuntimeConfig
): InstalledModuleRecord {
  const manifestPath = app.manifestPath ?? path.posix.join('apps', app.id, 'manifest.json');
  const resolvedManifestPath = resolveAppManifestPath(manifestPath, config);

  return {
    id: app.id,
    metadataUrl: app.manifestUrl ?? manifestPath,
    ...(app.manifestUrl ? { manifestUrl: app.manifestUrl } : {}),
    metadataPath: resolvedManifestPath,
    manifestPath,
    ...(app.selectedChannel ? { selectedChannel: app.selectedChannel } : {}),
    ...(app.selectedRuntime ? { selectedRuntime: app.selectedRuntime } : {}),
    ...(app.metadataDigest ? { metadataDigest: app.metadataDigest } : {}),
    ...(app.planDigest ? { planDigest: app.planDigest } : {}),
    containers: app.containers ?? [],
    operationStatus: app.operationStatus ?? 'installed',
    ...(app.settings ? { settings: app.settings } : {}),
    ...(app.storage ? { storage: app.storage } : {}),
    ...(app.storageMappings ? { storageMappings: app.storageMappings } : {}),
    ...(app.externalMounts ? { externalMounts: app.externalMounts } : {}),
    ...(app.resolvedDependencies ? { resolvedDependencies: app.resolvedDependencies } : {}),
    ...(app.dependencies ? { dependencies: app.dependencies } : {}),
    installedAt: app.installedAt,
    updatedAt: app.updatedAt,
    ...(app.lastOperation ? { lastOperation: app.lastOperation } : {}),
    ...(app.updateAttempt ? { updateAttempt: app.updateAttempt } : {}),
    ...(app.lastError !== undefined ? { lastError: app.lastError } : {}),
  };
}

function installedModuleRecordToAppRecord(module: InstalledModuleRecord): InstalledAppRecord {
  const manifestUrl = module.manifestUrl ?? module.metadataUrl;
  const manifestPath = getAppManifestPath(module);

  return {
    id: module.id,
    ...(manifestUrl ? { manifestUrl } : {}),
    ...(manifestPath ? { manifestPath } : {}),
    ...(module.selectedChannel ? { selectedChannel: module.selectedChannel } : {}),
    ...(module.selectedRuntime ? { selectedRuntime: module.selectedRuntime } : {}),
    ...(module.metadataDigest ? { metadataDigest: module.metadataDigest } : {}),
    ...(module.planDigest ? { planDigest: module.planDigest } : {}),
    containers: module.containers ?? [],
    ...(module.operationStatus ? { operationStatus: module.operationStatus } : {}),
    ...(module.settings ? { settings: module.settings } : {}),
    ...(module.storage ? { storage: module.storage } : {}),
    ...(module.storageMappings ? { storageMappings: module.storageMappings } : {}),
    ...(module.externalMounts ? { externalMounts: module.externalMounts } : {}),
    ...(module.resolvedDependencies ? { resolvedDependencies: module.resolvedDependencies } : {}),
    ...(module.dependencies ? { dependencies: module.dependencies } : {}),
    installedAt: module.installedAt,
    updatedAt: module.updatedAt,
    ...(module.lastOperation ? { lastOperation: module.lastOperation } : {}),
    ...(module.updateAttempt ? { updateAttempt: module.updateAttempt } : {}),
    ...(module.lastError !== undefined ? { lastError: module.lastError } : {}),
  };
}

function isAppLifecycleModuleRecord(
  module: InstalledModuleRecord,
  config: HostRuntimeConfig
) {
  const candidatePaths = [module.manifestPath, module.metadataPath].filter((value): value is string => Boolean(value));
  return candidatePaths.some(candidate => isAppRelativeOrAbsolutePath(candidate, config));
}

function getAppManifestPath(module: InstalledModuleRecord) {
  return module.manifestPath ?? (
    module.metadataPath && module.metadataPath.includes(`${path.sep}apps${path.sep}`)
      ? module.metadataPath
      : undefined
  );
}

function resolveAppManifestPath(manifestPath: string, config: HostRuntimeConfig) {
  return path.isAbsolute(manifestPath)
    ? manifestPath
    : path.join(config.dataRootContainer, manifestPath);
}

function isAppRelativeOrAbsolutePath(candidate: string, config: HostRuntimeConfig) {
  if (path.isAbsolute(candidate)) {
    const appsRoot = config.appsRootContainer ?? path.join(config.dataRootContainer, 'apps');
    const relative = path.relative(appsRoot, candidate);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  return candidate === 'apps' ||
    candidate.startsWith('apps/') ||
    candidate.startsWith(`apps${path.sep}`);
}

function normalizeInstalledModuleRecord(value: unknown): InstalledModuleRecord | null {
  if (!isInstalledModuleRecord(value)) {
    return null;
  }

  const {
    containerName: legacyContainerName,
    networkAlias: legacyNetworkAlias,
    image: legacyImage,
    containers,
    ...record
  } = value;

  return {
    ...record,
    metadataUrl: typeof record.metadataUrl === 'string' && record.metadataUrl
      ? record.metadataUrl
      : record.manifestUrl as string,
    ...(typeof record.manifestUrl === 'string' && record.manifestUrl
      ? { manifestUrl: record.manifestUrl }
      : {}),
    containers: Array.isArray(containers)
      ? containers
      : [
          buildLegacyContainerRecord({
            moduleId: value.id,
            containerName: legacyContainerName,
            networkAlias: legacyNetworkAlias,
            image: legacyImage,
          }),
        ],
  } as InstalledModuleRecord;
}

function isInstalledModuleRecord(
  value: unknown
): value is Record<string, unknown> & { id: string; metadataUrl?: string; manifestUrl?: string } {
  return isObject(value) &&
    typeof value.id === 'string' &&
    (typeof value.metadataUrl === 'string' || typeof value.manifestUrl === 'string');
}

function buildLegacyContainerRecord(input: {
  moduleId: string;
  containerName: unknown;
  networkAlias: unknown;
  image: unknown;
}): InstalledModuleContainerRecord {
  const legacyName = getLegacyModuleDockerName(input.moduleId);
  return {
    key: 'main',
    containerName: typeof input.containerName === 'string' && input.containerName
      ? input.containerName
      : legacyName,
    networkAlias: typeof input.networkAlias === 'string' && input.networkAlias
      ? input.networkAlias
      : legacyName,
    image: normalizeLegacyImage(input.image),
  };
}

function normalizeLegacyImage(image: unknown): ModuleImage {
  const source = isObject(image) ? image : {};
  const repository = typeof source.repository === 'string' && source.repository
    ? source.repository
    : 'unknown';
  const tag = typeof source.tag === 'string' && source.tag ? source.tag : 'latest';
  const reference = typeof source.reference === 'string' && source.reference
    ? source.reference
    : `${repository}:${tag}`;
  const pullPolicy = typeof source.pullPolicy === 'string' && source.pullPolicy
    ? source.pullPolicy
    : undefined;

  return {
    repository,
    tag,
    reference,
    ...(pullPolicy ? { pullPolicy } : {}),
  };
}

function getLegacyModuleDockerName(moduleId: string) {
  const normalized = moduleId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return `mod-${normalized || 'module'}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function isWritable(targetPath: string) {
  try {
    await fs.access(targetPath, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
