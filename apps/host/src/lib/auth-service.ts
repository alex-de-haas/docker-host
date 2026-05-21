import { randomUUID } from 'node:crypto';
import type { HostPrincipal } from '../types/auth.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import {
  appendAuthAuditEvent,
  readAuthState,
  updateAuthState,
} from './auth-store.ts';
import type {
  AuthAccountSetRecord,
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
export const ACCOUNT_SET_COOKIE_NAME = 'docker_host_accounts';
export const SESSION_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
export const ACCOUNT_SET_ABSOLUTE_TIMEOUT_MS = SESSION_ABSOLUTE_TIMEOUT_MS;
export const SETUP_TOKEN_TTL_MS = 15 * 60 * 1000;
export const RECENT_REAUTH_WINDOW_MS = 10 * 60 * 1000;
export const SESSION_ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;
export const SESSION_REJECTION_AUDIT_THROTTLE_MS = 5 * 60 * 1000;

const SETUP_TOKEN_PREFIX = 'dhstp_';
const ACCOUNT_SET_TOKEN_PREFIX = 'dhacct_';
const CLI_TOKEN_PREFIX = 'dhcli_';
const DEFAULT_DEV_ADMIN_EMAIL = 'admin@docker-host.local';
const DEFAULT_DEV_ADMIN_DISPLAY_NAME = 'Dev Admin';
const DEFAULT_DEV_ADMIN_PASSWORD = 'docker-host-dev-admin';
const DEFAULT_DEV_USER_EMAIL = 'user@docker-host.local';
const DEFAULT_DEV_USER_DISPLAY_NAME = 'Dev User';
const DEFAULT_DEV_USER_PASSWORD = 'docker-host-dev-user';
const SESSION_REJECTION_AUDIT_CACHE_MAX = 500;
const rejectedSessionAuditCache = new Map<string, number>();

export interface AuthRequestMeta {
  origin?: string;
  userAgent?: string;
}

type DevAuthRole = 'host.admin' | 'host.user';

interface DevAuthCredentials {
  email: string;
  displayName: string;
  password: string;
  role: DevAuthRole;
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

export interface BrowserAccountSummary extends HostPrincipal {
  authProvider?: string;
  addedAt: string;
  lastUsedAt: string;
  active: boolean;
}

export interface BrowserAccountSetSummary {
  accountSetId?: string;
  expiresAt?: string;
  activeUser: HostPrincipal | null;
  accounts: BrowserAccountSummary[];
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

export function isDevAuthAutoLoginEnabled() {
  const enabled = isEnabledDevFlag(process.env.HOST_DEV_AUTH, ['auto', 'auto-login']);

  if (!enabled) {
    return false;
  }

  return isDevelopmentRuntime();
}

export function isDevAuthBrowserAccountSeedEnabled() {
  return isDevAuthAutoLoginEnabled() &&
    isEnabledDevFlag(process.env.HOST_DEV_AUTH_SEED_BROWSER_ACCOUNTS);
}

export function getDevAuthCredentials() {
  return getDevAccountCredentials(getDevAuthRole());
}

function isEnabledDevFlag(value: string | undefined, extraValues: string[] = []) {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' ||
    normalized === 'true' ||
    normalized === 'enabled' ||
    normalized === 'on' ||
    normalized === 'yes' ||
    extraValues.includes(normalized || '');
}

function getDevAuthRole(): DevAuthRole {
  const configuredRole = process.env.HOST_DEV_AUTH_ROLE?.trim().toLowerCase();
  switch (configuredRole) {
    case undefined:
    case '':
    case 'admin':
    case 'host.admin':
      return 'host.admin';
    case 'user':
    case 'host.user':
      return 'host.user';
    default:
      throw new AuthServiceError(
        'invalid_dev_auth_role',
        'HOST_DEV_AUTH_ROLE must be "admin" or "user".'
      );
  }
}

function getDevAccountCredentials(role: DevAuthRole): DevAuthCredentials {
  if (role === 'host.user') {
    const configuredEmail = normalizeEmail(process.env.HOST_DEV_USER_EMAIL || '');
    const configuredPassword = process.env.HOST_DEV_USER_PASSWORD || '';
    const displayName = process.env.HOST_DEV_USER_NAME?.trim() || DEFAULT_DEV_USER_DISPLAY_NAME;

    return {
      email: configuredEmail || DEFAULT_DEV_USER_EMAIL,
      displayName,
      password: configuredPassword || DEFAULT_DEV_USER_PASSWORD,
      role,
    };
  }

  const configuredEmail = normalizeEmail(process.env.HOST_DEV_ADMIN_EMAIL || '');
  const configuredPassword = process.env.HOST_DEV_ADMIN_PASSWORD || '';
  const displayName = process.env.HOST_DEV_ADMIN_NAME?.trim() || DEFAULT_DEV_ADMIN_DISPLAY_NAME;

  return {
    email: configuredEmail || DEFAULT_DEV_ADMIN_EMAIL,
    displayName,
    password: configuredPassword || DEFAULT_DEV_ADMIN_PASSWORD,
    role,
  };
}

function upsertDevAuthUser(
  users: AuthUserRecord[],
  credentials: DevAuthCredentials,
  passwordHash: string,
  now: Date
) {
  const existingUser = users.find(candidate =>
    candidate.email === credentials.email &&
    (candidate.authProvider === 'local' || candidate.authProvider === undefined)
  );
  const user: AuthUserRecord = existingUser
    ? {
        ...existingUser,
        email: credentials.email,
        displayName: credentials.displayName,
        role: credentials.role,
        authProvider: 'local',
        passwordHash,
        disabled: false,
        updatedAt: now.toISOString(),
      }
    : {
        id: `user_${randomUUID()}`,
        email: credentials.email,
        displayName: credentials.displayName,
        role: credentials.role,
        authProvider: 'local',
        passwordHash,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };

  return {
    user,
    createdUser: !existingUser,
    users: existingUser
      ? users.map(candidate => candidate.id === user.id ? user : candidate)
      : [...users, user],
  };
}

export async function createDevSession(
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig
) {
  if (!isDevAuthAutoLoginEnabled()) {
    throw new AuthServiceError('dev_auth_disabled', 'Development auto-login is not enabled.');
  }

  return createDevSessionForCredentials(getDevAuthCredentials(), request, config, {
    seedBrowserAccounts: isDevAuthBrowserAccountSeedEnabled(),
  });
}

export async function prepareDevBrowserAccountUsers(
  config?: HostRuntimeConfig
) {
  if (!isDevAuthBrowserAccountSeedEnabled()) {
    throw new AuthServiceError('dev_auth_disabled', 'Development browser account seeding is not enabled.');
  }

  const accountCredentials = getDevSessionAccountCredentials(getDevAuthCredentials(), true);
  const passwordHashes = await validateAndHashDevCredentials(accountCredentials);
  const now = new Date();

  const accountUsers = await updateAuthState(state => {
    let users = state.users;
    const nextAccountUsers: AuthUserRecord[] = [];

    for (const account of accountCredentials) {
      const result = upsertDevAuthUser(users, account, passwordHashes.get(account.email) ?? '', now);
      users = result.users;
      nextAccountUsers.push(result.user);
    }

    return {
      state: {
        ...state,
        users,
      },
      result: nextAccountUsers,
    };
  }, config);

  return accountUsers.map(toPrincipal);
}

export async function createDevAdminSession(
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig
) {
  if (!isDevAuthAutoLoginEnabled()) {
    throw new AuthServiceError('dev_auth_disabled', 'Development auto-login is not enabled.');
  }

  return createDevSessionForCredentials(getDevAccountCredentials('host.admin'), request, config);
}

async function createDevSessionForCredentials(
  credentials: DevAuthCredentials,
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig,
  options: {
    seedBrowserAccounts?: boolean;
  } = {}
) {
  const accountCredentials = getDevSessionAccountCredentials(credentials, Boolean(options.seedBrowserAccounts));
  const passwordHashes = await validateAndHashDevCredentials(accountCredentials);

  const sessionToken = generateToken('dhs_');
  const now = new Date();

  const { user, session, createdUser, accountUsers } = await updateAuthState(state => {
    let users = state.users;
    let sessionUser: AuthUserRecord | null = null;
    let createdSessionUser = false;
    const nextAccountUsers: AuthUserRecord[] = [];

    for (const account of accountCredentials) {
      const result = upsertDevAuthUser(users, account, passwordHashes.get(account.email) ?? '', now);
      users = result.users;
      nextAccountUsers.push(result.user);
      if (account.email === credentials.email) {
        sessionUser = result.user;
        createdSessionUser = result.createdUser;
      }
    }

    if (!sessionUser) {
      throw new AuthServiceError('dev_auth_user_missing', 'Development account could not be prepared.');
    }

    const session = createSessionRecord(sessionUser.id, sessionToken, now, request);

    return {
      state: {
        ...state,
        users,
        sessions: [...pruneExpiredSessions(state.sessions, now), session],
      },
      result: {
        user: sessionUser,
        session,
        createdUser: createdSessionUser,
        accountUsers: nextAccountUsers,
      },
    };
  }, config);

  await appendAuthAuditEvent({
    type: 'auth.dev_login.succeeded',
    actorUserId: user.id,
    success: true,
    request,
    details: {
      sessionId: session.id,
      createdUser,
      role: user.role,
    },
  }, config);

  return {
    sessionToken,
    session,
    user: toPrincipal(user),
    browserAccountUsers: accountUsers.map(toPrincipal),
  };
}

async function validateAndHashDevCredentials(accountCredentials: DevAuthCredentials[]) {
  for (const account of accountCredentials) {
    const passwordPolicy = validatePasswordPolicy(account.password);
    if (!passwordPolicy.valid) {
      throw new AuthServiceError('weak_password', passwordPolicy.errors.join(' '));
    }
  }

  const passwordHashes = new Map<string, string>();
  for (const account of accountCredentials) {
    passwordHashes.set(account.email, await hashPassword(account.password));
  }

  return passwordHashes;
}

function getDevSessionAccountCredentials(
  sessionCredentials: DevAuthCredentials,
  seedBrowserAccounts: boolean
) {
  const adminCredentials = getDevAccountCredentials('host.admin');
  const userCredentials = getDevAccountCredentials('host.user');
  const requiresUserAccount = sessionCredentials.role === 'host.user' || seedBrowserAccounts;
  if (requiresUserAccount && adminCredentials.email === userCredentials.email) {
    throw new AuthServiceError(
      'dev_auth_account_conflict',
      'Development user and administrator accounts must use different email addresses.'
    );
  }

  const accountCredentials = requiresUserAccount
    ? [
        adminCredentials,
        userCredentials,
      ]
    : [sessionCredentials];

  return accountCredentials.filter((account, index, accounts) =>
    accounts.findIndex(candidate => candidate.email === account.email) === index
  );
}

export async function addUserToBrowserAccountSet(
  input: {
    accountSetToken?: string | null;
    userId: string;
  },
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig
) {
  const userId = input.userId.trim();
  const result = await addUsersToBrowserAccountSet({
    accountSetToken: input.accountSetToken,
    userIds: [userId],
  }, request, config);

  return {
    accountSetToken: result.accountSetToken,
    accountSetId: result.accountSetId,
    expiresAt: result.expiresAt,
    created: result.created,
    added: result.addedUserIds.includes(userId),
  };
}

export async function addUsersToBrowserAccountSet(
  input: {
    accountSetToken?: string | null;
    userIds: string[];
  },
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig
) {
  const normalizedUserIds = input.userIds.map(userId => userId.trim());
  if (normalizedUserIds.length === 0 || normalizedUserIds.some(userId => userId.length === 0)) {
    throw new AuthServiceError('invalid_user_id', 'At least one Host user id is required.');
  }
  const userIds = Array.from(new Set(normalizedUserIds));

  const now = new Date();
  const incomingToken = normalizeToken(input.accountSetToken);
  const newAccountSetToken = generateToken(ACCOUNT_SET_TOKEN_PREFIX);
  const newAccountSetTokenHash = hashToken(newAccountSetToken);
  const incomingTokenHash = incomingToken ? hashToken(incomingToken) : null;

  const result = await updateAuthState<{
    accountSet: AuthAccountSetRecord;
    accountSetToken: string;
    created: boolean;
    addedUserIds: string[];
  }>(state => {
    const usersById = new Map(
      state.users
        .filter(candidate => !candidate.disabled)
        .map(candidate => [candidate.id, candidate])
    );
    const users = userIds.map(userId => usersById.get(userId));
    if (users.some(user => !user)) {
      throw new AuthServiceError('user_not_found', 'The Host user is disabled or does not exist.');
    }

    const accountSets = pruneExpiredAccountSets(state.accountSets, now);
    const existingAccountSet = incomingTokenHash
      ? findActiveAccountSetByTokenHash(accountSets, incomingTokenHash, now)
      : null;
    const accountSet = existingAccountSet ?? createAccountSetRecord(newAccountSetTokenHash, now, request);
    let accountSetUsers = accountSet.users;
    const addedUserIds: string[] = [];
    for (const user of users) {
      if (!user) {
        continue;
      }
      const existingUser = accountSetUsers.find(candidate => candidate.userId === user.id);
      if (!existingUser) {
        addedUserIds.push(user.id);
      }
      accountSetUsers = upsertAccountSetUser(accountSetUsers, user.id, now);
    }

    const nextAccountSet: AuthAccountSetRecord = {
      ...accountSet,
      users: accountSetUsers,
      updatedAt: now.toISOString(),
    };

    return {
      state: {
        ...state,
        accountSets: existingAccountSet
          ? accountSets.map(candidate => candidate.id === nextAccountSet.id ? nextAccountSet : candidate)
          : [...accountSets, nextAccountSet],
      },
      result: {
        accountSet: nextAccountSet,
        accountSetToken: existingAccountSet ? incomingToken ?? newAccountSetToken : newAccountSetToken,
        created: !existingAccountSet,
        addedUserIds,
      },
    };
  }, config);

  for (const userId of result.addedUserIds) {
    await appendAuthAuditEvent({
      type: 'auth.account_set.account_added',
      actorUserId: userId,
      target: {
        type: 'auth.account_set',
        id: result.accountSet.id,
      },
      success: true,
      request,
      details: {
        created: result.created,
        expiresAt: result.accountSet.expiresAt,
      },
    }, config);
  }

  return {
    accountSetToken: result.accountSetToken,
    accountSetId: result.accountSet.id,
    expiresAt: result.accountSet.expiresAt,
    created: result.created,
    added: result.addedUserIds.length > 0,
    addedUserIds: result.addedUserIds,
  };
}

export async function listBrowserAccounts(
  accountSetToken: string | null | undefined,
  activeUser: HostPrincipal | null,
  config?: HostRuntimeConfig
): Promise<BrowserAccountSetSummary> {
  const token = normalizeToken(accountSetToken);
  if (!token) {
    return {
      activeUser,
      accounts: [],
    };
  }

  const state = await readAuthState(config);
  const now = new Date();
  const accountSet = findActiveAccountSetByTokenHash(state.accountSets, hashToken(token), now);
  if (!accountSet) {
    return {
      activeUser,
      accounts: [],
    };
  }

  const usersById = new Map(state.users.map(user => [user.id, user]));
  const accounts = accountSet.users
    .map(accountUser => summarizeBrowserAccount(accountUser, usersById.get(accountUser.userId), activeUser))
    .filter((account): account is BrowserAccountSummary => account !== null)
    .sort(sortBrowserAccounts);

  return {
    accountSetId: accountSet.id,
    expiresAt: accountSet.expiresAt,
    activeUser,
    accounts,
  };
}

export async function switchBrowserAccount(
  input: {
    accountSetToken: string | null | undefined;
    userId: string;
    actorUserId?: string;
  },
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig
) {
  const token = normalizeToken(input.accountSetToken);
  if (!token) {
    throw new AuthServiceError('account_set_required', 'No remembered browser accounts are available.');
  }

  const now = new Date();
  const sessionToken = generateToken('dhs_');
  const tokenHash = hashToken(token);
  const targetUserId = input.userId.trim();
  const actorUserId = input.actorUserId?.trim() || undefined;

  const result = await updateAuthState<{
    accountSet: AuthAccountSetRecord;
    user: AuthUserRecord;
    session: AuthSessionRecord;
  }>(state => {
    const accountSets = pruneExpiredAccountSets(state.accountSets, now);
    const accountSet = findActiveAccountSetByTokenHash(accountSets, tokenHash, now);
    if (!accountSet) {
      throw new AuthServiceError('account_set_not_found', 'Remembered browser accounts are expired or unavailable.');
    }

    const accountUser = accountSet.users.find(candidate => candidate.userId === targetUserId);
    if (!accountUser) {
      throw new AuthServiceError('account_not_remembered', 'This account is not remembered in the current browser.');
    }

    const user = state.users.find(candidate => candidate.id === targetUserId && !candidate.disabled);
    if (!user) {
      throw new AuthServiceError('user_not_found', 'The Host user is disabled or does not exist.');
    }

    const session = createSessionRecord(user.id, sessionToken, now, request);
    const nextAccountSet: AuthAccountSetRecord = {
      ...accountSet,
      users: accountSet.users.map(candidate =>
        candidate.userId === user.id
          ? { ...candidate, lastUsedAt: now.toISOString() }
          : candidate
      ),
      updatedAt: now.toISOString(),
    };

    return {
      state: {
        ...state,
        accountSets: accountSets.map(candidate => candidate.id === nextAccountSet.id ? nextAccountSet : candidate),
        sessions: [...pruneExpiredSessions(state.sessions, now), session],
      },
      result: {
        accountSet: nextAccountSet,
        user,
        session,
      },
    };
  }, config);

  await appendAuthAuditEvent({
    type: 'auth.account_set.switched',
    actorUserId,
    target: {
      type: 'auth.account_set',
      id: result.accountSet.id,
    },
    success: true,
    request,
    details: {
      sessionId: result.session.id,
      switchedToUserId: result.user.id,
    },
  }, config);

  return {
    sessionToken,
    session: result.session,
    user: toPrincipal(result.user),
  };
}

export async function removeBrowserAccount(
  input: {
    accountSetToken: string | null | undefined;
    userId: string;
    activeSessionToken?: string | null;
    actorUserId?: string;
  },
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig
) {
  const token = normalizeToken(input.accountSetToken);
  if (!token) {
    throw new AuthServiceError('account_set_required', 'No remembered browser accounts are available.');
  }

  const now = new Date();
  const tokenHash = hashToken(token);
  const targetUserId = input.userId.trim();
  const activeSessionToken = normalizeToken(input.activeSessionToken);
  const activeSessionTokenHash = activeSessionToken ? hashToken(activeSessionToken) : null;
  const actorUserId = input.actorUserId?.trim() || undefined;

  const result = await updateAuthState<{
    accountSetId: string;
    removed: boolean;
    accountSetRevoked: boolean;
    activeSessionRevoked: boolean;
  }>(state => {
    const accountSets = pruneExpiredAccountSets(state.accountSets, now);
    const accountSet = findActiveAccountSetByTokenHash(accountSets, tokenHash, now);
    if (!accountSet) {
      throw new AuthServiceError('account_set_not_found', 'Remembered browser accounts are expired or unavailable.');
    }

    const removed = accountSet.users.some(candidate => candidate.userId === targetUserId);
    const remainingUsers = accountSet.users.filter(candidate => candidate.userId !== targetUserId);
    const accountSetRevoked = removed && remainingUsers.length === 0;
    const nextAccountSet: AuthAccountSetRecord = accountSetRevoked
      ? { ...accountSet, users: [], updatedAt: now.toISOString(), revokedAt: now.toISOString() }
      : { ...accountSet, users: remainingUsers, updatedAt: now.toISOString() };
    let activeSessionRevoked = false;
    const sessions = removed && activeSessionTokenHash
      ? state.sessions.map(session => {
          if (
            session.tokenHash === activeSessionTokenHash &&
            session.userId === targetUserId &&
            !session.revokedAt
          ) {
            activeSessionRevoked = true;
            return { ...session, revokedAt: now.toISOString() };
          }

          return session;
        })
      : state.sessions;

    return {
      state: {
        ...state,
        accountSets: accountSets.map(candidate => candidate.id === nextAccountSet.id ? nextAccountSet : candidate),
        sessions,
      },
      result: {
        accountSetId: accountSet.id,
        removed,
        accountSetRevoked,
        activeSessionRevoked,
      },
    };
  }, config);

  if (result.removed) {
    await appendAuthAuditEvent({
      type: 'auth.account_set.account_removed',
      actorUserId,
      target: {
        type: 'auth.account_set',
        id: result.accountSetId,
      },
      success: true,
      request,
      details: {
        removedUserId: targetUserId,
        accountSetRevoked: result.accountSetRevoked,
        activeSessionRevoked: result.activeSessionRevoked,
      },
    }, config);
  }

  return result;
}

export async function clearBrowserAccountSet(
  input: {
    accountSetToken: string | null | undefined;
    activeSessionToken?: string | null;
    actorUserId?: string;
  },
  request?: AuthRequestMeta,
  config?: HostRuntimeConfig
) {
  const token = normalizeToken(input.accountSetToken);
  const activeSessionToken = normalizeToken(input.activeSessionToken);
  const now = new Date();
  const tokenHash = token ? hashToken(token) : null;
  const activeSessionTokenHash = activeSessionToken ? hashToken(activeSessionToken) : null;

  const result = await updateAuthState<{
    accountSetId?: string;
    accountSetRevoked: boolean;
    activeSessionRevoked: boolean;
  }>(state => {
    const accountSets = pruneExpiredAccountSets(state.accountSets, now);
    const accountSet = tokenHash ? findActiveAccountSetByTokenHash(accountSets, tokenHash, now) : null;
    let activeSessionRevoked = false;
    const sessions = activeSessionTokenHash
      ? state.sessions.map(session => {
          if (session.tokenHash === activeSessionTokenHash && !session.revokedAt) {
            activeSessionRevoked = true;
            return { ...session, revokedAt: now.toISOString() };
          }

          return session;
        })
      : state.sessions;

    return {
      state: {
        ...state,
        accountSets: accountSet
          ? accountSets.map(candidate =>
              candidate.id === accountSet.id
                ? { ...candidate, users: [], updatedAt: now.toISOString(), revokedAt: now.toISOString() }
                : candidate
            )
          : accountSets,
        sessions,
      },
      result: {
        accountSetId: accountSet?.id,
        accountSetRevoked: Boolean(accountSet),
        activeSessionRevoked,
      },
    };
  }, config);

  if (result.accountSetRevoked || result.activeSessionRevoked) {
    await appendAuthAuditEvent({
      type: 'auth.account_set.cleared',
      actorUserId: input.actorUserId,
      target: result.accountSetId
        ? {
            type: 'auth.account_set',
            id: result.accountSetId,
          }
        : undefined,
      success: true,
      request,
      details: {
        activeSessionRevoked: result.activeSessionRevoked,
      },
    }, config);
  }

  return result;
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

export function isDevelopmentRuntime() {
  const hostRuntimeMode = process.env.HOST_RUNTIME_MODE?.trim().toLowerCase();
  if (hostRuntimeMode) {
    return hostRuntimeMode === 'development';
  }

  return process.env.NODE_ENV === 'development';
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

function normalizeToken(token: string | null | undefined) {
  const normalized = token?.trim();
  return normalized || null;
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

function createAccountSetRecord(
  tokenHash: string,
  now: Date,
  request?: AuthRequestMeta
): AuthAccountSetRecord {
  return {
    id: `acct_${randomUUID()}`,
    tokenHash,
    users: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ACCOUNT_SET_ABSOLUTE_TIMEOUT_MS).toISOString(),
    request,
  };
}

function upsertAccountSetUser(
  users: AuthAccountSetRecord['users'],
  userId: string,
  now: Date
): AuthAccountSetRecord['users'] {
  const existingUser = users.find(candidate => candidate.userId === userId);
  if (!existingUser) {
    return [
      ...users,
      {
        userId,
        addedAt: now.toISOString(),
        lastUsedAt: now.toISOString(),
      },
    ];
  }

  return users.map(candidate =>
    candidate.userId === userId
      ? { ...candidate, lastUsedAt: now.toISOString() }
      : candidate
  );
}

function pruneExpiredAccountSets(accountSets: AuthAccountSetRecord[], now: Date) {
  return accountSets.filter(accountSet => isAccountSetActive(accountSet, now));
}

function findActiveAccountSetByTokenHash(
  accountSets: AuthAccountSetRecord[],
  tokenHash: string,
  now: Date
) {
  return accountSets.find(candidate =>
    candidate.tokenHash === tokenHash &&
    isAccountSetActive(candidate, now)
  ) ?? null;
}

function isAccountSetActive(accountSet: AuthAccountSetRecord, now: Date) {
  return !accountSet.revokedAt && !isExpired(accountSet.expiresAt, now);
}

function summarizeBrowserAccount(
  accountUser: AuthAccountSetRecord['users'][number],
  user: AuthUserRecord | undefined,
  activeUser: HostPrincipal | null
): BrowserAccountSummary | null {
  if (!user || user.disabled) {
    return null;
  }

  return {
    ...toPrincipal(user),
    authProvider: user.authProvider,
    addedAt: accountUser.addedAt,
    lastUsedAt: accountUser.lastUsedAt,
    active: user.id === activeUser?.id,
  };
}

function sortBrowserAccounts(left: BrowserAccountSummary, right: BrowserAccountSummary) {
  if (left.active !== right.active) {
    return left.active ? -1 : 1;
  }

  return Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt);
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
