import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getHostRuntimeConfig, pathExists } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type {
  ModuleDevTargetRecord,
  ModuleDevTargetShellApp,
  ModuleDevTargetState,
} from '../types/module-dev.ts';

const MODULE_DEV_STORE_SCHEMA_VERSION = '0.1' as const;

let moduleDevStoreMutex: Promise<void> = Promise.resolve();

export async function readModuleDevTargetState(
  config = getHostRuntimeConfig()
): Promise<ModuleDevTargetState> {
  await ensureModuleDevTargetState(config);

  const raw = await fs.readFile(getModuleDevTargetsPath(config), 'utf-8');
  return normalizeModuleDevTargetState(JSON.parse(raw) as unknown);
}

export async function readModuleDevTargetStateSnapshot(
  config = getHostRuntimeConfig()
): Promise<ModuleDevTargetState> {
  const targetsPath = getModuleDevTargetsPath(config);
  if (!(await pathExists(targetsPath))) {
    return createEmptyModuleDevTargetState();
  }

  const raw = await fs.readFile(targetsPath, 'utf-8');
  return normalizeModuleDevTargetState(JSON.parse(raw) as unknown);
}

export async function writeModuleDevTargetState(
  state: ModuleDevTargetState,
  config = getHostRuntimeConfig()
) {
  const targetsPath = getModuleDevTargetsPath(config);
  await fs.mkdir(path.dirname(targetsPath), { recursive: true });
  const nextState: ModuleDevTargetState = {
    schemaVersion: MODULE_DEV_STORE_SCHEMA_VERSION,
    targets: state.targets.map(normalizeModuleDevTargetRecord).filter(isModuleDevTargetRecord),
    updatedAt: new Date().toISOString(),
  };
  const temporaryPath = `${targetsPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf-8');
  await fs.rename(temporaryPath, targetsPath);
}

export async function updateModuleDevTargetState<T>(
  operation: (
    state: ModuleDevTargetState
  ) => Promise<{ state: ModuleDevTargetState; result: T }> | { state: ModuleDevTargetState; result: T },
  config = getHostRuntimeConfig()
): Promise<T> {
  return withModuleDevStoreLock(async () => {
    const current = await readModuleDevTargetState(config);
    const { state, result } = await operation(current);
    await writeModuleDevTargetState(state, config);
    return result;
  });
}

export function createEmptyModuleDevTargetState(): ModuleDevTargetState {
  return {
    schemaVersion: MODULE_DEV_STORE_SCHEMA_VERSION,
    targets: [],
    updatedAt: new Date().toISOString(),
  };
}

function getModuleDevTargetsPath(config: HostRuntimeConfig) {
  return config.moduleDevTargetsPath ||
    path.join(config.dataRootContainer, 'dev', 'module-targets.json');
}

async function ensureModuleDevTargetState(config: HostRuntimeConfig) {
  await fs.mkdir(path.dirname(getModuleDevTargetsPath(config)), { recursive: true });

  if (!(await pathExists(getModuleDevTargetsPath(config)))) {
    await writeModuleDevTargetState(createEmptyModuleDevTargetState(), config);
  }
}

async function withModuleDevStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = moduleDevStoreMutex;
  let release: () => void = () => undefined;
  moduleDevStoreMutex = new Promise<void>(resolve => {
    release = resolve;
  });

  await previous;

  try {
    return await operation();
  } finally {
    release();
  }
}

function normalizeModuleDevTargetState(parsed: unknown): ModuleDevTargetState {
  if (!isObject(parsed)) {
    throw new Error('module dev target state must contain a JSON object.');
  }

  return {
    schemaVersion: MODULE_DEV_STORE_SCHEMA_VERSION,
    targets: Array.isArray(parsed.targets)
      ? parsed.targets.map(normalizeModuleDevTargetRecord).filter(isModuleDevTargetRecord)
      : [],
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

function normalizeModuleDevTargetRecord(value: unknown): ModuleDevTargetRecord | null {
  if (!isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.moduleId !== 'string' ||
    typeof value.moduleName !== 'string' ||
    typeof value.moduleVersion !== 'string' ||
    typeof value.metadataUrl !== 'string' ||
    typeof value.hostname !== 'string' ||
    typeof value.portKey !== 'string' ||
    typeof value.targetBaseUrl !== 'string' ||
    typeof value.containerPort !== 'number' ||
    typeof value.protocol !== 'string' ||
    !isExposurePolicy(value.exposurePolicy) ||
    !isIdentityMode(value.identityMode) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string') {
    return null;
  }

  const shellApp = normalizeModuleDevTargetShellApp(value.shellApp);

  return {
    id: value.id,
    moduleId: value.moduleId,
    moduleName: value.moduleName,
    moduleVersion: value.moduleVersion,
    ...(typeof value.moduleDescription === 'string' ? { moduleDescription: value.moduleDescription } : {}),
    metadataUrl: value.metadataUrl,
    hostname: value.hostname.toLowerCase(),
    portKey: value.portKey,
    targetBaseUrl: value.targetBaseUrl,
    targetPathPrefix: typeof value.targetPathPrefix === 'string' ? value.targetPathPrefix : '',
    containerPort: value.containerPort,
    protocol: value.protocol,
    exposurePolicy: value.exposurePolicy,
    identityMode: value.identityMode,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    ...(shellApp ? { shellApp } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function normalizeModuleDevTargetShellApp(value: unknown): ModuleDevTargetShellApp | null {
  if (!isObject(value) ||
    typeof value.displayName !== 'string' ||
    typeof value.entrypointPath !== 'string' ||
    !Array.isArray(value.navigation)) {
    return null;
  }

  const navigation = value.navigation
    .map(item => {
      if (!isObject(item) || typeof item.label !== 'string' || typeof item.path !== 'string') {
        return null;
      }

      return {
        label: item.label,
        path: item.path,
      };
    })
    .filter((item): item is { label: string; path: string } => item !== null);

  return {
    displayName: value.displayName,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.icon === 'string' ? { icon: value.icon } : {}),
    entrypointPath: value.entrypointPath,
    navigation,
  };
}

function isExposurePolicy(value: unknown) {
  return value === 'public' || value === 'loginRequired' || value === 'assignedUsersOnly';
}

function isIdentityMode(value: unknown) {
  return value === 'none' || value === 'optional' || value === 'required';
}

function isModuleDevTargetRecord(value: ModuleDevTargetRecord | null): value is ModuleDevTargetRecord {
  return value !== null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
