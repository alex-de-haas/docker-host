import { canAccessModule } from './auth-policy.ts';
import { appendAuthAuditEvent, readAuthStateSnapshot } from './auth-store.ts';
import type { AuthUserRecord } from './auth-store.ts';
import { getHostRuntimeConfig } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import {
  MODULE_IDENTITY_TOKEN_HEADER,
  MODULE_IDENTITY_TOKEN_TTL_SECONDS,
  createModuleIdentityToken,
} from './module-identity.mjs';
import { readModuleDevTargetStateSnapshot } from './module-dev-store.ts';
import type { HostPrincipal } from '../types/auth.ts';

export interface ModuleDevIdentityInput {
  targetId: string;
  userEmail?: string;
  userId?: string;
}

export async function issueModuleDevIdentityToken(
  input: ModuleDevIdentityInput,
  actorUserId = 'local-cli',
  config = getHostRuntimeConfig()
) {
  const targetId = input.targetId.trim();
  if (!targetId) {
    throw new ModuleDevIdentityError('target_id_required', 'Developer target id is required.', 422);
  }

  const [devState, authState] = await Promise.all([
    readModuleDevTargetStateSnapshot(config),
    readAuthStateSnapshot(config),
  ]);
  const target = devState.targets.find(candidate => candidate.id === targetId);
  if (!target) {
    throw new ModuleDevIdentityError('developer_target_not_found', 'Developer target was not found.', 404);
  }

  if (!target.enabled) {
    throw new ModuleDevIdentityError('developer_target_disabled', 'Developer target is disabled.', 409);
  }

  const user = resolveIdentityUser(authState.users, input);
  if (!user) {
    throw new ModuleDevIdentityError('identity_user_not_found', 'Development user was not found.', 404);
  }

  const principal = toPrincipal(user);
  const access = canAccessModule({
    principal,
    moduleId: target.moduleId,
    exposurePolicy: target.exposurePolicy,
    assignments: authState.moduleAssignments,
  });
  const token = await createModuleIdentityToken({
    exposure: {
      id: target.id,
      moduleId: target.moduleId,
      hostname: target.hostname,
      endpointKey: target.portKey,
      exposurePolicy: target.exposurePolicy,
      identityMode: target.identityMode,
    },
    access,
    principal,
  }, config);

  if (!access.allowed) {
    await appendIssueAudit(false, actorUserId, target.id, target.moduleId, principal, access.reason, config);
    throw new ModuleDevIdentityError(
      'identity_user_access_denied',
      'Development user is not allowed to access this developer target.',
      403
    );
  }

  if (!token) {
    await appendIssueAudit(false, actorUserId, target.id, target.moduleId, principal, 'identityDisabled', config);
    throw new ModuleDevIdentityError(
      'identity_not_enabled',
      'Developer target identity mode does not issue module identity tokens.',
      409
    );
  }

  await appendIssueAudit(true, actorUserId, target.id, target.moduleId, principal, access.reason, config);

  return {
    token,
    tokenType: 'DockerHostModuleIdentity',
    headerName: MODULE_IDENTITY_TOKEN_HEADER,
    targetId: target.id,
    moduleId: target.moduleId,
    origin: target.targetBaseUrl,
    hostname: target.hostname,
    portKey: target.portKey,
    expiresInSeconds: MODULE_IDENTITY_TOKEN_TTL_SECONDS,
    user: {
      id: principal.id,
      role: principal.role,
      ...(principal.email ? { email: principal.email } : {}),
      ...(principal.displayName ? { displayName: principal.displayName } : {}),
    },
  };
}

export function isModuleDevIdentityError(error: unknown): error is ModuleDevIdentityError {
  return error instanceof ModuleDevIdentityError;
}

export class ModuleDevIdentityError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'ModuleDevIdentityError';
    this.code = code;
    this.status = status;
  }
}

function resolveIdentityUser(users: AuthUserRecord[], input: ModuleDevIdentityInput) {
  const userId = input.userId?.trim();
  const email = input.userEmail?.trim().toLowerCase();
  if (!userId && !email) {
    throw new ModuleDevIdentityError('identity_user_required', 'Development user id or email is required.', 422);
  }

  return users.find(candidate => {
    if (candidate.disabled) {
      return false;
    }

    if (userId) {
      return candidate.id === userId;
    }

    return typeof candidate.email === 'string' && candidate.email.toLowerCase() === email;
  }) ?? null;
}

function toPrincipal(user: AuthUserRecord): HostPrincipal {
  return {
    id: user.id,
    role: user.role,
    ...(user.email ? { email: user.email } : {}),
    ...(user.displayName ? { displayName: user.displayName } : {}),
  };
}

async function appendIssueAudit(
  success: boolean,
  actorUserId: string,
  targetId: string,
  moduleId: string,
  principal: HostPrincipal,
  reason: string,
  config: HostRuntimeConfig
) {
  await appendAuthAuditEvent({
    type: 'module.dev.identity.issued',
    actorUserId,
    target: {
      type: 'module.dev.target',
      id: targetId,
    },
    success,
    details: {
      moduleId,
      userId: principal.id,
      userEmail: principal.email,
      reason,
    },
  }, config);
}
