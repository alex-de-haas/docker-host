import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getHostRuntimeConfig } from './host-runtime.ts';
import { listInstalledModules } from './module-service.ts';
import { writeModulesStore } from './module-store.ts';

test('listInstalledModules normalizes schema 0.3 service metadata', async t => {
  const previousDataRootHost = process.env.HOST_DATA_ROOT_HOST;
  const previousDataRootContainer = process.env.HOST_DATA_ROOT_CONTAINER;
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-module-service-'));
  t.after(async () => {
    if (previousDataRootHost === undefined) {
      delete process.env.HOST_DATA_ROOT_HOST;
    } else {
      process.env.HOST_DATA_ROOT_HOST = previousDataRootHost;
    }
    if (previousDataRootContainer === undefined) {
      delete process.env.HOST_DATA_ROOT_CONTAINER;
    } else {
      process.env.HOST_DATA_ROOT_CONTAINER = previousDataRootContainer;
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
  });

  process.env.HOST_DATA_ROOT_HOST = dataRoot;
  process.env.HOST_DATA_ROOT_CONTAINER = dataRoot;

  const config = getHostRuntimeConfig();
  const metadataPath = path.join(config.modulesRootContainer, 'com.haas.project-manager', 'metadata.json');
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, `${JSON.stringify({
    schemaVersion: '0.3',
    id: 'com.haas.project-manager',
    name: 'Project Manager',
    version: '1.0.0',
    services: [
      {
        key: 'web',
        source: {
          type: 'image',
          image: {
            repository: 'ghcr.io/haas/project-manager',
            tag: '1.0.0',
          },
        },
        runtime: {
          ports: [
            {
              key: 'http',
              containerPort: 3000,
              protocol: 'http',
            },
          ],
        },
      },
    ],
    endpoints: [
      {
        key: 'http',
        service: 'web',
        port: 'http',
        public: true,
      },
    ],
  })}\n`, 'utf-8');

  await writeModulesStore({
    schemaVersion: '0.2',
    hostSettings: {},
    updatedAt: '2026-05-28T00:00:00.000Z',
    modules: [
      {
        id: 'com.haas.project-manager',
        metadataUrl: 'https://example.test/project-manager/metadata.json',
        metadataPath: path.relative(config.dataRootContainer, metadataPath),
        operationStatus: 'installed',
        containers: [
          {
            key: 'web',
            containerName: 'mod-com-haas-project-manager-web',
            networkAlias: 'mod-com-haas-project-manager-web',
            image: {
              repository: 'ghcr.io/haas/project-manager',
              tag: '1.0.0',
              reference: 'ghcr.io/haas/project-manager:1.0.0',
            },
            ports: [
              {
                key: 'http',
                endpointKey: 'http',
                containerPort: 3000,
                hostPort: 3100,
                protocol: 'http',
                hostPublished: true,
              },
            ],
          },
        ],
      },
    ],
  }, config);

  const modules = await listInstalledModules();

  assert.equal(modules.length, 1);
  assert.equal(modules[0]?.id, 'com.haas.project-manager');
  assert.equal(modules[0]?.name, 'Project Manager');
  assert.equal(modules[0]?.containers[0]?.key, 'web');
  assert.equal(modules[0]?.containers[0]?.endpoints[0]?.key, 'http');
});
