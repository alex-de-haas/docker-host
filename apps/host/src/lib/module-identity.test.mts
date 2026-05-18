import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalJWKSet, jwtVerify } from 'jose';
import {
  MODULE_IDENTITY_ISSUER,
  MODULE_IDENTITY_TOKEN_HEADER,
  createModuleIdentityToken,
  getModuleIdentityDiscovery,
  getModuleIdentityJwks,
  shouldIssueModuleIdentity,
} from './module-identity.mjs';
import type { HostRuntimeConfig } from './host-runtime.ts';

test('creates a signed module identity token that validates against JWKS', async () => {
  const config = await createIdentityTestConfig();
  const issuedAt = new Date('2026-05-18T10:00:00.000Z');
  const input = {
    principal: {
      id: 'user_1',
      role: 'host.user' as const,
      email: 'user@example.test',
      displayName: 'User One',
    },
    access: {
      allowed: true,
      policy: 'assignedUsersOnly' as const,
      reason: 'assigned' as const,
    },
    exposure: {
      id: 'gw_1',
      moduleId: 'com.example.reports',
      hostname: 'reports.example.test',
      portKey: 'web',
      exposurePolicy: 'assignedUsersOnly' as const,
      identityMode: 'required' as const,
    },
  };

  const token = await createModuleIdentityToken(input, config, issuedAt);
  assert.equal(typeof token, 'string');

  const jwks = await getModuleIdentityJwks(config);
  assert.equal(jwks.keys.length, 1);
  assert.equal('d' in jwks.keys[0], false);

  const verified = await jwtVerify(token!, createLocalJWKSet(jwks), {
    issuer: MODULE_IDENTITY_ISSUER,
    audience: 'com.example.reports',
    currentDate: new Date('2026-05-18T10:01:00.000Z'),
  });

  assert.equal(verified.payload.sub, 'user_1');
  assert.equal(verified.payload.hostRole, 'host.user');
  assert.equal(verified.payload.moduleAccess, 'assigned');
  assert.equal(verified.payload.moduleExposurePolicy, 'assignedUsersOnly');
  assert.equal(verified.payload.email, 'user@example.test');
  assert.equal(verified.payload.name, 'User One');
  assert.equal(verified.payload.gatewayExposureId, 'gw_1');
  assert.equal(verified.payload.hostname, 'reports.example.test');
  assert.equal(verified.payload.portKey, 'web');

  await assert.rejects(
    jwtVerify(token!, createLocalJWKSet(jwks), {
      issuer: MODULE_IDENTITY_ISSUER,
      audience: 'com.example.media',
      currentDate: new Date('2026-05-18T10:01:00.000Z'),
    }),
    /unexpected "aud" claim value/
  );
});

test('does not issue identity for default public exposure, but supports optional public identity', async () => {
  const config = await createIdentityTestConfig();
  const baseInput = {
    principal: {
      id: 'user_1',
      role: 'host.user' as const,
      email: 'user@example.test',
    },
    access: {
      allowed: true,
      policy: 'public' as const,
      reason: 'public' as const,
    },
    exposure: {
      id: 'gw_public',
      moduleId: 'com.example.public',
      hostname: 'public.example.test',
      portKey: 'web',
      exposurePolicy: 'public' as const,
    },
  };

  assert.equal(shouldIssueModuleIdentity(baseInput), false);
  assert.equal(await createModuleIdentityToken(baseInput, config), null);

  const optionalInput = {
    ...baseInput,
    exposure: {
      ...baseInput.exposure,
      identityMode: 'optional' as const,
    },
  };

  const token = await createModuleIdentityToken(optionalInput, config, new Date('2026-05-18T10:00:00.000Z'));
  const verified = await jwtVerify(token!, createLocalJWKSet(await getModuleIdentityJwks(config)), {
    issuer: MODULE_IDENTITY_ISSUER,
    audience: 'com.example.public',
    currentDate: new Date('2026-05-18T10:01:00.000Z'),
  });

  assert.equal(verified.payload.moduleAccess, 'publicAuthenticated');
});

test('publishes module identity discovery with internal JWKS URL', async () => {
  const config = await createIdentityTestConfig();
  const discovery = getModuleIdentityDiscovery(config, 'https://host.example.test');

  assert.equal(discovery.issuer, MODULE_IDENTITY_ISSUER);
  assert.equal(discovery.jwks_uri, 'http://docker-host:3000/.well-known/docker-host/jwks.json');
  assert.equal(discovery.token_header, MODULE_IDENTITY_TOKEN_HEADER);
  assert.deepEqual(discovery.algorithms, ['ES256']);
});

async function createIdentityTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-identity-'));
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
