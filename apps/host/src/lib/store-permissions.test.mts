import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEmptyAuthState, writeAuthState } from './auth-store.ts';
import { writeModulesStore } from './module-store.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';

test('writes sensitive Host stores with owner-only permissions', async () => {
  const config = await createStorePermissionTestConfig();

  await writeAuthState(createEmptyAuthState(), config);
  await writeModulesStore({
    schemaVersion: '0.2',
    hostSettings: {},
    modules: [],
    updatedAt: new Date().toISOString(),
  }, config);

  assert.equal((await fs.stat(config.authStatePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(config.modulesStorePath)).mode & 0o777, 0o600);
});

async function createStorePermissionTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-store-permissions-'));
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
