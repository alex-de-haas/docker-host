import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GET } from './route.ts';
import { createEmptyAuthState, writeAuthState } from '../../../lib/auth-store.ts';
import type { HostRuntimeConfig } from '../../../lib/host-runtime.ts';

test('GET /api/apps rejects unauthenticated callers', async t => {
  const config = await createRouteTestConfig();
  const previousDataRoot = process.env.HOST_DATA_ROOT_CONTAINER;
  process.env.HOST_DATA_ROOT_CONTAINER = config.dataRootContainer;
  t.after(() => {
    if (previousDataRoot === undefined) {
      delete process.env.HOST_DATA_ROOT_CONTAINER;
    } else {
      process.env.HOST_DATA_ROOT_CONTAINER = previousDataRoot;
    }
  });

  await writeAuthState({
    ...createEmptyAuthState(),
    users: [
      {
        id: 'user_admin',
        email: 'admin@example.test',
        role: 'host.admin',
        authProvider: 'local',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  }, config);

  const response = await GET(new Request('http://localhost:3000/api/apps'));
  const body = await response.json() as { error?: { code?: string; action?: string } };

  assert.equal(response.status, 401);
  assert.equal(body.error?.code, 'unauthorized');
  assert.equal(body.error?.action, 'apps.read');
});

async function createRouteTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-apps-route-'));
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
