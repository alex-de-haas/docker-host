import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { getHostRuntimeConfig, pathExists } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type { HostRole } from '../types/auth.ts';
import type { ModuleAccessAssignment } from '../types/auth.ts';

export const AUTH_STORE_SCHEMA_VERSION = '0.2';

export interface AuthUserRecord {
  id: string;
  email?: string;
  displayName?: string;
  role: HostRole;
  authProvider?: 'local' | 'oidc' | 'trusted-proxy';
  passwordHash?: string;
  createdAt: string;
  updatedAt: string;
  disabled?: boolean;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  revokedAt?: string;
  reauthenticatedAt?: string;
  request?: {
    origin?: string;
    userAgent?: string;
  };
}

export interface AuthAccountSetUserRecord {
  userId: string;
  addedAt: string;
  lastUsedAt: string;
}

export interface AuthAccountSetRecord {
  id: string;
  tokenHash: string;
  users: AuthAccountSetUserRecord[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  revokedAt?: string;
  request?: {
    origin?: string;
    userAgent?: string;
  };
}

export interface AuthSetupTokenRecord {
  id: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  revokedAt?: string;
  purpose: 'first-admin' | 'recovery' | 'invite';
  role?: HostRole;
  email?: string;
  displayName?: string;
  assignedModuleIds?: string[];
  createdByUserId?: string;
}

export interface AuthCliTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  scope: 'host.admin.cli';
}

export interface AuthModuleServiceTokenRecord {
  id: string;
  moduleId: string;
  tokenHash: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  scope: 'module.directory';
}

export interface AuthModuleDirectoryPolicyRecord {
  moduleId: string;
  includeEmail: boolean;
  updatedAt: string;
}

export interface AuthExternalIdentityRecord {
  id: string;
  userId: string;
  providerId: string;
  issuer: string;
  subject: string;
  email?: string;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

export interface AuthOidcRoleMappingRecord {
  claim: string;
  values: string[];
  role: HostRole;
}

export interface AuthOidcProviderRecord {
  id: string;
  type: 'oidc';
  enabled: boolean;
  label: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  callbackUrl?: string;
  scopes: string[];
  roleMappings: AuthOidcRoleMappingRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface AuthOidcTransactionRecord {
  id: string;
  providerId: string;
  stateHash: string;
  nonceHash: string;
  codeVerifier: string;
  redirectUri: string;
  redirectTo?: string;
  createdAt: string;
  expiresAt: string;
}

export interface AuthTrustedProxyRoleMappingRecord {
  claim: string;
  values: string[];
  role: HostRole;
}

export interface AuthTrustedProxyProviderRecord {
  id: string;
  type: 'trusted-proxy';
  enabled: boolean;
  label: string;
  issuer: string;
  audience: string | string[];
  assertionHeader: string;
  jwks?: {
    keys: JsonWebKey[];
  };
  jwksUri?: string;
  subjectClaim?: string;
  emailClaim?: string;
  displayNameClaim?: string;
  roleMappings: AuthTrustedProxyRoleMappingRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface AuthState {
  schemaVersion: string;
  users: AuthUserRecord[];
  sessions: AuthSessionRecord[];
  accountSets: AuthAccountSetRecord[];
  setupTokens: AuthSetupTokenRecord[];
  cliTokens: AuthCliTokenRecord[];
  moduleServiceTokens: AuthModuleServiceTokenRecord[];
  moduleDirectoryPolicies: AuthModuleDirectoryPolicyRecord[];
  externalIdentities: AuthExternalIdentityRecord[];
  oidcProviders: AuthOidcProviderRecord[];
  oidcTransactions: AuthOidcTransactionRecord[];
  trustedProxyProviders: AuthTrustedProxyProviderRecord[];
  moduleAssignments: ModuleAccessAssignment[];
  updatedAt: string;
}

export interface AuthAuditEvent {
  id: string;
  type: string;
  createdAt: string;
  actorUserId?: string;
  target?: {
    type: string;
    id: string;
  };
  success?: boolean;
  request?: {
    origin?: string;
    userAgent?: string;
  };
  details?: Record<string, unknown>;
}

let authStoreMutex: Promise<void> = Promise.resolve();
const AUTH_STATE_LOCK_STALE_MS = 2 * 60 * 1000;
const AUTH_STATE_LOCK_TIMEOUT_MS = 30 * 1000;
const AUTH_STATE_LOCK_RETRY_MS = 50;
const PRIVATE_AUTH_STATE_FILE_MODE = 0o600;

export async function readAuthState(config = getHostRuntimeConfig()): Promise<AuthState> {
  await ensureAuthState(config);

  const raw = await fs.readFile(config.authStatePath, 'utf-8');
  return normalizeAuthState(JSON.parse(raw) as unknown);
}

export async function readAuthStateSnapshot(
  config = getHostRuntimeConfig()
): Promise<AuthState> {
  if (!(await pathExists(config.authStatePath))) {
    return createEmptyAuthState();
  }

  const raw = await fs.readFile(config.authStatePath, 'utf-8');
  return normalizeAuthState(JSON.parse(raw) as unknown);
}

export async function writeAuthState(
  state: AuthState,
  config = getHostRuntimeConfig()
) {
  await fs.mkdir(config.authRootContainer, { recursive: true });
  const nextState = normalizeAuthState({
    ...state,
    updatedAt: new Date().toISOString(),
  });
  const temporaryPath = `${config.authStatePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(nextState, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: PRIVATE_AUTH_STATE_FILE_MODE,
  });
  await fs.rename(temporaryPath, config.authStatePath);
  await fs.chmod(config.authStatePath, PRIVATE_AUTH_STATE_FILE_MODE);
}

export async function updateAuthState<T>(
  operation: (state: AuthState) => Promise<{ state: AuthState; result: T }> | { state: AuthState; result: T },
  config = getHostRuntimeConfig()
): Promise<T> {
  return withAuthStoreLock(async () => {
    return await withAuthStateFileLock(config, async () => {
      await ensureAuthStateUnlocked(config);
      const raw = await fs.readFile(config.authStatePath, 'utf-8');
      const current = normalizeAuthState(JSON.parse(raw) as unknown);
      const { state, result } = await operation(current);
      if (state !== current) {
        await writeAuthState(state, config);
      }
      return result;
    });
  });
}

export async function appendAuthAuditEvent(
  event: Omit<AuthAuditEvent, 'id' | 'createdAt'>,
  config = getHostRuntimeConfig()
) {
  await fs.mkdir(path.dirname(config.authAuditPath), { recursive: true });
  const entry: AuthAuditEvent = {
    id: `evt_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...event,
  };
  await fs.appendFile(config.authAuditPath, `${JSON.stringify(sanitizeAuthAuditEvent(entry))}\n`, 'utf-8');
}

export function createEmptyAuthState(): AuthState {
  return {
    schemaVersion: AUTH_STORE_SCHEMA_VERSION,
    users: [],
    sessions: [],
    accountSets: [],
    setupTokens: [],
    cliTokens: [],
    moduleServiceTokens: [],
    moduleDirectoryPolicies: [],
    externalIdentities: [],
    oidcProviders: [],
    oidcTransactions: [],
    trustedProxyProviders: [],
    moduleAssignments: [],
    updatedAt: new Date().toISOString(),
  };
}

async function ensureAuthState(config: HostRuntimeConfig) {
  await fs.mkdir(config.authRootContainer, { recursive: true });

  if (!(await pathExists(config.authStatePath))) {
    await withAuthStateFileLock(config, async () => {
      await ensureAuthStateUnlocked(config);
    });
  }
}

async function ensureAuthStateUnlocked(config: HostRuntimeConfig) {
  await fs.mkdir(config.authRootContainer, { recursive: true });

  if (!(await pathExists(config.authStatePath))) {
    await writeAuthState(createEmptyAuthState(), config);
  }
}

async function withAuthStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = authStoreMutex;
  let release: () => void = () => undefined;
  authStoreMutex = new Promise<void>(resolve => {
    release = resolve;
  });

  await previous;

  try {
    return await operation();
  } finally {
    release();
  }
}

async function withAuthStateFileLock<T>(
  config: HostRuntimeConfig,
  operation: () => Promise<T>
): Promise<T> {
  await fs.mkdir(config.authRootContainer, { recursive: true });
  const lockPath = `${config.authStatePath}.lock`;
  const start = Date.now();
  let lock: FileHandle | null = null;

  while (!lock) {
    try {
      lock = await fs.open(lockPath, 'wx');
      await lock.writeFile(`${process.pid}\n`, 'utf-8');
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw error;
      }

      await removeStaleAuthStateLock(lockPath);
      if (Date.now() - start >= AUTH_STATE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for auth state lock at ${lockPath}.`);
      }
      await delay(AUTH_STATE_LOCK_RETRY_MS);
    }
  }

  try {
    return await operation();
  } finally {
    await lock.close();
    await fs.unlink(lockPath).catch(error => {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
    });
  }
}

async function removeStaleAuthStateLock(lockPath: string) {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs >= AUTH_STATE_LOCK_STALE_MS) {
      await fs.unlink(lockPath);
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function normalizeAuthState(parsed: unknown): AuthState {
  if (!isObject(parsed)) {
    throw new Error('auth state must contain a JSON object.');
  }

  return {
    schemaVersion: AUTH_STORE_SCHEMA_VERSION,
    users: Array.isArray(parsed.users) ? parsed.users.filter(isAuthUserRecord) : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter(isAuthSessionRecord) : [],
    accountSets: Array.isArray(parsed.accountSets)
      ? parsed.accountSets.filter(isAuthAccountSetRecord)
      : [],
    setupTokens: Array.isArray(parsed.setupTokens)
      ? parsed.setupTokens.filter(isAuthSetupTokenRecord)
      : [],
    cliTokens: Array.isArray(parsed.cliTokens) ? parsed.cliTokens.filter(isAuthCliTokenRecord) : [],
    moduleServiceTokens: Array.isArray(parsed.moduleServiceTokens)
      ? parsed.moduleServiceTokens.filter(isAuthModuleServiceTokenRecord)
      : [],
    moduleDirectoryPolicies: Array.isArray(parsed.moduleDirectoryPolicies)
      ? parsed.moduleDirectoryPolicies.filter(isAuthModuleDirectoryPolicyRecord)
      : [],
    externalIdentities: Array.isArray(parsed.externalIdentities)
      ? parsed.externalIdentities.filter(isAuthExternalIdentityRecord)
      : [],
    oidcProviders: Array.isArray(parsed.oidcProviders)
      ? parsed.oidcProviders.filter(isAuthOidcProviderRecord)
      : [],
    oidcTransactions: Array.isArray(parsed.oidcTransactions)
      ? parsed.oidcTransactions.filter(isAuthOidcTransactionRecord)
      : [],
    trustedProxyProviders: Array.isArray(parsed.trustedProxyProviders)
      ? parsed.trustedProxyProviders.filter(isAuthTrustedProxyProviderRecord)
      : [],
    moduleAssignments: Array.isArray(parsed.moduleAssignments)
      ? parsed.moduleAssignments.filter(isModuleAccessAssignment)
      : [],
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

function isAuthUserRecord(value: unknown): value is AuthUserRecord {
  return isObject(value) &&
    typeof value.id === 'string' &&
    (typeof value.email === 'string' || value.email === undefined) &&
    (typeof value.passwordHash === 'string' || value.passwordHash === undefined) &&
    (
      value.authProvider === 'local' ||
      value.authProvider === 'oidc' ||
      value.authProvider === 'trusted-proxy' ||
      value.authProvider === undefined
    ) &&
    (value.role === 'host.admin' || value.role === 'host.user') &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string';
}

function isAuthSessionRecord(value: unknown): value is AuthSessionRecord {
  return isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.userId === 'string' &&
    typeof value.tokenHash === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.lastSeenAt === 'string' &&
    typeof value.idleExpiresAt === 'string' &&
    typeof value.absoluteExpiresAt === 'string' &&
    (value.reauthenticatedAt === undefined || typeof value.reauthenticatedAt === 'string') &&
    (value.request === undefined || isAuthRequestMeta(value.request));
}

function isAuthAccountSetUserRecord(value: unknown): value is AuthAccountSetUserRecord {
  return isObject(value) &&
    typeof value.userId === 'string' &&
    typeof value.addedAt === 'string' &&
    typeof value.lastUsedAt === 'string';
}

function isAuthAccountSetRecord(value: unknown): value is AuthAccountSetRecord {
  return isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.tokenHash === 'string' &&
    Array.isArray(value.users) &&
    value.users.every(isAuthAccountSetUserRecord) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.expiresAt === 'string' &&
    (value.revokedAt === undefined || typeof value.revokedAt === 'string') &&
    (value.request === undefined || isAuthRequestMeta(value.request));
}

function isAuthSetupTokenRecord(value: unknown): value is AuthSetupTokenRecord {
  return isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.tokenHash === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.expiresAt === 'string' &&
    (value.usedAt === undefined || typeof value.usedAt === 'string') &&
    (value.revokedAt === undefined || typeof value.revokedAt === 'string') &&
    (
      value.purpose === 'first-admin' ||
      value.purpose === 'recovery' ||
      (
        value.purpose === 'invite' &&
        (value.role === 'host.admin' || value.role === 'host.user') &&
        typeof value.email === 'string' &&
        (typeof value.displayName === 'string' || value.displayName === undefined) &&
        (
          value.assignedModuleIds === undefined ||
          (Array.isArray(value.assignedModuleIds) && value.assignedModuleIds.every(item => typeof item === 'string'))
        ) &&
        (typeof value.createdByUserId === 'string' || value.createdByUserId === undefined)
      )
    );
}

function isAuthCliTokenRecord(value: unknown): value is AuthCliTokenRecord {
  return isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.userId === 'string' &&
    typeof value.tokenHash === 'string' &&
    typeof value.label === 'string' &&
    typeof value.createdAt === 'string' &&
    value.scope === 'host.admin.cli';
}

function isAuthModuleServiceTokenRecord(value: unknown): value is AuthModuleServiceTokenRecord {
  return isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.moduleId === 'string' &&
    typeof value.tokenHash === 'string' &&
    typeof value.label === 'string' &&
    typeof value.createdAt === 'string' &&
    value.scope === 'module.directory';
}

function isAuthModuleDirectoryPolicyRecord(value: unknown): value is AuthModuleDirectoryPolicyRecord {
  return isObject(value) &&
    typeof value.moduleId === 'string' &&
    typeof value.includeEmail === 'boolean' &&
    typeof value.updatedAt === 'string';
}

function isAuthExternalIdentityRecord(value: unknown): value is AuthExternalIdentityRecord {
  return isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.userId === 'string' &&
    typeof value.providerId === 'string' &&
    typeof value.issuer === 'string' &&
    typeof value.subject === 'string' &&
    (typeof value.email === 'string' || value.email === undefined) &&
    (typeof value.displayName === 'string' || value.displayName === undefined) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string';
}

function isAuthOidcProviderRecord(value: unknown): value is AuthOidcProviderRecord {
  return isObject(value) &&
    typeof value.id === 'string' &&
    value.type === 'oidc' &&
    typeof value.enabled === 'boolean' &&
    typeof value.label === 'string' &&
    typeof value.issuer === 'string' &&
    typeof value.clientId === 'string' &&
    (typeof value.clientSecret === 'string' || value.clientSecret === undefined) &&
    (typeof value.callbackUrl === 'string' || value.callbackUrl === undefined) &&
    Array.isArray(value.scopes) &&
    value.scopes.every(scope => typeof scope === 'string') &&
    Array.isArray(value.roleMappings) &&
    value.roleMappings.every(isAuthOidcRoleMappingRecord) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string';
}

function isAuthOidcRoleMappingRecord(value: unknown): value is AuthOidcRoleMappingRecord {
  return isObject(value) &&
    typeof value.claim === 'string' &&
    Array.isArray(value.values) &&
    value.values.every(item => typeof item === 'string') &&
    (value.role === 'host.admin' || value.role === 'host.user');
}

function isAuthOidcTransactionRecord(value: unknown): value is AuthOidcTransactionRecord {
  return isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.providerId === 'string' &&
    typeof value.stateHash === 'string' &&
    typeof value.nonceHash === 'string' &&
    typeof value.codeVerifier === 'string' &&
    typeof value.redirectUri === 'string' &&
    (typeof value.redirectTo === 'string' || value.redirectTo === undefined) &&
    typeof value.createdAt === 'string' &&
    typeof value.expiresAt === 'string';
}

function isAuthTrustedProxyProviderRecord(value: unknown): value is AuthTrustedProxyProviderRecord {
  return isObject(value) &&
    typeof value.id === 'string' &&
    value.type === 'trusted-proxy' &&
    typeof value.enabled === 'boolean' &&
    typeof value.label === 'string' &&
    typeof value.issuer === 'string' &&
    (typeof value.audience === 'string' ||
      (Array.isArray(value.audience) && value.audience.every(item => typeof item === 'string'))) &&
    typeof value.assertionHeader === 'string' &&
    (value.jwks === undefined || isJsonWebKeySet(value.jwks)) &&
    (typeof value.jwksUri === 'string' || value.jwksUri === undefined) &&
    (typeof value.subjectClaim === 'string' || value.subjectClaim === undefined) &&
    (typeof value.emailClaim === 'string' || value.emailClaim === undefined) &&
    (typeof value.displayNameClaim === 'string' || value.displayNameClaim === undefined) &&
    Array.isArray(value.roleMappings) &&
    value.roleMappings.every(isAuthTrustedProxyRoleMappingRecord) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string';
}

function isAuthTrustedProxyRoleMappingRecord(value: unknown): value is AuthTrustedProxyRoleMappingRecord {
  return isObject(value) &&
    typeof value.claim === 'string' &&
    Array.isArray(value.values) &&
    value.values.every(item => typeof item === 'string') &&
    (value.role === 'host.admin' || value.role === 'host.user');
}

function isJsonWebKeySet(value: unknown): value is { keys: JsonWebKey[] } {
  return isObject(value) && Array.isArray(value.keys) && value.keys.every(isObject);
}

function isModuleAccessAssignment(value: unknown): value is ModuleAccessAssignment {
  return isObject(value) &&
    typeof value.moduleId === 'string' &&
    typeof value.userId === 'string';
}

function isAuthRequestMeta(value: unknown): value is { origin?: string; userAgent?: string } {
  return isObject(value) &&
    (value.origin === undefined || typeof value.origin === 'string') &&
    (value.userAgent === undefined || typeof value.userAgent === 'string');
}

function sanitizeAuthAuditEvent(event: AuthAuditEvent): AuthAuditEvent {
  return {
    ...event,
    request: event.request
      ? {
          origin: truncateAuditString(event.request.origin),
          userAgent: truncateAuditString(event.request.userAgent),
        }
      : undefined,
    details: event.details
      ? sanitizeAuditDetails(event.details) as Record<string, unknown>
      : undefined,
  };
}

function sanitizeAuditDetails(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return '[truncated]';
  }

  if (typeof value === 'string') {
    return truncateAuditString(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeAuditDetails(item, depth + 1));
  }

  if (!isObject(value)) {
    return value;
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    isSensitiveAuditDetailKey(key) ? '[redacted]' : sanitizeAuditDetails(item, depth + 1),
  ]));
}

function isSensitiveAuditDetailKey(key: string) {
  return new Set([
    'access_token',
    'accesstoken',
    'assertion',
    'authorization',
    'client_secret',
    'clientsecret',
    'code_verifier',
    'codeverifier',
    'cookie',
    'id_token',
    'idtoken',
    'password',
    'raw_token',
    'rawtoken',
    'recovery_token',
    'recoverytoken',
    'refresh_token',
    'refreshtoken',
    'secret',
    'session_token',
    'sessiontoken',
    'setup_token',
    'setuptoken',
    'token',
  ]).has(key.toLowerCase());
}

function truncateAuditString(value: string | undefined) {
  if (value === undefined || value.length <= 2048) {
    return value;
  }

  return `${value.slice(0, 2048)}...[truncated]`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
