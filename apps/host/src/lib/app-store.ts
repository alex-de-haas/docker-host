import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getHostRuntimeConfig, pathExists, syncPathOwnershipWithDataRoot } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';

const APP_STORE_SCHEMA_VERSION = 'app-store.0.1';
const PRIVATE_STORE_FILE_MODE = 0o600;

export interface InstalledAppRecord {
  id: string;
  manifestUrl?: string;
  manifestPath?: string;
  selectedChannel?: string;
  selectedRuntime?: string;
  installedAt?: string;
  updatedAt?: string;
}

export interface AppsStoreData {
  schemaVersion: typeof APP_STORE_SCHEMA_VERSION;
  apps: InstalledAppRecord[];
  updatedAt: string;
}

export function getAppsRootContainer(config: HostRuntimeConfig) {
  return config.appsRootContainer ?? path.join(config.dataRootContainer, 'apps');
}

export function getAppsStorePath(config: HostRuntimeConfig) {
  return config.appsStorePath ?? path.join(config.dataRootContainer, 'apps.json');
}

export async function readAppsStoreSnapshot(
  config = getHostRuntimeConfig()
): Promise<AppsStoreData> {
  const storePath = getAppsStorePath(config);
  if (!(await pathExists(storePath))) {
    return createEmptyAppsStore();
  }

  const raw = await fs.readFile(storePath, 'utf-8');
  return normalizeAppsStore(JSON.parse(raw) as unknown);
}

export async function readAppsStore(config = getHostRuntimeConfig()): Promise<AppsStoreData> {
  await ensureAppsStore(config);
  return readAppsStoreSnapshot(config);
}

export async function writeAppsStore(
  store: AppsStoreData,
  config = getHostRuntimeConfig()
) {
  const storePath = getAppsStorePath(config);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.mkdir(getAppsRootContainer(config), { recursive: true });

  const nextStore: AppsStoreData = {
    schemaVersion: APP_STORE_SCHEMA_VERSION,
    apps: store.apps,
    updatedAt: new Date().toISOString(),
  };
  const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(nextStore, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: PRIVATE_STORE_FILE_MODE,
  });
  await fs.rename(temporaryPath, storePath);
  await fs.chmod(storePath, PRIVATE_STORE_FILE_MODE);
  await syncPathOwnershipWithDataRoot(storePath, config);
}

export async function upsertInstalledAppRecord(
  app: InstalledAppRecord,
  config = getHostRuntimeConfig()
) {
  const store = await readAppsStore(config);
  const existingIndex = store.apps.findIndex(candidate => candidate.id === app.id);
  const existing = existingIndex >= 0 ? store.apps[existingIndex] : null;
  const now = new Date().toISOString();
  const nextRecord: InstalledAppRecord = {
    ...existing,
    ...app,
    installedAt: existing?.installedAt ?? app.installedAt ?? now,
    updatedAt: app.updatedAt ?? now,
  };
  const apps = existingIndex >= 0
    ? store.apps.map((candidate, index) => (index === existingIndex ? nextRecord : candidate))
    : [...store.apps, nextRecord];

  await writeAppsStore({ ...store, apps }, config);
}

async function ensureAppsStore(config: HostRuntimeConfig) {
  const storePath = getAppsStorePath(config);
  await fs.mkdir(config.dataRootContainer, { recursive: true });
  await fs.mkdir(getAppsRootContainer(config), { recursive: true });

  if (!(await pathExists(storePath))) {
    await writeAppsStore(createEmptyAppsStore(), config);
  }
}

function createEmptyAppsStore(): AppsStoreData {
  return {
    schemaVersion: APP_STORE_SCHEMA_VERSION,
    apps: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeAppsStore(parsed: unknown): AppsStoreData {
  if (!isObject(parsed)) {
    throw new Error('apps.json must contain a JSON object.');
  }

  return {
    schemaVersion: APP_STORE_SCHEMA_VERSION,
    apps: Array.isArray(parsed.apps)
      ? parsed.apps.flatMap(value => {
          const record = normalizeInstalledAppRecord(value);
          return record ? [record] : [];
        })
      : [],
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

function normalizeInstalledAppRecord(value: unknown): InstalledAppRecord | null {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id.trim()) {
    return null;
  }

  const record: InstalledAppRecord = {
    id: value.id.trim(),
  };

  record.manifestUrl = readString(value, 'manifestUrl');
  record.manifestPath = readString(value, 'manifestPath');
  record.selectedChannel = readString(value, 'selectedChannel');
  record.selectedRuntime = readString(value, 'selectedRuntime');
  record.installedAt = readString(value, 'installedAt');
  record.updatedAt = readString(value, 'updatedAt');

  return record;
}

function readString(source: Record<string, unknown>, key: string) {
  const value = source[key];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
