import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getHostRuntimeConfig, pathExists } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type { HostRole } from '../types/auth.ts';

export const AUTH_STORE_SCHEMA_VERSION = '0.1';

export interface AuthUserRecord {
  id: string;
  email: string;
  displayName?: string;
  role: HostRole;
  passwordHash: string;
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

export interface AuthState {
  schemaVersion: string;
  users: AuthUserRecord[];
  sessions: AuthSessionRecord[];
  setupTokens: AuthSetupTokenRecord[];
  cliTokens: AuthCliTokenRecord[];
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
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

function isAuthUserRecord(value: unknown): value is AuthUserRecord {
  return isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.email === 'string' &&
    typeof value.passwordHash === 'string' &&
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
