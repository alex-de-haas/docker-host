import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
} from 'jose';

const DEFAULT_DATA_ROOT = path.join(os.homedir(), '.docker-host');
const TRUSTED_PROXY_TYPE = 'trusted-proxy';
const CLOUDFLARE_ACCESS_ASSERTION_HEADER = 'cf-access-jwt-assertion';
const GENERIC_ASSERTION_HEADER = 'x-docker-host-trusted-proxy-jwt';
const DEFAULT_SUBJECT_CLAIM = 'sub';
const DEFAULT_EMAIL_CLAIM = 'email';
const DEFAULT_DISPLAY_NAME_CLAIM = 'name';

const remoteJwkSets = new Map();
let trustedProxyStoreMutex = Promise.resolve();

export const TRUSTED_PROXY_DEFAULT_ASSERTION_HEADERS = Object.freeze([
  CLOUDFLARE_ACCESS_ASSERTION_HEADER,
  GENERIC_ASSERTION_HEADER,
]);

export class TrustedProxyServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TrustedProxyServiceError';
    this.code = code;
  }
}

export async function getTrustedProxyModeStatus(config = getRuntimeConfig()) {
  const providers = await getConfiguredTrustedProxyProviders(config);
  return {
    enabled: providers.length > 0,
    assertionHeaders: getTrustedProxyAssertionHeaderNamesFromProviders(providers),
  };
}

export async function getTrustedProxyAssertionHeaderNames(config = getRuntimeConfig()) {
  const providers = await getConfiguredTrustedProxyProviders(config);
  return getTrustedProxyAssertionHeaderNamesFromProviders(providers);
}

export async function authenticateTrustedProxyRequest(request, config = getRuntimeConfig()) {
  const providers = await getConfiguredTrustedProxyProviders(config);
  const assertionHeaders = getTrustedProxyAssertionHeaderNamesFromProviders(providers);
  if (providers.length === 0) {
    return {
      modeActive: false,
      principal: null,
      source: 'trusted-proxy',
      assertionHeaders,
    };
  }

  if (providers.length > 1) {
    await appendAuthAuditEvent({
      type: 'auth.trusted_proxy.rejected',
      success: false,
      request: getRequestMeta(request),
      details: {
        reason: 'multiple_active_providers',
      },
    }, config);

    return {
      modeActive: true,
      principal: null,
      source: 'trusted-proxy',
      reason: 'multiple_active_providers',
      assertionHeaders,
    };
  }

  const provider = providers[0];
  const assertion = readHeader(request, provider.assertionHeader);
  if (!assertion) {
    return {
      modeActive: true,
      principal: null,
      source: 'trusted-proxy',
      reason: 'missing_assertion',
      provider: summarizeProvider(provider),
      assertionHeaders,
    };
  }

  try {
    const payload = await verifyTrustedProxyAssertion(provider, assertion);
    const subject = readStringClaim(readClaimPath(payload, provider.subjectClaim || DEFAULT_SUBJECT_CLAIM));
    if (!subject) {
      throw new TrustedProxyServiceError(
        'trusted_proxy_missing_subject',
        'Trusted proxy assertion did not contain a subject.'
      );
    }

    const role = mapTrustedProxyRole(provider.roleMappings, payload);
    if (!role) {
      await appendAuthAuditEvent({
        type: 'auth.trusted_proxy.role_mapping.denied',
        success: false,
        request: getRequestMeta(request),
        details: {
          providerId: provider.id,
          issuer: provider.issuer,
          subject,
        },
      }, config);

      return {
        modeActive: true,
        principal: null,
        source: 'trusted-proxy',
        reason: 'role_mapping_denied',
        provider: summarizeProvider(provider),
        assertionHeaders,
      };
    }

    const userResult = await upsertTrustedProxyUser({
      provider,
      claims: payload,
      subject,
      role,
    }, config);

    return {
      modeActive: true,
      principal: toPrincipal(userResult.user),
      source: 'trusted-proxy',
      reason: 'authenticated',
      provider: summarizeProvider(provider),
      assertionHeaders,
      externalIdentity: userResult.externalIdentity,
      provisioned: userResult.provisioned,
    };
  } catch (error) {
    await appendAuthAuditEvent({
      type: 'auth.trusted_proxy.rejected',
      success: false,
      request: getRequestMeta(request),
      details: {
        providerId: provider.id,
        reason: error instanceof TrustedProxyServiceError ? error.code : 'invalid_assertion',
      },
    }, config);

    return {
      modeActive: true,
      principal: null,
      source: 'trusted-proxy',
      reason: error instanceof TrustedProxyServiceError ? error.code : 'invalid_assertion',
      provider: summarizeProvider(provider),
      assertionHeaders,
    };
  }
}

export function mapTrustedProxyRole(mappings, claims) {
  const matchedRoles = mappings
    .filter(mapping => claimValueMatches(readClaimPath(claims, mapping.claim), mapping.values))
    .map(mapping => mapping.role);

  if (matchedRoles.includes('host.admin')) {
    return 'host.admin';
  }

  return matchedRoles.includes('host.user') ? 'host.user' : null;
}

async function verifyTrustedProxyAssertion(provider, assertion) {
  const keySet = getProviderJwkSet(provider);
  try {
    const { payload } = await jwtVerify(assertion, keySet, {
      issuer: provider.issuer,
      audience: provider.audience,
    });
    return payload;
  } catch {
    throw new TrustedProxyServiceError(
      'trusted_proxy_invalid_assertion',
      'Trusted proxy assertion could not be verified.'
    );
  }
}

function getProviderJwkSet(provider) {
  if (provider.jwks) {
    return createLocalJWKSet(provider.jwks);
  }

  if (provider.jwksUri) {
    const jwksUri = provider.jwksUri;
    let cached = remoteJwkSets.get(jwksUri);
    if (!cached) {
      cached = createRemoteJWKSet(new URL(jwksUri));
      remoteJwkSets.set(jwksUri, cached);
    }
    return cached;
  }

  throw new TrustedProxyServiceError(
    'trusted_proxy_jwks_missing',
    'Trusted proxy provider must define jwks or jwksUri.'
  );
}

async function upsertTrustedProxyUser(input, config) {
  const now = new Date().toISOString();
  const email = normalizeOptionalEmail(readStringClaim(
    readClaimPath(input.claims, input.provider.emailClaim || DEFAULT_EMAIL_CLAIM)
  ));
  const displayName =
    readStringClaim(readClaimPath(input.claims, input.provider.displayNameClaim || DEFAULT_DISPLAY_NAME_CLAIM)) ||
    readStringClaim(readClaimPath(input.claims, 'preferred_username')) ||
    email ||
    input.subject;

  const result = await updateAuthState(current => {
    const existingIdentity = current.externalIdentities.find(candidate =>
      candidate.providerId === input.provider.id &&
      candidate.issuer === input.provider.issuer &&
      candidate.subject === input.subject
    ) ?? null;

    if (existingIdentity) {
      const existingUser = current.users.find(candidate => candidate.id === existingIdentity.userId);
      if (!existingUser || existingUser.disabled) {
        throw new TrustedProxyServiceError(
          'trusted_proxy_user_disabled',
          'The mapped Host user is disabled.'
        );
      }

      const updatedUser = {
        ...existingUser,
        email: email || existingUser.email,
        displayName: displayName || existingUser.displayName,
        role: input.role,
        authProvider: existingUser.authProvider || TRUSTED_PROXY_TYPE,
        updatedAt: now,
      };
      const updatedIdentity = {
        ...existingIdentity,
        email: email || existingIdentity.email,
        displayName: displayName || existingIdentity.displayName,
        updatedAt: now,
        lastLoginAt: now,
      };

      return {
        state: {
          ...current,
          users: current.users.map(candidate => candidate.id === updatedUser.id ? updatedUser : candidate),
          externalIdentities: current.externalIdentities.map(candidate =>
            candidate.id === updatedIdentity.id ? updatedIdentity : candidate
          ),
        },
        result: {
          user: updatedUser,
          externalIdentity: updatedIdentity,
          provisioned: false,
        },
      };
    }

    const user = {
      id: `user_${randomUUID()}`,
      email,
      displayName,
      role: input.role,
      authProvider: TRUSTED_PROXY_TYPE,
      createdAt: now,
      updatedAt: now,
    };
    const externalIdentity = {
      id: `ext_${randomUUID()}`,
      userId: user.id,
      providerId: input.provider.id,
      issuer: input.provider.issuer,
      subject: input.subject,
      email,
      displayName,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    };

    return {
      state: {
        ...current,
        users: [...current.users, user],
        externalIdentities: [...current.externalIdentities, externalIdentity],
      },
      result: {
        user,
        externalIdentity,
        provisioned: true,
      },
    };
  }, config);

  if (result.provisioned) {
    await appendAuthAuditEvent({
      type: 'auth.trusted_proxy.user.provisioned',
      actorUserId: result.user.id,
      success: true,
      details: {
        providerId: input.provider.id,
        externalIdentityId: result.externalIdentity.id,
        role: result.user.role,
      },
    }, config);
  }

  return result;
}

async function getConfiguredTrustedProxyProviders(config) {
  const state = await readAuthState(config);
  const envProvider = getEnvTrustedProxyProvider();
  return [
    ...(state.trustedProxyProviders || []).filter(provider => provider.enabled).map(normalizeTrustedProxyProvider).filter(Boolean),
    ...(envProvider ? [envProvider] : []),
  ];
}

function getEnvTrustedProxyProvider() {
  const enabled = process.env.HOST_TRUSTED_PROXY_ENABLED?.trim().toLowerCase();
  if (enabled === 'false') {
    return null;
  }

  const cloudflareTeamDomain = process.env.HOST_TRUSTED_PROXY_CLOUDFLARE_TEAM_DOMAIN?.trim();
  const audience = splitList(process.env.HOST_TRUSTED_PROXY_AUDIENCE);
  const issuer = normalizeIssuer(process.env.HOST_TRUSTED_PROXY_ISSUER);
  const now = new Date().toISOString();

  if (cloudflareTeamDomain && audience.length > 0) {
    const normalizedTeamDomain = cloudflareTeamDomain.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return normalizeTrustedProxyProvider({
      id: 'env-cloudflare-access',
      type: TRUSTED_PROXY_TYPE,
      enabled: true,
      label: process.env.HOST_TRUSTED_PROXY_LABEL?.trim() || 'Cloudflare Access',
      issuer: `https://${normalizedTeamDomain}`,
      audience: audience.length === 1 ? audience[0] : audience,
      assertionHeader: CLOUDFLARE_ACCESS_ASSERTION_HEADER,
      jwksUri: `https://${normalizedTeamDomain}/cdn-cgi/access/certs`,
      subjectClaim: process.env.HOST_TRUSTED_PROXY_SUBJECT_CLAIM?.trim() || DEFAULT_SUBJECT_CLAIM,
      emailClaim: process.env.HOST_TRUSTED_PROXY_EMAIL_CLAIM?.trim() || DEFAULT_EMAIL_CLAIM,
      displayNameClaim: process.env.HOST_TRUSTED_PROXY_DISPLAY_NAME_CLAIM?.trim() || DEFAULT_DISPLAY_NAME_CLAIM,
      roleMappings: getEnvRoleMappings(),
      createdAt: now,
      updatedAt: now,
    });
  }

  const jwks = parseJsonWebKeySet(process.env.HOST_TRUSTED_PROXY_JWKS);
  const jwksUri = process.env.HOST_TRUSTED_PROXY_JWKS_URI?.trim();
  if (!issuer || audience.length === 0 || (!jwks && !jwksUri)) {
    return null;
  }

  return normalizeTrustedProxyProvider({
    id: 'env',
    type: TRUSTED_PROXY_TYPE,
    enabled: true,
    label: process.env.HOST_TRUSTED_PROXY_LABEL?.trim() || 'Trusted proxy',
    issuer,
    audience: audience.length === 1 ? audience[0] : audience,
    assertionHeader: process.env.HOST_TRUSTED_PROXY_ASSERTION_HEADER?.trim() || GENERIC_ASSERTION_HEADER,
    jwks,
    jwksUri,
    subjectClaim: process.env.HOST_TRUSTED_PROXY_SUBJECT_CLAIM?.trim() || DEFAULT_SUBJECT_CLAIM,
    emailClaim: process.env.HOST_TRUSTED_PROXY_EMAIL_CLAIM?.trim() || DEFAULT_EMAIL_CLAIM,
    displayNameClaim: process.env.HOST_TRUSTED_PROXY_DISPLAY_NAME_CLAIM?.trim() || DEFAULT_DISPLAY_NAME_CLAIM,
    roleMappings: getEnvRoleMappings(),
    createdAt: now,
    updatedAt: now,
  });
}

function getEnvRoleMappings() {
  const groupClaim = process.env.HOST_TRUSTED_PROXY_GROUPS_CLAIM?.trim() || 'groups';
  return [
    ...splitList(process.env.HOST_TRUSTED_PROXY_ADMIN_GROUPS).map(value => ({
      claim: groupClaim,
      values: [value],
      role: 'host.admin',
    })),
    ...splitList(process.env.HOST_TRUSTED_PROXY_USER_GROUPS).map(value => ({
      claim: groupClaim,
      values: [value],
      role: 'host.user',
    })),
  ];
}

function normalizeTrustedProxyProvider(value) {
  if (!isObject(value) || value.type !== TRUSTED_PROXY_TYPE || value.enabled !== true) {
    return null;
  }

  const issuer = normalizeIssuer(value.issuer);
  const assertionHeader = normalizeHeaderName(value.assertionHeader || CLOUDFLARE_ACCESS_ASSERTION_HEADER);
  const audience = normalizeAudience(value.audience);
  const roleMappings = Array.isArray(value.roleMappings)
    ? value.roleMappings.filter(isRoleMapping)
    : [];

  if (!value.id || !issuer || !assertionHeader || audience.length === 0 || roleMappings.length === 0) {
    return null;
  }

  const jwks = isJsonWebKeySet(value.jwks) ? value.jwks : undefined;
  const jwksUri = typeof value.jwksUri === 'string' && value.jwksUri.trim()
    ? value.jwksUri.trim()
    : undefined;
  if (!jwks && !jwksUri) {
    return null;
  }

  return {
    id: String(value.id),
    type: TRUSTED_PROXY_TYPE,
    enabled: true,
    label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : 'Trusted proxy',
    issuer,
    audience: audience.length === 1 ? audience[0] : audience,
    assertionHeader,
    ...(jwks ? { jwks } : {}),
    ...(jwksUri ? { jwksUri } : {}),
    subjectClaim: typeof value.subjectClaim === 'string' && value.subjectClaim.trim()
      ? value.subjectClaim.trim()
      : DEFAULT_SUBJECT_CLAIM,
    emailClaim: typeof value.emailClaim === 'string' && value.emailClaim.trim()
      ? value.emailClaim.trim()
      : DEFAULT_EMAIL_CLAIM,
    displayNameClaim: typeof value.displayNameClaim === 'string' && value.displayNameClaim.trim()
      ? value.displayNameClaim.trim()
      : DEFAULT_DISPLAY_NAME_CLAIM,
    roleMappings,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  };
}

function getTrustedProxyAssertionHeaderNamesFromProviders(providers) {
  const names = new Set(TRUSTED_PROXY_DEFAULT_ASSERTION_HEADERS);
  for (const provider of providers) {
    if (provider?.assertionHeader) {
      names.add(normalizeHeaderName(provider.assertionHeader));
    }
  }
  return [...names];
}

async function readAuthState(config) {
  await fs.mkdir(config.authRootContainer, { recursive: true });
  try {
    const raw = await fs.readFile(config.authStatePath, 'utf-8');
    return normalizeAuthState(JSON.parse(raw));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const empty = createEmptyAuthState();
      await writeAuthState(empty, config);
      return empty;
    }
    throw error;
  }
}

async function updateAuthState(operation, config) {
  return withTrustedProxyStoreLock(async () => {
    const current = await readAuthState(config);
    const { state, result } = await operation(current);
    await writeAuthState(state, config);
    return result;
  });
}

async function writeAuthState(state, config) {
  await fs.mkdir(config.authRootContainer, { recursive: true });
  const nextState = normalizeAuthState({
    ...state,
    updatedAt: new Date().toISOString(),
  });
  const temporaryPath = `${config.authStatePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf-8');
  await fs.rename(temporaryPath, config.authStatePath);
}

async function appendAuthAuditEvent(event, config) {
  await fs.mkdir(path.dirname(config.authAuditPath), { recursive: true });
  const entry = {
    id: `evt_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...event,
  };
  await fs.appendFile(config.authAuditPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

async function withTrustedProxyStoreLock(operation) {
  const previous = trustedProxyStoreMutex;
  let release = () => undefined;
  trustedProxyStoreMutex = new Promise(resolve => {
    release = resolve;
  });

  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function normalizeAuthState(parsed) {
  const value = isObject(parsed) ? parsed : {};
  return {
    schemaVersion: '0.1',
    users: Array.isArray(value.users) ? value.users.filter(isObject) : [],
    sessions: Array.isArray(value.sessions) ? value.sessions.filter(isObject) : [],
    setupTokens: Array.isArray(value.setupTokens) ? value.setupTokens.filter(isObject) : [],
    cliTokens: Array.isArray(value.cliTokens) ? value.cliTokens.filter(isObject) : [],
    moduleServiceTokens: Array.isArray(value.moduleServiceTokens) ? value.moduleServiceTokens.filter(isObject) : [],
    moduleDirectoryPolicies: Array.isArray(value.moduleDirectoryPolicies)
      ? value.moduleDirectoryPolicies.filter(isObject)
      : [],
    externalIdentities: Array.isArray(value.externalIdentities) ? value.externalIdentities.filter(isObject) : [],
    oidcProviders: Array.isArray(value.oidcProviders) ? value.oidcProviders.filter(isObject) : [],
    oidcTransactions: Array.isArray(value.oidcTransactions) ? value.oidcTransactions.filter(isObject) : [],
    trustedProxyProviders: Array.isArray(value.trustedProxyProviders)
      ? value.trustedProxyProviders.filter(isObject)
      : [],
    moduleAssignments: Array.isArray(value.moduleAssignments) ? value.moduleAssignments.filter(isObject) : [],
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  };
}

function createEmptyAuthState() {
  return {
    schemaVersion: '0.1',
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

function readHeader(request, name) {
  const normalizedName = normalizeHeaderName(name);
  if (!normalizedName) {
    return null;
  }

  if (request?.headers?.get && typeof request.headers.get === 'function') {
    return request.headers.get(normalizedName)?.trim() || null;
  }

  const headers = request?.headers;
  if (!headers || typeof headers !== 'object') {
    return null;
  }

  const value = headers[normalizedName] ?? headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }

  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getRequestMeta(request) {
  return {
    origin: readHeader(request, 'origin') || undefined,
    userAgent: readHeader(request, 'user-agent') || undefined,
  };
}

function readClaimPath(claims, claimPath) {
  return String(claimPath || '').split('.').reduce((current, segment) => {
    if (current && typeof current === 'object' && segment in current) {
      return current[segment];
    }
    return undefined;
  }, claims);
}

function readStringClaim(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function claimValueMatches(value, expectedValues) {
  return expectedValues.some(expected => claimValueContains(value, expected));
}

function claimValueContains(value, expected) {
  if (typeof value === 'string') {
    return value === expected;
  }

  if (Array.isArray(value)) {
    return value.some(item => claimValueContains(item, expected));
  }

  return false;
}

function normalizeOptionalEmail(value) {
  if (!value) {
    return undefined;
  }

  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

function toPrincipal(user) {
  return {
    id: user.id,
    email: user.email || undefined,
    displayName: user.displayName,
    role: user.role,
  };
}

function summarizeProvider(provider) {
  return {
    id: provider.id,
    label: provider.label,
  };
}

function isRoleMapping(value) {
  return isObject(value) &&
    typeof value.claim === 'string' &&
    Array.isArray(value.values) &&
    value.values.every(item => typeof item === 'string') &&
    (value.role === 'host.admin' || value.role === 'host.user');
}

function isJsonWebKeySet(value) {
  return isObject(value) && Array.isArray(value.keys) && value.keys.every(isObject);
}

function parseJsonWebKeySet(value) {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    return isJsonWebKeySet(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAudience(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? splitList(value)
      : [];
  return values.map(item => String(item).trim()).filter(Boolean);
}

function normalizeIssuer(value) {
  const normalized = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  return normalized || '';
}

function normalizeHeaderName(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized || '';
}

function splitList(value) {
  return value
    ? String(value).split(/[,\s]+/).map(item => item.trim()).filter(Boolean)
    : [];
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRuntimeConfig() {
  const configuredDataRootHost = process.env.HOST_DATA_ROOT_HOST?.trim();
  const configuredDataRootContainer = process.env.HOST_DATA_ROOT_CONTAINER?.trim();
  const dataRootContainer = configuredDataRootContainer || configuredDataRootHost || DEFAULT_DATA_ROOT;
  const dataRootHost = configuredDataRootHost || dataRootContainer;
  const authRootContainer = path.join(dataRootContainer, 'auth');
  return {
    dataRootHost,
    dataRootContainer,
    authRootContainer,
    authStatePath: path.join(authRootContainer, 'state.json'),
    authAuditPath: path.join(authRootContainer, 'audit.ndjson'),
  };
}
