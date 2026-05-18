import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getHostRuntimeConfig, pathExists } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type { HostRole } from '../types/auth.ts';
import type { ModuleAccessAssignment } from '../types/auth.ts';

export const AUTH_STORE_SCHEMA_VERSION = '0.1';

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
}

export interface AuthSetupTokenRecord {
  id: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  purpose: 'first-admin' | 'recovery';
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
  success?: boolean;
  request?: {
    origin?: string;
    userAgent?: string;
  };
  details?: Record<string, unknown>;
}

let authStoreMutex: Promise<void> = Promise.resolve();

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
  await fs.writeFile(temporaryPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf-8');
  await fs.rename(temporaryPath, config.authStatePath);
}

export async function updateAuthState<T>(
  operation: (state: AuthState) => Promise<{ state: AuthState; result: T }> | { state: AuthState; result: T },
  config = getHostRuntimeConfig()
): Promise<T> {
  return withAuthStoreLock(async () => {
    const current = await readAuthState(config);
    const { state, result } = await operation(current);
    await writeAuthState(state, config);
    return result;
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
  await fs.appendFile(config.authAuditPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

export function createEmptyAuthState(): AuthState {
  return {
    schemaVersion: AUTH_STORE_SCHEMA_VERSION,
    users: [],
    sessions: [],
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

function normalizeAuthState(parsed: unknown): AuthState {
  if (!isObject(parsed)) {
    throw new Error('auth state must contain a JSON object.');
  }

  return {
    schemaVersion: AUTH_STORE_SCHEMA_VERSION,
    users: Array.isArray(parsed.users) ? parsed.users.filter(isAuthUserRecord) : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter(isAuthSessionRecord) : [],
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
    typeof value.absoluteExpiresAt === 'string';
}

function isAuthSetupTokenRecord(value: unknown): value is AuthSetupTokenRecord {
  return isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.tokenHash === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.expiresAt === 'string' &&
    (value.purpose === 'first-admin' || value.purpose === 'recovery');
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
