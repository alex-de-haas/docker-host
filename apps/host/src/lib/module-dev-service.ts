import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { appendAuthAuditEvent } from './auth-store.ts';
import { DEFAULT_MODULE_EXPOSURE_POLICY } from './auth-policy.ts';
import { getHostRuntimeConfig } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import { getDefaultModuleIdentityMode, isModuleIdentityMode } from './module-identity.mjs';
import { loadMetadataGraph } from './module-metadata.ts';
import {
  readModuleDevTargetStateSnapshot,
  updateModuleDevTargetState,
} from './module-dev-store.ts';
import { isAllowedGatewayHostname, normalizeGatewayHostname } from './gateway-service.ts';
import type { InstallPlanValidationError } from '../types/modules.ts';
import type { ModuleDevTargetInput, ModuleDevTargetRecord } from '../types/module-dev.ts';

export async function listModuleDevTargets(config = getHostRuntimeConfig()) {
  const state = await readModuleDevTargetStateSnapshot(config);
  return {
    developerModeEnabled: config.moduleDevModeEnabled === true,
    targets: state.targets,
  };
}

export async function upsertModuleDevTarget(
  input: ModuleDevTargetInput & { id?: string },
  actorUserId?: string,
  config = getHostRuntimeConfig()
) {
  assertModuleDevModeEnabled(config);
  const normalized = await validateModuleDevTargetInput(input, config);
  const now = new Date().toISOString();

  const target = await updateModuleDevTargetState(state => {
    const existingIndex = state.targets.findIndex(candidate => candidate.id === normalized.id);
    const duplicate = state.targets.find(candidate =>
      candidate.hostname === normalized.hostname &&
      candidate.id !== normalized.id
    );

    if (duplicate) {
      throw new ModuleDevServiceError(
        'module_dev_hostname_conflict',
        `Developer hostname "${normalized.hostname}" is already assigned to module "${duplicate.moduleId}".`
      );
    }

    const nextTarget: ModuleDevTargetRecord = existingIndex >= 0
      ? {
          ...normalized,
          createdAt: state.targets[existingIndex]?.createdAt || now,
          updatedAt: now,
        }
      : {
          ...normalized,
          createdAt: now,
          updatedAt: now,
        };

    const targets = existingIndex >= 0
      ? state.targets.map(candidate => candidate.id === nextTarget.id ? nextTarget : candidate)
      : [...state.targets, nextTarget];

    return {
      state: {
        ...state,
        targets,
      },
      result: nextTarget,
    };
  }, config);

  await appendAuthAuditEvent({
    type: 'module.dev.target.saved',
    actorUserId,
    success: true,
    details: {
      targetId: target.id,
      moduleId: target.moduleId,
      hostname: target.hostname,
      portKey: target.portKey,
      targetBaseUrl: target.targetBaseUrl,
      exposurePolicy: target.exposurePolicy,
      identityMode: target.identityMode,
      enabled: target.enabled,
    },
  }, config);

  return target;
}

export async function deleteModuleDevTarget(
  targetId: string,
  actorUserId?: string,
  config = getHostRuntimeConfig()
) {
  assertModuleDevModeEnabled(config);
  const deleted = await updateModuleDevTargetState(state => {
    const target = state.targets.find(candidate => candidate.id === targetId) ?? null;
    return {
      state: {
        ...state,
        targets: state.targets.filter(candidate => candidate.id !== targetId),
      },
      result: target,
    };
  }, config);

  if (deleted) {
    await appendAuthAuditEvent({
      type: 'module.dev.target.deleted',
      actorUserId,
      success: true,
      details: {
        targetId: deleted.id,
        moduleId: deleted.moduleId,
        hostname: deleted.hostname,
      },
    }, config);
  }

  return deleted;
}

export async function validateModuleDevTargetInput(
  input: ModuleDevTargetInput & { id?: string },
  config = getHostRuntimeConfig()
): Promise<ModuleDevTargetRecord> {
  const metadataUrl = input.metadataUrl.trim();
  const portKey = input.portKey.trim();
  const hostname = normalizeGatewayHostname(input.hostname);
  const exposurePolicy = input.exposurePolicy ?? DEFAULT_MODULE_EXPOSURE_POLICY;
  const identityMode = input.identityMode ?? getDefaultModuleIdentityMode(exposurePolicy);
  const enabled = input.enabled ?? true;

  if (!metadataUrl) {
    throw new ModuleDevServiceError('module_dev_metadata_url_required', 'Metadata URL is required.');
  }

  if (!portKey) {
    throw new ModuleDevServiceError('module_dev_port_key_required', 'Runtime port key is required.');
  }

  if (!isAllowedModuleDevHostname(hostname, config)) {
    throw new ModuleDevServiceError(
      'module_dev_hostname_invalid',
      'Developer hostname must be a valid gateway hostname, a .localhost hostname, or a hostname under the configured gateway base domain.'
    );
  }

  if (!isExposurePolicy(exposurePolicy)) {
    throw new ModuleDevServiceError('module_dev_exposure_policy_invalid', 'Exposure policy is not supported.');
  }

  if (!isModuleIdentityMode(identityMode)) {
    throw new ModuleDevServiceError('module_dev_identity_mode_invalid', 'Module identity mode is not supported.');
  }

  if (exposurePolicy === 'public' && identityMode === 'required') {
    throw new ModuleDevServiceError(
      'module_dev_identity_mode_invalid',
      'Public developer targets can use identity mode "none" or "optional", but not "required".'
    );
  }

  const targetUrl = normalizeModuleDevTargetUrl(input.targetBaseUrl);
  const graphResult = await loadMetadataGraph(metadataUrl);
  if (!graphResult.graph || graphResult.validationErrors.length > 0) {
    throw new ModuleDevServiceError(
      'module_dev_metadata_invalid',
      'Module metadata is invalid.',
      422,
      graphResult.validationErrors
    );
  }

  const root = graphResult.graph.nodes.get(graphResult.graph.rootId);
  if (!root) {
    throw new ModuleDevServiceError('module_dev_metadata_invalid', 'Module metadata root is missing.', 422);
  }

  const port = root.metadata.runtime.ports.find(candidate => candidate.key === portKey);
  if (!port) {
    throw new ModuleDevServiceError(
      'module_dev_port_not_found',
      `Module "${root.metadata.id}" does not define runtime port "${portKey}".`
    );
  }

  if (!port.public) {
    throw new ModuleDevServiceError(
      'module_dev_port_not_public',
      `Runtime port "${portKey}" is not marked as externally exposable.`
    );
  }

  return {
    id: input.id?.trim() || `mdev_${randomUUID()}`,
    moduleId: root.metadata.id,
    moduleName: root.metadata.name,
    moduleVersion: root.metadata.version,
    metadataUrl: root.metadataUrl,
    hostname,
    portKey,
    targetBaseUrl: targetUrl.targetBaseUrl,
    targetPathPrefix: targetUrl.targetPathPrefix,
    containerPort: port.containerPort,
    protocol: port.protocol,
    exposurePolicy,
    identityMode,
    enabled,
    createdAt: '',
    updatedAt: '',
  };
}

export function isModuleDevServiceError(error: unknown): error is ModuleDevServiceError {
  return error instanceof ModuleDevServiceError;
}

export class ModuleDevServiceError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly validationErrors: InstallPlanValidationError[];

  public constructor(
    code: string,
    message: string,
    status = 400,
    validationErrors: InstallPlanValidationError[] = []
  ) {
    super(message);
    this.name = 'ModuleDevServiceError';
    this.code = code;
    this.status = status;
    this.validationErrors = validationErrors;
  }
}

function assertModuleDevModeEnabled(config: HostRuntimeConfig) {
  if (config.moduleDevModeEnabled === true) {
    return;
  }

  throw new ModuleDevServiceError(
    'module_dev_mode_disabled',
    'Module developer mode is disabled. Set HOST_MODULE_DEV_MODE=enabled and restart Docker Host.',
    409
  );
}

function normalizeModuleDevTargetUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ModuleDevServiceError('module_dev_target_url_invalid', 'Target URL must be an absolute URL.');
  }

  if (url.protocol !== 'http:') {
    throw new ModuleDevServiceError('module_dev_target_url_invalid', 'Target URL must use http.');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new ModuleDevServiceError(
      'module_dev_target_url_invalid',
      'Target URL must not include credentials, query, or fragment.'
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!isAllowedDevTargetHost(hostname)) {
    throw new ModuleDevServiceError(
      'module_dev_target_url_forbidden',
      'Target URL must point to localhost, host.docker.internal, or a private network address.'
    );
  }

  const port = Number(url.port || (url.protocol === 'http:' ? 80 : 443));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ModuleDevServiceError('module_dev_target_url_invalid', 'Target URL port is not valid.');
  }

  const targetPathPrefix = normalizePathPrefix(url.pathname);
  return {
    targetBaseUrl: `${url.origin}${targetPathPrefix}`,
    targetPathPrefix,
  };
}

function normalizePathPrefix(pathname: string) {
  const normalized = pathname.replace(/\/+$/, '');
  return normalized === '' || normalized === '/' ? '' : normalized;
}

function isAllowedModuleDevHostname(hostname: string, config: HostRuntimeConfig) {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return true;
  }

  return isAllowedGatewayHostname(hostname, config);
}

function isAllowedDevTargetHost(hostname: string) {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'host.docker.internal') {
    return true;
  }

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) {
    return isPrivateIpv4(hostname);
  }

  if (ipVersion === 6) {
    const lower = hostname.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd');
  }

  return false;
}

function isPrivateIpv4(value: string) {
  const parts = value.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [first, second] = parts as [number, number, number, number];
  return first === 10 ||
    (first === 127) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function isExposurePolicy(value: unknown) {
  return value === 'public' || value === 'loginRequired' || value === 'assignedUsersOnly';
}
