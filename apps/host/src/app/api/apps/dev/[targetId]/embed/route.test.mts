import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { GET } from './route.ts';
import { createSessionForUser, SESSION_COOKIE_NAME } from '../../../../../../lib/auth-service.ts';
import { createEmptyAuthState, writeAuthState } from '../../../../../../lib/auth-store.ts';
import { writeModuleDevTargetState } from '../../../../../../lib/module-dev-store.ts';
import type { HostRuntimeConfig } from '../../../../../../lib/host-runtime.ts';

test('GET /api/apps/dev/[targetId]/embed rejects unauthenticated callers', async t => {
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

  const response = await GET(
    new Request('http://localhost:3000/api/apps/dev/mdev_reports/embed?path=%2F'),
    { params: Promise.resolve({ targetId: 'mdev_reports' }) }
  );
  const body = await response.json() as { error?: { code?: string; action?: string } };

  assert.equal(response.status, 401);
  assert.equal(body.error?.code, 'unauthorized');
  assert.equal(body.error?.action, 'apps.read');
});

test('GET /api/apps/dev/[targetId]/embed proxies enabled developer targets through the Host shell', async t => {
  const config = await createRouteTestConfig();
  setRouteTestEnv(t, config);
  const upstreamRequests: Array<{ url?: string; identity?: string | string[] }> = [];
  const upstream = createHttpServer((req, res) => {
    upstreamRequests.push({
      url: req.url,
      identity: req.headers['x-docker-host-identity'],
    });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('dev ok');
  });

  try {
    await listen(upstream);
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
        {
          id: 'user_regular',
          email: 'user@example.test',
          role: 'host.user',
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
          targetBaseUrl: `http://127.0.0.1:${getPort(upstream)}/dev`,
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
            navigation: [
              {
                label: 'People',
                path: '/people',
              },
            ],
          },
          createdAt: now,
          updatedAt: now,
        },
      ],
      updatedAt: now,
    }, config);

    const response = await GET(
      new Request('http://localhost:3000/api/apps/dev/mdev_reports/embed?path=%2Fpeople%3Fteam%3Dops', {
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${session.sessionToken}`,
        },
      }),
      { params: Promise.resolve({ targetId: 'mdev_reports' }) }
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'dev ok');
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0]?.url, '/dev/people?team=ops');
    assert.equal(typeof upstreamRequests[0]?.identity, 'string');
  } finally {
    await closeServer(upstream);
  }
});

async function createRouteTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-apps-dev-embed-route-'));
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

async function listen(server: { listen: (...args: unknown[]) => unknown; address: () => unknown }) {
  server.listen(0, '127.0.0.1');
  await once(server as never, 'listening');
}

async function closeServer(server: { close: (callback: (error?: Error) => void) => void; listening?: boolean }) {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function getPort(server: { address: () => unknown }) {
  const address = server.address();
  assert.ok(address && typeof address === 'object' && 'port' in address);
  return Number(address.port);
}
