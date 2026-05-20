import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { GET } from './route.ts';
import { createSessionForUser, SESSION_COOKIE_NAME } from '../../../lib/auth-service.ts';
import { createEmptyAuthState, writeAuthState } from '../../../lib/auth-store.ts';
import { writeModuleDevTargetState } from '../../../lib/module-dev-store.ts';
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

test('GET /api/apps returns developer apps without local target internals', async t => {
  const config = await createRouteTestConfig();
  setRouteTestEnv(t, config, { moduleDevMode: true });
  const now = new Date().toISOString();

  await writeAuthState({
    ...createEmptyAuthState(),
    users: [
      {
        id: 'user_regular',
        email: 'user@example.test',
        role: 'host.user',
        authProvider: 'local',
        createdAt: now,
        updatedAt: now,
      },
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
  const session = await createSessionForUser('user_regular', 'auth.test.session.created', undefined, config);
  await writeModuleDevTargetState({
    schemaVersion: '0.1',
    targets: [createDeveloperTarget()],
    updatedAt: now,
  }, config);

  const response = await GET(new Request('http://localhost:3000/api/apps', {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
    },
  }));
  const body = await response.json() as { apps?: Array<Record<string, unknown>> };

  assert.equal(response.status, 200);
  assert.equal(body.apps?.length, 1);
  assert.equal(body.apps[0]?.id, 'dev:mdev_reports');
  assert.equal(body.apps[0]?.source, 'developer');
  assert.equal(body.apps[0]?.entryPath, '/apps/dev/mdev_reports');
  assert.equal(body.apps[0]?.embeddedUrl, '/api/apps/dev/mdev_reports/embed?path=%2F');
  assert.deepEqual(body.apps[0]?.navigation, [
    {
      label: 'People',
      path: '/people',
      entryPath: '/apps/dev/mdev_reports?path=%2Fpeople',
      embeddedUrl: '/api/apps/dev/mdev_reports/embed?path=%2Fpeople',
    },
  ]);
  assert.equal('targetBaseUrl' in body.apps[0]!, false);
  assert.equal('targetPathPrefix' in body.apps[0]!, false);
  assert.equal('hostname' in body.apps[0]!, false);
  assert.equal('containerPort' in body.apps[0]!, false);
});

test('GET /api/apps applies assigned developer target filtering by principal', async t => {
  const config = await createRouteTestConfig();
  setRouteTestEnv(t, config, { moduleDevMode: true });
  const now = new Date().toISOString();

  await writeAuthState({
    ...createEmptyAuthState(),
    users: [
      {
        id: 'user_assigned',
        email: 'assigned@example.test',
        role: 'host.user',
        authProvider: 'local',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'user_unassigned',
        email: 'unassigned@example.test',
        role: 'host.user',
        authProvider: 'local',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'user_admin',
        email: 'admin@example.test',
        role: 'host.admin',
        authProvider: 'local',
        createdAt: now,
        updatedAt: now,
      },
    ],
    moduleAssignments: [
      {
        moduleId: 'com.example.reports',
        userId: 'user_assigned',
      },
    ],
  }, config);
  const assignedSession = await createSessionForUser('user_assigned', 'auth.test.session.created', undefined, config);
  const unassignedSession = await createSessionForUser('user_unassigned', 'auth.test.session.created', undefined, config);
  const adminSession = await createSessionForUser('user_admin', 'auth.test.session.created', undefined, config);
  await writeModuleDevTargetState({
    schemaVersion: '0.1',
    targets: [createDeveloperTarget({ exposurePolicy: 'assignedUsersOnly' })],
    updatedAt: now,
  }, config);

  const assignedResponse = await listAppsWithSession(assignedSession.sessionToken);
  const unassignedResponse = await listAppsWithSession(unassignedSession.sessionToken);
  const adminResponse = await listAppsWithSession(adminSession.sessionToken);

  assert.equal(assignedResponse.status, 200);
  assert.equal(unassignedResponse.status, 200);
  assert.equal(adminResponse.status, 200);
  assert.equal((await assignedResponse.json() as { apps?: unknown[] }).apps?.length, 1);
  assert.equal((await unassignedResponse.json() as { apps?: unknown[] }).apps?.length, 0);
  assert.equal((await adminResponse.json() as { apps?: unknown[] }).apps?.length, 1);
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
    moduleDevModeEnabled: false,
    moduleDevRootContainer: path.join(dataRootContainer, 'dev'),
    moduleDevTargetsPath: path.join(dataRootContainer, 'dev', 'module-targets.json'),
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
  options: { moduleDevMode?: boolean } = {}
) {
  const previousDataRoot = process.env.HOST_DATA_ROOT_CONTAINER;
  const previousDevMode = process.env.HOST_MODULE_DEV_MODE;
  process.env.HOST_DATA_ROOT_CONTAINER = config.dataRootContainer;
  if (options.moduleDevMode) {
    process.env.HOST_MODULE_DEV_MODE = 'enabled';
    config.moduleDevModeEnabled = true;
  } else {
    delete process.env.HOST_MODULE_DEV_MODE;
    config.moduleDevModeEnabled = false;
  }

  t.after(() => {
    if (previousDataRoot === undefined) {
      delete process.env.HOST_DATA_ROOT_CONTAINER;
    } else {
      process.env.HOST_DATA_ROOT_CONTAINER = previousDataRoot;
    }

    if (previousDevMode === undefined) {
      delete process.env.HOST_MODULE_DEV_MODE;
    } else {
      process.env.HOST_MODULE_DEV_MODE = previousDevMode;
    }
  });
}

function createDeveloperTarget(input: { exposurePolicy?: 'public' | 'loginRequired' | 'assignedUsersOnly' } = {}) {
  const now = new Date().toISOString();
  return {
    id: 'mdev_reports',
    moduleId: 'com.example.reports',
    moduleName: 'Reports',
    moduleVersion: '1.0.0',
    moduleDescription: 'Reports developer target.',
    metadataUrl: 'http://127.0.0.1:3000/metadata.json',
    hostname: 'reports.localhost',
    portKey: 'web',
    targetBaseUrl: 'http://127.0.0.1:3001/dev',
    targetPathPrefix: '/dev',
    containerPort: 3000,
    protocol: 'http',
    exposurePolicy: input.exposurePolicy ?? 'loginRequired',
    identityMode: 'required',
    enabled: true,
    shellApp: {
      displayName: 'Reports Dev',
      description: 'Reports developer target.',
      icon: 'boxes',
      entrypointPath: '/',
      navigation: [
        {
          label: 'People',
          path: '/people',
        },
      ],
    },
    createdAt: now,
    updatedAt: now,
  };
}

async function listAppsWithSession(sessionToken: string) {
  return await GET(new Request('http://localhost:3000/api/apps', {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
    },
  }));
}
