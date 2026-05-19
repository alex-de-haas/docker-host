import { randomUUID } from 'node:crypto';
import type { HostPrincipal } from '../types/auth.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import {
  appendAuthAuditEvent,
  readAuthState,
  updateAuthState,
} from './auth-store.ts';
import type {
  AuthCliTokenRecord,
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
export const RECENT_REAUTH_WINDOW_MS = 10 * 60 * 1000;
export const SESSION_ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;
export const SESSION_REJECTION_AUDIT_THROTTLE_MS = 5 * 60 * 1000;

const SETUP_TOKEN_PREFIX = 'dhstp_';
const CLI_TOKEN_PREFIX = 'dhcli_';
const SESSION_REJECTION_AUDIT_CACHE_MAX = 500;
const rejectedSessionAuditCache = new Map<string, number>();

export interface AuthRequestMeta {
  origin?: string;
  userAgent?: string;
}

export interface SessionPrincipal extends HostPrincipal {
  sessionId: string;
}

export interface CliTokenSummary {
  id: string;
  userId: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  scope: 'host.admin.cli';
}

export interface AuthSessionSummary {
  id: string;
  userId: string;
  userEmail?: string;
  userDisplayName?: string;
  userRole?: string;
  authProvider?: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  revokedAt?: string;
  reauthenticatedAt?: string;
  active: boolean;
  current: boolean;
  request?: AuthRequestMeta;
}

export interface AuthSessionListOptions {
  userId?: string;
  includeRevoked?: boolean;
  currentSessionId?: string;
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
    const session = createSessionRecord(user.id, sessionToken, now, request);

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

export async function recoverHostAdmin(
  input: {
    recoveryToken: string;
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
  const recoveryTokenHash = hashToken(input.recoveryToken);

  const { user, session, recoveryTokenId, restoredExistingUser } = await updateAuthState(state => {
    const recoveryToken = findValidRecoveryToken(state, recoveryTokenHash, now);
    if (!recoveryToken) {
      throw new AuthServiceError('invalid_recovery_token', 'The recovery token is invalid or expired.');
    }

    const existingUser = state.users.find(candidate => candidate.email === email);
    const user: AuthUserRecord = existingUser
      ? {
          ...existingUser,
          email,
          displayName: input.displayName?.trim() || existingUser.displayName,
          role: 'host.admin',
          authProvider: 'local',
          passwordHash,
          disabled: false,
          updatedAt: now.toISOString(),
        }
      : {
          id: `user_${randomUUID()}`,
          email,
          displayName: input.displayName?.trim() || undefined,
          role: 'host.admin',
          authProvider: 'local',
          passwordHash,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
    const session = createSessionRecord(user.id, sessionToken, now, request);

    return {
      state: {
        ...state,
        users: existingUser
          ? state.users.map(candidate => candidate.id === user.id ? user : candidate)
          : [...state.users, user],
        sessions: [
          ...pruneExpiredSessions(state.sessions, now).map(candidate =>
            candidate.userId === user.id ? { ...candidate, revokedAt: now.toISOString() } : candidate
          ),
          session,
        ],
        setupTokens: state.setupTokens.map(candidate =>
          candidate.id === recoveryToken.id
            ? { ...candidate, usedAt: now.toISOString() }
            : candidate
        ),
      },
      result: {
        user,
        session,
        recoveryTokenId: recoveryToken.id,
        restoredExistingUser: Boolean(existingUser),
      },
    };
  }, config);

  await appendAuthAuditEvent({
    type: 'auth.recovery.completed',
    actorUserId: user.id,
    target: {
      type: 'auth.user',
      id: user.id,
    },
    success: true,
    request,
    details: {
      recoveryTokenId,
      restoredExistingUser,
      sessionId: session.id,
    },
  }, config);

  return {
    sessionToken,
    session,
    user: toPrincipal(user),
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
    const session = createSessionRecord(user.id, sessionToken, now, request);
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

    const shouldTouchSession = Boolean(session && user && shouldRefreshSessionActivity(session, now));
    const sessionId = session?.id;
    const nextSessions = shouldTouchSession
      ? sessions.map(candidate =>
          candidate.id === sessionId
            ? {
                ...candidate,
                lastSeenAt: now.toISOString(),
                idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_TIMEOUT_MS).toISOString(),
              }
            : candidate
        )
      : sessions;
    const stateChanged = shouldTouchSession || sessions.length !== state.sessions.length;

    return {
      state: stateChanged ? { ...state, sessions: nextSessions } : state,
      result: null,
    };
  }, config);

  if (!principal && request && shouldAuditRejectedSession(sessionTokenHash, now)) {
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

export async function listAuthSessions(
  options: AuthSessionListOptions = {},
  config?: HostRuntimeConfig
): Promise<AuthSessionSummary[]> {
  const state = await readAuthState(config);
  const now = new Date();
  const usersById = new Map(state.users.map(user => [user.id, user]));

  return state.sessions
    .filter(session => !options.userId || session.userId === options.userId)
    .filter(session => options.includeRevoked || !session.revokedAt)
    .filter(session => options.includeRevoked || !isExpired(session.idleExpiresAt, now))
    .filter(session => options.includeRevoked || !isExpired(session.absoluteExpiresAt, now))
    .map(session => summarizeSession(session, usersById.get(session.userId), now, options.currentSessionId))
    .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt));
}

export async function revokeSessionById(
  sessionId: string,
  actorUserId: string,
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig
) {
  const normalizedSessionId = sessionId.trim();
  const now = new Date();

  const revokedSession = await updateAuthState<AuthSessionRecord | null>(state => {
    const existingSession = state.sessions.find(session =>
      session.id === normalizedSessionId &&
      !session.revokedAt &&
      !isExpired(session.idleExpiresAt, now) &&
      !isExpired(session.absoluteExpiresAt, now)
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
      type: 'auth.session.revoked',
      actorUserId,
      target: {
        type: 'auth.session',
        id: revokedSession.id,
      },
      success: true,
      request,
      details: {
        userId: revokedSession.userId,
      },
    }, config);
  }

  return Boolean(revokedSession);
}

export async function reauthenticateSession(
  input: {
    sessionId: string;
    userId: string;
    password?: string;
    recoveryToken?: string;
  },
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig
) {
  const now = new Date();
  const state = await readAuthState(config);
  const user = state.users.find(candidate => candidate.id === input.userId && !candidate.disabled);
  if (!user) {
    throw new AuthServiceError('user_not_found', 'The Host user is disabled or does not exist.');
  }

  if (input.password) {
    if (
      (user.authProvider !== 'local' && user.authProvider !== undefined) ||
      !user.passwordHash ||
      !(await verifyPassword(input.password, user.passwordHash))
    ) {
      await appendAuthAuditEvent({
        type: 'auth.reauthentication.failed',
        actorUserId: input.userId,
        success: false,
        request,
        details: {
          method: 'password',
        },
      }, config);

      throw new AuthServiceError('reauth_failed', 'Password reauthentication failed.');
    }

    return await markSessionReauthenticated(input.sessionId, input.userId, 'password', request, config);
  }

  if (input.recoveryToken) {
    const recoveryTokenHash = hashToken(input.recoveryToken);
    const recoveryTokenId = await updateAuthState<string | null>(current => {
      const recoveryToken = findValidRecoveryToken(current, recoveryTokenHash, now);
      if (!recoveryToken) {
        return {
          state: current,
          result: null,
        };
      }

      return {
        state: {
          ...current,
          setupTokens: current.setupTokens.map(candidate =>
            candidate.id === recoveryToken.id
              ? { ...candidate, usedAt: now.toISOString() }
              : candidate
          ),
        },
        result: recoveryToken.id,
      };
    }, config);

    if (!recoveryTokenId) {
      await appendAuthAuditEvent({
        type: 'auth.reauthentication.failed',
        actorUserId: input.userId,
        success: false,
        request,
        details: {
          method: 'recoveryToken',
        },
      }, config);

      throw new AuthServiceError('invalid_recovery_token', 'The recovery token is invalid or expired.');
    }

    return await markSessionReauthenticated(input.sessionId, input.userId, 'recoveryToken', request, config, {
      recoveryTokenId,
    });
  }

  throw new AuthServiceError('reauth_method_required', 'Enter a password or recovery token.');
}

export async function hasRecentSessionReauthentication(
  sessionId: string,
  config?: HostRuntimeConfig
) {
  const state = await readAuthState(config);
  const session = state.sessions.find(candidate => candidate.id === sessionId);
  if (!session?.reauthenticatedAt) {
    return false;
  }

  return Date.parse(session.reauthenticatedAt) >= Date.now() - RECENT_REAUTH_WINDOW_MS;
}

export async function createCliTokenForAdmin(
  userId: string,
  label: string,
  config?: HostRuntimeConfig
) {
  const token = generateToken(CLI_TOKEN_PREFIX);
  const now = new Date();

  const createdToken = await updateAuthState<AuthCliTokenRecord>(state => {
    const user = state.users.find(candidate => candidate.id === userId && !candidate.disabled);
    if (!user || user.role !== 'host.admin') {
      throw new AuthServiceError('admin_required', 'CLI tokens can only be issued for Host administrators.');
    }

    const nextToken: AuthCliTokenRecord = {
      id: `cli_${randomUUID()}`,
      userId,
      tokenHash: hashToken(token),
      label: normalizeCliTokenLabel(label),
      createdAt: now.toISOString(),
      scope: 'host.admin.cli',
    };

    return {
      state: {
        ...state,
        cliTokens: [
          ...state.cliTokens,
          nextToken,
        ],
      },
      result: nextToken,
    };
  }, config);

  await appendAuthAuditEvent({
    type: 'auth.cli_token.created',
    actorUserId: userId,
    success: true,
    details: { tokenId: createdToken.id, label: createdToken.label },
  }, config);

  return {
    token,
    tokenId: createdToken.id,
    cliToken: summarizeCliToken(createdToken),
  };
}

export async function listCliTokens(config?: HostRuntimeConfig): Promise<CliTokenSummary[]> {
  const state = await readAuthState(config);
  return state.cliTokens.map(summarizeCliToken);
}

export async function revokeCliToken(
  tokenId: string,
  actorUserId: string,
  config?: HostRuntimeConfig
) {
  const normalizedTokenId = tokenId.trim();
  const now = new Date();

  const revokedToken = await updateAuthState<AuthCliTokenRecord | null>(state => {
    const existingToken = state.cliTokens.find(candidate =>
      candidate.id === normalizedTokenId && !candidate.revokedAt
    );
    const revoked: AuthCliTokenRecord | null = existingToken
      ? { ...existingToken, revokedAt: now.toISOString() }
      : null;

    return {
      state: {
        ...state,
        cliTokens: state.cliTokens.map(candidate =>
          revoked && candidate.id === revoked.id ? revoked : candidate
        ),
      },
      result: revoked,
    };
  }, config);

  if (revokedToken) {
    await appendAuthAuditEvent({
      type: 'auth.cli_token.revoked',
      actorUserId,
      success: true,
      details: {
        tokenId: revokedToken.id,
        userId: revokedToken.userId,
        label: revokedToken.label,
      },
    }, config);
  }

  return Boolean(revokedToken);
}

export async function rotateCliToken(
  tokenId: string,
  actorUserId: string,
  label?: string,
  config?: HostRuntimeConfig
) {
  const normalizedTokenId = tokenId.trim();
  const token = generateToken(CLI_TOKEN_PREFIX);
  const now = new Date();

  const rotated = await updateAuthState<{
    revokedToken: AuthCliTokenRecord;
    createdToken: AuthCliTokenRecord;
  }>(state => {
    const existingToken = state.cliTokens.find(candidate =>
      candidate.id === normalizedTokenId && !candidate.revokedAt
    );
    if (!existingToken) {
      throw new AuthServiceError('cli_token_not_found', 'CLI token was not found or is already revoked.');
    }

    const user = state.users.find(candidate =>
      candidate.id === existingToken.userId &&
      !candidate.disabled &&
      candidate.role === 'host.admin'
    );
    if (!user) {
      throw new AuthServiceError('admin_required', 'CLI tokens can only be issued for Host administrators.');
    }

    const revokedToken: AuthCliTokenRecord = {
      ...existingToken,
      revokedAt: now.toISOString(),
    };
    const createdToken: AuthCliTokenRecord = {
      id: `cli_${randomUUID()}`,
      userId: existingToken.userId,
      tokenHash: hashToken(token),
      label: normalizeCliTokenLabel(label ?? existingToken.label),
      createdAt: now.toISOString(),
      scope: 'host.admin.cli',
    };

    return {
      state: {
        ...state,
        cliTokens: [
          ...state.cliTokens.map(candidate =>
            candidate.id === revokedToken.id ? revokedToken : candidate
          ),
          createdToken,
        ],
      },
      result: {
        revokedToken,
        createdToken,
      },
    };
  }, config);

  await appendAuthAuditEvent({
    type: 'auth.cli_token.rotated',
    actorUserId,
    success: true,
    details: {
      revokedTokenId: rotated.revokedToken.id,
      tokenId: rotated.createdToken.id,
      userId: rotated.createdToken.userId,
      label: rotated.createdToken.label,
    },
  }, config);

  return {
    token,
    tokenId: rotated.createdToken.id,
    revokedTokenId: rotated.revokedToken.id,
    cliToken: summarizeCliToken(rotated.createdToken),
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

    const createdSession = createSessionRecord(existingUser.id, sessionToken, now, request);
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

function createSessionRecord(
  userId: string,
  token: string,
  now: Date,
  request?: AuthRequestMeta
): AuthSessionRecord {
  return {
    id: `session_${randomUUID()}`,
    userId,
    tokenHash: hashToken(token),
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_TIMEOUT_MS).toISOString(),
    absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_TIMEOUT_MS).toISOString(),
    request,
  };
}

function pruneExpiredSessions(sessions: AuthSessionRecord[], now: Date) {
  return sessions.filter(session => isSessionActive(session, now));
}

function isSessionActive(session: AuthSessionRecord, now: Date) {
  return !session.revokedAt &&
    !isExpired(session.idleExpiresAt, now) &&
    !isExpired(session.absoluteExpiresAt, now);
}

function isExpired(expiresAt: string, now: Date) {
  return Date.parse(expiresAt) <= now.getTime();
}

function shouldRefreshSessionActivity(session: AuthSessionRecord, now: Date) {
  const lastSeenTime = Date.parse(session.lastSeenAt);
  return Number.isNaN(lastSeenTime) ||
    now.getTime() - lastSeenTime >= SESSION_ACTIVITY_WRITE_INTERVAL_MS;
}

function shouldAuditRejectedSession(sessionTokenHash: string, now: Date) {
  const nowTime = now.getTime();
  for (const [key, timestamp] of rejectedSessionAuditCache) {
    if (
      nowTime - timestamp >= SESSION_REJECTION_AUDIT_THROTTLE_MS ||
      rejectedSessionAuditCache.size > SESSION_REJECTION_AUDIT_CACHE_MAX
    ) {
      rejectedSessionAuditCache.delete(key);
    }
  }

  const lastAuditTime = rejectedSessionAuditCache.get(sessionTokenHash);
  if (lastAuditTime !== undefined && nowTime - lastAuditTime < SESSION_REJECTION_AUDIT_THROTTLE_MS) {
    return false;
  }

  rejectedSessionAuditCache.set(sessionTokenHash, nowTime);
  return true;
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

function normalizeCliTokenLabel(label: string) {
  const normalized = label.trim();
  return (normalized || 'Docker Host CLI').slice(0, 80);
}

function findValidRecoveryToken(state: AuthState, tokenHash: string, now: Date) {
  return state.setupTokens.find(candidate =>
    candidate.purpose === 'recovery' &&
    !candidate.usedAt &&
    !isExpired(candidate.expiresAt, now) &&
    candidate.tokenHash === tokenHash
  );
}

async function markSessionReauthenticated(
  sessionId: string,
  userId: string,
  method: 'password' | 'recoveryToken',
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig,
  details?: Record<string, unknown>
) {
  const now = new Date();

  const session = await updateAuthState<AuthSessionRecord | null>(state => {
    const existingSession = state.sessions.find(candidate =>
      candidate.id === sessionId &&
      candidate.userId === userId &&
      !candidate.revokedAt &&
      !isExpired(candidate.idleExpiresAt, now) &&
      !isExpired(candidate.absoluteExpiresAt, now)
    );
    const reauthenticatedSession: AuthSessionRecord | null = existingSession
      ? { ...existingSession, reauthenticatedAt: now.toISOString() }
      : null;

    return {
      state: {
        ...state,
        sessions: state.sessions.map(candidate =>
          reauthenticatedSession && candidate.id === reauthenticatedSession.id
            ? reauthenticatedSession
            : candidate
        ),
      },
      result: reauthenticatedSession,
    };
  }, config);

  if (!session) {
    throw new AuthServiceError('session_not_found', 'Session was not found or expired.');
  }

  await appendAuthAuditEvent({
    type: 'auth.reauthentication.succeeded',
    actorUserId: userId,
    target: {
      type: 'auth.session',
      id: session.id,
    },
    success: true,
    request,
    details: {
      method,
      ...details,
    },
  }, config);

  return summarizeSession(session, undefined, now, session.id);
}

function summarizeCliToken(token: AuthCliTokenRecord | null): CliTokenSummary {
  if (!token) {
    throw new AuthServiceError('cli_token_not_created', 'CLI token was not created.');
  }

  return {
    id: token.id,
    userId: token.userId,
    label: token.label,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
    revokedAt: token.revokedAt,
    scope: token.scope,
  };
}

function summarizeSession(
  session: AuthSessionRecord,
  user: AuthUserRecord | undefined,
  now: Date,
  currentSessionId?: string
): AuthSessionSummary {
  return {
    id: session.id,
    userId: session.userId,
    userEmail: user?.email,
    userDisplayName: user?.displayName,
    userRole: user?.role,
    authProvider: user?.authProvider,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    idleExpiresAt: session.idleExpiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
    revokedAt: session.revokedAt,
    reauthenticatedAt: session.reauthenticatedAt,
    active: isSessionActive(session, now),
    current: session.id === currentSessionId,
    request: session.request,
  };
}
