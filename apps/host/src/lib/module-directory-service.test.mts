import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEmptyAuthState, readAuthStateSnapshot, writeAuthState } from './auth-store.ts';
import {
  ModuleDirectoryServiceError,
  authenticateModuleServiceToken,
  buildModuleServiceEnvironment,
  createModuleServiceToken,
  getModuleDirectoryUsers,
  revokeModuleServiceToken,
  revokeModuleServiceTokenForModule,
  setModuleDirectoryPolicy,
} from './module-directory-service.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type { AuthUserRecord } from './auth-store.ts';

test('module directory returns only explicitly assigned enabled users without email by default', async () => {
  const config = await createDirectoryTestConfig();
  await writeAuthState({
    ...createEmptyAuthState(),
    users: [
      authUser('user_1', 'user@example.test', 'User One', 'host.user'),
      authUser('user_2', 'other@example.test', 'Other User', 'host.user'),
      authUser('user_admin', 'admin@example.test', 'Admin User', 'host.admin'),
      authUser('user_disabled', 'disabled@example.test', 'Disabled User', 'host.user', true),
    ],
    moduleAssignments: [
      { moduleId: 'com.example.reports', userId: 'user_1' },
      { moduleId: 'com.example.reports', userId: 'user_disabled' },
      { moduleId: 'com.example.media', userId: 'user_2' },
    ],
  }, config);

  const serviceToken = await createModuleServiceToken({
    moduleId: 'com.example.reports',
    label: 'Reports token',
  }, 'user_admin', config);
  const principal = await authenticateModuleServiceToken(serviceToken.token, undefined, config);
  const directory = await getModuleDirectoryUsers('com.example.reports', principal, config);

  assert.deepEqual(directory.users, [
    {
      id: 'user_1',
      displayName: 'User One',
      hostRole: 'host.user',
    },
  ]);
  assert.equal(directory.pagination.total, 1);
  assert.equal(directory.schemaVersion, '0.1');
});

test('module directory includes email only after module policy opt-in', async () => {
  const config = await createDirectoryTestConfig();
  await writeAuthState({
    ...createEmptyAuthState(),
    users: [
      authUser('user_1', 'user@example.test', 'User One', 'host.user'),
    ],
    moduleAssignments: [
      { moduleId: 'com.example.reports', userId: 'user_1' },
    ],
  }, config);
  await setModuleDirectoryPolicy('com.example.reports', { includeEmail: true }, 'user_admin', config);

  const serviceToken = await createModuleServiceToken({
    moduleId: 'com.example.reports',
  }, 'user_admin', config);
  const principal = await authenticateModuleServiceToken(serviceToken.token, undefined, config);
  const directory = await getModuleDirectoryUsers('com.example.reports', principal, config);

  assert.equal(directory.users[0]?.email, 'user@example.test');
});

test('module service token cannot read another module directory', async () => {
  const config = await createDirectoryTestConfig();
  const serviceToken = await createModuleServiceToken({
    moduleId: 'com.example.reports',
  }, 'user_admin', config);
  const principal = await authenticateModuleServiceToken(serviceToken.token, undefined, config);

  await assert.rejects(
    getModuleDirectoryUsers('com.example.media', principal, config),
    (error: unknown) =>
      error instanceof ModuleDirectoryServiceError &&
      error.code === 'module_directory_forbidden' &&
      error.status === 403
  );
});

test('revoked module service token no longer authenticates', async () => {
  const config = await createDirectoryTestConfig();
  const serviceToken = await createModuleServiceToken({
    moduleId: 'com.example.reports',
  }, 'user_admin', config);

  assert.equal((await authenticateModuleServiceToken(serviceToken.token, undefined, config))?.moduleId, 'com.example.reports');
  assert.equal(await revokeModuleServiceToken(serviceToken.tokenId, 'user_admin', config), true);
  assert.equal(await authenticateModuleServiceToken(serviceToken.token, undefined, config), null);
});

test('throttles module service token activity writes after first use', async () => {
  const config = await createDirectoryTestConfig();
  const serviceToken = await createModuleServiceToken({
    moduleId: 'com.example.reports',
  }, 'user_admin', config);

  assert.equal((await authenticateModuleServiceToken(serviceToken.token, undefined, config))?.moduleId, 'com.example.reports');
  const afterFirstUse = await readAuthStateSnapshot(config);
  const firstLastUsedAt = afterFirstUse.moduleServiceTokens[0]?.lastUsedAt;
  assert.equal(typeof firstLastUsedAt, 'string');

  assert.equal((await authenticateModuleServiceToken(serviceToken.token, undefined, config))?.moduleId, 'com.example.reports');
  const afterSecondUse = await readAuthStateSnapshot(config);
  assert.equal(afterSecondUse.moduleServiceTokens[0]?.lastUsedAt, firstLastUsedAt);
});

test('module service token revoke is constrained to the owning module', async () => {
  const config = await createDirectoryTestConfig();
  const serviceToken = await createModuleServiceToken({
    moduleId: 'com.example.reports',
  }, 'user_admin', config);

  await assert.rejects(
    revokeModuleServiceTokenForModule('com.example.media', serviceToken.tokenId, 'user_admin', config),
    (error: unknown) =>
      error instanceof ModuleDirectoryServiceError &&
      error.code === 'module_service_token_not_found' &&
      error.status === 404
  );
  assert.equal(await revokeModuleServiceTokenForModule('com.example.reports', serviceToken.tokenId, 'user_admin', config), true);
});

test('module service environment exposes internal origin, module id, and raw token', () => {
  assert.deepEqual(
    buildModuleServiceEnvironment({
      moduleId: 'com.example.reports',
      serviceToken: 'dhmst_secret',
      hostInternalOrigin: 'http://docker-host:3000',
    }),
    {
      DOCKER_HOST_INTERNAL_ORIGIN: 'http://docker-host:3000',
      DOCKER_HOST_MODULE_ID: 'com.example.reports',
      DOCKER_HOST_MODULE_SERVICE_TOKEN: 'dhmst_secret',
    }
  );
});

async function createDirectoryTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-directory-'));
  const authRootContainer = path.join(dataRootContainer, 'auth');
  const gatewayRootContainer = path.join(dataRootContainer, 'gateway');
  return {
    dataRootHost: dataRootContainer,
    dataRootContainer,
    modulesRootContainer: path.join(dataRootContainer, 'modules'),
    modulesStorePath: path.join(dataRootContainer, 'modules.json'),
    authRootContainer,
    authStatePath: path.join(authRootContainer, 'state.json'),
    authAuditPath: path.join(authRootContainer, 'audit.ndjson'),
    gatewayRootContainer,
    gatewayExposuresPath: path.join(gatewayRootContainer, 'exposures.json'),
    gatewayBaseDomain: 'example.test',
    hostPublicOrigin: 'https://host.example.test',
    hostInternalOrigin: 'http://docker-host:3000',
    dockerSocketPath: '/var/run/docker.sock',
    moduleNetwork: 'docker-host-modules',
  };
}

function authUser(
  id: string,
  email: string,
  displayName: string,
  role: AuthUserRecord['role'],
  disabled = false
): AuthUserRecord {
  return {
    id,
    email,
    displayName,
    role,
    passwordHash: 'unused',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(disabled ? { disabled: true } : {}),
  };
}
