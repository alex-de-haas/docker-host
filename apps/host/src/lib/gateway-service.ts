import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_MODULE_EXPOSURE_POLICY, canAccessModule } from './auth-policy.ts';
import { appendAuthAuditEvent, readAuthStateSnapshot, updateAuthState } from './auth-store.ts';
import { getHostRuntimeConfig } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import { getDefaultModuleIdentityMode, isModuleIdentityMode } from './module-identity.mjs';
import { validateAndNormalizeMetadata } from './module-metadata.ts';
import { readModulesStoreSnapshot } from './module-store.ts';
import {
  readGatewayExposureStateSnapshot,
  updateGatewayExposureState,
} from './gateway-store.ts';
import { updateExternalIngressState } from './external-ingress-store.ts';
import type { ModuleAccessAssignment } from '../types/auth.ts';
import type {
  GatewayExposureInput,
  GatewayExposureOptions,
  GatewayExposureRecord,
} from '../types/gateway.ts';
import type {
  InstalledModuleRecord,
  ModuleMetadata,
  NormalizedModuleMetadata,
  ModuleRuntimePortMetadata,
} from '../types/modules.ts';

type GatewayModuleMetadata = ModuleMetadata | NormalizedModuleMetadata;

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
          endpointKey: normalized.endpointKey,
          exposurePolicy: normalized.exposurePolicy,
          identityMode: normalized.identityMode,
          enabled: normalized.enabled,
          updatedAt: now,
        }
      : {
          id: normalized.id,
          moduleId: normalized.moduleId,
          hostname: normalized.hostname,
          endpointKey: normalized.endpointKey,
          exposurePolicy: normalized.exposurePolicy,
          identityMode: normalized.identityMode,
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
      endpointKey: exposure.endpointKey,
      exposurePolicy: exposure.exposurePolicy,
      identityMode: exposure.identityMode,
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
    await updateExternalIngressState(state => ({
      state: {
        ...state,
        records: state.records.filter(record => record.gatewayExposureId !== deleted.id),
      },
      result: null,
    }), config);

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

export async function listGatewayExposureOptions(
  config = getHostRuntimeConfig()
): Promise<GatewayExposureOptions> {
  const [modulesStore, auth] = await Promise.all([
    readModulesStoreSnapshot(config),
    readAuthStateSnapshot(config),
  ]);

  const modules = await Promise.all(
    modulesStore.modules.map(async installedModule => {
      const metadata = await readInstalledModuleMetadata(installedModule, config);
      const uiEntrypointPortKey = metadata?.ui?.entrypoint?.portKey;
      const ports = (metadata?.endpoints ?? []).flatMap(endpoint => {
        const target = metadata ? resolveEndpointTarget(metadata, endpoint.key) : null;
        return target
          ? [{
              key: endpoint.key,
              containerPort: target.port.containerPort,
              protocol: target.port.protocol,
              public: endpoint.public,
              isUiEntrypoint: Boolean(uiEntrypointPortKey && endpoint.key === uiEntrypointPortKey),
            }]
          : [];
      });

      return {
        id: installedModule.id,
        name: metadata?.name ?? installedModule.id,
        ...(metadata?.description ? { description: metadata.description } : {}),
        ...(installedModule.operationStatus ? { operationStatus: installedModule.operationStatus } : {}),
        ...(uiEntrypointPortKey ? { uiEntrypointPortKey } : {}),
        ports,
      };
    })
  );

  return {
    gatewayBaseDomain: config.gatewayBaseDomain,
    hostPublicOrigin: config.hostPublicOrigin,
    modules: modules
      .filter(module => module.ports.some(port => port.public))
      .sort((left, right) => left.name.localeCompare(right.name)),
    users: auth.users
      .filter(user => !user.disabled)
      .map(user => ({
        id: user.id,
        ...(user.displayName ? { displayName: user.displayName } : {}),
        ...(user.email ? { email: user.email } : {}),
        role: user.role,
      }))
      .sort((left, right) =>
        (left.displayName ?? left.email ?? left.id).localeCompare(right.displayName ?? right.email ?? right.id)
      ),
  };
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
  const target = metadata ? resolveEndpointTarget(metadata, exposure.endpointKey) : null;
  if (!target) {
    throw new GatewayServiceError(
      'endpoint_not_found',
      `Module "${exposure.moduleId}" does not define endpoint "${exposure.endpointKey}".`
    );
  }

  const auth = await readAuthStateSnapshot(config);
  const access = canAccessModule({
    principal,
    moduleId: exposure.moduleId,
    exposurePolicy: exposure.exposurePolicy,
    assignments: auth.moduleAssignments,
  });
  const networkAlias = installedModule.containers.find(container => container.key === target.endpoint.container)?.networkAlias ||
    getModuleNetworkAlias(exposure.moduleId, target.endpoint.container);

  return {
    exposure,
    targetBaseUrl: `http://${networkAlias}:${target.port.containerPort}`,
    networkAlias,
    containerPort: target.port.containerPort,
    port: target.port,
    access,
  };
}

export async function validateGatewayExposureInput(
  input: GatewayExposureInput & { id?: string },
  config = getHostRuntimeConfig()
): Promise<GatewayExposureInput & {
  id: string;
  endpointKey: string;
  hostname: string;
  exposurePolicy: GatewayExposureRecord['exposurePolicy'];
  identityMode: GatewayExposureRecord['identityMode'];
  enabled: boolean;
}> {
  const moduleId = input.moduleId.trim();
  const endpointKey = (input.endpointKey ?? input.portKey ?? '').trim();
  const hostname = normalizeGatewayHostname(input.hostname);
  const exposurePolicy = input.exposurePolicy ?? DEFAULT_MODULE_EXPOSURE_POLICY;
  const identityMode = input.identityMode ?? getDefaultModuleIdentityMode(exposurePolicy);
  const enabled = input.enabled ?? true;

  if (!moduleId) {
    throw new GatewayServiceError('invalid_module_id', 'Module id is required.');
  }

  if (!endpointKey) {
    throw new GatewayServiceError('invalid_endpoint_key', 'Module endpoint key is required.');
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

  if (!isModuleIdentityMode(identityMode)) {
    throw new GatewayServiceError('invalid_identity_mode', 'Module identity mode is not supported.');
  }

  if (exposurePolicy === 'public' && identityMode === 'required') {
    throw new GatewayServiceError(
      'invalid_identity_mode',
      'Public exposures can use identity mode "none" or "optional", but not "required".'
    );
  }

  const installedModule = await findInstalledModuleSnapshot(moduleId, config);
  if (!installedModule) {
    throw new GatewayServiceError('module_not_found', `Module "${moduleId}" is not installed.`);
  }

  const metadata = await readInstalledModuleMetadata(installedModule, config);
  const target = metadata ? resolveEndpointTarget(metadata, endpointKey) : null;
  if (!target) {
    throw new GatewayServiceError(
      'endpoint_not_found',
      `Module "${moduleId}" does not define endpoint "${endpointKey}".`
    );
  }

  if (!target.endpoint.public) {
    throw new GatewayServiceError(
      'endpoint_not_public',
      `Endpoint "${endpointKey}" is not marked as externally exposable.`
    );
  }

  return {
    id: input.id?.trim() || `gw_${randomUUID()}`,
    moduleId,
    hostname,
    endpointKey,
    exposurePolicy,
    identityMode,
    enabled,
  };
}

function resolveEndpointTarget(metadata: GatewayModuleMetadata, endpointKey: string) {
  const endpoint = metadata.endpoints?.find(candidate => candidate.key === endpointKey);
  const container = metadata.containers.find(candidate => candidate.key === endpoint?.container);
  const port = container?.runtime?.ports?.find(candidate => candidate.key === endpoint?.port);

  return endpoint && container && port ? { endpoint, container, port } : null;
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

export function getModuleNetworkAlias(moduleId: string, containerKey = 'main') {
  const normalized = moduleId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return `mod-${normalized || 'module'}-${containerKey}`;
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

async function readInstalledModuleMetadata(
  module: InstalledModuleRecord,
  config: HostRuntimeConfig
): Promise<GatewayModuleMetadata | null> {
  const metadataPath = module.metadataPath
    ? path.isAbsolute(module.metadataPath)
      ? module.metadataPath
      : path.join(config.dataRootContainer, module.metadataPath)
    : path.join(config.modulesRootContainer, module.id, 'metadata.json');

  try {
    const raw = await fs.readFile(metadataPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return validateAndNormalizeMetadata(parsed, '$').metadata ?? (parsed as ModuleMetadata);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function isExposurePolicy(value: unknown): value is GatewayExposureRecord['exposurePolicy'] {
  return value === 'public' || value === 'loginRequired' || value === 'assignedUsersOnly';
}
