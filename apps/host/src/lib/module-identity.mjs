import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  importJWK,
} from 'jose';

export const MODULE_IDENTITY_SCHEMA_VERSION = '0.1';
export const MODULE_IDENTITY_ISSUER = 'docker-host';
export const MODULE_IDENTITY_ALGORITHM = 'ES256';
export const MODULE_IDENTITY_TOKEN_HEADER = 'X-Docker-Host-Identity';
export const MODULE_IDENTITY_TOKEN_TTL_SECONDS = 5 * 60;

const KEY_STORE_FILE = 'module-identity-keys.json';

let keyStoreMutex = Promise.resolve();

export async function getModuleIdentityJwks(config) {
  const state = await ensureModuleIdentityKeyStore(config);
  return {
    keys: state.keys.map(key => sanitizePublicJwk(key.publicJwk, key)),
  };
}

export function getModuleIdentityDiscovery(config, requestOrigin) {
  const origin = normalizeOrigin(config.hostInternalOrigin || requestOrigin || 'http://docker-host:3000');
  return {
    issuer: MODULE_IDENTITY_ISSUER,
    jwks_uri: `${origin}/.well-known/docker-host/jwks.json`,
    token_header: MODULE_IDENTITY_TOKEN_HEADER,
    algorithms: [MODULE_IDENTITY_ALGORITHM],
    token_ttl_seconds: MODULE_IDENTITY_TOKEN_TTL_SECONDS,
    audience: 'module id',
  };
}

export async function createModuleIdentityToken(input, config, now = new Date()) {
  if (!shouldIssueModuleIdentity(input)) {
    return null;
  }

  const state = await ensureModuleIdentityKeyStore(config);
  const activeKey = state.keys.find(key => key.kid === state.activeKeyId && key.active) ?? state.keys.find(key => key.active);
  if (!activeKey) {
    throw new Error('Module identity signing key store does not contain an active key.');
  }

  const privateKey = await importJWK(activeKey.privateJwk, activeKey.alg);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const expiresAt = nowSeconds + MODULE_IDENTITY_TOKEN_TTL_SECONDS;
  const exposure = input.exposure;
  const principal = input.principal;
  const payload = {
    hostRole: principal.role,
    moduleAccess: getModuleAccessClaim(input),
    moduleExposurePolicy: exposure.exposurePolicy,
    ...(principal.email ? { email: principal.email } : {}),
    ...(principal.displayName ? { name: principal.displayName } : {}),
    ...(exposure.id ? { gatewayExposureId: exposure.id } : {}),
    ...(exposure.hostname ? { hostname: exposure.hostname } : {}),
    ...(exposure.portKey ? { portKey: exposure.portKey } : {}),
  };

  return await new SignJWT(payload)
    .setProtectedHeader({
      alg: activeKey.alg,
      kid: activeKey.kid,
      typ: 'JWT',
    })
    .setIssuer(MODULE_IDENTITY_ISSUER)
    .setSubject(principal.id)
    .setAudience(exposure.moduleId)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expiresAt)
    .setJti(`mit_${randomUUID()}`)
    .sign(privateKey);
}

export function shouldIssueModuleIdentity(input) {
  if (!input?.principal || !input.access?.allowed || !input.exposure) {
    return false;
  }

  const identityMode = getExposureIdentityMode(input.exposure);
  return identityMode === 'required' || identityMode === 'optional';
}

export function getExposureIdentityMode(exposure) {
  return isModuleIdentityMode(exposure.identityMode)
    ? exposure.identityMode
    : getDefaultModuleIdentityMode(exposure.exposurePolicy);
}

export function getDefaultModuleIdentityMode(exposurePolicy) {
  return exposurePolicy === 'public' ? 'none' : 'required';
}

export function isModuleIdentityMode(value) {
  return value === 'none' || value === 'optional' || value === 'required';
}

export function getModuleAccessClaim(input) {
  if (input.exposure?.exposurePolicy === 'public') {
    return 'publicAuthenticated';
  }

  if (input.access?.reason === 'hostAdmin') {
    return 'hostAdmin';
  }

  if (input.access?.reason === 'assigned') {
    return 'assigned';
  }

  return 'authenticated';
}

export async function readModuleIdentityKeyStoreSnapshot(config) {
  const keyStorePath = getModuleIdentityKeyStorePath(config);
  try {
    return normalizeModuleIdentityKeyStore(JSON.parse(await fs.readFile(keyStorePath, 'utf-8')));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return createEmptyModuleIdentityKeyStore();
    }

    throw error;
  }
}

export async function ensureModuleIdentityKeyStore(config) {
  return await updateModuleIdentityKeyStore(async state => {
    if (state.keys.some(key => key.active)) {
      return state;
    }

    const key = await createModuleIdentityKeyRecord();
    return {
      ...state,
      activeKeyId: key.kid,
      keys: [key],
    };
  }, config);
}

export async function updateModuleIdentityKeyStore(operation, config) {
  const previous = keyStoreMutex;
  let release = () => undefined;
  keyStoreMutex = new Promise(resolve => {
    release = resolve;
  });

  await previous;

  try {
    const current = await readModuleIdentityKeyStoreSnapshot(config);
    const next = normalizeModuleIdentityKeyStore(await operation(current));
    await writeModuleIdentityKeyStore(next, config);
    return next;
  } finally {
    release();
  }
}

export function createEmptyModuleIdentityKeyStore() {
  return {
    schemaVersion: MODULE_IDENTITY_SCHEMA_VERSION,
    activeKeyId: null,
    keys: [],
    updatedAt: new Date().toISOString(),
  };
}

async function createModuleIdentityKeyRecord() {
  const keyId = `mik_${randomUUID()}`;
  const now = new Date().toISOString();
  const { publicKey, privateKey } = await generateKeyPair(MODULE_IDENTITY_ALGORITHM, {
    extractable: true,
  });
  const [publicJwk, privateJwk] = await Promise.all([
    exportJWK(publicKey),
    exportJWK(privateKey),
  ]);

  return {
    kid: keyId,
    alg: MODULE_IDENTITY_ALGORITHM,
    active: true,
    createdAt: now,
    publicJwk: decorateJwk(publicJwk, keyId),
    privateJwk: decorateJwk(privateJwk, keyId),
  };
}

async function writeModuleIdentityKeyStore(state, config) {
  const keyStorePath = getModuleIdentityKeyStorePath(config);
  await fs.mkdir(path.dirname(keyStorePath), { recursive: true });
  const nextState = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  const temporaryPath = `${keyStorePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(nextState, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  await fs.rename(temporaryPath, keyStorePath);
  await fs.chmod(keyStorePath, 0o600);
}

function normalizeModuleIdentityKeyStore(parsed) {
  if (!isObject(parsed)) {
    return createEmptyModuleIdentityKeyStore();
  }

  const keys = Array.isArray(parsed.keys)
    ? parsed.keys.filter(isModuleIdentityKeyRecord)
    : [];
  const activeKeyId = typeof parsed.activeKeyId === 'string' && keys.some(key => key.kid === parsed.activeKeyId)
    ? parsed.activeKeyId
    : keys.find(key => key.active)?.kid ?? null;

  return {
    schemaVersion: MODULE_IDENTITY_SCHEMA_VERSION,
    activeKeyId,
    keys,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

function isModuleIdentityKeyRecord(value) {
  return isObject(value) &&
    typeof value.kid === 'string' &&
    value.alg === MODULE_IDENTITY_ALGORITHM &&
    typeof value.active === 'boolean' &&
    typeof value.createdAt === 'string' &&
    isObject(value.publicJwk) &&
    isObject(value.privateJwk);
}

function sanitizePublicJwk(publicJwk, key) {
  const jwk = decorateJwk(publicJwk, key.kid);
  delete jwk.d;
  return jwk;
}

function decorateJwk(jwk, kid) {
  return {
    ...jwk,
    kid,
    alg: MODULE_IDENTITY_ALGORITHM,
    use: 'sig',
  };
}

function getModuleIdentityKeyStorePath(config) {
  if (!config?.authRootContainer) {
    throw new Error('Module identity key store requires authRootContainer runtime configuration.');
  }

  return path.join(config.authRootContainer, KEY_STORE_FILE);
}

function normalizeOrigin(value) {
  return String(value || '').replace(/\/+$/, '');
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
