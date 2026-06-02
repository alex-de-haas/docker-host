import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  readAppsStore,
  readAppsStoreSnapshot,
  upsertInstalledAppRecord,
  writeAppsStore,
} from './app-store.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';

test('returns an empty app store snapshot when apps.json does not exist', async () => {
  const config = await createAppStoreTestConfig();

  const store = await readAppsStoreSnapshot(config);

  assert.equal(store.schemaVersion, 'app-store.0.1');
  assert.deepEqual(store.apps, []);
});

test('creates apps.json and apps root for new app-oriented stores', async () => {
  const config = await createAppStoreTestConfig();

  const store = await readAppsStore(config);

  assert.equal(store.schemaVersion, 'app-store.0.1');
  assert.deepEqual(store.apps, []);
  assert.equal(await exists(config.appsStorePath as string), true);
  assert.equal(await exists(config.appsRootContainer as string), true);
});

test('writes normalized app records to apps.json', async () => {
  const config = await createAppStoreTestConfig();

  await writeAppsStore({
    schemaVersion: 'app-store.0.1',
    apps: [
      {
        id: 'com.example.notes',
        manifestUrl: 'https://apps.example.test/notes/manifest.json',
        manifestPath: 'apps/com.example.notes/manifest.json',
        selectedChannel: 'main',
        selectedRuntime: 'docker',
      },
    ],
    updatedAt: new Date().toISOString(),
  }, config);

  const store = await readAppsStoreSnapshot(config);

  assert.equal(store.apps.length, 1);
  assert.equal(store.apps[0]?.id, 'com.example.notes');
  assert.equal(store.apps[0]?.manifestUrl, 'https://apps.example.test/notes/manifest.json');
  assert.equal(store.apps[0]?.manifestPath, 'apps/com.example.notes/manifest.json');
  assert.equal(store.apps[0]?.selectedChannel, 'main');
  assert.equal(store.apps[0]?.selectedRuntime, 'docker');
});

test('writes normalized app lifecycle records to apps.json', async () => {
  const config = await createAppStoreTestConfig();

  await writeAppsStore({
    schemaVersion: 'app-store.0.1',
    apps: [
      {
        id: 'com.example.notes',
        manifestUrl: 'https://apps.example.test/notes/manifest.json',
        manifestPath: 'apps/com.example.notes/manifest.json',
        selectedRuntime: 'docker',
        metadataDigest: 'sha256:metadata',
        planDigest: 'sha256:plan',
        containers: [
          {
            key: 'web',
            containerName: 'mod-com-example-notes-web',
            networkAlias: 'mod-com-example-notes-web',
            image: {
              repository: 'ghcr.io/example/notes',
              tag: '1.0.0',
              reference: 'ghcr.io/example/notes:1.0.0',
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
        operationStatus: 'failed',
        settings: {
          GREETING: 'Hello',
        },
        storageMappings: [
          {
            key: 'data',
            container: 'web',
            containerPath: '/data',
            hostPath: path.join(config.dataRootContainer, 'apps/com.example.notes/data'),
            required: true,
            writable: true,
          },
        ],
        externalMounts: [],
        resolvedDependencies: [],
        lastOperation: 'update',
        updateAttempt: {
          updatePlanDigest: 'sha256:update',
          settings: [],
          externalMounts: [],
          attemptedAt: '2026-06-02T12:00:00.000Z',
        },
        lastError: {
          message: 'Update failed.',
        },
      },
    ],
    updatedAt: new Date().toISOString(),
  }, config);

  const store = await readAppsStoreSnapshot(config);
  const app = store.apps[0];

  assert.equal(app?.metadataDigest, 'sha256:metadata');
  assert.equal(app?.planDigest, 'sha256:plan');
  assert.equal(app?.containers?.[0]?.containerName, 'mod-com-example-notes-web');
  assert.equal(app?.operationStatus, 'failed');
  assert.equal(app?.settings?.GREETING, 'Hello');
  assert.equal(Array.isArray(app?.storageMappings), true);
  assert.equal(app?.lastOperation, 'update');
  assert.equal(app?.updateAttempt?.updatePlanDigest, 'sha256:update');
  assert.equal(app?.lastError?.message, 'Update failed.');
});

test('upserts app records without removing install time', async () => {
  const config = await createAppStoreTestConfig();

  await upsertInstalledAppRecord({
    id: 'com.example.notes',
    manifestUrl: 'https://apps.example.test/notes/main/manifest.json',
    manifestPath: 'apps/com.example.notes/manifest.json',
    selectedRuntime: 'docker',
  }, config);
  const first = await readAppsStoreSnapshot(config);
  await upsertInstalledAppRecord({
    id: 'com.example.notes',
    manifestUrl: 'https://apps.example.test/notes/pr/manifest.json',
    manifestPath: 'apps/com.example.notes/manifest.json',
    selectedChannel: 'pr-42',
    selectedRuntime: 'docker',
  }, config);

  const store = await readAppsStoreSnapshot(config);

  assert.equal(store.apps.length, 1);
  assert.equal(store.apps[0]?.manifestUrl, 'https://apps.example.test/notes/pr/manifest.json');
  assert.equal(store.apps[0]?.selectedChannel, 'pr-42');
  assert.equal(store.apps[0]?.installedAt, first.apps[0]?.installedAt);
});

async function createAppStoreTestConfig(): Promise<HostRuntimeConfig> {
  const dataRootContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'hosty-app-store-'));
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

async function exists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
