import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_MODULE_EXPOSURE_POLICY, canAccessModule } from './auth-policy.ts';
import { appendAuthAuditEvent, readAuthStateSnapshot, updateAuthState } from './auth-store.ts';
import { getHostRuntimeConfig, pathExists } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import {
  readGatewayExposureStateSnapshot,
  updateGatewayExposureState,
} from './gateway-store.ts';
import type { ModuleAccessAssignment } from '../types/auth.ts';
import type { GatewayExposureInput, GatewayExposureRecord } from '../types/gateway.ts';
import type {
  InstalledModuleRecord,
  ModuleMetadata,
  ModuleRuntimePortMetadata,
  ModulesStoreData,
} from '../types/modules.ts';

export interface GatewayResolvedTarget {
  exposure: GatewayExposureRecord;
  targetBaseUrl: string;
  networkAlias: string;
  containerPort: number;
  port: ModuleRuntimePortMetadata;
  access: ReturnType<typeof canAccessModule>;
}

export async function listGatewayExposures(config = getHostRuntimeConfig()) {
  const [gateway, auth] = await Promise.all([
    readGatewayExposureStateSnapshot(config),
    readAuthStateSnapshot(config),
  ]);

  return gateway.exposures.map(exposure => ({
    ...exposure,
    assignedUserIds: auth.moduleAssignments
      .filter(assignment => assignment.moduleId === exposure.moduleId)
      .map(assignment => assignment.userId)
      .sort(),
  }));
}

export async function upsertGatewayExposure(
  input: GatewayExposureInput & { id?: string },
  actorUserId?: string,
  config = getHostRuntimeConfig()
) {
  const normalized = await validateGatewayExposureInput(input, config);
  const now = new Date().toISOString();

  const exposure = await updateGatewayExposureState(state => {
    const existingIndex = state.exposures.findIndex(candidate => candidate.id === normalized.id);
    const duplicate = state.exposures.find(candidate =>
      candidate.hostname === normalized.hostname &&
      candidate.id !== normalized.id
    );

    if (duplicate) {
      throw new GatewayServiceError(
        'hostname_conflict',
        `Hostname "${normalized.hostname}" is already assigned to module "${duplicate.moduleId}".`
      );
    }

    const nextExposure: GatewayExposureRecord = existingIndex >= 0
      ? {
          ...state.exposures[existingIndex],
          moduleId: normalized.moduleId,
          hostname: normalized.hostname,
          portKey: normalized.portKey,
          exposurePolicy: normalized.exposurePolicy,
          enabled: normalized.enabled,
          updatedAt: now,
        }
      : {
          id: normalized.id,
          moduleId: normalized.moduleId,
          hostname: normalized.hostname,
          portKey: normalized.portKey,
          exposurePolicy: normalized.exposurePolicy,
          enabled: normalized.enabled,
          createdAt: now,
          updatedAt: now,
        };

    const exposures = existingIndex >= 0
      ? state.exposures.map(candidate => candidate.id === nextExposure.id ? nextExposure : candidate)
      : [...state.exposures, nextExposure];

    return {
      state: {
        ...state,
        exposures,
      },
      result: nextExposure,
    };
  }, config);

  await appendAuthAuditEvent({
    type: 'gateway.exposure.saved',
    actorUserId,
    success: true,
    details: {
      exposureId: exposure.id,
      moduleId: exposure.moduleId,
      hostname: exposure.hostname,
      portKey: exposure.portKey,
      exposurePolicy: exposure.exposurePolicy,
      enabled: exposure.enabled,
    },
  }, config);

  return exposure;
}

export async function deleteGatewayExposure(
  exposureId: string,
  actorUserId?: string,
  config = getHostRuntimeConfig()
) {
  const deleted = await updateGatewayExposureState(state => {
    const exposure = state.exposures.find(candidate => candidate.id === exposureId) ?? null;
    return {
      state: {
        ...state,
        exposures: state.exposures.filter(candidate => candidate.id !== exposureId),
      },
      result: exposure,
    };
  }, config);

  if (deleted) {
    await appendAuthAuditEvent({
      type: 'gateway.exposure.deleted',
      actorUserId,
      success: true,
      details: {
        exposureId: deleted.id,
        moduleId: deleted.moduleId,
        hostname: deleted.hostname,
      },
    }, config);
  }

  return deleted;
}

export async function setGatewayExposureAssignments(
  exposureId: string,
  assignedUserIds: string[],
  actorUserId?: string,
  config = getHostRuntimeConfig()
) {
  const gateway = await readGatewayExposureStateSnapshot(config);
  const exposure = gateway.exposures.find(candidate => candidate.id === exposureId);
  if (!exposure) {
    throw new GatewayServiceError('exposure_not_found', `Gateway exposure "${exposureId}" was not found.`);
  }

  const normalizedUserIds = [...new Set(assignedUserIds.map(id => id.trim()).filter(Boolean))].sort();
  const assignments = await updateAuthState(state => {
    const knownUserIds = new Set(state.users.filter(user => !user.disabled).map(user => user.id));
    const unknownUserIds = normalizedUserIds.filter(userId => !knownUserIds.has(userId));
    if (unknownUserIds.length > 0) {
      throw new GatewayServiceError(
        'unknown_users',
        `Unknown Host user ids: ${unknownUserIds.join(', ')}.`
      );
    }

    const nextModuleAssignments: ModuleAccessAssignment[] = [
      ...state.moduleAssignments.filter(assignment => assignment.moduleId !== exposure.moduleId),
      ...normalizedUserIds.map(userId => ({
        moduleId: exposure.moduleId,
        userId,
      })),
    ];

    return {
      state: {
        ...state,
        moduleAssignments: nextModuleAssignments,
      },
      result: nextModuleAssignments.filter(assignment => assignment.moduleId === exposure.moduleId),
    };
  }, config);

  await appendAuthAuditEvent({
    type: 'gateway.exposure.assignments.updated',
    actorUserId,
    success: true,
    details: {
      exposureId: exposure.id,
      moduleId: exposure.moduleId,
      assignedUserIds: assignments.map(assignment => assignment.userId).sort(),
    },
  }, config);

  return assignments;
}

export async function resolveGatewayTarget(
  hostname: string,
  principal?: Parameters<typeof canAccessModule>[0]['principal'],
  config = getHostRuntimeConfig()
): Promise<GatewayResolvedTarget | null> {
  const normalizedHostname = normalizeGatewayHostname(hostname);
  const gateway = await readGatewayExposureStateSnapshot(config);
  const exposure = gateway.exposures.find(candidate =>
    candidate.enabled && candidate.hostname === normalizedHostname
  );

  if (!exposure) {
    return null;
  }

  const installedModule = await findInstalledModuleSnapshot(exposure.moduleId, config);
  if (!installedModule || installedModule.operationStatus && installedModule.operationStatus !== 'installed') {
    throw new GatewayServiceError(
      'module_unavailable',
      `Module "${exposure.moduleId}" is not installed and ready for gateway traffic.`
    );
  }

  const metadata = await readInstalledModuleMetadata(installedModule, config);
  const port = metadata?.runtime?.ports?.find(candidate => candidate.key === exposure.portKey);
  if (!port) {
    throw new GatewayServiceError(
      'port_not_found',
      `Module "${exposure.moduleId}" does not define runtime port "${exposure.portKey}".`
    );
  }

  const auth = await readAuthStateSnapshot(config);
  const access = canAccessModule({
    principal,
    moduleId: exposure.moduleId,
    exposurePolicy: exposure.exposurePolicy,
    assignments: auth.moduleAssignments,
  });
  const networkAlias = getModuleNetworkAlias(exposure.moduleId);

  return {
    exposure,
    targetBaseUrl: `http://${networkAlias}:${port.containerPort}`,
    networkAlias,
    containerPort: port.containerPort,
    port,
    access,
  };
}

export async function validateGatewayExposureInput(
  input: GatewayExposureInput & { id?: string },
  config = getHostRuntimeConfig()
): Promise<GatewayExposureInput & {
  id: string;
  hostname: string;
  exposurePolicy: GatewayExposureRecord['exposurePolicy'];
  enabled: boolean;
}> {
  const moduleId = input.moduleId.trim();
  const portKey = input.portKey.trim();
  const hostname = normalizeGatewayHostname(input.hostname);
  const exposurePolicy = input.exposurePolicy ?? DEFAULT_MODULE_EXPOSURE_POLICY;
  const enabled = input.enabled ?? true;

  if (!moduleId) {
    throw new GatewayServiceError('invalid_module_id', 'Module id is required.');
  }

  if (!portKey) {
    throw new GatewayServiceError('invalid_port_key', 'Runtime port key is required.');
  }

  if (!isAllowedGatewayHostname(hostname, config)) {
    throw new GatewayServiceError(
      'invalid_hostname',
      config.gatewayBaseDomain
        ? `Hostname must be under "${config.gatewayBaseDomain}".`
        : 'Hostname must be a valid DNS hostname.'
    );
  }

  if (!isExposurePolicy(exposurePolicy)) {
    throw new GatewayServiceError('invalid_exposure_policy', 'Exposure policy is not supported.');
  }

  const installedModule = await findInstalledModuleSnapshot(moduleId, config);
  if (!installedModule) {
    throw new GatewayServiceError('module_not_found', `Module "${moduleId}" is not installed.`);
  }

  const metadata = await readInstalledModuleMetadata(installedModule, config);
  const port = metadata?.runtime?.ports?.find(candidate => candidate.key === portKey);
  if (!port) {
    throw new GatewayServiceError(
      'port_not_found',
      `Module "${moduleId}" does not define runtime port "${portKey}".`
    );
  }

  if (!port.public) {
    throw new GatewayServiceError(
      'port_not_public',
      `Runtime port "${portKey}" is not marked as externally exposable.`
    );
  }

  return {
    id: input.id?.trim() || `gw_${randomUUID()}`,
    moduleId,
    hostname,
    portKey,
    exposurePolicy,
    enabled,
  };
}

export function normalizeGatewayHostname(hostname: string) {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');

  if (!normalized ||
    normalized.includes('/') ||
    normalized.includes('@') ||
    normalized.includes(':') ||
    normalized.length > 253) {
    throw new GatewayServiceError('invalid_hostname', 'Hostname is not valid.');
  }

  const labels = normalized.split('.');
  const valid = labels.every(label =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );

  if (!valid) {
    throw new GatewayServiceError('invalid_hostname', 'Hostname is not valid.');
  }

  return normalized;
}

export function isAllowedGatewayHostname(hostname: string, config = getHostRuntimeConfig()) {
  if (!config.gatewayBaseDomain) {
    return true;
  }

  const baseDomain = normalizeGatewayHostname(config.gatewayBaseDomain);
  return hostname.endsWith(`.${baseDomain}`) && hostname !== `host.${baseDomain}`;
}

export function getModuleNetworkAlias(moduleId: string) {
  const normalized = moduleId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return `mod-${normalized || 'module'}`;
}

export function isGatewayServiceError(error: unknown): error is GatewayServiceError {
  return error instanceof GatewayServiceError;
}

export class GatewayServiceError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(
    code: string,
    message: string,
    status = 400
  ) {
    super(message);
    this.name = 'GatewayServiceError';
    this.code = code;
    this.status = status;
  }
}

async function findInstalledModuleSnapshot(
  moduleId: string,
  config: HostRuntimeConfig
): Promise<InstalledModuleRecord | null> {
  const store = await readModulesStoreSnapshot(config);
  return store.modules.find(module => module.id === moduleId) ?? null;
}

async function readModulesStoreSnapshot(config: HostRuntimeConfig): Promise<ModulesStoreData> {
  if (!(await pathExists(config.modulesStorePath))) {
    return {
      schemaVersion: '0.1',
      hostSettings: {},
      modules: [],
      updatedAt: new Date().toISOString(),
    };
  }

  const raw = await fs.readFile(config.modulesStorePath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  if (!isObject(parsed)) {
    throw new GatewayServiceError('modules_store_invalid', 'modules.json must contain a JSON object.', 500);
  }

  return {
    schemaVersion: '0.1',
    hostSettings: isObject(parsed.hostSettings) ? parsed.hostSettings : {},
    modules: Array.isArray(parsed.modules) ? parsed.modules.filter(isInstalledModuleRecord) : [],
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

async function readInstalledModuleMetadata(
  module: InstalledModuleRecord,
  config: HostRuntimeConfig
): Promise<ModuleMetadata | null> {
  const metadataPath = module.metadataPath
    ? path.isAbsolute(module.metadataPath)
      ? module.metadataPath
      : path.join(config.dataRootContainer, module.metadataPath)
    : path.join(config.modulesRootContainer, module.id, 'metadata.json');

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

function isInstalledModuleRecord(value: unknown): value is InstalledModuleRecord {
  return isObject(value) && typeof value.id === 'string' && typeof value.metadataUrl === 'string';
}

function isExposurePolicy(value: unknown): value is GatewayExposureRecord['exposurePolicy'] {
  return value === 'public' || value === 'loginRequired' || value === 'assignedUsersOnly';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
