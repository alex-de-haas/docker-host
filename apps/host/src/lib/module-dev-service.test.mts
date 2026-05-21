import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  deleteModuleDevTarget,
  isModuleDevServiceError,
  listModuleDevTargets,
  upsertModuleDevTarget,
} from './module-dev-service.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';

test('module dev target links metadata to a local gateway override', async () => {
  const config = await createModuleDevTestConfig({ enabled: true });
  const metadataServer = createMetadataServer();

  try {
    await listen(metadataServer);
    const target = await upsertModuleDevTarget({
      metadataUrl: `http://127.0.0.1:${getPort(metadataServer)}/metadata.json`,
      hostname: 'reports.localhost',
      portKey: 'web',
      targetBaseUrl: 'http://127.0.0.1:3001/dev',
    }, 'user_admin', config);

    assert.equal(target.moduleId, 'com.example.reports');
    assert.equal(target.moduleName, 'Reports');
    assert.equal(target.hostname, 'reports.localhost');
    assert.equal(target.targetBaseUrl, 'http://127.0.0.1:3001/dev');
    assert.equal(target.targetPathPrefix, '/dev');
    assert.equal(target.containerPort, 8080);
    assert.equal(target.exposurePolicy, 'loginRequired');
    assert.equal(target.identityMode, 'required');

    const listed = await listModuleDevTargets(config);
    assert.equal(listed.developerModeEnabled, true);
    assert.equal(listed.targets.length, 1);
    assert.equal(listed.targets[0]?.id, target.id);

    const deleted = await deleteModuleDevTarget(target.id, 'user_admin', config);
    assert.equal(deleted?.id, target.id);
    assert.equal((await listModuleDevTargets(config)).targets.length, 0);
  } finally {
    await closeServer(metadataServer);
  }
});

test('module dev target rejects mutations unless developer mode is enabled', async () => {
  const config = await createModuleDevTestConfig({ enabled: false });
  await assert.rejects(
    () => upsertModuleDevTarget({
      metadataUrl: 'http://127.0.0.1:3000/metadata.json',
      hostname: 'reports.localhost',
      portKey: 'web',
      targetBaseUrl: 'http://127.0.0.1:3001',
    }, 'user_admin', config),
    error => isModuleDevServiceError(error) &&
      error.code === 'module_dev_mode_disabled' &&
      error.status === 409
  );
});

test('module dev target rejects public target URLs', async () => {
  const config = await createModuleDevTestConfig({ enabled: true });
  const metadataServer = createMetadataServer();

  try {
    await listen(metadataServer);
    await assert.rejects(
      () => upsertModuleDevTarget({
        metadataUrl: `http://127.0.0.1:${getPort(metadataServer)}/metadata.json`,
        hostname: 'reports.localhost',
        portKey: 'web',
        targetBaseUrl: 'http://example.com:3001',
      }, 'user_admin', config),
      error => isModuleDevServiceError(error) &&
        error.code === 'module_dev_target_url_forbidden'
    );
  } finally {
    await closeServer(metadataServer);
  }
});

function createMetadataServer() {
  return createHttpServer((req, res) => {
    if (req.url !== '/metadata.json') {
      res.writeHead(404);
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      schemaVersion: '0.2',
      id: 'com.example.reports',
      name: 'Reports',
      version: '1.0.0',
      containers: [{
        key: 'app',
        image: {
          repository: 'reports-module',
          tag: 'dev',
          pullPolicy: 'ifNotPresent',
        },
        runtime: {
          ports: [{
            key: 'http',
            containerPort: 8080,
            protocol: 'http',
          }],
        },
      }],
      endpoints: [{
        key: 'web',
        container: 'app',
        port: 'http',
        public: true,
      }],
    }));
  });
}

async function createModuleDevTestConfig(input: { enabled: boolean }): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-module-dev-'));
  const authRootContainer = path.join(dataRootContainer, 'auth');
  const moduleDevRootContainer = path.join(dataRootContainer, 'dev');
  return {
    dataRootHost: dataRootContainer,
    dataRootContainer,
    modulesRootContainer: path.join(dataRootContainer, 'modules'),
    modulesStorePath: path.join(dataRootContainer, 'modules.json'),
    moduleDevModeEnabled: input.enabled,
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
