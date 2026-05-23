import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { GET } from './route.ts';
import { createSessionForUser, SESSION_COOKIE_NAME } from '../../lib/auth-service.ts';
import { createEmptyAuthState, writeAuthState } from '../../lib/auth-store.ts';
import { writeModuleDevTargetState } from '../../lib/module-dev-store.ts';
import type { HostRuntimeConfig } from '../../lib/host-runtime.ts';

test('root-relative embedded RSC requests proxy to the referring developer module', async t => {
  const config = await createRouteTestConfig();
  setRouteTestEnv(t, config);
  const originalFetch = globalThis.fetch;
  const upstreamRequests: string[] = [];
  const now = new Date().toISOString();

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const upstreamUrl = input instanceof Request ? input.url : String(input);
    upstreamRequests.push(upstreamUrl);
    return new Response('1:["$","main",null,{"children":"Release planner"}]', {
      status: 200,
      headers: {
        'content-type': 'text/x-component',
      },
    });
  }) as typeof fetch;

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
    targets: [
      {
        id: 'mdev_reports',
        moduleId: 'com.example.reports',
        moduleName: 'Reports',
        moduleVersion: '1.0.0',
        moduleDescription: 'Reports developer target.',
        metadataUrl: 'http://127.0.0.1:3000/metadata.json',
        hostname: 'reports.localhost',
        portKey: 'web',
        targetBaseUrl: 'http://dev.example.test/dev',
        targetPathPrefix: '/dev',
        containerPort: 3000,
        protocol: 'http',
        exposurePolicy: 'loginRequired',
        identityMode: 'required',
        enabled: true,
        shellApp: {
          displayName: 'Reports Dev',
          description: 'Reports developer target.',
          icon: 'boxes',
          entrypointPath: '/',
          navigation: [],
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  }, config);

  const response = await GET(new Request('http://localhost:3000/release-planner?_rsc=fixture', {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
      referer: 'http://localhost:3000/api/apps/dev/mdev_reports/embed/',
    },
  }));

  assert.equal(response.status, 200);
  assert.match(await response.text(), /Release planner/);
  assert.deepEqual(upstreamRequests, [
    'http://dev.example.test/dev/release-planner?_rsc=fixture',
  ]);
});

async function createRouteTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-embed-fallback-route-'));
  const authRootContainer = path.join(dataRootContainer, 'auth');
  const gatewayRootContainer = path.join(dataRootContainer, 'gateway');
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
    gatewayRootContainer,
    gatewayExposuresPath: path.join(gatewayRootContainer, 'exposures.json'),
    gatewayBaseDomain: 'example.test',
    hostPublicOrigin: 'https://host.example.test',
    hostInternalOrigin: 'http://docker-host:3000',
    dockerSocketPath: '/var/run/docker.sock',
    moduleNetwork: 'docker-host-modules',
  };
}

function setRouteTestEnv(t: TestContext, config: HostRuntimeConfig) {
  const previousDataRoot = process.env.HOST_DATA_ROOT_CONTAINER;
  const previousDevMode = process.env.HOST_MODULE_DEV_MODE;
  process.env.HOST_DATA_ROOT_CONTAINER = config.dataRootContainer;
  process.env.HOST_MODULE_DEV_MODE = 'enabled';
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
