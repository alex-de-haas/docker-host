import { randomUUID } from 'node:crypto';
import type { HostPrincipal } from '../types/auth.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import {
  appendAuthAuditEvent,
  readAuthState,
  updateAuthState,
} from './auth-store.ts';
import type {
  AuthSessionRecord,
  AuthState,
  AuthUserRecord,
} from './auth-store.ts';
import {
  generateToken,
  hashPassword,
  hashToken,
  validatePasswordPolicy,
  verifyPassword,
} from './auth-crypto.ts';

export const SESSION_COOKIE_NAME = 'docker_host_session';
export const SESSION_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
export const SETUP_TOKEN_TTL_MS = 15 * 60 * 1000;

const SETUP_TOKEN_PREFIX = 'dhstp_';
const CLI_TOKEN_PREFIX = 'dhcli_';

export interface AuthRequestMeta {
  origin?: string;
  userAgent?: string;
}

export interface SessionPrincipal extends HostPrincipal {
  sessionId: string;
}

export async function getAuthStatus(config?: HostRuntimeConfig) {
  const state = await readAuthState(config);
  const activeUsers = state.users.filter(user => !user.disabled);
  const adminExists = activeUsers.some(user => user.role === 'host.admin');

  return {
    ready: adminExists,
    setupRequired: !adminExists,
    userCount: activeUsers.length,
    adminExists,
  };
}

export async function createSetupToken(
  purpose: 'first-admin' | 'recovery' = 'first-admin',
  config?: HostRuntimeConfig
) {
  const token = generateToken(SETUP_TOKEN_PREFIX);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SETUP_TOKEN_TTL_MS).toISOString();

  const tokenId = await updateAuthState(state => {
    const activeAdminExists = state.users.some(user => user.role === 'host.admin' && !user.disabled);
    if (purpose === 'first-admin' && activeAdminExists) {
      throw new AuthServiceError('admin_exists', 'A Host administrator already exists.');
    }

    const nextState: AuthState = {
      ...state,
      setupTokens: [
        ...state.setupTokens.filter(setupToken => !isExpired(setupToken.expiresAt, now)),
        {
          id: `setup_${randomUUID()}`,
          tokenHash: hashToken(token),
          createdAt: now.toISOString(),
          expiresAt,
          purpose,
        },
      ],
    };

    return {
      state: nextState,
      result: nextState.setupTokens.at(-1)?.id ?? '',
    };
  }, config);

  await appendAuthAuditEvent({
    type: purpose === 'first-admin' ? 'auth.setup_token.created' : 'auth.recovery_token.created',
    success: true,
    details: {
      tokenId,
      expiresAt,
    },
  }, config);

  return {
    token,
    tokenId,
    expiresAt,
  };
}

export async function bootstrapFirstAdmin(
  input: {
    setupToken: string;
    email: string;
    password: string;
    displayName?: string;
  },
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig
) {
  const email = normalizeEmail(input.email);
  if (!email) {
    throw new AuthServiceError('invalid_email', 'Enter a valid email address.');
  }

  const passwordPolicy = validatePasswordPolicy(input.password);
  if (!passwordPolicy.valid) {
    throw new AuthServiceError('weak_password', passwordPolicy.errors.join(' '));
  }

  const passwordHash = await hashPassword(input.password);
  const sessionToken = generateToken('dhs_');
  const now = new Date();

  const { createdUser, createdSession } = await updateAuthState(state => {
    if (state.users.some(user => user.role === 'host.admin' && !user.disabled)) {
      throw new AuthServiceError('admin_exists', 'A Host administrator already exists.');
    }

    const setupTokenHash = hashToken(input.setupToken);
    const setupToken = state.setupTokens.find(candidate =>
      candidate.purpose === 'first-admin' &&
      !candidate.usedAt &&
      !isExpired(candidate.expiresAt, now) &&
      candidate.tokenHash === setupTokenHash
    );

    if (!setupToken) {
      throw new AuthServiceError('invalid_setup_token', 'The setup token is invalid or expired.');
    }

    const user: AuthUserRecord = {
      id: `user_${randomUUID()}`,
      email,
      displayName: input.displayName?.trim() || undefined,
      role: 'host.admin',
      authProvider: 'local',
      passwordHash,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const session = createSessionRecord(user.id, sessionToken, now);

    return {
      state: {
        ...state,
        users: [...state.users, user],
        sessions: [...pruneExpiredSessions(state.sessions, now), session],
        setupTokens: state.setupTokens.map(candidate =>
          candidate.id === setupToken.id
            ? { ...candidate, usedAt: now.toISOString() }
            : candidate
        ),
      },
      result: {
        createdUser: user,
        createdSession: session,
      },
    };
  }, config);

  await appendAuthAuditEvent({
    type: 'auth.bootstrap.completed',
    actorUserId: createdUser.id,
    success: true,
    request,
  }, config);

  return {
    sessionToken,
    session: createdSession,
    user: toPrincipal(createdUser),
  };
}

export async function authenticatePassword(
  input: {
    email: string;
    password: string;
  },
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig
) {
  const email = normalizeEmail(input.email);
  const state = await readAuthState(config);
  const user = state.users.find(candidate =>
    candidate.email === email &&
    !candidate.disabled &&
    (candidate.authProvider === 'local' || candidate.authProvider === undefined) &&
    typeof candidate.passwordHash === 'string'
  );
  const valid = user?.passwordHash ? await verifyPassword(input.password, user.passwordHash) : false;

  if (!user || !valid) {
    await appendAuthAuditEvent({
      type: 'auth.login.failed',
      success: false,
      request,
      details: { email: email || input.email },
    }, config);

    throw new AuthServiceError('invalid_credentials', 'Email or password is incorrect.');
  }

  const now = new Date();
  const sessionToken = generateToken('dhs_');

  const createdSession = await updateAuthState(current => {
    const session = createSessionRecord(user.id, sessionToken, now);
    return {
      state: {
        ...current,
        sessions: [...pruneExpiredSessions(current.sessions, now), session],
      },
      result: session,
    };
  }, config);

  await appendAuthAuditEvent({
    type: 'auth.login.succeeded',
    actorUserId: user.id,
    success: true,
    request,
  }, config);

  return {
    sessionToken,
    session: createdSession,
    user: toPrincipal(user),
  };
}

export async function authenticateSessionToken(
  sessionToken: string | null | undefined,
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig
): Promise<SessionPrincipal | null> {
  if (!sessionToken) {
    return null;
  }

  const now = new Date();
  const sessionTokenHash = hashToken(sessionToken);
  let principal: SessionPrincipal | null = null;

  await updateAuthState(state => {
    const sessions = pruneExpiredSessions(state.sessions, now);
    const session = sessions.find(candidate =>
      !candidate.revokedAt &&
      candidate.tokenHash === sessionTokenHash &&
      !isExpired(candidate.idleExpiresAt, now) &&
      !isExpired(candidate.absoluteExpiresAt, now)
    );
    const user = session
      ? state.users.find(candidate => candidate.id === session.userId && !candidate.disabled)
      : null;

    if (session && user) {
      principal = {
        ...toPrincipal(user),
        sessionId: session.id,
      };
    }

    return {
      state: {
        ...state,
        sessions: sessions.map(candidate =>
          principal && candidate.id === principal.sessionId
            ? {
                ...candidate,
                lastSeenAt: now.toISOString(),
                idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_TIMEOUT_MS).toISOString(),
              }
            : candidate
        ),
      },
      result: null,
    };
  }, config);

  if (!principal && request) {
    await appendAuthAuditEvent({
      type: 'auth.session.rejected',
      success: false,
      request,
    }, config);
  }

  return principal;
}

export async function authenticateCliToken(
  token: string | null | undefined,
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig
): Promise<HostPrincipal | null> {
  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);
  const now = new Date();
  let principal: HostPrincipal | null = null;

  await updateAuthState(state => {
    const cliToken = state.cliTokens.find(candidate =>
      !candidate.revokedAt &&
      candidate.scope === 'host.admin.cli' &&
      candidate.tokenHash === tokenHash
    );
    const user = cliToken
      ? state.users.find(candidate => candidate.id === cliToken.userId && !candidate.disabled)
      : null;

    if (cliToken && user && user.role === 'host.admin') {
      principal = toPrincipal(user);
    }

    return {
      state: {
        ...state,
        cliTokens: state.cliTokens.map(candidate =>
          principal && candidate.id === cliToken?.id
            ? { ...candidate, lastUsedAt: now.toISOString() }
            : candidate
        ),
      },
      result: null,
    };
  }, config);

  if (!principal && request) {
    await appendAuthAuditEvent({
      type: 'auth.cli_token.rejected',
      success: false,
      request,
    }, config);
  }

  return principal;
}

export async function revokeSession(
  sessionToken: string | null | undefined,
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig
) {
  if (!sessionToken) {
    return false;
  }

  const now = new Date();
  const tokenHash = hashToken(sessionToken);

  const revokedSession = await updateAuthState(state => {
    const existingSession = state.sessions.find(session =>
      session.tokenHash === tokenHash && !session.revokedAt
    );
    const revoked: AuthSessionRecord | null = existingSession
      ? { ...existingSession, revokedAt: now.toISOString() }
      : null;

    return {
      state: {
        ...state,
        sessions: state.sessions.map(session =>
          revoked && session.id === revoked.id ? revoked : session
        ),
      },
      result: revoked,
    };
  }, config);

  if (revokedSession) {
    await appendAuthAuditEvent({
      type: 'auth.logout',
      actorUserId: revokedSession.userId,
      success: true,
      request,
    }, config);
  }

  return Boolean(revokedSession);
}

export async function createCliTokenForAdmin(
  userId: string,
  label: string,
  config?: HostRuntimeConfig
) {
  const token = generateToken(CLI_TOKEN_PREFIX);
  const now = new Date();
  let tokenId = '';

  await updateAuthState(state => {
    const user = state.users.find(candidate => candidate.id === userId && !candidate.disabled);
    if (!user || user.role !== 'host.admin') {
      throw new AuthServiceError('admin_required', 'CLI tokens can only be issued for Host administrators.');
    }

    tokenId = `cli_${randomUUID()}`;
    return {
      state: {
        ...state,
        cliTokens: [
          ...state.cliTokens,
          {
            id: tokenId,
            userId,
            tokenHash: hashToken(token),
            label,
            createdAt: now.toISOString(),
            scope: 'host.admin.cli',
          },
        ],
      },
      result: null,
    };
  }, config);

  await appendAuthAuditEvent({
    type: 'auth.cli_token.created',
    actorUserId: userId,
    success: true,
    details: { tokenId, label },
  }, config);

  return {
    token,
    tokenId,
  };
}

export async function createSessionForUser(
  userId: string,
  auditType: string,
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig
) {
  const now = new Date();
  const sessionToken = generateToken('dhs_');

  const { user, session } = await updateAuthState(state => {
    const existingUser = state.users.find(candidate => candidate.id === userId && !candidate.disabled);
    if (!existingUser) {
      throw new AuthServiceError('user_not_found', 'The Host user is disabled or does not exist.');
    }

    const createdSession = createSessionRecord(existingUser.id, sessionToken, now);
    return {
      state: {
        ...state,
        sessions: [...pruneExpiredSessions(state.sessions, now), createdSession],
      },
      result: {
        user: existingUser,
        session: createdSession,
      },
    };
  }, config);

  await appendAuthAuditEvent({
    type: auditType,
    actorUserId: user.id,
    success: true,
    request,
    details: {
      sessionId: session.id,
    },
  }, config);

  return {
    sessionToken,
    session,
    user: toPrincipal(user),
  };
}

export function isAuthServiceError(error: unknown): error is AuthServiceError {
  return error instanceof AuthServiceError;
}

export class AuthServiceError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthServiceError';
    this.code = code;
  }
}

function createSessionRecord(userId: string, token: string, now: Date): AuthSessionRecord {
  return {
    id: `session_${randomUUID()}`,
    userId,
    tokenHash: hashToken(token),
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_TIMEOUT_MS).toISOString(),
    absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_TIMEOUT_MS).toISOString(),
  };
}

function pruneExpiredSessions(sessions: AuthSessionRecord[], now: Date) {
  return sessions.filter(session =>
    !session.revokedAt &&
    !isExpired(session.idleExpiresAt, now) &&
    !isExpired(session.absoluteExpiresAt, now)
  );
}

function isExpired(expiresAt: string, now: Date) {
  return Date.parse(expiresAt) <= now.getTime();
}

function normalizeEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : '';
}

function toPrincipal(user: AuthUserRecord): HostPrincipal {
  return {
    id: user.id,
    email: user.email || undefined,
    displayName: user.displayName,
    role: user.role,
  };
}
