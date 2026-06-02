import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { GET } from './route.ts';
import { createSessionForUser, SESSION_COOKIE_NAME } from '../../../lib/auth-service.ts';
import { createEmptyAuthState, writeAuthState } from '../../../lib/auth-store.ts';
import type { HostRuntimeConfig } from '../../../lib/host-runtime.ts';

test('GET /api/apps rejects unauthenticated callers', async t => {
  const config = await createRouteTestConfig();
  setRouteTestEnv(t, config);

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

test('GET /api/apps accepts authenticated host users', async t => {
  const config = await createRouteTestConfig();
  setRouteTestEnv(t, config);

  await writeAuthState({
    ...createEmptyAuthState(),
    users: [
      {
        id: 'user_regular',
        email: 'user@example.test',
        role: 'host.user',
        authProvider: 'local',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
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
  const session = await createSessionForUser('user_regular', 'auth.test.session.created', undefined, config);

  const response = await GET(new Request('http://localhost:3000/api/apps', {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
    },
  }));
  const body = await response.json() as { apps?: unknown[] };

  assert.equal(response.status, 200);
  assert.deepEqual(body.apps, []);
});

test('GET /api/apps returns structured registry errors', async t => {
  const config = await createRouteTestConfig();
  setRouteTestEnv(t, config);
  const now = new Date().toISOString();

  await writeAuthState({
    ...createEmptyAuthState(),
    users: [
      {
        id: 'user_admin',
        email: 'admin@example.test',
        role: 'host.admin',
        authProvider: 'local',
        createdAt: now,
        updatedAt: now,
      },
    ],
  }, config);
  const session = await createSessionForUser('user_admin', 'auth.test.session.created', undefined, config);
  await fs.mkdir(path.dirname(config.modulesStorePath), { recursive: true });
  await fs.writeFile(config.modulesStorePath, '{invalid json', 'utf-8');
  t.mock.method(console, 'error', () => {});

  const response = await GET(new Request('http://localhost:3000/api/apps', {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
    },
  }));
  const body = await response.json() as { error?: { code?: string; message?: string } };

  assert.equal(response.status, 500);
  assert.equal(body.error?.code, 'host_apps_failed');
  assert.equal(typeof body.error?.message, 'string');
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

function setRouteTestEnv(
  t: TestContext,
  config: HostRuntimeConfig,
  options: { hostPublicOrigin?: string | null } = {}
) {
  const previousDataRoot = process.env.HOST_DATA_ROOT_CONTAINER;
  const previousPublicOrigin = process.env.HOST_PUBLIC_ORIGIN;
  process.env.HOST_DATA_ROOT_CONTAINER = config.dataRootContainer;
  restoreEnvValue('HOST_PUBLIC_ORIGIN', options.hostPublicOrigin ?? undefined);

  t.after(() => {
    if (previousDataRoot === undefined) {
      delete process.env.HOST_DATA_ROOT_CONTAINER;
    } else {
      process.env.HOST_DATA_ROOT_CONTAINER = previousDataRoot;
    }

    restoreEnvValue('HOST_PUBLIC_ORIGIN', previousPublicOrigin);
  });
}

function restoreEnvValue(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
