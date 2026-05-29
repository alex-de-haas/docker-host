import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { createEmptyAuthState, writeAuthState } from './auth-store.ts';
import { issueModuleDevIdentityToken, isModuleDevIdentityError } from './module-dev-identity.ts';
import { writeModuleDevTargetState } from './module-dev-store.ts';
import { getModuleIdentityJwks } from './module-identity.mjs';
import type { HostRuntimeConfig } from './host-runtime.ts';

test('issues a Host-signed identity token for an assigned developer target user', async () => {
  const config = await createModuleDevIdentityTestConfig();
  await writeDeveloperTarget(config, 'assignedUsersOnly');
  await writeAuthState({
    ...createEmptyAuthState(),
    users: [
      {
        id: 'user_1',
        email: 'user@example.test',
        displayName: 'User One',
        role: 'host.user',
        passwordHash: 'unused',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    moduleAssignments: [
      {
        moduleId: 'com.example.reports',
        userId: 'user_1',
      },
    ],
  }, config);

  const identity = await issueModuleDevIdentityToken({
    targetId: 'mdev_reports',
    userEmail: 'user@example.test',
  }, 'test-cli', config);

  assert.equal(identity.headerName, 'X-Docker-Host-Identity');
  assert.equal(identity.moduleId, 'com.example.reports');
  assert.equal(identity.user.email, 'user@example.test');

  const jwks = await getModuleIdentityJwks(config);
  const verified = await jwtVerify(identity.token, createLocalJWKSet(jwks), {
    issuer: 'docker-host',
    audience: 'com.example.reports',
  });
  assert.equal(verified.payload.sub, 'user_1');
  assert.equal(verified.payload.email, 'user@example.test');
  assert.equal(verified.payload.moduleAccess, 'assigned');
});

test('rejects identity issuance when the selected user cannot access the developer target', async () => {
  const config = await createModuleDevIdentityTestConfig();
  await writeDeveloperTarget(config, 'assignedUsersOnly');
  await writeAuthState({
    ...createEmptyAuthState(),
    users: [
      {
        id: 'user_1',
        email: 'user@example.test',
        role: 'host.user',
        passwordHash: 'unused',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  }, config);

  await assert.rejects(
    () => issueModuleDevIdentityToken({
      targetId: 'mdev_reports',
      userEmail: 'user@example.test',
    }, 'test-cli', config),
    error => isModuleDevIdentityError(error) &&
      error.code === 'identity_user_access_denied' &&
      error.status === 403
  );
});

async function writeDeveloperTarget(config: HostRuntimeConfig, exposurePolicy: 'loginRequired' | 'assignedUsersOnly') {
  const now = new Date().toISOString();
  await writeModuleDevTargetState({
    schemaVersion: '0.1',
    targets: [
      {
        id: 'mdev_reports',
        moduleId: 'com.example.reports',
        moduleName: 'Reports',
        moduleVersion: '1.0.0',
        metadataUrl: 'http://127.0.0.1:3000/metadata.json',
        hostname: 'reports.localhost',
        portKey: 'web',
        targetBaseUrl: 'http://127.0.0.1:3001',
        targetPathPrefix: '',
        containerPort: 8080,
        protocol: 'http',
        exposurePolicy,
        identityMode: 'required',
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  }, config);
}

async function createModuleDevIdentityTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-module-dev-identity-'));
  const authRootContainer = path.join(dataRootContainer, 'auth');
  const moduleDevRootContainer = path.join(dataRootContainer, 'dev');
  return {
    dataRootHost: dataRootContainer,
    dataRootContainer,
    modulesRootContainer: path.join(dataRootContainer, 'modules'),
    modulesStorePath: path.join(dataRootContainer, 'modules.json'),
    moduleDevModeEnabled: true,
    moduleDevRootContainer,
    moduleDevTargetsPath: path.join(moduleDevRootContainer, 'module-targets.json'),
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
