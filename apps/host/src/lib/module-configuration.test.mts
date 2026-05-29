import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getHostRuntimeConfig } from './host-runtime.ts';
import {
  applyModuleConfigurationRequest,
  createModuleConfigurationPlan,
} from './module-configuration.ts';
import { readModulesStore, writeModulesStore } from './module-store.ts';

test('configuration updates public origin for legacy ports without endpointKey', async t => {
  const previousDataRootHost = process.env.HOST_DATA_ROOT_HOST;
  const previousDataRootContainer = process.env.HOST_DATA_ROOT_CONTAINER;
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-module-configuration-'));
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
  const metadataPath = path.join(config.modulesRootContainer, 'com.example.reports', 'metadata.json');
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, `${JSON.stringify({
    schemaVersion: '0.2',
    id: 'com.example.reports',
    name: 'Reports',
    version: '1.0.0',
    containers: [
      {
        key: 'app',
        image: {
          repository: 'ghcr.io/example/reports',
          tag: '1.0.0',
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
        key: 'web',
        container: 'app',
        port: 'http',
        public: true,
      },
    ],
  })}\n`, 'utf-8');

  await writeModulesStore({
    schemaVersion: '0.2',
    hostSettings: {},
    updatedAt: '2026-05-29T00:00:00.000Z',
    modules: [
      {
        id: 'com.example.reports',
        metadataUrl: 'https://example.test/reports/metadata.json',
        metadataPath: path.relative(config.dataRootContainer, metadataPath),
        operationStatus: 'installed',
        settings: {},
        containers: [
          {
            key: 'app',
            containerName: 'mod-com-example-reports-app',
            networkAlias: 'mod-com-example-reports-app',
            image: {
              repository: 'ghcr.io/example/reports',
              tag: '1.0.0',
              reference: 'ghcr.io/example/reports:1.0.0',
            },
            ports: [
              {
                key: 'http',
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

  const planResult = await createModuleConfigurationPlan('com.example.reports', config);
  assert.equal(planResult.status, 200);
  assert.equal(planResult.body.error, undefined);

  const plan = planResult.body.plan;
  assert.ok(plan);

  const result = await applyModuleConfigurationRequest('com.example.reports', {
    configurationDigest: plan.configurationDigest,
    settings: [],
    externalMounts: [],
    endpointOrigins: [
      {
        moduleId: 'com.example.reports',
        endpoint: 'web',
        publicOrigin: 'https://reports.example.test',
      },
    ],
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.error, null);
  assert.equal(result.body.recreatedContainers, false);

  const store = await readModulesStore(config);
  const installedModule = store.modules.find(candidate => candidate.id === 'com.example.reports');
  assert.equal(installedModule?.containers[0]?.ports?.[0]?.publicOrigin, 'https://reports.example.test');
});

test('configuration accepts empty optional number and boolean settings', async t => {
  const previousDataRootHost = process.env.HOST_DATA_ROOT_HOST;
  const previousDataRootContainer = process.env.HOST_DATA_ROOT_CONTAINER;
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-module-configuration-'));
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
  const metadataPath = path.join(config.modulesRootContainer, 'com.example.reports', 'metadata.json');
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, `${JSON.stringify({
    schemaVersion: '0.2',
    id: 'com.example.reports',
    name: 'Reports',
    version: '1.0.0',
    containers: [
      {
        key: 'app',
        image: {
          repository: 'ghcr.io/example/reports',
          tag: '1.0.0',
        },
      },
    ],
    settings: [
      {
        key: 'OPTIONAL_RETENTION_DAYS',
        type: 'number',
        required: false,
        targets: [{ container: 'app', type: 'env', name: 'OPTIONAL_RETENTION_DAYS' }],
      },
      {
        key: 'ENABLE_EXPORTS',
        type: 'boolean',
        required: false,
        targets: [{ container: 'app', type: 'env', name: 'ENABLE_EXPORTS' }],
      },
    ],
  })}\n`, 'utf-8');

  await writeModulesStore({
    schemaVersion: '0.2',
    hostSettings: {},
    updatedAt: '2026-05-29T00:00:00.000Z',
    modules: [
      {
        id: 'com.example.reports',
        metadataUrl: 'https://example.test/reports/metadata.json',
        metadataPath: path.relative(config.dataRootContainer, metadataPath),
        operationStatus: 'installed',
        settings: {},
        containers: [
          {
            key: 'app',
            containerName: 'mod-com-example-reports-app',
            networkAlias: 'mod-com-example-reports-app',
            image: {
              repository: 'ghcr.io/example/reports',
              tag: '1.0.0',
              reference: 'ghcr.io/example/reports:1.0.0',
            },
          },
        ],
      },
    ],
  }, config);

  const planResult = await createModuleConfigurationPlan('com.example.reports', config);
  assert.equal(planResult.status, 200);
  assert.equal(planResult.body.error, undefined);

  const plan = planResult.body.plan;
  assert.ok(plan);

  const result = await applyModuleConfigurationRequest('com.example.reports', {
    configurationDigest: plan.configurationDigest,
    settings: [
      {
        moduleId: 'com.example.reports',
        key: 'OPTIONAL_RETENTION_DAYS',
        value: '',
        secret: false,
      },
      {
        moduleId: 'com.example.reports',
        key: 'ENABLE_EXPORTS',
        value: '',
        secret: false,
      },
    ],
    externalMounts: [],
    endpointOrigins: [],
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.error, null);
  assert.equal(result.body.recreatedContainers, false);

  const store = await readModulesStore(config);
  const installedModule = store.modules.find(candidate => candidate.id === 'com.example.reports');
  assert.deepEqual(installedModule?.settings, {});
});
