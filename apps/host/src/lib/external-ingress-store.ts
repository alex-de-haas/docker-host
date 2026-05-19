import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getHostRuntimeConfig, pathExists } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type {
  ExternalIngressChecklist,
  ExternalIngressRecord,
  ExternalIngressSnapshot,
  ExternalIngressState,
  ExternalIngressStatus,
  ExternalIngressValidationCheck,
  ExternalIngressValidationResult,
} from '../types/ingress.ts';

const EXTERNAL_INGRESS_SCHEMA_VERSION = '0.1' as const;

let externalIngressStoreMutex: Promise<void> = Promise.resolve();

export async function readExternalIngressState(
  config = getHostRuntimeConfig()
): Promise<ExternalIngressState> {
  await ensureExternalIngressState(config);

  const raw = await fs.readFile(getExternalIngressStatePath(config), 'utf-8');
  return normalizeExternalIngressState(JSON.parse(raw) as unknown);
}

export async function readExternalIngressStateSnapshot(
  config = getHostRuntimeConfig()
): Promise<ExternalIngressState> {
  const statePath = getExternalIngressStatePath(config);
  if (!(await pathExists(statePath))) {
    return createEmptyExternalIngressState();
  }

  const raw = await fs.readFile(statePath, 'utf-8');
  return normalizeExternalIngressState(JSON.parse(raw) as unknown);
}

export async function writeExternalIngressState(
  state: ExternalIngressState,
  config = getHostRuntimeConfig()
) {
  const statePath = getExternalIngressStatePath(config);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const nextState: ExternalIngressState = {
    schemaVersion: EXTERNAL_INGRESS_SCHEMA_VERSION,
    records: state.records.map(normalizeExternalIngressRecord).filter(isExternalIngressRecord),
    updatedAt: new Date().toISOString(),
  };
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf-8');
  await fs.rename(temporaryPath, statePath);
}

export async function updateExternalIngressState<T>(
  operation: (
    state: ExternalIngressState
  ) => Promise<{ state: ExternalIngressState; result: T }> | { state: ExternalIngressState; result: T },
  config = getHostRuntimeConfig()
): Promise<T> {
  return withExternalIngressStoreLock(async () => {
    const current = await readExternalIngressState(config);
    const { state, result } = await operation(current);
    await writeExternalIngressState(state, config);
    return result;
  });
}

export function createEmptyExternalIngressState(): ExternalIngressState {
  return {
    schemaVersion: EXTERNAL_INGRESS_SCHEMA_VERSION,
    records: [],
    updatedAt: new Date().toISOString(),
  };
}

export function getExternalIngressRootContainer(config: HostRuntimeConfig) {
  return config.ingressRootContainer ?? path.join(config.dataRootContainer, 'ingress');
}

export function getExternalIngressStatePath(config: HostRuntimeConfig) {
  return config.ingressStatePath ?? path.join(getExternalIngressRootContainer(config), 'external-ingress.json');
}

async function ensureExternalIngressState(config: HostRuntimeConfig) {
  await fs.mkdir(getExternalIngressRootContainer(config), { recursive: true });

  if (!(await pathExists(getExternalIngressStatePath(config)))) {
    await writeExternalIngressState(createEmptyExternalIngressState(), config);
  }
}

async function withExternalIngressStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = externalIngressStoreMutex;
  let release: () => void = () => undefined;
  externalIngressStoreMutex = new Promise<void>(resolve => {
    release = resolve;
  });

  await previous;

  try {
    return await operation();
  } finally {
    release();
  }
}

function normalizeExternalIngressState(parsed: unknown): ExternalIngressState {
  if (!isObject(parsed)) {
    throw new Error('external ingress state must contain a JSON object.');
  }

  return {
    schemaVersion: EXTERNAL_INGRESS_SCHEMA_VERSION,
    records: Array.isArray(parsed.records)
      ? parsed.records.map(normalizeExternalIngressRecord).filter(isExternalIngressRecord)
      : [],
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

function normalizeExternalIngressRecord(value: unknown): ExternalIngressRecord | null {
  if (!isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.gatewayExposureId !== 'string' ||
    value.mode !== 'manual' ||
    !isExternalIngressStatus(value.status) ||
    !isExternalIngressSnapshot(value.snapshot) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string') {
    return null;
  }

  return {
    id: value.id,
    gatewayExposureId: value.gatewayExposureId,
    mode: 'manual',
    status: value.status,
    checklist: isExternalIngressChecklist(value.checklist) ? value.checklist : {},
    ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
    snapshot: value.snapshot,
    ...(isExternalIngressValidationResult(value.lastValidation)
      ? { lastValidation: value.lastValidation }
      : {}),
    ...(typeof value.markedReadyAt === 'string' ? { markedReadyAt: value.markedReadyAt } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function isExternalIngressSnapshot(value: unknown): value is ExternalIngressSnapshot {
  return isObject(value) &&
    typeof value.moduleId === 'string' &&
    typeof value.hostname === 'string' &&
    typeof value.portKey === 'string' &&
    (value.exposurePolicy === 'public' ||
      value.exposurePolicy === 'loginRequired' ||
      value.exposurePolicy === 'assignedUsersOnly') &&
    (value.identityMode === 'none' ||
      value.identityMode === 'optional' ||
      value.identityMode === 'required') &&
    (typeof value.gatewayBaseDomain === 'string' || value.gatewayBaseDomain === null) &&
    (typeof value.hostPublicOrigin === 'string' || value.hostPublicOrigin === null) &&
    typeof value.trustedProxyMode === 'boolean';
}

function isExternalIngressChecklist(value: unknown): value is ExternalIngressChecklist {
  if (!isObject(value)) {
    return false;
  }

  return [
    'dnsConfigured',
    'reverseProxyConfigured',
    'tlsConfigured',
    'websocketForwarding',
    'authProviderConfigured',
    'directOriginProtected',
  ].every(key => value[key] === undefined || typeof value[key] === 'boolean');
}

function isExternalIngressValidationResult(value: unknown): value is ExternalIngressValidationResult {
  return isObject(value) &&
    typeof value.checkedAt === 'string' &&
    isExternalIngressStatus(value.status) &&
    Array.isArray(value.checks) &&
    value.checks.every(isExternalIngressValidationCheck) &&
    Array.isArray(value.drift) &&
    value.drift.every(item => typeof item === 'string');
}

function isExternalIngressValidationCheck(value: unknown): value is ExternalIngressValidationCheck {
  return isObject(value) &&
    typeof value.code === 'string' &&
    typeof value.label === 'string' &&
    (value.status === 'pass' || value.status === 'warn' || value.status === 'fail') &&
    typeof value.message === 'string' &&
    (value.nextStep === undefined || typeof value.nextStep === 'string');
}

function isExternalIngressStatus(value: unknown): value is ExternalIngressStatus {
  return value === 'unmanaged' ||
    value === 'planned' ||
    value === 'manualReady' ||
    value === 'validated' ||
    value === 'drifted' ||
    value === 'failed' ||
    value === 'unknown';
}

function isExternalIngressRecord(value: ExternalIngressRecord | null): value is ExternalIngressRecord {
  return value !== null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
