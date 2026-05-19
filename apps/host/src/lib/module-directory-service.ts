import { randomUUID } from 'node:crypto';
import { appendAuthAuditEvent, readAuthState, updateAuthState } from './auth-store.ts';
import type {
  AuthModuleDirectoryPolicyRecord,
  AuthModuleServiceTokenRecord,
  AuthState,
  AuthUserRecord,
} from './auth-store.ts';
import type { AuthRequestMeta } from './auth-service.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import {
  generateToken,
  hashToken,
} from './auth-crypto.ts';

export const MODULE_SERVICE_TOKEN_PREFIX = 'dhmst_';
export const MODULE_DIRECTORY_SCHEMA_VERSION = '0.1';
export const MODULE_SERVICE_TOKEN_ENV = 'DOCKER_HOST_MODULE_SERVICE_TOKEN';
export const MODULE_ID_ENV = 'DOCKER_HOST_MODULE_ID';
export const HOST_INTERNAL_ORIGIN_ENV = 'DOCKER_HOST_INTERNAL_ORIGIN';
export const MODULE_SERVICE_TOKEN_ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export interface ModuleServicePrincipal {
  moduleId: string;
  tokenId: string;
  scope: 'module.directory';
}

export interface ModuleDirectoryUser {
  id: string;
  displayName?: string;
  email?: string;
  hostRole: AuthUserRecord['role'];
}

export interface ModuleDirectoryResponse {
  schemaVersion: typeof MODULE_DIRECTORY_SCHEMA_VERSION;
  moduleId: string;
  users: ModuleDirectoryUser[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
  updatedAt: string;
}

export async function createModuleServiceToken(
  input: {
    moduleId: string;
    label?: string;
  },
  actorUserId?: string,
  config?: HostRuntimeConfig
) {
  const moduleId = normalizeModuleId(input.moduleId);
  if (!moduleId) {
    throw new ModuleDirectoryServiceError('invalid_module_id', 'Module id is required.', 400);
  }

  const token = generateToken(MODULE_SERVICE_TOKEN_PREFIX);
  const now = new Date().toISOString();
  const record: AuthModuleServiceTokenRecord = {
    id: `mst_${randomUUID()}`,
    moduleId,
    tokenHash: hashToken(token),
    label: input.label?.trim() || 'Module directory service token',
    createdAt: now,
    scope: 'module.directory',
  };

  await updateAuthState(state => ({
    state: {
      ...state,
      moduleServiceTokens: [...state.moduleServiceTokens, record],
    },
    result: null,
  }), config);

  await appendAuthAuditEvent({
    type: 'auth.module_service_token.created',
    actorUserId,
    success: true,
    details: {
      moduleId,
      tokenId: record.id,
      label: record.label,
      scope: record.scope,
    },
  }, config);

  return {
    token,
    tokenId: record.id,
    moduleId,
    label: record.label,
    createdAt: record.createdAt,
  };
}

export async function revokeModuleServiceToken(
  tokenId: string,
  actorUserId?: string,
  config?: HostRuntimeConfig
) {
  const normalizedTokenId = tokenId.trim();
  if (!normalizedTokenId) {
    return false;
  }

  const now = new Date().toISOString();

  const revoked = await updateAuthState<AuthModuleServiceTokenRecord | null>(state => {
    const existing = state.moduleServiceTokens.find(token =>
      token.id === normalizedTokenId && !token.revokedAt
    );
    const revokedToken = existing ? { ...existing, revokedAt: now } : null;

    return {
      state: {
        ...state,
        moduleServiceTokens: state.moduleServiceTokens.map(token =>
          revokedToken && token.id === revokedToken.id ? revokedToken : token
        ),
      },
      result: revokedToken,
    };
  }, config);

  if (revoked) {
    await appendAuthAuditEvent({
      type: 'auth.module_service_token.revoked',
      actorUserId,
      success: true,
      details: {
        moduleId: revoked.moduleId,
        tokenId: revoked.id,
        scope: revoked.scope,
      },
    }, config);
  }

  return Boolean(revoked);
}

export async function revokeModuleServiceTokenForModule(
  moduleId: string,
  tokenId: string,
  actorUserId?: string,
  config?: HostRuntimeConfig
) {
  const normalizedModuleId = normalizeModuleId(moduleId);
  if (!normalizedModuleId) {
    throw new ModuleDirectoryServiceError('invalid_module_id', 'Module id is required.', 400);
  }

  const normalizedTokenId = tokenId.trim();
  const state = await readAuthState(config);
  const token = state.moduleServiceTokens.find(candidate =>
    candidate.id === normalizedTokenId &&
    candidate.moduleId === normalizedModuleId &&
    !candidate.revokedAt
  );

  if (!token) {
    throw new ModuleDirectoryServiceError(
      'module_service_token_not_found',
      'Module service token was not found.',
      404
    );
  }

  await revokeModuleServiceToken(normalizedTokenId, actorUserId, config);
  return true;
}

export async function authenticateModuleServiceToken(
  token: string | null | undefined,
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig
): Promise<ModuleServicePrincipal | null> {
  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);
  const now = new Date();
  let principal: ModuleServicePrincipal | null = null;

  await updateAuthState(state => {
    const serviceToken = state.moduleServiceTokens.find(candidate =>
      !candidate.revokedAt &&
      candidate.scope === 'module.directory' &&
      candidate.tokenHash === tokenHash
    );

    if (serviceToken) {
      principal = {
        moduleId: serviceToken.moduleId,
        tokenId: serviceToken.id,
        scope: serviceToken.scope,
      };
    }

    const shouldTouchToken = Boolean(serviceToken && shouldRefreshModuleServiceTokenActivity(serviceToken, now));
    const serviceTokenId = serviceToken?.id;

    return {
      state: shouldTouchToken
        ? {
            ...state,
            moduleServiceTokens: state.moduleServiceTokens.map(candidate =>
              candidate.id === serviceTokenId
                ? { ...candidate, lastUsedAt: now.toISOString() }
                : candidate
            ),
          }
        : state,
      result: null,
    };
  }, config);

  if (!principal && request) {
    await appendAuthAuditEvent({
      type: 'auth.module_service_token.rejected',
      success: false,
      request,
    }, config);
  }

  return principal;
}

export async function setModuleDirectoryPolicy(
  moduleId: string,
  policy: {
    includeEmail: boolean;
  },
  actorUserId?: string,
  config?: HostRuntimeConfig
) {
  const normalizedModuleId = normalizeModuleId(moduleId);
  if (!normalizedModuleId) {
    throw new ModuleDirectoryServiceError('invalid_module_id', 'Module id is required.', 400);
  }

  const now = new Date().toISOString();
  const record: AuthModuleDirectoryPolicyRecord = {
    moduleId: normalizedModuleId,
    includeEmail: policy.includeEmail,
    updatedAt: now,
  };

  await updateAuthState(state => ({
    state: {
      ...state,
      moduleDirectoryPolicies: [
        ...state.moduleDirectoryPolicies.filter(candidate => candidate.moduleId !== normalizedModuleId),
        record,
      ],
    },
    result: null,
  }), config);

  await appendAuthAuditEvent({
    type: 'auth.module_directory_policy.updated',
    actorUserId,
    success: true,
    details: {
      moduleId: normalizedModuleId,
      includeEmail: record.includeEmail,
    },
  }, config);

  return record;
}

export async function getModuleDirectoryUsers(
  moduleId: string,
  principal: ModuleServicePrincipal | null | undefined,
  config?: HostRuntimeConfig
): Promise<ModuleDirectoryResponse> {
  const normalizedModuleId = normalizeModuleId(moduleId);
  if (!normalizedModuleId) {
    throw new ModuleDirectoryServiceError('invalid_module_id', 'Module id is required.', 400);
  }

  if (!principal) {
    throw new ModuleDirectoryServiceError(
      'module_service_token_required',
      'A module service token is required.',
      401
    );
  }

  if (principal.moduleId !== normalizedModuleId) {
    await appendAuthAuditEvent({
      type: 'module_directory.access.denied',
      success: false,
      details: {
        requestedModuleId: normalizedModuleId,
        credentialModuleId: principal.moduleId,
        tokenId: principal.tokenId,
      },
    }, config);

    throw new ModuleDirectoryServiceError(
      'module_directory_forbidden',
      'Module service token cannot read another module directory.',
      403
    );
  }

  const state = await readAuthState(config);
  const assignedUserIds = new Set(
    state.moduleAssignments
      .filter(assignment => assignment.moduleId === normalizedModuleId)
      .map(assignment => assignment.userId)
  );
  const policy = getModuleDirectoryPolicy(state, normalizedModuleId);
  const users = state.users
    .filter(user => !user.disabled && assignedUserIds.has(user.id))
    .map(user => toDirectoryUser(user, policy.includeEmail))
    .sort(compareDirectoryUsers);

  return {
    schemaVersion: MODULE_DIRECTORY_SCHEMA_VERSION,
    moduleId: normalizedModuleId,
    users,
    pagination: {
      limit: users.length,
      offset: 0,
      total: users.length,
    },
    updatedAt: state.updatedAt,
  };
}

export function buildModuleServiceEnvironment(input: {
  moduleId: string;
  serviceToken: string;
  hostInternalOrigin?: string | null;
}) {
  return {
    [MODULE_ID_ENV]: input.moduleId,
    [MODULE_SERVICE_TOKEN_ENV]: input.serviceToken,
    [HOST_INTERNAL_ORIGIN_ENV]: input.hostInternalOrigin || 'http://docker-host:3000',
  };
}

export function isModuleDirectoryServiceError(error: unknown): error is ModuleDirectoryServiceError {
  return error instanceof ModuleDirectoryServiceError;
}

export class ModuleDirectoryServiceError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(
    code: string,
    message: string,
    status: number
  ) {
    super(message);
    this.name = 'ModuleDirectoryServiceError';
    this.code = code;
    this.status = status;
  }
}

function getModuleDirectoryPolicy(
  state: AuthState,
  moduleId: string
): AuthModuleDirectoryPolicyRecord {
  return state.moduleDirectoryPolicies.find(policy => policy.moduleId === moduleId) ?? {
    moduleId,
    includeEmail: false,
    updatedAt: state.updatedAt,
  };
}

function toDirectoryUser(user: AuthUserRecord, includeEmail: boolean): ModuleDirectoryUser {
  return {
    id: user.id,
    ...(user.displayName ? { displayName: user.displayName } : {}),
    ...(includeEmail ? { email: user.email } : {}),
    hostRole: user.role,
  };
}

function compareDirectoryUsers(left: ModuleDirectoryUser, right: ModuleDirectoryUser) {
  return (left.displayName || left.email || left.id).localeCompare(
    right.displayName || right.email || right.id
  );
}

function normalizeModuleId(moduleId: string) {
  return moduleId.trim();
}

function shouldRefreshModuleServiceTokenActivity(
  token: AuthModuleServiceTokenRecord,
  now: Date
) {
  if (!token.lastUsedAt) {
    return true;
  }

  const lastUsedTime = Date.parse(token.lastUsedAt);
  return Number.isNaN(lastUsedTime) ||
    now.getTime() - lastUsedTime >= MODULE_SERVICE_TOKEN_ACTIVITY_WRITE_INTERVAL_MS;
}
