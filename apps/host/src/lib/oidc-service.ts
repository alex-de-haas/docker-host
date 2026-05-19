import { createHash, randomUUID } from 'node:crypto';
import {
  createLocalJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';
import { generateToken, hashToken } from './auth-crypto.ts';
import { AuthServiceError, createSessionForUser } from './auth-service.ts';
import type { AuthRequestMeta } from './auth-service.ts';
import {
  appendAuthAuditEvent,
  readAuthState,
  updateAuthState,
} from './auth-store.ts';
import type {
  AuthExternalIdentityRecord,
  AuthOidcProviderRecord,
  AuthOidcRoleMappingRecord,
  AuthOidcTransactionRecord,
  AuthUserRecord,
} from './auth-store.ts';
import { getHostRuntimeConfig } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type { HostRole } from '../types/auth.ts';

export const OIDC_TRANSACTION_TTL_MS = 10 * 60 * 1000;
export const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback';

interface OidcHttpClient {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface OidcTokenResponse {
  id_token?: string;
  error?: string;
  error_description?: string;
}

export interface OidcLoginStatus {
  enabled: boolean;
  provider?: {
    id: string;
    label: string;
  };
}

export async function getOidcLoginStatus(
  config = getHostRuntimeConfig()
): Promise<OidcLoginStatus> {
  const provider = await getActiveOidcProvider(config);
  return provider
    ? {
        enabled: true,
        provider: {
          id: provider.id,
          label: provider.label,
        },
      }
    : { enabled: false };
}

export async function startOidcLogin(
  input: {
    requestOrigin: string;
    redirectTo?: string | null;
  },
  request?: AuthRequestMeta,
  config = getHostRuntimeConfig(),
  client: OidcHttpClient = defaultOidcHttpClient
) {
  const provider = await getActiveOidcProvider(config);
  if (!provider) {
    throw new AuthServiceError('oidc_not_configured', 'OIDC login is not configured.');
  }

  const discovery = await fetchOidcDiscovery(provider, client);
  const redirectUri = getOidcRedirectUri(provider, input.requestOrigin, config);
  const state = generateToken('oidc_state_');
  const nonce = generateToken('oidc_nonce_');
  const codeVerifier = generateToken('oidc_pkce_');
  const codeChallenge = createPkceCodeChallenge(codeVerifier);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OIDC_TRANSACTION_TTL_MS).toISOString();
  const transaction: AuthOidcTransactionRecord = {
    id: `oidc_tx_${randomUUID()}`,
    providerId: provider.id,
    stateHash: hashToken(state),
    nonceHash: hashToken(nonce),
    codeVerifier,
    redirectUri,
    redirectTo: normalizeRedirectTo(input.redirectTo),
    createdAt: now.toISOString(),
    expiresAt,
  };

  await updateAuthState(current => ({
    state: {
      ...current,
      oidcTransactions: [
        ...current.oidcTransactions.filter(candidate => Date.parse(candidate.expiresAt) > now.getTime()),
        transaction,
      ],
    },
    result: null,
  }), config);

  await appendAuthAuditEvent({
    type: 'auth.oidc.login.started',
    success: true,
    request,
    details: {
      providerId: provider.id,
      transactionId: transaction.id,
      expiresAt,
    },
  }, config);

  const authorizationUrl = new URL(discovery.authorization_endpoint);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', provider.clientId);
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('scope', provider.scopes.join(' '));
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('nonce', nonce);
  authorizationUrl.searchParams.set('code_challenge', codeChallenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');

  return {
    authorizationUrl: authorizationUrl.toString(),
    provider: {
      id: provider.id,
      label: provider.label,
    },
    transactionId: transaction.id,
    expiresAt,
  };
}

export async function completeOidcLogin(
  input: {
    state: string;
    code: string;
    requestOrigin: string;
  },
  request?: AuthRequestMeta,
  config = getHostRuntimeConfig(),
  client: OidcHttpClient = defaultOidcHttpClient
) {
  const now = new Date();
  const transaction = await consumeOidcTransaction(input.state, now, config);
  if (!transaction) {
    await appendAuthAuditEvent({
      type: 'auth.oidc.callback.failed',
      success: false,
      request,
      details: {
        reason: 'invalid_state',
      },
    }, config);

    throw new AuthServiceError('oidc_invalid_state', 'OIDC login state is invalid or expired.');
  }

  const provider = await getOidcProviderById(transaction.providerId, config);
  if (!provider) {
    await appendAuthAuditEvent({
      type: 'auth.oidc.callback.failed',
      success: false,
      request,
      details: {
        reason: 'provider_not_found',
        providerId: transaction.providerId,
      },
    }, config);

    throw new AuthServiceError('oidc_provider_not_found', 'OIDC provider configuration was not found.');
  }

  const discovery = await fetchOidcDiscovery(provider, client);
  const tokenResponse = await exchangeAuthorizationCode({
    provider,
    discovery,
    code: input.code,
    redirectUri: transaction.redirectUri || getOidcRedirectUri(provider, input.requestOrigin, config),
    codeVerifier: transaction.codeVerifier,
  }, client);
  const claims = await verifyOidcIdToken(provider, discovery, tokenResponse.id_token || '', client);

  if (hashToken(readStringClaim(claims.nonce) || '') !== transaction.nonceHash) {
    await appendAuthAuditEvent({
      type: 'auth.oidc.callback.failed',
      success: false,
      request,
      details: {
        reason: 'invalid_nonce',
        providerId: provider.id,
      },
    }, config);

    throw new AuthServiceError('oidc_invalid_nonce', 'OIDC token nonce did not match the login transaction.');
  }

  const subject = readStringClaim(claims.sub);
  if (!subject) {
    throw new AuthServiceError('oidc_missing_subject', 'OIDC token did not contain a subject.');
  }

  const role = mapOidcRole(provider.roleMappings, claims);
  if (!role) {
    await appendAuthAuditEvent({
      type: 'auth.oidc.role_mapping.denied',
      success: false,
      request,
      details: {
        providerId: provider.id,
        issuer: provider.issuer,
        subject,
      },
    }, config);

    throw new AuthServiceError('oidc_role_mapping_denied', 'OIDC user did not match a Host role mapping.');
  }

  const userResult = await upsertOidcUser({
    provider,
    claims,
    subject,
    role,
  }, config);

  const session = await createSessionForUser(
    userResult.user.id,
    'auth.oidc.session.created',
    request,
    config
  );

  await appendAuthAuditEvent({
    type: 'auth.oidc.callback.succeeded',
    actorUserId: userResult.user.id,
    success: true,
    request,
    details: {
      providerId: provider.id,
      externalIdentityId: userResult.externalIdentity.id,
      provisioned: userResult.provisioned,
      role,
    },
  }, config);

  return {
    ...session,
    redirectTo: transaction.redirectTo || '/',
    externalIdentity: userResult.externalIdentity,
    provisioned: userResult.provisioned,
  };
}

export function mapOidcRole(
  mappings: AuthOidcRoleMappingRecord[],
  claims: JWTPayload
): HostRole | null {
  const matchedRoles = mappings
    .filter(mapping => oidcClaimMatches(claims, mapping))
    .map(mapping => mapping.role);

  if (matchedRoles.includes('host.admin')) {
    return 'host.admin';
  }

  return matchedRoles.includes('host.user') ? 'host.user' : null;
}

async function consumeOidcTransaction(
  state: string,
  now: Date,
  config: HostRuntimeConfig
): Promise<AuthOidcTransactionRecord | null> {
  const stateHash = hashToken(state);
  return await updateAuthState(current => {
    const transaction = current.oidcTransactions.find(candidate =>
      candidate.stateHash === stateHash &&
      Date.parse(candidate.expiresAt) > now.getTime()
    ) ?? null;

    return {
      state: {
        ...current,
        oidcTransactions: current.oidcTransactions.filter(candidate =>
          Date.parse(candidate.expiresAt) > now.getTime() &&
          candidate.stateHash !== stateHash
        ),
      },
      result: transaction,
    };
  }, config);
}

async function upsertOidcUser(
  input: {
    provider: AuthOidcProviderRecord;
    claims: JWTPayload;
    subject: string;
    role: HostRole;
  },
  config: HostRuntimeConfig
) {
  const now = new Date().toISOString();
  const email = normalizeOptionalEmail(readStringClaim(input.claims.email));
  const displayName =
    readStringClaim(input.claims.name) ||
    readStringClaim(input.claims.preferred_username) ||
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
        throw new AuthServiceError('user_disabled', 'The mapped Host user is disabled.');
      }

      const updatedUser: AuthUserRecord = {
        ...existingUser,
        email: email || existingUser.email,
        displayName: displayName || existingUser.displayName,
        role: input.role,
        authProvider: existingUser.authProvider || 'oidc',
        updatedAt: now,
      };
      const updatedIdentity: AuthExternalIdentityRecord = {
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

    const user: AuthUserRecord = {
      id: `user_${randomUUID()}`,
      email,
      displayName,
      role: input.role,
      authProvider: 'oidc',
      createdAt: now,
      updatedAt: now,
    };
    const externalIdentity: AuthExternalIdentityRecord = {
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
      type: 'auth.oidc.user.provisioned',
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

async function getActiveOidcProvider(config: HostRuntimeConfig) {
  return selectSingleActiveOidcProvider(await getConfiguredOidcProviders(config));
}

async function getOidcProviderById(providerId: string, config: HostRuntimeConfig) {
  const providers = await getConfiguredOidcProviders(config);
  selectSingleActiveOidcProvider(providers);
  return providers.find(provider => provider.id === providerId) ?? null;
}

async function getConfiguredOidcProviders(config: HostRuntimeConfig) {
  const state = await readAuthState(config);
  const envProvider = getEnvOidcProvider();
  return [
    ...state.oidcProviders.filter(provider => provider.enabled),
    ...(envProvider ? [envProvider] : []),
  ];
}

function selectSingleActiveOidcProvider(providers: AuthOidcProviderRecord[]) {
  if (providers.length > 1) {
    throw new AuthServiceError(
      'oidc_multiple_active_providers',
      'Exactly one active OIDC browser login provider is supported.'
    );
  }

  return providers[0] ?? null;
}

function getEnvOidcProvider(): AuthOidcProviderRecord | null {
  if (process.env.HOST_OIDC_ENABLED?.trim().toLowerCase() === 'false') {
    return null;
  }

  const issuer = normalizeIssuer(process.env.HOST_OIDC_ISSUER);
  const clientId = process.env.HOST_OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId) {
    return null;
  }

  const now = new Date().toISOString();
  const scopes = splitList(process.env.HOST_OIDC_SCOPES).length > 0
    ? splitList(process.env.HOST_OIDC_SCOPES)
    : ['openid', 'profile', 'email'];
  const groupClaim = process.env.HOST_OIDC_GROUPS_CLAIM?.trim() || 'groups';
  const roleMappings: AuthOidcRoleMappingRecord[] = [
    ...splitList(process.env.HOST_OIDC_ADMIN_GROUPS).map(value => ({
      claim: groupClaim,
      values: [value],
      role: 'host.admin' as const,
    })),
    ...splitList(process.env.HOST_OIDC_USER_GROUPS).map(value => ({
      claim: groupClaim,
      values: [value],
      role: 'host.user' as const,
    })),
  ];

  return {
    id: 'env',
    type: 'oidc',
    enabled: true,
    label: process.env.HOST_OIDC_LABEL?.trim() || 'OIDC',
    issuer,
    clientId,
    clientSecret: process.env.HOST_OIDC_CLIENT_SECRET?.trim() || undefined,
    callbackUrl: process.env.HOST_OIDC_CALLBACK_URL?.trim() || undefined,
    scopes,
    roleMappings,
    createdAt: now,
    updatedAt: now,
  };
}

async function fetchOidcDiscovery(
  provider: AuthOidcProviderRecord,
  client: OidcHttpClient
): Promise<OidcDiscoveryDocument> {
  const discoveryUrl = new URL(`${provider.issuer}/.well-known/openid-configuration`);
  const response = await client.fetch(discoveryUrl);
  const document = await readJson<Partial<OidcDiscoveryDocument>>(response, 'oidc_discovery_failed');

  if (
    normalizeIssuer(document.issuer) !== provider.issuer ||
    typeof document.authorization_endpoint !== 'string' ||
    typeof document.token_endpoint !== 'string' ||
    typeof document.jwks_uri !== 'string'
  ) {
    throw new AuthServiceError('oidc_discovery_invalid', 'OIDC discovery document is invalid.');
  }

  return {
    issuer: provider.issuer,
    authorization_endpoint: document.authorization_endpoint,
    token_endpoint: document.token_endpoint,
    jwks_uri: document.jwks_uri,
  };
}

async function exchangeAuthorizationCode(
  input: {
    provider: AuthOidcProviderRecord;
    discovery: OidcDiscoveryDocument;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  },
  client: OidcHttpClient
): Promise<OidcTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.provider.clientId,
    code_verifier: input.codeVerifier,
  });

  if (input.provider.clientSecret) {
    body.set('client_secret', input.provider.clientSecret);
  }

  const response = await client.fetch(input.discovery.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  const tokenResponse = await readJson<OidcTokenResponse>(response, 'oidc_token_exchange_failed');
  if (!tokenResponse.id_token) {
    throw new AuthServiceError(
      'oidc_missing_id_token',
      tokenResponse.error_description || tokenResponse.error || 'OIDC token response did not include an ID token.'
    );
  }

  return tokenResponse;
}

async function verifyOidcIdToken(
  provider: AuthOidcProviderRecord,
  discovery: OidcDiscoveryDocument,
  idToken: string,
  client: OidcHttpClient
) {
  const jwksResponse = await client.fetch(discovery.jwks_uri);
  const jwks = await readJson<JSONWebKeySet>(jwksResponse, 'oidc_jwks_failed');
  try {
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
      issuer: provider.issuer,
      audience: provider.clientId,
    });
    return payload;
  } catch {
    throw new AuthServiceError('oidc_token_invalid', 'OIDC ID token could not be verified.');
  }
}

async function readJson<T>(response: Response, errorCode: string): Promise<T> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new AuthServiceError(errorCode, `OIDC provider request failed with status ${response.status}.`);
  }

  if (!body || typeof body !== 'object') {
    throw new AuthServiceError(errorCode, 'OIDC provider returned an invalid JSON response.');
  }

  return body as T;
}

function oidcClaimMatches(claims: JWTPayload, mapping: AuthOidcRoleMappingRecord) {
  const claimValue = readClaimPath(claims, mapping.claim);
  return mapping.values.some(expected => claimValueContains(claimValue, expected));
}

function readClaimPath(claims: JWTPayload, claimPath: string): unknown {
  return claimPath.split('.').reduce<unknown>((current, segment) => {
    if (current && typeof current === 'object' && segment in current) {
      return (current as Record<string, unknown>)[segment];
    }

    return undefined;
  }, claims);
}

function claimValueContains(value: unknown, expected: string): boolean {
  if (typeof value === 'string') {
    return value === expected;
  }

  if (Array.isArray(value)) {
    return value.some(item => claimValueContains(item, expected));
  }

  return false;
}

function readStringClaim(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeOptionalEmail(value: string | null) {
  if (!value) {
    return undefined;
  }

  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

function normalizeRedirectTo(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return '/';
  }

  return value;
}

function getOidcRedirectUri(
  provider: AuthOidcProviderRecord,
  requestOrigin: string,
  config: HostRuntimeConfig
) {
  if (provider.callbackUrl) {
    return provider.callbackUrl;
  }

  const origin = config.hostPublicOrigin || getLocalDevelopmentOrigin(requestOrigin);
  return `${origin.replace(/\/+$/, '')}${OIDC_CALLBACK_PATH}`;
}

function getLocalDevelopmentOrigin(requestOrigin: string) {
  let parsed: URL;
  try {
    parsed = new URL(requestOrigin);
  } catch {
    throw new AuthServiceError(
      'oidc_public_origin_required',
      'HOST_PUBLIC_ORIGIN or an explicit OIDC callback URL is required for non-loopback OIDC login.'
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost');
  if (!loopback) {
    throw new AuthServiceError(
      'oidc_public_origin_required',
      'HOST_PUBLIC_ORIGIN or an explicit OIDC callback URL is required for non-loopback OIDC login.'
    );
  }

  return parsed.origin;
}

function createPkceCodeChallenge(codeVerifier: string) {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

function normalizeIssuer(value: string | undefined) {
  const normalized = value?.trim().replace(/\/+$/, '');
  return normalized || '';
}

function splitList(value: string | undefined) {
  return value
    ? value.split(/[,\s]+/).map(item => item.trim()).filter(Boolean)
    : [];
}

const defaultOidcHttpClient: OidcHttpClient = {
  fetch: (input, init) => fetch(input, init),
};
