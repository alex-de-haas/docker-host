import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type KeyLike,
} from 'jose';
import { authenticateSessionToken } from './auth-service.ts';
import {
  createEmptyAuthState,
  readAuthStateSnapshot,
  writeAuthState,
} from './auth-store.ts';
import type { AuthOidcProviderRecord } from './auth-store.ts';
import {
  completeOidcLogin,
  startOidcLogin,
} from './oidc-service.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';

const issuer = 'https://idp.example.test/realms/docker-host';
const clientId = 'docker-host';
const authorizationEndpoint = `${issuer}/protocol/openid-connect/auth`;
const tokenEndpoint = `${issuer}/protocol/openid-connect/token`;
const jwksUri = `${issuer}/protocol/openid-connect/certs`;

test('OIDC callback verifies ID token, maps role, provisions user, and creates Host session', async () => {
  const config = await createTestConfig();
  await writeAuthState({
    ...createEmptyAuthState(),
    oidcProviders: [testProvider()],
  }, config);
  const signing = await createSigningFixture();
  const client = createMockOidcClient(signing);

  const login = await startOidcLogin({
    requestOrigin: 'http://localhost:3000',
    redirectTo: '/modules',
  }, undefined, config, client);
  const authorizationUrl = new URL(login.authorizationUrl);
  assert.equal(authorizationUrl.origin + authorizationUrl.pathname, authorizationEndpoint);
  assert.equal(authorizationUrl.searchParams.get('response_type'), 'code');
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');

  signing.idToken = await signIdToken(signing.privateKey, {
    nonce: authorizationUrl.searchParams.get('nonce') || '',
    groups: ['docker-host-users'],
    email: 'User@Example.Test',
    name: 'Example User',
    subject: 'subject-user',
  });

  const result = await completeOidcLogin({
    state: authorizationUrl.searchParams.get('state') || '',
    code: 'authorization-code',
    requestOrigin: 'http://localhost:3000',
  }, undefined, config, client);

  assert.equal(result.user.role, 'host.user');
  assert.equal(result.user.email, 'user@example.test');
  assert.equal(result.redirectTo, '/modules');
  assert.equal((await authenticateSessionToken(result.sessionToken, undefined, config))?.id, result.user.id);

  const state = await readAuthStateSnapshot(config);
  assert.equal(state.users.length, 1);
  assert.equal(state.users[0]?.authProvider, 'oidc');
  assert.equal(state.externalIdentities.length, 1);
  assert.equal(state.externalIdentities[0]?.issuer, issuer);
  assert.equal(state.externalIdentities[0]?.subject, 'subject-user');
  assert.equal(state.oidcTransactions.length, 0);
});

test('OIDC callback denies users that do not match a Host role mapping', async () => {
  const config = await createTestConfig();
  await writeAuthState({
    ...createEmptyAuthState(),
    oidcProviders: [testProvider()],
  }, config);
  const signing = await createSigningFixture();
  const client = createMockOidcClient(signing);
  const login = await startOidcLogin({
    requestOrigin: 'http://localhost:3000',
  }, undefined, config, client);
  const authorizationUrl = new URL(login.authorizationUrl);
  signing.idToken = await signIdToken(signing.privateKey, {
    nonce: authorizationUrl.searchParams.get('nonce') || '',
    groups: ['unmapped-group'],
    subject: 'subject-denied',
  });

  await assert.rejects(
    completeOidcLogin({
      state: authorizationUrl.searchParams.get('state') || '',
      code: 'authorization-code',
      requestOrigin: 'http://localhost:3000',
    }, undefined, config, client),
    /did not match a Host role mapping/
  );

  const state = await readAuthStateSnapshot(config);
  assert.equal(state.users.length, 0);
  assert.equal(state.sessions.length, 0);
});

test('OIDC callback rejects disabled mapped Host users', async () => {
  const config = await createTestConfig();
  await writeAuthState({
    ...createEmptyAuthState(),
    oidcProviders: [testProvider()],
  }, config);
  const signing = await createSigningFixture();
  const client = createMockOidcClient(signing);

  const firstLogin = await startOidcLogin({
    requestOrigin: 'http://localhost:3000',
  }, undefined, config, client);
  const firstAuthorizationUrl = new URL(firstLogin.authorizationUrl);
  signing.idToken = await signIdToken(signing.privateKey, {
    nonce: firstAuthorizationUrl.searchParams.get('nonce') || '',
    groups: ['docker-host-users'],
    subject: 'subject-disabled',
  });
  const firstResult = await completeOidcLogin({
    state: firstAuthorizationUrl.searchParams.get('state') || '',
    code: 'authorization-code',
    requestOrigin: 'http://localhost:3000',
  }, undefined, config, client);

  const state = await readAuthStateSnapshot(config);
  await writeAuthState({
    ...state,
    users: state.users.map(user =>
      user.id === firstResult.user.id ? { ...user, disabled: true } : user
    ),
  }, config);

  const secondLogin = await startOidcLogin({
    requestOrigin: 'http://localhost:3000',
  }, undefined, config, client);
  const secondAuthorizationUrl = new URL(secondLogin.authorizationUrl);
  signing.idToken = await signIdToken(signing.privateKey, {
    nonce: secondAuthorizationUrl.searchParams.get('nonce') || '',
    groups: ['docker-host-admins'],
    subject: 'subject-disabled',
  });

  await assert.rejects(
    completeOidcLogin({
      state: secondAuthorizationUrl.searchParams.get('state') || '',
      code: 'authorization-code',
      requestOrigin: 'http://localhost:3000',
    }, undefined, config, client),
    /disabled/
  );
});

function testProvider(): AuthOidcProviderRecord {
  const now = new Date().toISOString();
  return {
    id: 'keycloak',
    type: 'oidc',
    enabled: true,
    label: 'Keycloak',
    issuer,
    clientId,
    clientSecret: 'secret',
    scopes: ['openid', 'profile', 'email'],
    roleMappings: [
      {
        claim: 'groups',
        values: ['docker-host-admins'],
        role: 'host.admin',
      },
      {
        claim: 'groups',
        values: ['docker-host-users'],
        role: 'host.user',
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

async function signIdToken(
  privateKey: KeyLike,
  input: {
    nonce: string;
    groups: string[];
    subject: string;
    email?: string;
    name?: string;
  }
) {
  return await new SignJWT({
    nonce: input.nonce,
    groups: input.groups,
    ...(input.email ? { email: input.email } : {}),
    ...(input.name ? { name: input.name } : {}),
  })
    .setProtectedHeader({
      alg: 'ES256',
      kid: 'test-key',
      typ: 'JWT',
    })
    .setIssuer(issuer)
    .setSubject(input.subject)
    .setAudience(clientId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function createSigningFixture() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const publicJwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwk: {
      ...publicJwk,
      kid: 'test-key',
      alg: 'ES256',
      use: 'sig',
    },
    idToken: '',
  };
}

function createMockOidcClient(signing: Awaited<ReturnType<typeof createSigningFixture>>) {
  return {
    async fetch(input: string | URL, init?: RequestInit) {
      const url = String(input);
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return jsonResponse({
          issuer,
          authorization_endpoint: authorizationEndpoint,
          token_endpoint: tokenEndpoint,
          jwks_uri: jwksUri,
        });
      }

      if (url === tokenEndpoint) {
        const body = init?.body instanceof URLSearchParams ? init.body : null;
        assert.equal(init?.method, 'POST');
        assert.equal(body?.get('grant_type'), 'authorization_code');
        assert.equal(body?.get('client_id'), clientId);
        assert.equal(body?.get('client_secret'), 'secret');
        assert.ok(body?.get('code_verifier')?.startsWith('oidc_pkce_'));
        return jsonResponse({
          id_token: signing.idToken,
        });
      }

      if (url === jwksUri) {
        return jsonResponse({
          keys: [signing.publicJwk],
        });
      }

      return new Response('not found', { status: 404 });
    },
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

async function createTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-oidc-'));
  const authRootContainer = path.join(dataRootContainer, 'auth');
  return {
    dataRootHost: dataRootContainer,
    dataRootContainer,
    modulesRootContainer: path.join(dataRootContainer, 'modules'),
    modulesStorePath: path.join(dataRootContainer, 'modules.json'),
    authRootContainer,
    authStatePath: path.join(authRootContainer, 'state.json'),
    authAuditPath: path.join(authRootContainer, 'audit.ndjson'),
    gatewayRootContainer: path.join(dataRootContainer, 'gateway'),
    gatewayExposuresPath: path.join(dataRootContainer, 'gateway', 'exposures.json'),
    gatewayBaseDomain: null,
    hostPublicOrigin: null,
    hostInternalOrigin: 'http://docker-host:3000',
    dockerSocketPath: '/var/run/docker.sock',
    moduleNetwork: 'docker-host-modules',
  };
}
