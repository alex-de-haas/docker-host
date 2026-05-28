import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getHostRuntimeConfig, pathExists, syncPathOwnershipWithDataRoot } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
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
  if (!(await pathExists(config.modulesStorePath))) {
    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      hostSettings: {},
      modules: [],
      updatedAt: new Date().toISOString(),
    };
  }

  const raw = await fs.readFile(config.modulesStorePath, 'utf-8');
  return normalizeStore(JSON.parse(raw) as unknown);
}

export async function writeModulesStore(
  store: ModulesStoreData,
  config = getHostRuntimeConfig()
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

  return path.join(config.modulesRootContainer, module.id, 'metadata.json');
}

async function ensureModulesStore(config: HostRuntimeConfig) {
  await fs.mkdir(config.dataRootContainer, { recursive: true });
  await fs.mkdir(config.modulesRootContainer, { recursive: true });

  if (!(await pathExists(config.modulesStorePath))) {
    await writeModulesStore(
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
): value is Record<string, unknown> & { id: string; metadataUrl: string } {
  return isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.metadataUrl === 'string';
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
