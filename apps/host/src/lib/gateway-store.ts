import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getHostRuntimeConfig, pathExists } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type { GatewayExposureRecord, GatewayExposureState } from '../types/gateway.ts';

const GATEWAY_STORE_SCHEMA_VERSION = '0.1' as const;

let gatewayStoreMutex: Promise<void> = Promise.resolve();

export async function readGatewayExposureState(
  config = getHostRuntimeConfig()
): Promise<GatewayExposureState> {
  await ensureGatewayExposureState(config);

  const raw = await fs.readFile(config.gatewayExposuresPath, 'utf-8');
  return normalizeGatewayExposureState(JSON.parse(raw) as unknown);
}

export async function readGatewayExposureStateSnapshot(
  config = getHostRuntimeConfig()
): Promise<GatewayExposureState> {
  if (!(await pathExists(config.gatewayExposuresPath))) {
    return createEmptyGatewayExposureState();
  }

  const raw = await fs.readFile(config.gatewayExposuresPath, 'utf-8');
  return normalizeGatewayExposureState(JSON.parse(raw) as unknown);
}

export async function writeGatewayExposureState(
  state: GatewayExposureState,
  config = getHostRuntimeConfig()
) {
  await fs.mkdir(path.dirname(config.gatewayExposuresPath), { recursive: true });
  const nextState: GatewayExposureState = {
    schemaVersion: GATEWAY_STORE_SCHEMA_VERSION,
    exposures: state.exposures.map(normalizeGatewayExposureRecord).filter(isGatewayExposureRecord),
    updatedAt: new Date().toISOString(),
  };
  const temporaryPath = `${config.gatewayExposuresPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf-8');
  await fs.rename(temporaryPath, config.gatewayExposuresPath);
}

export async function updateGatewayExposureState<T>(
  operation: (
    state: GatewayExposureState
  ) => Promise<{ state: GatewayExposureState; result: T }> | { state: GatewayExposureState; result: T },
  config = getHostRuntimeConfig()
): Promise<T> {
  return withGatewayStoreLock(async () => {
    const current = await readGatewayExposureState(config);
    const { state, result } = await operation(current);
    await writeGatewayExposureState(state, config);
    return result;
  });
}

export function createEmptyGatewayExposureState(): GatewayExposureState {
  return {
    schemaVersion: GATEWAY_STORE_SCHEMA_VERSION,
    exposures: [],
    updatedAt: new Date().toISOString(),
  };
}

async function ensureGatewayExposureState(config: HostRuntimeConfig) {
  await fs.mkdir(config.gatewayRootContainer, { recursive: true });

  if (!(await pathExists(config.gatewayExposuresPath))) {
    await writeGatewayExposureState(createEmptyGatewayExposureState(), config);
  }
}

async function withGatewayStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = gatewayStoreMutex;
  let release: () => void = () => undefined;
  gatewayStoreMutex = new Promise<void>(resolve => {
    release = resolve;
  });

  await previous;

  try {
    return await operation();
  } finally {
    release();
  }
}

function normalizeGatewayExposureState(parsed: unknown): GatewayExposureState {
  if (!isObject(parsed)) {
    throw new Error('gateway exposures state must contain a JSON object.');
  }

  return {
    schemaVersion: GATEWAY_STORE_SCHEMA_VERSION,
    exposures: Array.isArray(parsed.exposures)
      ? parsed.exposures.map(normalizeGatewayExposureRecord).filter(isGatewayExposureRecord)
      : [],
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

function normalizeGatewayExposureRecord(value: unknown): GatewayExposureRecord | null {
  if (!isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.moduleId !== 'string' ||
    typeof value.hostname !== 'string' ||
    typeof value.portKey !== 'string' ||
    !isExposurePolicy(value.exposurePolicy) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string') {
    return null;
  }

  return {
    id: value.id,
    moduleId: value.moduleId,
    hostname: value.hostname.toLowerCase(),
    portKey: value.portKey,
    exposurePolicy: value.exposurePolicy,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function isExposurePolicy(value: unknown) {
  return value === 'public' || value === 'loginRequired' || value === 'assignedUsersOnly';
}

function isGatewayExposureRecord(value: GatewayExposureRecord | null): value is GatewayExposureRecord {
  return value !== null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
