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
import {
  createEmptyAuthState,
  readAuthStateSnapshot,
  writeAuthState,
} from './auth-store.ts';
import { authenticateTrustedProxyRequest } from './trusted-proxy.mjs';
import type { AuthTrustedProxyProviderRecord } from './auth-store.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';

const issuer = 'https://access.example.test';
const audience = 'docker-host-audience';
const assertionHeader = 'cf-access-jwt-assertion';

test('trusted proxy assertion provisions a Host user through explicit role mapping', async () => {
  const config = await createTestConfig();
  const signing = await createSigningFixture();
  await writeAuthState({
    ...createEmptyAuthState(),
    trustedProxyProviders: [testProvider(signing.publicJwk)],
  }, config);

  const assertion = await signAssertion(signing.privateKey, {
    subject: 'proxy-user',
    groups: ['docker-host-users'],
    email: 'User@Example.Test',
    name: 'Proxy User',
  });

  const result = await authenticateTrustedProxyRequest(
    new Request('https://host.example.test/api/host/status', {
      headers: {
        [assertionHeader]: assertion,
      },
    }),
    config
  );

  assert.equal(result.modeActive, true);
  assert.equal(result.principal?.role, 'host.user');
  assert.equal(result.principal?.email, 'user@example.test');
  assert.equal(result.provisioned, true);

  const state = await readAuthStateSnapshot(config);
  assert.equal(state.users.length, 1);
  assert.equal(state.users[0]?.authProvider, 'trusted-proxy');
  assert.equal(state.externalIdentities[0]?.issuer, issuer);
  assert.equal(state.externalIdentities[0]?.subject, 'proxy-user');
});

test('trusted proxy assertion denies unmapped and disabled users', async () => {
  const config = await createTestConfig();
  const signing = await createSigningFixture();
  await writeAuthState({
    ...createEmptyAuthState(),
    trustedProxyProviders: [testProvider(signing.publicJwk)],
  }, config);

  const unmappedAssertion = await signAssertion(signing.privateKey, {
    subject: 'unmapped-user',
    groups: ['unmapped-group'],
  });
  const unmapped = await authenticateTrustedProxyRequest(
    new Request('https://host.example.test/api/host/status', {
      headers: {
        [assertionHeader]: unmappedAssertion,
      },
    }),
    config
  );

  assert.equal(unmapped.principal, null);
  assert.equal(unmapped.reason, 'role_mapping_denied');

  const firstAssertion = await signAssertion(signing.privateKey, {
    subject: 'disabled-user',
    groups: ['docker-host-users'],
  });
  const first = await authenticateTrustedProxyRequest(
    new Request('https://host.example.test/api/host/status', {
      headers: {
        [assertionHeader]: firstAssertion,
      },
    }),
    config
  );
  assert.ok(first.principal);

  const state = await readAuthStateSnapshot(config);
  await writeAuthState({
    ...state,
    users: state.users.map(user =>
      user.id === first.principal?.id ? { ...user, disabled: true } : user
    ),
  }, config);

  const disabled = await authenticateTrustedProxyRequest(
    new Request('https://host.example.test/api/host/status', {
      headers: {
        [assertionHeader]: firstAssertion,
      },
    }),
    config
  );

  assert.equal(disabled.principal, null);
  assert.equal(disabled.reason, 'trusted_proxy_user_disabled');
});

function testProvider(jwk: JsonWebKey): AuthTrustedProxyProviderRecord {
  const now = new Date().toISOString();
  return {
    id: 'trusted_proxy_1',
    type: 'trusted-proxy',
    enabled: true,
    label: 'Cloudflare Access',
    issuer,
    audience,
    assertionHeader,
    jwks: {
      keys: [jwk],
    },
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

async function createSigningFixture() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwk: {
      ...publicJwk,
      kid: 'trusted-proxy-test-key',
      alg: 'ES256',
      use: 'sig',
    },
  };
}

async function signAssertion(
  privateKey: KeyLike,
  input: {
    subject: string;
    groups: string[];
    email?: string;
    name?: string;
  }
) {
  return await new SignJWT({
    groups: input.groups,
    ...(input.email ? { email: input.email } : {}),
    ...(input.name ? { name: input.name } : {}),
  })
    .setProtectedHeader({
      alg: 'ES256',
      kid: 'trusted-proxy-test-key',
      typ: 'JWT',
    })
    .setIssuer(issuer)
    .setSubject(input.subject)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function createTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-trusted-proxy-'));
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
    gatewayBaseDomain: 'example.test',
    hostPublicOrigin: 'https://host.example.test',
    hostInternalOrigin: 'http://docker-host:3000',
    dockerSocketPath: '/var/run/docker.sock',
    moduleNetwork: 'docker-host-modules',
  };
}
