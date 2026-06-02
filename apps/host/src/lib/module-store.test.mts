import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  readAppsStoreSnapshot,
  writeAppsStore,
} from './app-store.ts';
import {
  readModuleMetadata,
  readModulesStore,
  readModulesStoreSnapshot,
  writeModulesStore,
} from './module-store.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';

test('migrates legacy single-container module records to containers array', async () => {
  const config = await createModuleStoreTestConfig();
  const updatedAt = '2026-05-21T12:00:00.000Z';

  await fs.mkdir(config.dataRootContainer, { recursive: true });
  await fs.writeFile(config.modulesStorePath, `${JSON.stringify({
    schemaVersion: '0.1',
    hostSettings: {
      theme: 'dark',
    },
    modules: [
      {
        id: 'com.example.legacy',
        metadataUrl: 'https://modules.example.test/legacy.json',
        metadataPath: 'modules/com.example.legacy/metadata.json',
        containerName: 'legacy-container',
        networkAlias: 'legacy-alias',
        image: {
          repository: 'ghcr.io/example/legacy',
          tag: '1.2.3',
          reference: 'ghcr.io/example/legacy:1.2.3',
          pullPolicy: 'always',
        },
      },
      {
        id: 'com.example.sparse',
        metadataUrl: 'https://modules.example.test/sparse.json',
      },
    ],
    updatedAt,
  }, null, 2)}\n`);

  const store = await readModulesStoreSnapshot(config);

  assert.equal(store.schemaVersion, '0.2');
  assert.deepEqual(store.hostSettings, { theme: 'dark' });
  assert.equal(store.updatedAt, updatedAt);
  assert.deepEqual(store.modules[0]?.containers, [
    {
      key: 'main',
      containerName: 'legacy-container',
      networkAlias: 'legacy-alias',
      image: {
        repository: 'ghcr.io/example/legacy',
        tag: '1.2.3',
        reference: 'ghcr.io/example/legacy:1.2.3',
        pullPolicy: 'always',
      },
    },
  ]);
  assert.deepEqual(store.modules[1]?.containers, [
    {
      key: 'main',
      containerName: 'mod-com-example-sparse',
      networkAlias: 'mod-com-example-sparse',
      image: {
        repository: 'unknown',
        tag: 'latest',
        reference: 'unknown:latest',
      },
    },
  ]);

  const migratedRecord = store.modules[0] as unknown as Record<string, unknown>;
  assert.equal(Object.hasOwn(migratedRecord, 'containerName'), false);
  assert.equal(Object.hasOwn(migratedRecord, 'networkAlias'), false);
  assert.equal(Object.hasOwn(migratedRecord, 'image'), false);

  await writeModulesStore(store, config);
  const persisted = JSON.parse(await fs.readFile(config.modulesStorePath, 'utf-8')) as {
    modules: Record<string, unknown>[];
  };
  assert.equal(Object.hasOwn(persisted.modules[0] ?? {}, 'containerName'), false);
  assert.equal(Object.hasOwn(persisted.modules[0] ?? {}, 'networkAlias'), false);
  assert.equal(Object.hasOwn(persisted.modules[0] ?? {}, 'image'), false);
});

test('migrates legacy array module stores in snapshot reads', async () => {
  const config = await createModuleStoreTestConfig();

  await fs.mkdir(config.dataRootContainer, { recursive: true });
  await fs.writeFile(config.modulesStorePath, `${JSON.stringify([
    {
      id: 'com.example.array',
      metadataUrl: 'https://modules.example.test/array.json',
      containerName: 'array-container',
    },
  ], null, 2)}\n`);

  const store = await readModulesStoreSnapshot(config);

  assert.equal(store.schemaVersion, '0.2');
  assert.deepEqual(store.hostSettings, {});
  assert.equal(store.modules[0]?.containers[0]?.containerName, 'array-container');
  assert.equal(store.modules[0]?.containers[0]?.networkAlias, 'mod-com-example-array');
});

test('reads manifestPath as a metadataPath compatibility alias', async () => {
  const config = await createModuleStoreTestConfig();
  const moduleRoot = path.join(config.dataRootContainer, 'apps', 'com.example.app');
  await fs.mkdir(moduleRoot, { recursive: true });
  await fs.writeFile(path.join(moduleRoot, 'manifest.json'), `${JSON.stringify({
    schemaVersion: '0.2',
    id: 'com.example.app',
    name: 'Example App',
    version: '1.0.0',
    containers: [],
  })}\n`);

  const metadata = await readModuleMetadata({
    id: 'com.example.app',
    metadataUrl: 'https://apps.example.test/app/manifest.json',
    manifestPath: 'apps/com.example.app/manifest.json',
    containers: [],
  }, config);

  assert.equal(metadata?.id, 'com.example.app');
});

test('projects app lifecycle records from apps.json into installed module records', async () => {
  const config = await createModuleStoreTestConfig();
  const appRoot = path.join(config.dataRootContainer, 'apps', 'com.example.app');
  await fs.mkdir(appRoot, { recursive: true });
  await fs.writeFile(path.join(appRoot, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 'app.0.1',
    id: 'com.example.app',
    name: 'Example App',
    version: '1.0.0',
    runtimeProfiles: [],
    services: [],
  })}\n`);
  await writeAppsStore({
    schemaVersion: 'app-store.0.1',
    apps: [
      {
        id: 'com.example.app',
        manifestUrl: 'https://apps.example.test/app/manifest.json',
        manifestPath: 'apps/com.example.app/manifest.json',
        selectedRuntime: 'docker',
        containers: [
          {
            key: 'web',
            containerName: 'mod-com-example-app-web',
            networkAlias: 'mod-com-example-app-web',
            image: {
              repository: 'ghcr.io/example/app',
              tag: '1.0.0',
              reference: 'ghcr.io/example/app:1.0.0',
            },
          },
        ],
        operationStatus: 'failed',
        lastOperation: 'update',
        lastError: {
          message: 'Update failed.',
        },
      },
    ],
    updatedAt: new Date().toISOString(),
  }, config);

  const store = await readModulesStoreSnapshot(config);
  const app = store.modules.find(module => module.id === 'com.example.app');
  const metadata = app ? await readModuleMetadata(app, config) : null;

  assert.equal(app?.manifestPath, 'apps/com.example.app/manifest.json');
  assert.equal(app?.metadataPath, path.join(config.dataRootContainer, 'apps/com.example.app/manifest.json'));
  assert.equal(app?.containers[0]?.containerName, 'mod-com-example-app-web');
  assert.equal(app?.operationStatus, 'failed');
  assert.equal(app?.lastError?.message, 'Update failed.');
  assert.equal(metadata?.id, 'com.example.app');
});

test('writes app lifecycle records back to apps.json instead of modules.json', async () => {
  const config = await createModuleStoreTestConfig();
  await writeAppsStore({
    schemaVersion: 'app-store.0.1',
    apps: [
      {
        id: 'com.example.app',
        manifestUrl: 'https://apps.example.test/app/manifest.json',
        manifestPath: 'apps/com.example.app/manifest.json',
        selectedRuntime: 'docker',
        containers: [],
        operationStatus: 'installing',
      },
    ],
    updatedAt: new Date().toISOString(),
  }, config);

  const store = await readModulesStore(config);
  await writeModulesStore({
    ...store,
    modules: store.modules.map(module =>
      module.id === 'com.example.app'
        ? {
            ...module,
            operationStatus: 'installed',
            lastOperation: 'install',
            containers: [
              {
                key: 'web',
                containerName: 'mod-com-example-app-web',
                networkAlias: 'mod-com-example-app-web',
                image: {
                  repository: 'ghcr.io/example/app',
                  tag: '1.0.0',
                  reference: 'ghcr.io/example/app:1.0.0',
                },
              },
            ],
          }
        : module
    ),
  }, config);

  const appsStore = await readAppsStoreSnapshot(config);
  const modulesStore = JSON.parse(await fs.readFile(config.modulesStorePath, 'utf-8')) as {
    modules: Array<{ id: string }>;
  };

  assert.equal(appsStore.apps[0]?.operationStatus, 'installed');
  assert.equal(appsStore.apps[0]?.lastOperation, 'install');
  assert.equal(appsStore.apps[0]?.containers?.[0]?.containerName, 'mod-com-example-app-web');
  assert.deepEqual(modulesStore.modules, []);
});

async function createModuleStoreTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-host-store-'));
  const authRootContainer = path.join(dataRootContainer, 'auth');
  const gatewayRootContainer = path.join(dataRootContainer, 'gateway');

  return {
    dataRootHost: dataRootContainer,
    dataRootContainer,
    appsRootContainer: path.join(dataRootContainer, 'apps'),
    appsStorePath: path.join(dataRootContainer, 'apps.json'),
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
