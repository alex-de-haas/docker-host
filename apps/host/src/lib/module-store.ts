import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getHostRuntimeConfig, pathExists } from '@/lib/host-runtime';
import type { HostRuntimeConfig } from '@/lib/host-runtime';
import type { InstalledModuleRecord, ModuleMetadata, ModulesStoreData } from '@/types/modules';

const STORE_SCHEMA_VERSION = '0.1';

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
  await fs.writeFile(temporaryPath, `${JSON.stringify(nextStore, null, 2)}\n`, 'utf-8');
  await fs.rename(temporaryPath, config.modulesStorePath);
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
  if (!isObject(parsed)) {
    throw new Error('modules.json must contain a JSON object.');
  }

  const modules = Array.isArray(parsed.modules) ? parsed.modules : [];
  const hostSettings = isObject(parsed.hostSettings) ? parsed.hostSettings : {};

  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    hostSettings,
    modules: modules.filter(isInstalledModuleRecord),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

function isInstalledModuleRecord(value: unknown): value is InstalledModuleRecord {
  return isObject(value) && typeof value.id === 'string' && typeof value.metadataUrl === 'string';
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
